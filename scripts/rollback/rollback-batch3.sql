-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK for Batch 3 (migrations 20261124010000-140000). Written 2026-11-24 from LIVE's own
-- definitions (read-only) before the release. Run only if the release must be undone; the code
-- rollback is promoting the previous Vercel deploy.
--  1. The 5 live functions Batch 3 replaces, exactly as live had them.
--  2. The bonus ledger view as live had it.
--  3. The new triggers on existing tables dropped (attendance, overtime, substitutions, AWOL).
--  4. The new nightly jobs unscheduled.
--  5. The profiles.employment_type default removed (live had none); HR's correction permission back.
--  6. The changed leave-credit defaults back to 5 / 5 (only the untouched defaults).
-- Kept (additive, harmless to the old code): new tables, columns, functions, widened checks and the
-- migration history rows. To also forget the migrations:
--   DELETE FROM supabase_migrations.schema_migrations WHERE version >= '20261124010000';
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

-- 1. Functions
-- apply_transfer_request_approval
CREATE OR REPLACE FUNCTION public.apply_transfer_request_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.reviewed_at := NOW();

    UPDATE public.profiles
    SET branch_id = NEW.to_branch_id, updated_at = NOW()
    WHERE id = NEW.employee_id;
  END IF;

  RETURN NEW;
END;
$function$;

-- attendance_schedule_for
CREATE OR REPLACE FUNCTION public.attendance_schedule_for(p_employee uuid, p_branch uuid, p_day date)
 RETURNS TABLE(work_start integer, work_end integer, grace numeric, work_hours numeric, schedule_id text, working_days smallint[], source text, schedule_name text, schedule_key uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- employee_probation_end
CREATE OR REPLACE FUNCTION public.employee_probation_end(p_employee uuid)
 RETURNS date
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (COALESCE(
      (SELECT MAX(c.effective_on) FROM public.employee_classification_changes c
       WHERE c.employee_id = p.id AND c.field = 'employment_status' AND c.new_value = 'Probationary' AND c.cancelled_at IS NULL),
      p.date_hired, p.created_at::DATE)
    + make_interval(months => COALESCE((SELECT NULLIF(value, '')::INTEGER FROM public.system_config WHERE section = 'hr' AND key = 'probation_months'), 6)))::DATE
  FROM public.profiles p
  WHERE p.id = p_employee AND p.employment_status = 'Probationary';
$function$;

-- employee_hr_reminders_run
CREATE OR REPLACE FUNCTION public.employee_hr_reminders_run(p_today date DEFAULT ((now() AT TIME ZONE 'Asia/Manila'::text))::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prob_days INTEGER := COALESCE((SELECT NULLIF(value, '')::INTEGER FROM public.system_config WHERE section = 'hr' AND key = 'probation_reminder_days'), 30);
  v_contract_days INTEGER := COALESCE((SELECT NULLIF(value, '')::INTEGER FROM public.system_config WHERE section = 'hr' AND key = 'contract_reminder_days'), 30);
  v_count INTEGER;
BEGIN
  WITH due AS (
    SELECT p.id, p.full_name, 'probation_end'::TEXT AS kind, public.employee_probation_end(p.id) AS due_on
    FROM public.profiles p
    WHERE p.employment_status = 'Probationary' AND NOT COALESCE(p.archived, FALSE) AND p.on_payroll
    UNION ALL
    SELECT p.id, p.full_name, 'contract_end', p.contract_end_date
    FROM public.profiles p
    WHERE p.contract_end_date IS NOT NULL AND NOT COALESCE(p.archived, FALSE) AND p.on_payroll
  ), fresh AS (
    INSERT INTO public.employee_hr_reminders (employee_id, kind, due_on)
    SELECT d.id, d.kind, d.due_on FROM due d
    WHERE d.due_on IS NOT NULL AND d.due_on >= p_today
      AND d.due_on <= p_today + CASE WHEN d.kind = 'probation_end' THEN v_prob_days ELSE v_contract_days END
    ON CONFLICT DO NOTHING
    RETURNING employee_id, kind, due_on
  ), sent AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT hr.id, 'hr_reminder',
      CASE f.kind WHEN 'probation_end' THEN 'Probation ends soon' ELSE 'Contract ends soon' END,
      (SELECT full_name FROM public.profiles WHERE id = f.employee_id)
        || CASE f.kind WHEN 'probation_end' THEN ' completes the probation on ' ELSE '''s contract ends on ' END
        || to_char(f.due_on, 'FMMonth FMDD, YYYY') || '. Decide the next status before then.',
      'hr-employees'
    FROM fresh f
    CROSS JOIN public.profiles hr
    WHERE lower(hr.role::TEXT) = 'hr' AND NOT COALESCE(hr.archived, FALSE)
      AND COALESCE(hr.employee_status, 'Active') NOT IN ('Inactive', 'Archived', 'Separated')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM fresh;
  RETURN v_count;
END;
$function$;

-- backup_export_tables
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
    'attendance_data_gaps',
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

-- 2. View
CREATE OR REPLACE VIEW public.payroll_exempt_benefits_paid WITH (security_invoker = true) AS
 SELECT t.employee_id,
    t.year AS tax_year,
    'thirteenth_month'::text AS kind,
    t.amount,
    t.processed_at::date AS paid_on
   FROM payroll_thirteenth_month t
UNION ALL
 SELECT l.employee_id,
    EXTRACT(year FROM l.date_granted)::integer AS tax_year,
    'subsidy_advance'::text AS kind,
    l.principal AS amount,
    l.date_granted AS paid_on
   FROM payroll_loans l
     JOIN payroll_subsidy_balances b ON b.id = l.subsidy_balance_id
  WHERE l.loan_type = 'subsidy_advance'::text AND b.tax_treatment = 'other_benefit'::text
UNION ALL
 SELECT b.employee_id,
    EXTRACT(year FROM b.paid_out_on)::integer AS tax_year,
    'subsidy_payout'::text AS kind,
    b.paid_out AS amount,
    b.paid_out_on AS paid_on
   FROM payroll_subsidy_balances b
  WHERE b.paid_out > 0::numeric AND b.paid_out_on IS NOT NULL AND b.tax_treatment = 'other_benefit'::text
UNION ALL
 SELECT a.employee_id,
    EXTRACT(year FROM a.applied_at)::integer AS tax_year,
    'subsidy_adjustment'::text AS kind,
    a.amount,
    a.applied_at::date AS paid_on
   FROM payroll_subsidy_adjustments a
     JOIN payroll_subsidy_balances b ON b.id = a.subsidy_balance_id
  WHERE a.status = 'applied'::text AND b.tax_treatment = 'other_benefit'::text
UNION ALL
 SELECT e.employee_id,
    EXTRACT(year FROM x.period_end)::integer AS tax_year,
    'bonus'::text AS kind,
    x.amount,
    x.period_end AS paid_on
   FROM payroll_entries e
     CROSS JOIN LATERAL ( SELECT NULLIF(((e.payroll -> 'audit'::text) -> 'period'::text) ->> 'end_key'::text, ''::text)::date AS period_end,
            NULLIF(((e.payroll -> 'audit'::text) -> 'period'::text) ->> 'start_key'::text, ''::text)::date AS period_start,
            COALESCE(((e.payroll -> 'totals'::text) ->> 'early_bird_winner_incentive'::text)::numeric, 0::numeric) + COALESCE(((e.payroll -> 'totals'::text) ->> 'perfect_attendance_incentive'::text)::numeric, 0::numeric) AS amount) x
  WHERE e.status = 'paid'::payroll_state AND x.period_end IS NOT NULL AND x.period_start >= '2026-10-01'::date AND x.amount > 0::numeric;

-- 3. Triggers on existing tables
DROP TRIGGER IF EXISTS attendance_logs_incentive_recs ON public.attendance_logs;
DROP TRIGGER IF EXISTS overtime_requests_track ON public.overtime_requests;
DROP TRIGGER IF EXISTS substitutions_track ON public.substitutions;
DROP TRIGGER IF EXISTS employee_awol_cases_track ON public.employee_awol_cases;

-- 4. Nightly jobs
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid, jobname FROM cron.job WHERE jobname IN
    ('automation-attendance-flags', 'automation-daily', 'automation-rfid-issues', 'automation-schedule-checks', 'transfer-apply-due') LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

-- 5. Default and permission
ALTER TABLE public.profiles ALTER COLUMN employment_type DROP DEFAULT;
UPDATE public.role_permissions SET can_create = FALSE WHERE role = 'hr' AND module = 'attendance_corrections';

-- 6. Leave-credit defaults back (untouched defaults only)
UPDATE public.leave_credit_rules SET days_per_year = 5
WHERE note = 'Default: pending policy manual' AND created_by_name = 'System'
  AND leave_type IN ('Vacation Leave', 'Sick Leave') AND employment_status IN ('Probationary', 'Contractual');

COMMIT;
