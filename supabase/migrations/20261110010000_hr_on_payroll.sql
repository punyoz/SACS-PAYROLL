-- ════════════════════════════════════════════════════════════════════════════
-- HR is an employee too (user decision 2026-11-09, reverses the 2026-10-20
-- role separation for HR only): HR has a salary, an RFID card, attendance,
-- payslips, leave, loans and BIR Form 2316 like any employee. Super Admin and
-- Admin stay off payroll.
--
-- Each function below is its CURRENT definition (read from the database, the
-- same as live: 149 = 149 migrations), with only the paid-role list
-- ('employee', 'accountant') widened to ('employee', 'accountant', 'hr') and
-- the matching error text. Nothing else in them changes. The server's paid
-- roles (src/lib/payroll/staff.js PAID_ROLES and the routes that copy it)
-- change in the same commit.
-- ════════════════════════════════════════════════════════════════════════════

-- ── attendance_close_days: 1 paid-role list(s) gain 'hr' ──
CREATE OR REPLACE FUNCTION public.attendance_close_days(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_last_closed DATE := LEAST(p_to, v_today - 1);
  v_reevaluated INTEGER := 0;
  v_absent INTEGER := 0;
BEGIN
  PERFORM set_config('app.change_source', 'day_close', true);
  PERFORM set_config('app.actor_id', COALESCE('', ''), true);
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RETURN jsonb_build_object('reevaluated', 0, 'absent_inserted', 0);
  END IF;

  UPDATE public.attendance_logs
  SET status_computed_at = NOW()
  WHERE time_in IS NOT NULL
    AND time_out IS NULL
    AND archived_duplicate = FALSE
    AND status NOT IN ('Incomplete', 'Pending Correction', 'Corrected')
    AND log_date BETWEEN p_from AND LEAST(p_to, v_today);
  GET DIAGNOSTICS v_reevaluated = ROW_COUNT;

  IF v_last_closed >= p_from THEN
    WITH missing AS MATERIALIZED (
      SELECT pr.id, pr.full_name, pr.employee_type, pr.branch_id, d.day
      FROM public.profiles pr
      CROSS JOIN LATERAL (
        SELECT gs::DATE AS day FROM generate_series(p_from, v_last_closed, INTERVAL '1 day') gs
      ) d
      WHERE lower(pr.role::TEXT) IN ('employee', 'accountant', 'hr')
        AND COALESCE(pr.archived, FALSE) = FALSE
        AND lower(COALESCE(pr.employee_status, 'active')) <> 'inactive'
        AND d.day >= COALESCE(pr.date_hired, pr.created_at::DATE)
        AND NOT EXISTS (
          SELECT 1 FROM public.attendance_logs l
          WHERE l.employee_id = pr.id AND l.log_date = d.day AND l.archived_duplicate = FALSE
        )
    )
    INSERT INTO public.attendance_logs
      (employee_id, employee_name, employee_type, time_in, time_out, total_hours, status, log_date, branch_id)
    SELECT m.id, m.full_name, m.employee_type, NULL, NULL, 0, 'Absent', m.day, m.branch_id
    FROM missing m
    WHERE NOT EXISTS (SELECT 1 FROM public.attendance_approved_leave(m.id, m.day))
      AND NOT public.attendance_is_rest_day_for(m.id, m.branch_id, m.day)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_absent = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('reevaluated', v_reevaluated, 'absent_inserted', v_absent);
END;
$function$;

-- ── attendance_correct_absence: 1 paid-role list(s) gain 'hr' ──
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
    IF public.attendance_is_rest_day(p_log_date) THEN
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

-- ── attendance_correct_record: 1 paid-role list(s) gain 'hr' ──
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
    IF public.attendance_is_rest_day(v_day) THEN
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

-- ── rfid_card_register: 1 paid-role list(s) gain 'hr' ──
CREATE OR REPLACE FUNCTION public.rfid_card_register(p_actor uuid, p_employee uuid, p_uid text, p_reason text)
 RETURNS rfid_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor RECORD;
  v_person public.profiles;
  v_uid TEXT;
  v_card public.rfid_cards;
  v_active public.rfid_cards;
BEGIN
  SELECT * INTO v_person FROM public.profiles WHERE id = p_employee;
  IF v_person.id IS NULL OR v_person.role::TEXT NOT IN ('employee', 'accountant', 'hr') OR COALESCE(v_person.archived, FALSE) THEN
    RAISE EXCEPTION 'invalid: RFID cards are registered to active Employee, Accountant and HR accounts only.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_actor FROM public.rfid_actor_for(p_actor, v_person.branch_id, 'RFID cards');
  SELECT * INTO v_active FROM public.rfid_cards WHERE employee_id = v_person.id AND status = 'active';
  IF v_active.id IS NOT NULL THEN
    RAISE EXCEPTION 'already_active: % already has an active card (ending %). Replace it instead.', v_person.full_name, v_active.uid_last4
      USING ERRCODE = 'unique_violation';
  END IF;

  PERFORM set_config('sacs.rfid_flow', 'on', true);
  v_uid := public.rfid_uid_free(p_uid, v_person.id);
  INSERT INTO public.rfid_cards (employee_id, branch_id, uid, uid_last4, status, registered_by, registered_by_name, registered_by_role, status_reason)
  VALUES (v_person.id, v_person.branch_id, v_uid, right(v_uid, 4), 'active', v_actor.id, v_actor.full_name, v_actor.role,
          NULLIF(btrim(COALESCE(p_reason, '')), ''))
  RETURNING * INTO v_card;
  UPDATE public.profiles SET rfid_uid = v_uid WHERE id = v_person.id;
  PERFORM public.rfid_card_event(v_card, 'registered', NULL, NULLIF(btrim(COALESCE(p_reason, '')), ''), v_actor.id, v_actor.full_name, v_actor.role);
  PERFORM set_config('sacs.rfid_flow', '', true);
  RETURN v_card;
END;
$function$;

-- ── rfid_card_set_status: 1 paid-role list(s) gain 'hr' ──
CREATE OR REPLACE FUNCTION public.rfid_card_set_status(p_actor uuid, p_card uuid, p_action text, p_reason text)
 RETURNS rfid_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor RECORD;
  v_card public.rfid_cards;
  v_person public.profiles;
  v_from TEXT;
  v_to TEXT;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  SELECT * INTO v_card FROM public.rfid_cards WHERE id = p_card FOR UPDATE;
  IF v_card.id IS NULL THEN RAISE EXCEPTION 'not_found: no such RFID card.' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_person FROM public.profiles WHERE id = v_card.employee_id;
  SELECT * INTO v_actor FROM public.rfid_actor_for(p_actor, v_person.branch_id, 'RFID cards');
  IF v_reason IS NULL OR length(v_reason) < 5 THEN
    RAISE EXCEPTION 'reason_required: give the reason (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;
  v_from := v_card.status;
  v_to := CASE p_action WHEN 'deactivate' THEN 'inactive' WHEN 'mark_lost' THEN 'lost' WHEN 'reactivate' THEN 'active' END;
  IF v_to IS NULL THEN RAISE EXCEPTION 'invalid: deactivate, mark_lost or reactivate.' USING ERRCODE = 'check_violation'; END IF;
  IF (p_action = 'deactivate' AND v_from <> 'active')
     OR (p_action = 'mark_lost' AND v_from NOT IN ('active', 'inactive'))
     OR (p_action = 'reactivate' AND v_from <> 'inactive') THEN
    RAISE EXCEPTION 'invalid_transition: a % card cannot be %.', v_from,
      CASE p_action WHEN 'deactivate' THEN 'deactivated' WHEN 'mark_lost' THEN 'marked lost' ELSE 'reactivated' END
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('sacs.rfid_flow', 'on', true);
  IF p_action = 'reactivate' THEN
    IF COALESCE(v_person.archived, FALSE) OR v_person.role::TEXT NOT IN ('employee', 'accountant', 'hr') THEN
      RAISE EXCEPTION 'invalid: the employee is archived; register a card again once the account is active.' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.rfid_cards WHERE employee_id = v_person.id AND status = 'active') THEN
      RAISE EXCEPTION 'already_active: % already has an active card. Deactivate it first.', v_person.full_name USING ERRCODE = 'unique_violation';
    END IF;
    PERFORM public.rfid_uid_free(v_card.uid, v_person.id);
  END IF;
  UPDATE public.rfid_cards
  SET status = v_to, status_reason = v_reason, status_changed_by = v_actor.id, status_changed_by_name = v_actor.full_name,
      status_changed_by_role = v_actor.role, status_changed_at = NOW(),
      branch_id = CASE WHEN p_action = 'reactivate' THEN v_person.branch_id ELSE branch_id END
  WHERE id = v_card.id RETURNING * INTO v_card;
  UPDATE public.profiles SET rfid_uid = CASE WHEN v_to = 'active' THEN v_card.uid ELSE NULL END
  WHERE id = v_person.id AND (v_to = 'active' OR rfid_uid = v_card.uid);
  PERFORM public.rfid_card_event(v_card, CASE p_action WHEN 'deactivate' THEN 'deactivated' WHEN 'mark_lost' THEN 'marked_lost' ELSE 'reactivated' END,
    v_from, v_reason, v_actor.id, v_actor.full_name, v_actor.role);
  PERFORM set_config('sacs.rfid_flow', '', true);
  RETURN v_card;
END;
$function$;

-- ── tenure_protection_grants_guard: 1 paid-role list(s) gain 'hr' ──
CREATE OR REPLACE FUNCTION public.tenure_protection_grants_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_role TEXT;
  v_employee_role TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A Tenure Pay Protection grant is never deleted: revoke it instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_role := public.tenure_protection_actor_role(NEW.granted_by);
    IF v_role IS NULL OR v_role <> 'hr' THEN
      RAISE EXCEPTION 'Only HR can grant Tenure Pay Protection.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_employee_role := public.tenure_protection_actor_role(NEW.employee_id);
    IF v_employee_role IS NULL OR v_employee_role NOT IN ('employee', 'accountant', 'hr') THEN
      RAISE EXCEPTION 'Tenure Pay Protection is granted to employees, accountants and HR only.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.effective_from < v_today THEN
      RAISE EXCEPTION 'A grant cannot take effect before today: payroll already worked out is never recalculated.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_on IS NOT NULL THEN
      RAISE EXCEPTION 'A new grant cannot already be revoked.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.granted_by_role := v_role;
    NEW.granted_at := NOW();
    RETURN NEW;
  END IF;

  -- UPDATE: only revoking, once.
  IF OLD.revoked_on IS NOT NULL THEN
    RAISE EXCEPTION 'This grant is already revoked; its history is kept as it is.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.granted_by_name IS DISTINCT FROM OLD.granted_by_name
     OR NEW.granted_by_role IS DISTINCT FROM OLD.granted_by_role
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'A grant is never edited: revoke it and grant it again.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_on IS NULL THEN
    RAISE EXCEPTION 'Revoking needs the date protection ends.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_on < v_today THEN
    RAISE EXCEPTION 'Protection can only end today or later: past payroll is never changed.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_role := public.tenure_protection_actor_role(NEW.revoked_by);
  IF v_role IS NULL OR v_role <> 'hr' THEN
    RAISE EXCEPTION 'Only HR can revoke Tenure Pay Protection.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.revoked_by_role := v_role;
  NEW.revoked_at := NOW();
  RETURN NEW;
END;
$function$;
