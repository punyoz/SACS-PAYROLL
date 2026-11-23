-- ═══════════════════════════════════════════════════════════════════════════
-- Part E step 6 (2026-11-23): rule-based incentives wait for HR.
--
-- Perfect Attendance and the Early Bird winner were paid as soon as payroll
-- computed them. From automation.incentive_approval_from (a pay period start
-- date) the system still computes them per cutoff, but records each one here
-- as a recommendation and pays it only once HR approves (user decision
-- 2026-11-23). HR sees them with the other incentives (multi-select).
--   pending    computed, waiting for HR (not paid)
--   approved   HR approved: paid when the payslip is (re)computed
--   rejected   HR rejected with a reason: never paid for that period
--   withdrawn  a recompute no longer qualifies (e.g. a late day was added)
-- One row per employee, period and kind. Writes go through the service role
-- (the payroll route) and incentive_recommendation_decide() (HR). Additive.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.incentive_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  pay_period TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('perfect_attendance', 'early_bird')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  reasons JSONB NOT NULL DEFAULT '[]'::JSONB,
  -- The attendance days the computation read (a 2nd half reads its whole month): a change inside them
  -- withdraws a pending recommendation, or flags an approved one for HR (trigger below).
  window_start DATE,
  window_end DATE,
  needs_review TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_by_name TEXT,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, period_start, kind)
);
CREATE INDEX IF NOT EXISTS incentive_recommendations_period_idx ON public.incentive_recommendations (period_start, status);
CREATE INDEX IF NOT EXISTS incentive_recommendations_branch_idx ON public.incentive_recommendations (branch_id, status);
-- The attendance trigger looks recommendations up by employee (every attendance write).
CREATE INDEX IF NOT EXISTS incentive_recommendations_employee_idx ON public.incentive_recommendations (employee_id, status);

ALTER TABLE public.incentive_recommendations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.incentive_recommendations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.incentive_recommendations TO service_role;

-- The pay period the gate starts from (empty = off; rule-based incentives paid as before).
INSERT INTO public.system_config (section, key, value, updated_by)
VALUES ('automation', 'incentive_approval_from', '2026-11-16', 'System')
ON CONFLICT (section, key) DO NOTHING;

-- HR approves or rejects one pending recommendation. Never their own.
CREATE OR REPLACE FUNCTION public.incentive_recommendation_decide(p_actor UUID, p_id UUID, p_decision TEXT, p_note TEXT)
RETURNS TABLE (id UUID, employee_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_actor RECORD;
  v_row RECORD;
  v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  SELECT p.id, p.role::TEXT AS role, p.full_name, COALESCE(p.archived, false) AS archived INTO v_actor FROM public.profiles p WHERE p.id = p_actor;
  IF v_actor.id IS NULL OR v_actor.role <> 'hr' OR v_actor.archived THEN
    RAISE EXCEPTION 'forbidden: only HR approves or rejects incentive recommendations.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'invalid: the decision is approve or reject.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'reject' AND length(COALESCE(v_note, '')) < 5 THEN
    RAISE EXCEPTION 'invalid: give the reason for rejecting it (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.id, r.employee_id, r.status INTO v_row FROM public.incentive_recommendations r WHERE r.id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'not_found: no such recommendation.' USING ERRCODE = 'no_data_found'; END IF;
  IF v_row.employee_id = p_actor THEN
    RAISE EXCEPTION 'forbidden: your own incentive is decided by another HR officer.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'already_decided: it is already %.', v_row.status USING ERRCODE = 'unique_violation'; END IF;
  RETURN QUERY UPDATE public.incentive_recommendations r
    SET status = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
        decided_by = v_actor.id, decided_by_name = v_actor.full_name, decided_at = NOW(), decision_note = v_note, updated_at = NOW()
    WHERE r.id = p_id RETURNING r.id, r.employee_id, r.status;
END;
$$;
REVOKE ALL ON FUNCTION public.incentive_recommendation_decide(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.incentive_recommendation_decide(UUID, UUID, TEXT, TEXT) TO service_role;

-- Decision remarks are audited like the other HR decisions (Part H).
DROP TRIGGER IF EXISTS incentive_recommendations_decision_remark ON public.incentive_recommendations;
CREATE TRIGGER incentive_recommendations_decision_remark AFTER INSERT OR UPDATE ON public.incentive_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();

-- The backup lists the new table (from 20261124010000_automation_framework.sql, plus incentive_recommendations).
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
    -- possible device / data problem days (Part D, 20261123030000)
    'attendance_data_gaps', 'automation_actions',
    -- leave
    'leave_requests',
    -- overtime requests (Part B, 20261122010000)
    'overtime_requests',
    -- substitute teaching (Part C, 20261123020000)
    'substitutions',
    -- payroll
    'payroll_entries', 'payroll_records', 'payroll_runs', 'payroll_run_items', 'payroll_run_exclusions',
    'payroll_approval_history', 'payroll_corrections', 'payroll_final_overrides', 'payroll_review_flags',
    'payroll_tax_annualizations', 'payroll_bir_exports',
    -- final pay waiting for HR (20261120010000), added to the backup 2026-11-21
    'payroll_final_pay_submissions',
    -- loans, advances, incentives, subsidy, 13th month
    'payroll_loans', 'payroll_loan_payments', 'payroll_cash_advances', 'payroll_incentives',
    'payroll_monthly_incentives', 'incentive_recommendations', 'payroll_deductions', 'payroll_contribution_amounts',
    'payroll_subsidy_requests', 'payroll_subsidy_adjustments', 'payroll_subsidy_balances',
    'payroll_subsidy_settings', 'payroll_thirteenth_month',
    -- preset remarks for decisions (Part H, 20261122030000)
    'remark_presets',
    -- rates and settings
    'payroll_rate_configs', 'payroll_tax_brackets', 'payroll_sss_msc_brackets', 'payroll_schedule_settings',
    'payroll_setting_changes', 'payroll_window_enforcement', 'payroll_window_enforcement_changes', 'system_config',
    -- announcements, audit
    'branch_announcements', 'audit_logs'
  ]::text[];
$function$;

-- Attendance changed inside a recommendation's window (a correction, an override, leave, a new
-- absence) before the payslip is saved again: a PENDING one is withdrawn (the next save
-- recomputes it and records it again if it still qualifies; one row per employee, period and kind,
-- never a duplicate); an APPROVED one is not changed: HR is flagged to check it.
CREATE OR REPLACE FUNCTION public.incentive_recs_attendance_changed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_emp UUID := COALESCE(NEW.employee_id, OLD.employee_id);
  v_day DATE := COALESCE(NEW.log_date, OLD.log_date);
  r RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.time_in IS NOT DISTINCT FROM OLD.time_in
     AND NEW.time_out IS NOT DISTINCT FROM OLD.time_out AND NEW.late_minutes IS NOT DISTINCT FROM OLD.late_minutes
     AND NEW.undertime_minutes IS NOT DISTINCT FROM OLD.undertime_minutes AND NEW.log_date IS NOT DISTINCT FROM OLD.log_date THEN
    RETURN NULL;
  END IF;
  UPDATE public.incentive_recommendations
  SET status = 'withdrawn', updated_at = NOW(),
      reasons = reasons || to_jsonb(format('Withdrawn: attendance on %s changed; recomputed when the payslip is saved again', v_day))
  WHERE employee_id = v_emp AND status = 'pending'
    AND v_day BETWEEN COALESCE(window_start, period_start) AND COALESCE(window_end, period_end);
  FOR r IN SELECT i.id, i.kind, i.pay_period, i.branch_id, p.full_name FROM public.incentive_recommendations i
           JOIN public.profiles p ON p.id = i.employee_id
           WHERE i.employee_id = v_emp AND i.status = 'approved' AND i.needs_review IS NULL
             AND v_day BETWEEN COALESCE(i.window_start, i.period_start) AND COALESCE(i.window_end, i.period_end) LOOP
    UPDATE public.incentive_recommendations SET needs_review = format('Attendance on %s changed after HR approved it', v_day), updated_at = NOW() WHERE id = r.id;
    PERFORM public.automation_log('incentive_recommendations', 'attendance changed after a rule-based incentive was approved', 'flag',
      format('%s: %s for %s was approved, then attendance on %s changed. Check it before the payroll run.', r.full_name,
             CASE r.kind WHEN 'perfect_attendance' THEN 'Perfect Attendance' ELSE 'Early Bird' END, r.pay_period, to_char(v_day, 'Mon DD')),
      jsonb_build_object('code', 'incentive_attendance_changed', 'recommendation_id', r.id, 'log_date', v_day),
      v_emp, r.branch_id, 'incentive_recommendation', r.id::TEXT);
  END LOOP;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.incentive_recs_attendance_changed() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS attendance_logs_incentive_recs ON public.attendance_logs;
CREATE TRIGGER attendance_logs_incentive_recs AFTER INSERT OR UPDATE OR DELETE ON public.attendance_logs
  FOR EACH ROW EXECUTE FUNCTION public.incentive_recs_attendance_changed();

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'automation', 'paused_incentive_recommendations', 'false', 'System'
WHERE NOT EXISTS (SELECT 1 FROM public.system_config WHERE section = 'automation' AND key = 'paused_incentive_recommendations');
