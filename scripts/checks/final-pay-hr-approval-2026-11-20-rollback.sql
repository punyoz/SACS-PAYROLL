-- Rollback of supabase/migrations/20261120010000_final_pay_hr_approval.sql.
-- The migration changed no existing row (it only added rows to its own
-- table), so dropping what it created restores the database. Final payslips
-- approved through it stay as ordinary Final payslips (the approver stays in
-- each payslip's payroll.final_pay.approval; re-applying the migration reads
-- it back).
--
-- One transaction: it refuses, and changes nothing, while a final pay is
-- still pending (its hold would vanish and the Accountant's computation would
-- never be written): decide those first.
\set ON_ERROR_STOP on
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.payroll_final_pay_submissions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.payroll_final_pay_submissions WHERE status = 'pending') THEN
      RAISE EXCEPTION 'A final pay is pending HR approval: approve or reject it before rolling back.';
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS payroll_loan_payments_a0_final_pay_hold ON public.payroll_loan_payments;
DROP TRIGGER IF EXISTS payroll_loans_a0_final_pay_hold ON public.payroll_loans;
DROP TRIGGER IF EXISTS payroll_subsidy_balances_a0_final_pay_hold ON public.payroll_subsidy_balances;
DROP TRIGGER IF EXISTS payroll_thirteenth_month_a0_final_pay_hold ON public.payroll_thirteenth_month;
DROP TRIGGER IF EXISTS payroll_entries_a0_final_pay_hold ON public.payroll_entries;
DROP FUNCTION IF EXISTS public.payroll_final_pay_decide(UUID, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS private.final_pay_needs_fallback(UUID);
DROP FUNCTION IF EXISTS public.payroll_final_pay_hold();
DROP FUNCTION IF EXISTS private.final_pay_releasing();
DROP TABLE IF EXISTS public.payroll_final_pay_submissions;
DROP FUNCTION IF EXISTS public.payroll_final_pay_submissions_lock();
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261120010000';

COMMIT;
