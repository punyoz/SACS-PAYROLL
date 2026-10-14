-- ═══════════════════════════════════════════════════════════════════════════
-- Explicit "no client access" policies on the server-only tables
-- ═══════════════════════════════════════════════════════════════════════════
--
-- From the Supabase security advisor (rls_enabled_no_policy), health check of
-- Oct 14, 2026. These 31 tables have Row Level Security on and no policy:
-- only the API routes (service role, which bypasses RLS) and the database's
-- own functions read or write them. anon / authenticated hold no privileges
-- on them either (20261012020000_revoke_authenticated_table_reads.sql), none
-- forces RLS on its owner, and none is published to Realtime.
--
-- A table with RLS and no policy already refuses every client row. This
-- states that rule as a policy, so the intent is visible in the schema and
-- the advisor stops reporting it. Behaviour does not change for anyone:
--   * anon / authenticated: still nothing (USING / WITH CHECK false);
--   * service_role and the table owner (functions, triggers, pg_cron): the
--     policy is only TO anon, authenticated, and they bypass RLS anyway.
--
-- Safe to run more than once.

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'attendance_blocked_taps', 'attendance_corrections', 'attendance_holidays',
    'attendance_logs_history', 'attendance_overtime_approvals', 'attendance_taps',
    'auth_email_otps', 'auth_throttle', 'early_bird_winners', 'employee_awol_cases',
    'employee_license_alerts', 'employee_license_changes', 'employee_license_documents',
    'employee_status_changes', 'payroll_cash_advances', 'payroll_contribution_amounts',
    'payroll_deductions', 'payroll_incentives', 'payroll_loan_payments', 'payroll_loans',
    'payroll_monthly_incentives', 'payroll_rate_configs', 'payroll_schedule_settings',
    'payroll_setting_changes', 'payroll_subsidy_adjustments', 'payroll_subsidy_balances',
    'payroll_subsidy_settings', 'payroll_tax_brackets', 'payroll_thirteenth_month',
    'work_schedule_assignments', 'work_schedules'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table AND policyname = v_table || '_no_client_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
        v_table || '_no_client_access', v_table
      );
    END IF;
  END LOOP;
END $$;
