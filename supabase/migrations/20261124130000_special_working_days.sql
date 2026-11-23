-- ═══════════════════════════════════════════════════════════════════════════
-- Special working days (2026-11-23), e.g. Saturday classes or events. HR
-- declares a date for some branches and people, with hours and a pay type:
--   makeup  a regular working day: taps expected, Late / Absent rules apply,
--           no extra pay (the nightly close records Absent for no-shows)
--   extra   paid on top of the salary: daily rate × premium_pct / 100 (default
--           130), only for those who tapped in; nobody is Absent for missing it
-- Covered: all, Teaching, Non-Teaching, or chosen employees; in chosen
-- branches (empty = all). Others: nothing changes (no Absent).
--
-- REPLACES attendance_schedule_for (from 20261013010000): a covered employee
-- gets the day's hours, and a make-up day counts as a working day (all seven
-- weekdays in working_days for that date). Everything else is unchanged; the
-- rollback is scripts/rollback/rollback-special-working-days.sql.
-- Also fixes payslip lines: 'substitution' (Part C) and 'special_working_day'
-- are allowed line types (a substitution line was refused on save).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.special_working_days (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_date     DATE NOT NULL,
  branch_ids    UUID[] NOT NULL DEFAULT '{}',
  audience      TEXT NOT NULL CHECK (audience IN ('all', 'teaching', 'non_teaching', 'employees')),
  employee_ids  UUID[] NOT NULL DEFAULT '{}',
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  reason        TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300),
  pay_type      TEXT NOT NULL CHECK (pay_type IN ('makeup', 'extra')),
  premium_pct   NUMERIC(6, 2) NOT NULL DEFAULT 130 CHECK (premium_pct BETWEEN 100 AND 400),
  created_by    UUID,
  created_by_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at  TIMESTAMPTZ,
  cancelled_by_name TEXT,
  CHECK (end_time > start_time),
  CHECK (audience <> 'employees' OR cardinality(employee_ids) > 0)
);
CREATE INDEX IF NOT EXISTS special_working_days_date_idx ON public.special_working_days (work_date) WHERE cancelled_at IS NULL;
ALTER TABLE public.special_working_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.special_working_days FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.special_working_days TO service_role;

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'attendance', 'extra_working_day_pct', '130', 'System'
WHERE NOT EXISTS (SELECT 1 FROM public.system_config WHERE section = 'attendance' AND key = 'extra_working_day_pct');

-- The special working day covering this employee on this date (the latest declared), or nothing.
CREATE OR REPLACE FUNCTION public.special_working_day_for(p_employee UUID, p_branch UUID, p_day DATE)
RETURNS public.special_working_days
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT d.* FROM public.special_working_days d
  JOIN public.profiles p ON p.id = p_employee
  WHERE d.work_date = p_day AND d.cancelled_at IS NULL
    AND (cardinality(d.branch_ids) = 0 OR COALESCE(p_branch, p.branch_id) = ANY (d.branch_ids))
    AND CASE d.audience
          WHEN 'all' THEN TRUE
          WHEN 'teaching' THEN p.employee_type = 'Teaching'
          WHEN 'non_teaching' THEN p.employee_type = 'Non-Teaching'
          ELSE p_employee = ANY (d.employee_ids) END
  ORDER BY d.created_at DESC
  LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.special_working_day_for(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.special_working_day_for(UUID, UUID, DATE) TO service_role;

-- attendance_schedule_for: the special day first, then exactly as before.
CREATE OR REPLACE FUNCTION public.attendance_schedule_for(p_employee UUID, p_branch UUID, p_day DATE)
RETURNS TABLE (
  work_start    INTEGER,
  work_end      INTEGER,
  grace         NUMERIC,
  work_hours    NUMERIC,
  schedule_id   TEXT,
  working_days  SMALLINT[],
  source        TEXT,
  schedule_name TEXT,
  schedule_key  UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_key UUID;
  v_level TEXT;
  v_source TEXT;
  s public.work_schedules;
  b RECORD;
  sp public.special_working_days;
  base RECORD;
BEGIN
  -- A special working day (20261124130000): its hours; a make-up day is a working day.
  IF p_employee IS NOT NULL THEN
    sp := public.special_working_day_for(p_employee, p_branch, p_day);
    IF sp.id IS NOT NULL THEN
      SELECT * INTO base FROM public.attendance_schedule_base_for(p_employee, p_branch, p_day);
      work_start := EXTRACT(HOUR FROM sp.start_time)::INTEGER * 60 + EXTRACT(MINUTE FROM sp.start_time)::INTEGER;
      work_end := EXTRACT(HOUR FROM sp.end_time)::INTEGER * 60 + EXTRACT(MINUTE FROM sp.end_time)::INTEGER;
      grace := base.grace;
      work_hours := ROUND((work_end - work_start) / 60.0, 2);
      schedule_id := 'special_working_day:' || sp.id::TEXT;
      working_days := CASE WHEN sp.pay_type = 'makeup' THEN ARRAY[0, 1, 2, 3, 4, 5, 6]::SMALLINT[] ELSE base.working_days END;
      source := 'special_day';
      schedule_name := CASE WHEN sp.pay_type = 'makeup' THEN 'Make-up working day' ELSE 'Extra working day' END || ': ' || sp.reason;
      schedule_key := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM public.attendance_schedule_base_for(p_employee, p_branch, p_day);
END;
$$;

-- The schedule before special days (the old attendance_schedule_for, word for word).
CREATE OR REPLACE FUNCTION public.attendance_schedule_base_for(p_employee UUID, p_branch UUID, p_day DATE)
RETURNS TABLE (
  work_start    INTEGER,
  work_end      INTEGER,
  grace         NUMERIC,
  work_hours    NUMERIC,
  schedule_id   TEXT,
  working_days  SMALLINT[],
  source        TEXT,
  schedule_name TEXT,
  schedule_key  UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_key UUID;
  v_level TEXT;
  v_source TEXT;
  s public.work_schedules;
  b RECORD;
BEGIN
  IF p_employee IS NOT NULL THEN
    -- (1) The employee's own schedule.
    SELECT a.schedule_key INTO v_key
    FROM public.work_schedule_assignments a
    WHERE a.employee_id = p_employee AND a.effective_from <= p_day
    ORDER BY a.effective_from DESC, a.created_at DESC
    LIMIT 1;
    v_source := 'employee';

    -- (2) The schedule of the employee's level.
    IF v_key IS NULL THEN
      SELECT pr.employee_level INTO v_level FROM public.profiles pr WHERE pr.id = p_employee;
      IF v_level IS NOT NULL THEN
        SELECT a.schedule_key INTO v_key
        FROM public.work_schedule_assignments a
        WHERE a.employee_level = v_level AND a.effective_from <= p_day
        ORDER BY a.effective_from DESC, a.created_at DESC
        LIMIT 1;
        v_source := 'level';
      END IF;
    END IF;

    IF v_key IS NOT NULL THEN
      s := public.work_schedule_version_on(v_key, p_day);
      IF s.id IS NOT NULL AND NOT s.archived THEN
        work_start := EXTRACT(HOUR FROM s.work_start)::INTEGER * 60 + EXTRACT(MINUTE FROM s.work_start)::INTEGER;
        work_end := EXTRACT(HOUR FROM s.work_end)::INTEGER * 60 + EXTRACT(MINUTE FROM s.work_end)::INTEGER;
        grace := s.grace_minutes;
        work_hours := s.work_hours;
        schedule_id := 'work_schedule:' || s.schedule_key::TEXT;
        working_days := s.working_days;
        source := v_source;
        schedule_name := s.name;
        schedule_key := s.schedule_key;
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;
  END IF;

  -- (3) the branch schedule, (4) the default.
  SELECT * INTO b FROM public.attendance_policy_for(p_branch);
  work_start := b.work_start;
  work_end := b.work_end;
  grace := b.grace;
  work_hours := b.work_hours;
  schedule_id := b.schedule_id;
  working_days := NULL;
  source := CASE WHEN b.schedule_id = 'attendance' THEN 'default' ELSE 'branch' END;
  schedule_name := NULL;
  schedule_key := NULL;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.attendance_schedule_base_for(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_schedule_base_for(UUID, UUID, DATE) TO service_role;

-- Payslip line types: Part C's substitution and the extra working day.
ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_type_check;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_type_check CHECK (type = ANY (ARRAY[
  'early_bird', 'perfect_attendance', 'overtime', 'holiday_premium', 'incentive', 'overload', 'subsidy',
  'subsidy_adjustment', 'early_bird_incentive', 'year_end_tax_refund', 'leave_conversion',
  'substitution', 'special_working_day']));

-- The backup lists the new table (from 20261124080000_incentive_recommendations.sql, plus special_working_days).
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
    'payroll_monthly_incentives', 'incentive_recommendations', 'special_working_days', 'payroll_deductions', 'payroll_contribution_amounts',
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

-- Traceability (20261123070000 added 'substitution'): an extra-working-day line is traced to its declared day.
ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_traceable_chk;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_traceable_chk CHECK (
  is_override
  OR type = ANY (ARRAY['incentive', 'overload', 'subsidy', 'subsidy_adjustment', 'year_end_tax_refund', 'leave_conversion', 'substitution', 'special_working_day'])
  OR source_log_id IS NOT NULL
  OR COALESCE(array_length(source_log_ids, 1), 0) > 0);
