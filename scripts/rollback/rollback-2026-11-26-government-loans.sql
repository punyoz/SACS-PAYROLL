-- Rollback of 20261126060000_government_loans_cash_advance_limit.sql.
-- Run BEFORE scripts/rollback/rollback-2026-11-25-loan-limit.sql when both are rolled back.
-- Refuses (and changes nothing) once HR has encoded a government loan: a stored loan is never deleted.
-- Afterwards the 20261126050000 versions of the limit functions are put back (re-run that file's
-- function part, below), so the database is exactly as after 20261126050000.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payroll_loans WHERE loan_type IN ('sss_loan', 'pagibig_loan')) THEN
    RAISE EXCEPTION 'Government loans exist: this rollback would lose them. Nothing was changed.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS payroll_loans_kind_guard ON public.payroll_loans;
DROP FUNCTION IF EXISTS public.payroll_loans_kind_guard();
DROP INDEX IF EXISTS public.payroll_loans_government_reference_uniq;

ALTER TABLE public.payroll_loans DROP CONSTRAINT IF EXISTS payroll_loans_government_chk;
ALTER TABLE public.payroll_loans DROP CONSTRAINT IF EXISTS payroll_loans_principal_max;
ALTER TABLE public.payroll_loans ADD CONSTRAINT payroll_loans_principal_max
  CHECK (principal <= (CASE WHEN loan_type = 'cash_advance' THEN 50000 ELSE 500000 END)::NUMERIC);
ALTER TABLE public.payroll_loans DROP CONSTRAINT IF EXISTS payroll_loans_loan_type_check;
ALTER TABLE public.payroll_loans ADD CONSTRAINT payroll_loans_loan_type_check
  CHECK (loan_type IN ('salary_loan', 'cash_advance', 'emergency_loan', 'other', 'subsidy_advance'));

ALTER TABLE public.payroll_loans DROP COLUMN IF EXISTS notice_path;
ALTER TABLE public.payroll_loans DROP COLUMN IF EXISTS notes;
ALTER TABLE public.payroll_loans DROP COLUMN IF EXISTS reference_no;
ALTER TABLE public.payroll_loans DROP COLUMN IF EXISTS loan_kind;
ALTER TABLE public.payroll_loans DROP COLUMN IF EXISTS agency;

-- The 20261126050000 rule (salary, emergency and other loans counted).
CREATE OR REPLACE FUNCTION public.loan_limit_counted_type(p_type TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = public
AS $$ SELECT p_type IN ('salary_loan', 'emergency_loan', 'other'); $$;

-- On live, also remove the migration history row the apply created:
-- DELETE FROM supabase_migrations.schema_migrations WHERE version = '<version>' AND name = 'government_loans_cash_advance_limit';

COMMIT;
-- Then re-run supabase/migrations/20261126050000_loan_salary_limit.sql (CREATE OR REPLACE only, no data) to
-- restore its loan_limit_overview and payroll_loans_salary_limit_guard wording exactly.
