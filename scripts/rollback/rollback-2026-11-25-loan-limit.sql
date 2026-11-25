-- Rollback of 20261125010000_loan_salary_limit.sql (loan salary limit).
-- Removes the check (trigger + functions) and its two settings rows. Touches no
-- stored loan, repayment or payslip. The app keeps working without it: the
-- limit numbers are simply not shown and nothing is checked (loadLoanLimits
-- answers available: false when loan_limit_overview is missing).
-- Tested on the local copy 2026-11-25 (apply -> rollback -> re-apply; loans unchanged).
BEGIN;

DROP TRIGGER IF EXISTS payroll_loans_salary_limit ON public.payroll_loans;
DROP FUNCTION IF EXISTS public.payroll_loans_salary_limit_guard();
DROP FUNCTION IF EXISTS public.loan_limit_overview(UUID[], UUID);
DROP FUNCTION IF EXISTS public.loan_limit_is_recovery(UUID);
DROP FUNCTION IF EXISTS public.loan_limit_counted_type(TEXT);
DROP FUNCTION IF EXISTS public.loan_limit_remaining_principal(NUMERIC, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS public.loan_limit_multiplier();
DROP FUNCTION IF EXISTS public.loan_limit_monthly_basis(UUID, DATE);

DELETE FROM public.system_config WHERE section = 'payroll' AND key IN ('loan_limit_basis', 'loan_limit_multiplier');

-- On live, also remove the migration history row the apply created (its version is the one the apply returned):
-- DELETE FROM supabase_migrations.schema_migrations WHERE version = '<version>' AND name = 'loan_salary_limit';

COMMIT;
