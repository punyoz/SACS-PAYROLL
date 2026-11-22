-- ═══════════════════════════════════════════════════════════════════════════
-- Part C (2026-11-22): substitute teaching by school employees, within
-- attendance and payroll only (no timetable, subjects or load models).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The branch Admin records a substitution (date, absent teacher, substitute,
-- time span, periods; class/section and subject are free text for the payslip
-- line and the report), from the suggested teachers (same level and branch,
-- tapped in that day, not on leave, under the weekly cap). HR approves (a
-- preset remark, Part H: decision_remark_audit on this table). Payroll pays
-- an approved one when the substitute's taps cover it
-- (src/lib/substitutions/pay.js). Additive.

CREATE TABLE IF NOT EXISTS public.substitutions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id           UUID REFERENCES public.branches(id),
  sub_date            DATE NOT NULL,
  absent_employee_id  UUID NOT NULL REFERENCES public.profiles(id),
  substitute_id       UUID NOT NULL REFERENCES public.profiles(id),
  start_time          TEXT NOT NULL CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time            TEXT NOT NULL CHECK (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND end_time > start_time),
  periods             INTEGER NOT NULL CHECK (periods BETWEEN 1 AND 10),
  class_section       TEXT CHECK (class_section IS NULL OR char_length(class_section) <= 80),
  subject             TEXT CHECK (subject IS NULL OR char_length(subject) <= 80),
  leave_request_id    TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_by          UUID,
  created_by_name     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by          UUID,
  decided_by_name     TEXT,
  decided_at          TIMESTAMPTZ,
  decision_note       TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (absent_employee_id <> substitute_id)
);
CREATE INDEX IF NOT EXISTS substitutions_date_idx ON public.substitutions (sub_date, branch_id);
CREATE INDEX IF NOT EXISTS substitutions_substitute_idx ON public.substitutions (substitute_id, sub_date);
-- One open or approved substitution per substitute and start time a day.
CREATE UNIQUE INDEX IF NOT EXISTS substitutions_one_slot ON public.substitutions (substitute_id, sub_date, start_time) WHERE status IN ('pending', 'approved');
ALTER TABLE public.substitutions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.substitutions FROM anon, authenticated;

DROP TRIGGER IF EXISTS substitutions_decision_remark ON public.substitutions;
CREATE TRIGGER substitutions_decision_remark AFTER INSERT OR UPDATE ON public.substitutions
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();

-- Settings, pending the school's policy manual.
INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'substitution', v.key, v.value, 'System'
FROM (VALUES ('substitution_rate_mode', 'fixed'), ('substitution_fixed_per_period', '150'), ('substitution_pct', '100'),
             ('substitution_cap_periods_week', '5'), ('standard_load_hours_week', '40')) v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'substitution' AND c.key = v.key);

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
    'payroll_monthly_incentives', 'payroll_deductions', 'payroll_contribution_amounts',
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
