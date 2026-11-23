-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 3 (2026-11-23): attendance correction requests (employees ask HR to fix
-- a time in / time out). Builds on attendance_corrections (20260926010000);
-- the old time-out-only functions stay as they are. Additive.
--
--   attendance_request_correction_v2  missing / wrong time in or out, a preset
--       reason, an optional attachment. Rules (settings, pending the policy
--       manual): within attendance.correction_window_days working days after
--       the date (default 3); never a future time; time out after time in; on
--       the record's own date; one open request per date; at most
--       attendance.correction_max_per_cutoff per cutoff (default 5).
--   attendance_preview_correction     the day as the engine would compute it
--       with the corrected times (nothing is kept).
--   attendance_review_correction_v2   HR decides. Approve: the times are
--       applied and the engine recalculates the day (status, late, undertime);
--       the original taps stay on the request and in the history. When the
--       day's cutoff was already paid, the pay difference HR saw becomes an
--       APPROVED payroll correction on the next payslip (user decision
--       2026-11-23): a refund as an incentive line, a reduction as a one-time
--       recovery; never twice (one per request).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.attendance_corrections ADD COLUMN IF NOT EXISTS fix_type TEXT
  CHECK (fix_type IS NULL OR fix_type IN ('missing_in', 'missing_out', 'wrong_in', 'wrong_out'));
ALTER TABLE public.attendance_corrections ADD COLUMN IF NOT EXISTS reason_code TEXT
  CHECK (reason_code IS NULL OR reason_code IN ('forgot_in', 'forgot_out', 'card_not_working', 'terminal_offline', 'other'));
ALTER TABLE public.attendance_corrections ADD COLUMN IF NOT EXISTS attachment_path TEXT;
ALTER TABLE public.attendance_corrections ADD COLUMN IF NOT EXISTS pay_effect JSONB;
ALTER TABLE public.attendance_corrections ADD COLUMN IF NOT EXISTS pay_correction_id UUID REFERENCES public.payroll_corrections(id);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_corrections_one_pay_correction ON public.attendance_corrections (pay_correction_id) WHERE pay_correction_id IS NOT NULL;

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'attendance', v.key, v.value, 'System'
FROM (VALUES ('correction_window_days', '3'), ('correction_max_per_cutoff', '5')) v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'attendance' AND c.key = v.key);

/** attendance.<key> as an integer. */
CREATE OR REPLACE FUNCTION public.attendance_setting_int(p_key TEXT, p_default INTEGER)
 RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT CASE WHEN value ~ '^\d{1,3}$' THEN value::INTEGER END FROM public.system_config
                   WHERE section = 'attendance' AND key = p_key LIMIT 1), p_default);
$function$;
REVOKE ALL ON FUNCTION public.attendance_setting_int(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

/** The cutoff containing a date: [start, end]. */
CREATE OR REPLACE FUNCTION public.attendance_cutoff_of(p_day DATE, OUT cutoff_start DATE, OUT cutoff_end DATE)
 LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE WHEN EXTRACT(DAY FROM p_day) <= 15 THEN date_trunc('month', p_day)::DATE ELSE date_trunc('month', p_day)::DATE + 15 END,
         CASE WHEN EXTRACT(DAY FROM p_day) <= 15 THEN date_trunc('month', p_day)::DATE + 14
              ELSE (date_trunc('month', p_day) + INTERVAL '1 month - 1 day')::DATE END;
$function$;

/** How many correction requests the employee filed in the cutoff containing p_day (any status). */
CREATE OR REPLACE FUNCTION public.attendance_corrections_used(p_employee UUID, p_day DATE)
 RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COUNT(*)::INTEGER FROM public.attendance_corrections c, public.attendance_cutoff_of(p_day) k
  WHERE c.employee_id = p_employee AND c.log_date BETWEEN k.cutoff_start AND k.cutoff_end AND c.fix_type IS NOT NULL;
$function$;
REVOKE ALL ON FUNCTION public.attendance_corrections_used(UUID, DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.attendance_request_correction_v2(
  p_log_id UUID, p_employee_id UUID, p_fix_type TEXT, p_time_in TIMESTAMPTZ, p_time_out TIMESTAMPTZ,
  p_reason_code TEXT, p_reason TEXT, p_attachment TEXT DEFAULT NULL)
 RETURNS public.attendance_corrections LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_log public.attendance_logs;
  v_row public.attendance_corrections;
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_window INTEGER := public.attendance_setting_int('correction_window_days', 3);
  v_max INTEGER := public.attendance_setting_int('correction_max_per_cutoff', 5);
  v_in TIMESTAMPTZ;
  v_out TIMESTAMPTZ;
  v_type TEXT;
BEGIN
  PERFORM set_config('app.change_source', 'correction_request', true);
  PERFORM set_config('app.actor_id', COALESCE(p_employee_id::TEXT, ''), true);
  SELECT * INTO v_log FROM public.attendance_logs WHERE id = p_log_id FOR UPDATE;
  IF NOT FOUND OR v_log.employee_id <> p_employee_id THEN
    RAISE EXCEPTION 'Attendance record not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_log.status = 'Pending Correction' THEN
    RAISE EXCEPTION 'There is already an open correction request for this day.' USING ERRCODE = 'unique_violation';
  END IF;
  IF v_log.status IN ('Holiday', 'On Leave') THEN
    RAISE EXCEPTION 'This day cannot be corrected (%).', v_log.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_log.log_date > v_today THEN
    RAISE EXCEPTION 'A future day cannot be corrected.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_today > public.automation_add_working_days(v_log.log_date, v_window, v_log.branch_id) THEN
    RAISE EXCEPTION 'File it within % working days after the date: the time to file for % has passed.', v_window, to_char(v_log.log_date, 'Mon DD') USING ERRCODE = 'check_violation';
  END IF;
  IF public.attendance_corrections_used(p_employee_id, v_log.log_date) >= v_max THEN
    RAISE EXCEPTION 'You have used all % correction requests for this cutoff.', v_max USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason_code IS NULL OR p_reason_code NOT IN ('forgot_in', 'forgot_out', 'card_not_working', 'terminal_offline', 'other') THEN
    RAISE EXCEPTION 'Choose the reason.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason_code = 'other' AND length(trim(COALESCE(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'Describe the reason (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;

  CASE p_fix_type
    WHEN 'missing_in' THEN
      IF v_log.time_in IS NOT NULL THEN RAISE EXCEPTION 'This day already has a time in: choose "Wrong time in".' USING ERRCODE = 'check_violation'; END IF;
      IF p_time_in IS NULL THEN RAISE EXCEPTION 'Enter the correct time in.' USING ERRCODE = 'check_violation'; END IF;
      v_in := p_time_in; v_out := COALESCE(p_time_out, v_log.time_out);
      IF v_out IS NULL THEN RAISE EXCEPTION 'There is no time out on this day either: enter both times.' USING ERRCODE = 'check_violation'; END IF;
    WHEN 'missing_out' THEN
      IF v_log.time_out IS NOT NULL THEN RAISE EXCEPTION 'This day already has a time out: choose "Wrong time out".' USING ERRCODE = 'check_violation'; END IF;
      IF v_log.time_in IS NULL THEN RAISE EXCEPTION 'There is no time in on this day either: choose "Missing time in" and enter both times.' USING ERRCODE = 'check_violation'; END IF;
      IF p_time_out IS NULL THEN RAISE EXCEPTION 'Enter the correct time out.' USING ERRCODE = 'check_violation'; END IF;
      v_in := v_log.time_in; v_out := p_time_out;
    WHEN 'wrong_in' THEN
      IF v_log.time_in IS NULL THEN RAISE EXCEPTION 'There is no time in to fix: choose "Missing time in".' USING ERRCODE = 'check_violation'; END IF;
      IF p_time_in IS NULL THEN RAISE EXCEPTION 'Enter the correct time in.' USING ERRCODE = 'check_violation'; END IF;
      v_in := p_time_in; v_out := v_log.time_out;
    WHEN 'wrong_out' THEN
      IF v_log.time_out IS NULL THEN RAISE EXCEPTION 'There is no time out to fix: choose "Missing time out".' USING ERRCODE = 'check_violation'; END IF;
      IF p_time_out IS NULL THEN RAISE EXCEPTION 'Enter the correct time out.' USING ERRCODE = 'check_violation'; END IF;
      v_in := v_log.time_in; v_out := p_time_out;
    ELSE
      RAISE EXCEPTION 'Choose what to fix.' USING ERRCODE = 'check_violation';
  END CASE;

  IF v_in > NOW() OR (v_out IS NOT NULL AND v_out > NOW()) THEN
    RAISE EXCEPTION 'A corrected time cannot be in the future.' USING ERRCODE = 'check_violation';
  END IF;
  IF (v_in AT TIME ZONE 'Asia/Manila')::DATE <> v_log.log_date OR (v_out IS NOT NULL AND (v_out AT TIME ZONE 'Asia/Manila')::DATE <> v_log.log_date) THEN
    RAISE EXCEPTION 'The corrected times must be on % itself.', to_char(v_log.log_date, 'Mon DD') USING ERRCODE = 'check_violation';
  END IF;
  IF v_out IS NOT NULL AND v_out <= v_in THEN
    RAISE EXCEPTION 'The time out must be after the time in.' USING ERRCODE = 'check_violation';
  END IF;

  v_type := CASE WHEN p_fix_type IN ('missing_in', 'wrong_in') AND p_time_out IS NOT NULL AND v_log.time_out IS NULL THEN 'both'
                 WHEN p_fix_type IN ('missing_in', 'wrong_in') THEN 'time_in' ELSE 'time_out' END;
  INSERT INTO public.attendance_corrections
    (log_id, employee_id, employee_name, branch_id, log_date, original_status, original_time_in, original_time_out,
     corrected_time_in, corrected_time_out, correction_type, fix_type, reason_code, reason, attachment_path,
     original_late_minutes, original_undertime_minutes, requested_by, requested_by_name)
  VALUES
    (v_log.id, v_log.employee_id, v_log.employee_name, v_log.branch_id, v_log.log_date, v_log.status, v_log.time_in, v_log.time_out,
     CASE WHEN v_type IN ('time_in', 'both') THEN v_in END, CASE WHEN v_type IN ('time_out', 'both') THEN v_out END, v_type,
     p_fix_type, p_reason_code,
     -- The preset's words, plus the employee's own (required for "Other").
     concat_ws(': ', CASE p_reason_code WHEN 'forgot_in' THEN 'Forgot to tap in' WHEN 'forgot_out' THEN 'Forgot to tap out'
                      WHEN 'card_not_working' THEN 'Card not working' WHEN 'terminal_offline' THEN 'Terminal offline' ELSE NULL END,
               NULLIF(left(trim(COALESCE(p_reason, '')), 450), '')),
     NULLIF(p_attachment, ''),
     v_log.late_minutes, v_log.undertime_minutes, p_employee_id, v_log.employee_name)
  RETURNING * INTO v_row;

  PERFORM set_config('sacs.attendance_override', 'on', true);
  UPDATE public.attendance_logs SET status = 'Pending Correction' WHERE id = v_log.id;
  PERFORM set_config('sacs.attendance_override', 'off', true);
  RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.attendance_request_correction_v2(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

/** Put new times on a log and let the engine recompute the day (status, late, undertime). */
CREATE OR REPLACE FUNCTION public.attendance_apply_times(p_log_id UUID, p_time_in TIMESTAMPTZ, p_time_out TIMESTAMPTZ)
 RETURNS public.attendance_logs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_log public.attendance_logs;
BEGIN
  PERFORM set_config('sacs.attendance_override', 'on', true);
  UPDATE public.attendance_logs SET time_in = p_time_in, time_out = p_time_out, status = 'Incomplete' WHERE id = p_log_id;
  PERFORM set_config('sacs.attendance_override', 'off', true);
  UPDATE public.attendance_logs SET status_computed_at = NOW() WHERE id = p_log_id RETURNING * INTO v_log;
  RETURN v_log;
END;
$function$;
REVOKE ALL ON FUNCTION public.attendance_apply_times(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

/** The day as the engine would compute it with the corrected times; nothing is kept. */
CREATE OR REPLACE FUNCTION public.attendance_preview_correction(p_correction_id UUID)
 RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.attendance_corrections;
  v_log public.attendance_logs;
  v_after JSONB;
BEGIN
  SELECT * INTO v_row FROM public.attendance_corrections WHERE id = p_correction_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Correction request not found.' USING ERRCODE = 'no_data_found'; END IF;
  BEGIN
    v_log := public.attendance_apply_times(v_row.log_id, COALESCE(v_row.corrected_time_in, v_row.original_time_in), COALESCE(v_row.corrected_time_out, v_row.original_time_out));
    v_after := jsonb_build_object('status', v_log.status, 'time_in', v_log.time_in, 'time_out', v_log.time_out,
      'late_minutes', v_log.late_minutes, 'undertime_minutes', v_log.undertime_minutes, 'is_half_day', v_log.is_half_day, 'total_hours', v_log.total_hours);
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sacs_preview_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sacs_preview_rollback' THEN RAISE; END IF;
  END;
  RETURN jsonb_build_object(
    'before', jsonb_build_object('status', v_row.original_status, 'time_in', v_row.original_time_in, 'time_out', v_row.original_time_out,
                                 'late_minutes', v_row.original_late_minutes, 'undertime_minutes', v_row.original_undertime_minutes),
    'after', v_after);
END;
$function$;
REVOKE ALL ON FUNCTION public.attendance_preview_correction(UUID) FROM PUBLIC, anon, authenticated;

/**
 * HR decides a request (v2). p_pay (computed by the app from the paid payslip's
 * own rates, shown to HR before approving): { entry_id, kind: underpayment |
 * overpayment, amount, line } or NULL when the cutoff is not paid yet / no change.
 */
CREATE OR REPLACE FUNCTION public.attendance_review_correction_v2(
  p_correction_id UUID, p_decision TEXT, p_reviewer UUID, p_reviewer_name TEXT, p_note TEXT, p_pay JSONB DEFAULT NULL)
 RETURNS public.attendance_corrections LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.attendance_corrections;
  v_entry public.payroll_entries;
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_amount NUMERIC;
  v_kind TEXT;
  v_line TEXT;
  v_pc UUID;
  v_incentive UUID;
  v_loan UUID;
  v_start DATE;
BEGIN
  PERFORM set_config('app.change_source', 'correction_review', true);
  PERFORM set_config('app.actor_id', COALESCE(p_reviewer::TEXT, ''), true);
  SELECT * INTO v_row FROM public.attendance_corrections WHERE id = p_correction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Correction request not found.' USING ERRCODE = 'no_data_found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This correction request has already been decided.' USING ERRCODE = 'check_violation'; END IF;
  IF v_row.employee_id = p_reviewer THEN RAISE EXCEPTION 'You cannot decide your own correction request.' USING ERRCODE = 'insufficient_privilege'; END IF;

  IF p_decision = 'reject' THEN
    -- The day goes back to what the taps say (the engine recomputes it).
    PERFORM public.attendance_apply_times(v_row.log_id, v_row.original_time_in, v_row.original_time_out);
    UPDATE public.attendance_corrections SET status = 'rejected', resolution = 'incomplete', approved_by = p_reviewer, approved_by_name = p_reviewer_name,
      approved_at = NOW(), review_note = NULLIF(trim(COALESCE(p_note, '')), ''), updated_at = NOW()
    WHERE id = p_correction_id RETURNING * INTO v_row;
    RETURN v_row;
  END IF;
  IF p_decision <> 'approve' THEN RAISE EXCEPTION 'Decision must be approve or reject.' USING ERRCODE = 'check_violation'; END IF;

  PERFORM public.attendance_apply_times(v_row.log_id, COALESCE(v_row.corrected_time_in, v_row.original_time_in), COALESCE(v_row.corrected_time_out, v_row.original_time_out));

  -- The pay difference HR saw: an approved correction on the next payslip (once).
  v_amount := ROUND(COALESCE((p_pay->>'amount')::NUMERIC, 0), 2);
  IF p_pay IS NOT NULL AND v_amount > 0 THEN
    v_kind := p_pay->>'kind';
    IF v_kind NOT IN ('underpayment', 'overpayment') THEN RAISE EXCEPTION 'Unknown pay adjustment.' USING ERRCODE = 'check_violation'; END IF;
    SELECT * INTO v_entry FROM public.payroll_entries WHERE id = (p_pay->>'entry_id')::UUID AND employee_id = v_row.employee_id;
    IF v_entry.id IS NULL THEN RAISE EXCEPTION 'The paid payslip for that day was not found.' USING ERRCODE = 'no_data_found'; END IF;
    v_line := left(COALESCE(NULLIF(p_pay->>'line', ''), format('Attendance correction (%s)', to_char(v_row.log_date, 'Mon DD'))), 200);
    IF v_kind = 'underpayment' THEN
      INSERT INTO public.payroll_monthly_incentives (employee_id, branch_id, item_date, kind, description, amount, created_by, created_by_name)
      VALUES (v_row.employee_id, v_entry.branch_id, v_today, 'incentive', v_line, v_amount, p_reviewer, p_reviewer_name)
      RETURNING id INTO v_incentive;
    ELSE
      -- Recovered once, on the next 2nd-half payslip (where deductions are taken).
      v_start := CASE WHEN extract(day FROM v_today) <= 16 THEN date_trunc('month', v_today)::DATE + 15
                      ELSE (date_trunc('month', v_today) + INTERVAL '1 month')::DATE + 15 END;
      INSERT INTO public.payroll_loans (employee_id, branch_id, loan_type, description, date_granted, principal, interest_pct,
        number_of_payrolls, amortization, start_period, remaining_balance, status, created_by, created_by_name)
      VALUES (v_row.employee_id, v_entry.branch_id, 'other', v_line, v_today, v_amount, 0, 1, v_amount, v_start, v_amount, 'active', p_reviewer, p_reviewer_name)
      RETURNING id INTO v_loan;
    END IF;
    INSERT INTO public.payroll_corrections (employee_id, branch_id, entry_id, period_label, payslip_no, kind, amount, payrolls, reason, status,
      requested_by, requested_by_name, requested_at, decided_by, decided_by_name, decided_at, decision_note, applied_incentive_id, applied_loan_id, history)
    VALUES (v_row.employee_id, v_entry.branch_id, v_entry.id, v_entry.pay_period, v_entry.payslip_no, v_kind, v_amount, 1, v_line, 'approved',
      p_reviewer, 'System (attendance correction)', NOW(), p_reviewer, p_reviewer_name, NOW(),
      format('Approved with attendance correction request %s', v_row.id), v_incentive, v_loan,
      jsonb_build_array(jsonb_build_object('action', 'approved', 'by', p_reviewer_name, 'at', NOW(), 'note', 'with the attendance correction request')))
    RETURNING id INTO v_pc;
  END IF;

  UPDATE public.attendance_corrections SET status = 'approved', resolution = 'corrected', approved_by = p_reviewer, approved_by_name = p_reviewer_name,
    approved_at = NOW(), review_note = NULLIF(trim(COALESCE(p_note, '')), ''), pay_effect = p_pay, pay_correction_id = v_pc, updated_at = NOW()
  WHERE id = p_correction_id RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.attendance_review_correction_v2(UUID, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
