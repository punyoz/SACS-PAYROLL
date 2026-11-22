-- HR's hand entry for a day with no record follows the EMPLOYEE's own
-- schedule (2026-11-21, finding b). attendance_correct_absence and
-- attendance_correct_record used attendance_is_rest_day(day), which only
-- knows Mon-Fri and nationwide holidays, so a Saturday on someone's own
-- schedule was refused as "a rest day or holiday". Now:
--   * a working day on the employee's schedule (attendance_schedule_for), any
--     weekday or weekend, is allowed;
--   * a whole-day holiday for their branch stays a day off, unless HR
--     assigned them holiday duty that day (holiday_duty_assignments);
--   * a day off on their schedule is still refused.
-- Only that one check changes; both functions are otherwise as in
-- 20261110010000_hr_on_payroll.sql.

CREATE OR REPLACE FUNCTION public.attendance_hand_entry_day_off(p_employee UUID, p_day DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.attendance_is_rest_day_for(
           p_employee,
           (SELECT p.branch_id FROM public.profiles p WHERE p.id = p_employee),
           p_day)
     AND NOT EXISTS (
       SELECT 1 FROM public.holiday_duty_assignments d
       WHERE d.employee_id = p_employee AND d.holiday_date = p_day);
$$;

REVOKE ALL ON FUNCTION public.attendance_hand_entry_day_off(UUID, DATE) FROM PUBLIC, anon, authenticated;

-- ── attendance_correct_absence ──
CREATE OR REPLACE FUNCTION public.attendance_correct_absence(p_employee_id uuid, p_log_date date, p_time_in timestamp with time zone, p_time_out timestamp with time zone, p_reviewer uuid, p_reviewer_name text, p_note text)
 RETURNS attendance_corrections
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_log public.attendance_logs;
  v_profile public.profiles;
  v_row public.attendance_corrections;
  v_exists BOOLEAN;
  v_orig_in TIMESTAMPTZ;
  v_orig_out TIMESTAMPTZ;
BEGIN
  PERFORM set_config('app.change_source', 'absence_correction', true);
  PERFORM set_config('app.actor_id', COALESCE(p_reviewer::TEXT, ''), true);
  IF length(trim(COALESCE(p_note, ''))) < 5 THEN
    RAISE EXCEPTION 'Give a reason for the correction.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_time_in IS NULL OR p_time_out IS NULL OR p_time_out <= p_time_in THEN
    RAISE EXCEPTION 'The time out must be after the time in.' USING ERRCODE = 'check_violation';
  END IF;
  IF (p_time_in AT TIME ZONE 'Asia/Manila')::DATE <> p_log_date
     OR (p_time_out AT TIME ZONE 'Asia/Manila')::DATE <> p_log_date THEN
    RAISE EXCEPTION 'The time in and time out must be on the same day as the record.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_time_out > NOW() THEN
    RAISE EXCEPTION 'The time out cannot be in the future.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_log
  FROM public.attendance_logs
  WHERE employee_id = p_employee_id AND log_date = p_log_date AND archived_duplicate = FALSE
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;
  v_exists := FOUND;

  IF v_exists THEN
    IF v_log.status <> 'Absent' THEN
      RAISE EXCEPTION 'Only an Absent day can be corrected here. This day is %.', v_log.status USING ERRCODE = 'check_violation';
    END IF;
    v_orig_in := v_log.time_in;
    v_orig_out := v_log.time_out;
  ELSE
    IF public.attendance_hand_entry_day_off(p_employee_id, p_log_date) THEN
      RAISE EXCEPTION 'That day is a rest day or holiday.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_profile FROM public.profiles WHERE id = p_employee_id;
    IF NOT FOUND OR lower(COALESCE(v_profile.role::TEXT, '')) NOT IN ('employee', 'accountant', 'hr') THEN
      RAISE EXCEPTION 'Employee not found.' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  PERFORM set_config('sacs.attendance_override', 'on', true);
  IF v_exists THEN
    UPDATE public.attendance_logs
    SET time_in = p_time_in, time_out = p_time_out, status = 'Corrected'
    WHERE id = v_log.id
    RETURNING * INTO v_log;
  ELSE
    INSERT INTO public.attendance_logs
      (employee_id, employee_name, employee_type, time_in, time_out, total_hours, status, log_date, branch_id)
    VALUES
      (p_employee_id, v_profile.full_name, v_profile.employee_type, p_time_in, p_time_out, 0, 'Corrected', p_log_date, v_profile.branch_id)
    RETURNING * INTO v_log;
  END IF;
  PERFORM set_config('sacs.attendance_override', 'off', true);

  INSERT INTO public.attendance_corrections
    (log_id, employee_id, employee_name, branch_id, log_date, original_status,
     original_time_in, original_time_out, corrected_time_in, corrected_time_out, reason,
     requested_by, requested_by_name, status, resolution,
     approved_by, approved_by_name, approved_at, review_note)
  VALUES
    (v_log.id, v_log.employee_id, v_log.employee_name, v_log.branch_id, v_log.log_date, 'Absent',
     v_orig_in, v_orig_out, p_time_in, p_time_out, trim(p_note),
     p_reviewer, p_reviewer_name, 'approved', 'corrected',
     p_reviewer, p_reviewer_name, NOW(), trim(p_note))
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

-- ── attendance_correct_record ──
CREATE OR REPLACE FUNCTION public.attendance_correct_record(p_log_id uuid, p_employee_id uuid, p_log_date date, p_type text, p_time_in timestamp with time zone, p_time_out timestamp with time zone, p_reviewer uuid, p_reviewer_name text, p_note text)
 RETURNS attendance_corrections
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_log public.attendance_logs;
  v_profile public.profiles;
  v_row public.attendance_corrections;
  v_exists BOOLEAN := FALSE;
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_day DATE;
  v_new_in TIMESTAMPTZ;
  v_new_out TIMESTAMPTZ;
  v_orig_status TEXT := 'Absent';
  v_orig_in TIMESTAMPTZ;
  v_orig_out TIMESTAMPTZ;
  v_orig_hours NUMERIC := 0;
  v_orig_late INTEGER := 0;
  v_orig_under INTEGER := 0;
BEGIN
  PERFORM set_config('app.change_source', 'record_correction', true);
  PERFORM set_config('app.actor_id', COALESCE(p_reviewer::TEXT, ''), true);

  IF p_type IS NULL OR p_type NOT IN ('time_in', 'time_out', 'both', 'present') THEN
    RAISE EXCEPTION 'Choose what to correct: time in, time out, both, or mark as present.' USING ERRCODE = 'check_violation';
  END IF;
  IF length(trim(COALESCE(p_note, ''))) < 5 THEN
    RAISE EXCEPTION 'Give a reason for the correction.' USING ERRCODE = 'check_violation';
  END IF;

  IF p_log_id IS NOT NULL THEN
    SELECT * INTO v_log FROM public.attendance_logs
    WHERE id = p_log_id AND archived_duplicate = FALSE
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Attendance record not found.' USING ERRCODE = 'no_data_found';
    END IF;
    v_exists := TRUE;
  ELSE
    IF p_employee_id IS NULL OR p_log_date IS NULL THEN
      RAISE EXCEPTION 'Choose the employee and the day to correct.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_log FROM public.attendance_logs
    WHERE employee_id = p_employee_id AND log_date = p_log_date AND archived_duplicate = FALSE
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE;
    v_exists := FOUND;
  END IF;

  IF v_exists THEN
    v_day := v_log.log_date;
    IF v_log.status = 'On Leave' THEN
      RAISE EXCEPTION 'This day is covered by approved leave. Cancel the leave first to record attendance.' USING ERRCODE = 'check_violation';
    END IF;
    v_orig_status := v_log.status;
    v_orig_in := v_log.time_in;
    v_orig_out := v_log.time_out;
    v_orig_hours := COALESCE(v_log.total_hours, 0);
    v_orig_late := COALESCE(v_log.late_minutes, 0);
    v_orig_under := COALESCE(v_log.undertime_minutes, 0);
  ELSE
    v_day := p_log_date;
    IF v_day > v_today THEN
      RAISE EXCEPTION 'That day has not happened yet.' USING ERRCODE = 'check_violation';
    END IF;
    IF public.attendance_hand_entry_day_off(p_employee_id, v_day) THEN
      RAISE EXCEPTION 'That day is a rest day or holiday.' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.attendance_approved_leave(p_employee_id, v_day)) THEN
      RAISE EXCEPTION 'This day is covered by approved leave. Cancel the leave first to record attendance.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_profile FROM public.profiles WHERE id = p_employee_id;
    IF NOT FOUND OR lower(COALESCE(v_profile.role::TEXT, '')) NOT IN ('employee', 'accountant', 'hr') THEN
      RAISE EXCEPTION 'Employee not found.' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  IF p_type IN ('time_in', 'both', 'present') AND p_time_in IS NULL THEN
    RAISE EXCEPTION 'Enter the new time in.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_type IN ('time_out', 'both', 'present') AND p_time_out IS NULL THEN
    RAISE EXCEPTION 'Enter the new time out.' USING ERRCODE = 'check_violation';
  END IF;

  v_new_in := CASE WHEN p_type IN ('time_in', 'both', 'present') THEN p_time_in ELSE v_orig_in END;
  v_new_out := CASE WHEN p_type IN ('time_out', 'both', 'present') THEN p_time_out ELSE v_orig_out END;

  IF v_new_in IS NULL THEN
    RAISE EXCEPTION 'This record has no time in. Choose "Correct both" or "Mark as present".' USING ERRCODE = 'check_violation';
  END IF;
  -- A finished day needs a time out, or it would count as a full day forever.
  IF v_new_out IS NULL AND v_day < v_today THEN
    RAISE EXCEPTION 'This day has no time out. Choose "Correct both" to enter it too.' USING ERRCODE = 'check_violation';
  END IF;
  IF (v_new_in AT TIME ZONE 'Asia/Manila')::DATE <> v_day
     OR (v_new_out IS NOT NULL AND (v_new_out AT TIME ZONE 'Asia/Manila')::DATE <> v_day) THEN
    RAISE EXCEPTION 'The time in and time out must be on the same day as the record.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_new_out IS NOT NULL AND v_new_out <= v_new_in THEN
    RAISE EXCEPTION 'Time out must be later than time in.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_new_in > NOW() OR (v_new_out IS NOT NULL AND v_new_out > NOW()) THEN
    RAISE EXCEPTION 'A corrected time cannot be in the future.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_exists AND v_new_in IS NOT DISTINCT FROM v_orig_in AND v_new_out IS NOT DISTINCT FROM v_orig_out THEN
    RAISE EXCEPTION 'The new times are the same as the current ones.' USING ERRCODE = 'check_violation';
  END IF;

  -- An employee's open request on this record is settled by this correction.
  IF v_exists THEN
    UPDATE public.attendance_corrections
    SET status = 'approved',
        resolution = 'corrected',
        approved_by = p_reviewer,
        approved_by_name = p_reviewer_name,
        approved_at = NOW(),
        review_note = 'Closed by a direct correction: ' || trim(p_note),
        updated_at = NOW()
    WHERE log_id = v_log.id AND status = 'pending';
  END IF;

  PERFORM set_config('sacs.attendance_override', 'on', true);
  IF v_exists THEN
    UPDATE public.attendance_logs
    SET time_in = v_new_in, time_out = v_new_out, status = 'Corrected'
    WHERE id = v_log.id
    RETURNING * INTO v_log;
  ELSE
    INSERT INTO public.attendance_logs
      (employee_id, employee_name, employee_type, time_in, time_out, total_hours, status, log_date, branch_id)
    VALUES
      (p_employee_id, v_profile.full_name, v_profile.employee_type, v_new_in, v_new_out, 0, 'Corrected', v_day, v_profile.branch_id)
    RETURNING * INTO v_log;
  END IF;
  PERFORM set_config('sacs.attendance_override', 'off', true);

  INSERT INTO public.attendance_corrections
    (log_id, employee_id, employee_name, branch_id, log_date, original_status,
     original_time_in, original_time_out, corrected_time_in, corrected_time_out, reason,
     requested_by, requested_by_name, status, resolution,
     approved_by, approved_by_name, approved_at, review_note,
     correction_type,
     original_total_hours, original_late_minutes, original_undertime_minutes,
     corrected_total_hours, corrected_late_minutes, corrected_undertime_minutes)
  VALUES
    (v_log.id, v_log.employee_id, v_log.employee_name, v_log.branch_id, v_log.log_date, v_orig_status,
     v_orig_in, v_orig_out, v_new_in, v_new_out, trim(p_note),
     p_reviewer, p_reviewer_name, 'approved', 'corrected',
     p_reviewer, p_reviewer_name, NOW(), trim(p_note),
     p_type,
     v_orig_hours, v_orig_late, v_orig_under,
     CASE WHEN v_log.time_out IS NULL THEN 0 ELSE COALESCE(v_log.total_hours, 0) END,
     COALESCE(v_log.late_minutes, 0), COALESCE(v_log.undertime_minutes, 0))
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;
