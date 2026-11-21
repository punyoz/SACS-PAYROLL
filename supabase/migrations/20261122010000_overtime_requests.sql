-- Part B, step 1 (2026-11-22): overtime is requested ahead, like leave.
--
-- An employee files an overtime request (date, planned start and end, hours,
-- reason); HR approves or rejects it. Only an approved request pays: the paid
-- minutes are the smaller of the approved minutes and the minutes actually
-- worked past the employee's own shift end (the time-out tap), written into
-- public.attendance_overtime_approvals, which payroll already pays from
-- (approved_minutes <= overtime_minutes is that table's own rule). The sync
-- runs when HR approves and again whenever that day's time out is recorded.
--
-- The limits are settings (system_config, section 'requests'), defaults
-- pending policy manual. The server enforces them; this table keeps a filed
-- request's date and hours fixed and its decision final.

CREATE TABLE IF NOT EXISTS public.overtime_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      UUID NOT NULL REFERENCES public.profiles(id),
  branch_id        UUID REFERENCES public.branches(id),
  request_date     DATE NOT NULL,
  planned_start    TIME NOT NULL,
  planned_end      TIME NOT NULL,
  minutes          INT NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  reason           TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  late_filing      BOOLEAN NOT NULL DEFAULT FALSE,
  prepared         JSONB NOT NULL DEFAULT '{}'::jsonb,
  filed_by         UUID REFERENCES public.profiles(id),
  filed_by_name    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by       UUID REFERENCES public.profiles(id),
  decided_by_name  TEXT,
  decided_at       TIMESTAMPTZ,
  decision_note    TEXT CHECK (decision_note IS NULL OR char_length(decision_note) <= 300),
  cancelled_at     TIMESTAMPTZ,
  CHECK (planned_end > planned_start),
  CHECK (status <> 'rejected' OR char_length(btrim(coalesce(decision_note, ''))) > 0)
);

-- One open request per employee and day (refuses duplicates and overlaps).
CREATE UNIQUE INDEX IF NOT EXISTS overtime_requests_one_per_day
  ON public.overtime_requests (employee_id, request_date) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS overtime_requests_status_date ON public.overtime_requests (status, request_date);

-- Server routes only (service role); no client reads or writes.
ALTER TABLE public.overtime_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.overtime_requests FROM PUBLIC, anon, authenticated;

-- A filed request keeps its date and hours; once decided or cancelled it is final; never deleted.
CREATE OR REPLACE FUNCTION public.overtime_requests_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An overtime request is never deleted. Cancel it instead.';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'This overtime request is already %. It cannot change.', OLD.status;
  END IF;
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.request_date IS DISTINCT FROM OLD.request_date
     OR NEW.minutes IS DISTINCT FROM OLD.minutes OR NEW.planned_start IS DISTINCT FROM OLD.planned_start
     OR NEW.planned_end IS DISTINCT FROM OLD.planned_end THEN
    RAISE EXCEPTION 'A filed overtime request keeps its date and hours. Cancel it and file a new one.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS overtime_requests_guard ON public.overtime_requests;
CREATE TRIGGER overtime_requests_guard
  BEFORE UPDATE OR DELETE ON public.overtime_requests
  FOR EACH ROW EXECUTE FUNCTION public.overtime_requests_guard();

-- The approved request's pay for one employee and day: the smaller of the
-- approved minutes and the minutes past the shift end, into the approvals
-- payroll reads. An approval HR made directly on the day (older flow) is kept
-- unless the request pays more.
CREATE OR REPLACE FUNCTION public.overtime_request_sync(p_employee UUID, p_day DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.overtime_requests;
  l public.attendance_logs;
  v_end INT;
  v_actual INT;
BEGIN
  SELECT * INTO r FROM public.overtime_requests
   WHERE employee_id = p_employee AND request_date = p_day AND status = 'approved' LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO l FROM public.attendance_logs
   WHERE employee_id = p_employee AND log_date = p_day AND time_out IS NOT NULL
   ORDER BY time_out DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT s.work_end INTO v_end FROM public.attendance_schedule_for(p_employee, l.branch_id, p_day) s;
  IF v_end IS NULL THEN RETURN; END IF;
  v_actual := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (l.time_out - ((p_day + make_interval(mins => v_end)) AT TIME ZONE 'Asia/Manila'))) / 60))::INT;
  INSERT INTO public.attendance_overtime_approvals
    (log_id, employee_id, branch_id, log_date, overtime_minutes, approved_minutes, status, note, decided_by, decided_by_name, decided_at)
  VALUES (l.id, p_employee, l.branch_id, p_day, v_actual, LEAST(r.minutes, v_actual), 'approved',
          'Overtime request ' || r.id, r.decided_by, r.decided_by_name, coalesce(r.decided_at, NOW()))
  ON CONFLICT (log_id) DO UPDATE
    SET overtime_minutes = EXCLUDED.overtime_minutes, approved_minutes = EXCLUDED.approved_minutes, status = 'approved',
        note = EXCLUDED.note, decided_by = EXCLUDED.decided_by, decided_by_name = EXCLUDED.decided_by_name, decided_at = EXCLUDED.decided_at
    WHERE public.attendance_overtime_approvals.note LIKE 'Overtime request %'
       OR public.attendance_overtime_approvals.approved_minutes < EXCLUDED.approved_minutes;
END;
$$;

CREATE OR REPLACE FUNCTION public.overtime_request_sync_on_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    PERFORM public.overtime_request_sync(NEW.employee_id, NEW.request_date);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS overtime_requests_sync ON public.overtime_requests;
CREATE TRIGGER overtime_requests_sync
  AFTER UPDATE OF status ON public.overtime_requests
  FOR EACH ROW EXECUTE FUNCTION public.overtime_request_sync_on_decision();

CREATE OR REPLACE FUNCTION public.overtime_request_sync_on_tap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.time_out IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.overtime_requests
     WHERE employee_id = NEW.employee_id AND request_date = NEW.log_date AND status = 'approved') THEN
    PERFORM public.overtime_request_sync(NEW.employee_id, NEW.log_date);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS attendance_logs_overtime_request_sync ON public.attendance_logs;
CREATE TRIGGER attendance_logs_overtime_request_sync
  AFTER INSERT OR UPDATE OF time_out ON public.attendance_logs
  FOR EACH ROW EXECUTE FUNCTION public.overtime_request_sync_on_tap();

REVOKE ALL ON FUNCTION public.overtime_requests_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.overtime_request_sync(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.overtime_request_sync_on_decision() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.overtime_request_sync_on_tap() FROM PUBLIC, anon, authenticated;

-- Settings, defaults pending policy manual (Part B).
INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'requests', v.key, v.value, 'System'
FROM (VALUES ('overtime_max_hours_day', '3'), ('overtime_max_hours_cutoff', '10'),
             ('file_days_before', '1'), ('late_filing_days_after', '2')) v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'requests' AND c.key = v.key);

-- In the Super Admin's backup (tests/backup-allow-list.test.js keeps the app's list and this one equal).
CREATE OR REPLACE FUNCTION public.backup_export_tables()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    -- users, employees, branches, roles
    'profiles', 'branches', 'role_permissions', 'employee_branch_assignments', 'branch_admin_requests',
    'employee_salary_changes', 'employee_status_changes', 'employee_awol_cases',
    'employee_license_changes', 'employee_license_alerts', 'employee_license_documents',
    'tenure_protection_policies', 'tenure_protection_grants', 'tenure_protection_applications',
    'rfid_cards', 'rfid_card_events', 'rfid_terminals', 'transfer_requests',
    -- the positions list (20261109050000), added to the backup 2026-11-15
    'employee_positions',
    -- Part A (20261121010000): classification history, HR reminders, leave and pay rules
    'employee_classification_changes', 'employee_hr_reminders', 'leave_credit_rules', 'leave_credit_overrides',
    'statutory_leave_types', 'employee_pay_rules',
    'work_schedules', 'work_schedule_assignments',
    -- attendance
    'attendance_logs', 'attendance_logs_history', 'attendance_corrections', 'attendance_overtime_approvals',
    'attendance_blocked_taps', 'attendance_taps', 'attendance_holidays', 'school_break_periods',
    'holiday_duty_assignments', 'holiday_duty_history', 'holiday_work_reviews', 'early_bird_winners',
    -- leave
    'leave_requests',
    -- overtime requests (Part B, 20261122010000)
    'overtime_requests',
    -- payroll
    'payroll_entries', 'payroll_records', 'payroll_runs', 'payroll_run_items', 'payroll_run_exclusions',
    'payroll_approval_history', 'payroll_corrections', 'payroll_final_overrides', 'payroll_review_flags',
    'payroll_tax_annualizations', 'payroll_bir_exports',
    -- final pay waiting for HR (20261120010000), added to the backup 2026-11-21
    'payroll_final_pay_submissions',
    -- loans, advances, incentives, subsidy, 13th month
    'payroll_loans', 'payroll_loan_payments', 'payroll_cash_advances', 'payroll_incentives',
    'payroll_monthly_incentives', 'payroll_deductions', 'payroll_contribution_amounts',
    'payroll_subsidy_requests', 'payroll_subsidy_adjustments', 'payroll_subsidy_balances',
    'payroll_subsidy_settings', 'payroll_thirteenth_month',
    -- rates and settings
    'payroll_rate_configs', 'payroll_tax_brackets', 'payroll_sss_msc_brackets', 'payroll_schedule_settings',
    'payroll_setting_changes', 'payroll_window_enforcement', 'payroll_window_enforcement_changes', 'system_config',
    -- announcements, audit
    'branch_announcements', 'audit_logs'
  ]::text[];
$function$;
