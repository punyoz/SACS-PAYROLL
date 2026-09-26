-- ═══════════════════════════════════════════════════════════════════════════
-- HR / Admin correct an Absent day
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An employee who came to work but did not tap at all (reader down, forgot
-- the card) is recorded Absent, and the request workflow only covers
-- Incomplete / Undertime / Half Day. HR or the branch Admin can now enter the
-- real time in and time out, with a reason:
--
--   * an existing Absent record gets the times and becomes Corrected;
--   * a working day with no record at all yet (today, or a day the nightly
--     close has not reached) gets a new Corrected record.
--
-- The late / undertime / half-day facts are computed from the entered times
-- by the status engine, exactly as for a tap. The change is written to
-- attendance_corrections as an approved request (original status Absent,
-- corrected_time_in / corrected_time_out, who and why), the same audit trail
-- every other correction has.
--
-- Safe to run more than once.

ALTER TABLE public.attendance_corrections
  ADD COLUMN IF NOT EXISTS corrected_time_in TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.attendance_correct_absence(
  p_employee_id UUID,
  p_log_date DATE,
  p_time_in TIMESTAMPTZ,
  p_time_out TIMESTAMPTZ,
  p_reviewer UUID,
  p_reviewer_name TEXT,
  p_note TEXT
)
RETURNS public.attendance_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log public.attendance_logs;
  v_profile public.profiles;
  v_row public.attendance_corrections;
  v_exists BOOLEAN;
  v_orig_in TIMESTAMPTZ;
  v_orig_out TIMESTAMPTZ;
BEGIN
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
    IF public.attendance_is_rest_day(p_log_date) THEN
      RAISE EXCEPTION 'That day is a rest day or holiday.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_profile FROM public.profiles WHERE id = p_employee_id;
    IF NOT FOUND OR lower(COALESCE(v_profile.role::TEXT, '')) NOT IN ('employee', 'accountant') THEN
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
$$;

REVOKE ALL ON FUNCTION public.attendance_correct_absence(UUID, DATE, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_correct_absence(UUID, DATE, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TEXT) TO service_role;
