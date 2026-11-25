-- ═══════════════════════════════════════════════════════════════════════════
-- Government loans + cash advance limit (2026-11-25, owner decisions).
--
-- The school does not lend. What comes off pay is a CASH ADVANCE (the school's,
-- limited by the salary) or a GOVERNMENT LOAN (SSS or Pag-IBIG, encoded by HR
-- from the agency's notice, never limited: the agencies set the amounts).
--
--  1. Two new kinds in payroll_loans (same deduction engine, balance and
--     repayment history): sss_loan, pagibig_loan, with the agency, the loan
--     kind, the agency reference number, notes and the notice file.
--     A duplicate (same employee, agency and reference number) is refused.
--     No amount cap on government loans (the ₱500,000 cap stays for the rest,
--     ₱50,000 for a cash advance).
--  2. No new school loans: the app can no longer create a salary loan,
--     emergency loan or "other" loan. The database's own functions still write
--     their recoveries ("other", owner role). Existing rows are untouched
--     (decision: the 2 live salary loans stay as they are, shown as
--     "Cash advance (legacy salary loan)").
--  3. Government loans: only HR (or the Super Admin) encodes one, never about
--     themselves.
--  4. The salary limit (20261126050000) applies to CASH ADVANCES ONLY: the
--     remaining principal of open cash advances + the new one ≤ the limit.
--     Not counted: government loans, subsidy advances and the cash advances a
--     subsidy excess was converted into, recoveries, legacy salary loans.
--
-- Additive: one wider check, five new nullable columns, one index, one trigger,
-- functions replaced. No stored loan, repayment or payslip is changed.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.payroll_loans DROP CONSTRAINT IF EXISTS payroll_loans_loan_type_check;
ALTER TABLE public.payroll_loans ADD CONSTRAINT payroll_loans_loan_type_check
  CHECK (loan_type IN ('salary_loan', 'cash_advance', 'emergency_loan', 'other', 'subsidy_advance', 'sss_loan', 'pagibig_loan'));

ALTER TABLE public.payroll_loans ADD COLUMN IF NOT EXISTS agency TEXT;
ALTER TABLE public.payroll_loans ADD COLUMN IF NOT EXISTS loan_kind TEXT;
ALTER TABLE public.payroll_loans ADD COLUMN IF NOT EXISTS reference_no TEXT;
ALTER TABLE public.payroll_loans ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.payroll_loans ADD COLUMN IF NOT EXISTS notice_path TEXT;

ALTER TABLE public.payroll_loans DROP CONSTRAINT IF EXISTS payroll_loans_government_chk;
ALTER TABLE public.payroll_loans ADD CONSTRAINT payroll_loans_government_chk CHECK (
  CASE
    WHEN loan_type = 'sss_loan' THEN agency = 'SSS' AND char_length(btrim(COALESCE(loan_kind, ''))) BETWEEN 2 AND 80
    WHEN loan_type = 'pagibig_loan' THEN agency = 'Pag-IBIG' AND char_length(btrim(COALESCE(loan_kind, ''))) BETWEEN 2 AND 80
    ELSE agency IS NULL AND loan_kind IS NULL AND reference_no IS NULL
  END
  AND (reference_no IS NULL OR reference_no ~ '^[A-Za-z0-9][A-Za-z0-9 ./-]{0,39}$')
  AND (notes IS NULL OR char_length(notes) <= 500)
  AND (notice_path IS NULL OR char_length(notice_path) <= 300)
);

-- The agencies set government loan amounts: no cap for them.
ALTER TABLE public.payroll_loans DROP CONSTRAINT IF EXISTS payroll_loans_principal_max;
ALTER TABLE public.payroll_loans ADD CONSTRAINT payroll_loans_principal_max CHECK (
  loan_type IN ('sss_loan', 'pagibig_loan')
  OR principal <= (CASE WHEN loan_type = 'cash_advance' THEN 50000 ELSE 500000 END)::NUMERIC
);

-- The same agency loan is encoded once.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_loans_government_reference_uniq
  ON public.payroll_loans (employee_id, agency, upper(btrim(reference_no)))
  WHERE loan_type IN ('sss_loan', 'pagibig_loan') AND reference_no IS NOT NULL;

-- What the app may create: a cash advance (Accountant) or a government loan (HR / Super Admin, never their own).
-- The database's own functions (owner role) are not affected: recoveries, subsidy conversions.
CREATE OR REPLACE FUNCTION public.payroll_loans_kind_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.loan_type IS NOT DISTINCT FROM OLD.loan_type THEN
    RETURN NEW;
  END IF;
  IF NEW.loan_type IN ('salary_loan', 'emergency_loan', 'other') THEN
    RAISE EXCEPTION 'loan_kind: The school does not give loans. Record a cash advance, or HR encodes an SSS or Pag-IBIG loan.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.loan_type IN ('sss_loan', 'pagibig_loan') THEN
    SELECT p.role::TEXT INTO v_role FROM public.profiles p WHERE p.id = NEW.created_by AND NOT COALESCE(p.archived, false);
    IF v_role IS NULL OR v_role NOT IN ('hr', 'super_admin') THEN
      RAISE EXCEPTION 'loan_kind: Only HR encodes a government loan.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_by = NEW.employee_id THEN
      RAISE EXCEPTION 'loan_kind: Nobody encodes a loan about themselves.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.payroll_loans_kind_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payroll_loans_kind_guard ON public.payroll_loans;
CREATE TRIGGER payroll_loans_kind_guard
  BEFORE INSERT OR UPDATE ON public.payroll_loans
  FOR EACH ROW EXECUTE FUNCTION public.payroll_loans_kind_guard();

-- ── The salary limit: cash advances only ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.loan_limit_counted_type(p_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT p_type = 'cash_advance'; $$;

-- Owed = the remaining principal of open cash advances, without the ones a subsidy
-- excess was converted into (subsidy items) and recoveries.
CREATE OR REPLACE FUNCTION public.loan_limit_overview(p_employee_ids UUID[], p_exclude UUID DEFAULT NULL)
RETURNS TABLE (employee_id UUID, monthly_basic NUMERIC, multiplier NUMERIC, loan_limit NUMERIC, owed NUMERIC, room NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ids AS (SELECT DISTINCT unnest(p_employee_ids) AS id),
  base AS (
    SELECT i.id,
           round(public.loan_limit_monthly_basis(i.id, (NOW() AT TIME ZONE 'Asia/Manila')::DATE), 2) AS monthly,
           public.loan_limit_multiplier() AS mult,
           COALESCE((SELECT SUM(public.loan_limit_remaining_principal(l.principal, l.interest_pct, l.remaining_balance)) FROM public.payroll_loans l
                      WHERE l.employee_id = i.id
                        AND public.loan_limit_counted_type(l.loan_type)
                        AND l.status <> 'paid'
                        AND l.approval_status IN ('pending', 'approved')
                        AND (p_exclude IS NULL OR l.id <> p_exclude)
                        AND NOT EXISTS (SELECT 1 FROM public.payroll_corrections pc WHERE pc.applied_loan_id = l.id)
                        AND NOT EXISTS (SELECT 1 FROM public.payroll_loans s WHERE s.converted_to_loan_id = l.id)), 0) AS owed
    FROM ids i)
  SELECT b.id, b.monthly, b.mult, round(b.monthly * b.mult, 2), round(b.owed, 2),
         round(b.monthly * b.mult - b.owed, 2)
  FROM base b;
$$;
REVOKE ALL ON FUNCTION public.loan_limit_overview(UUID[], UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loan_limit_overview(UUID[], UUID) TO service_role;

-- The same check as 20261126050000, in cash advance words.
CREATE OR REPLACE FUNCTION public.payroll_loans_salary_limit_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_app      BOOLEAN := current_user IN ('service_role', 'authenticated', 'anon');
  v_amount   NUMERIC;   -- what this cash advance adds to "owed": its amount (principal), never interest
  v_check    BOOLEAN := FALSE;
  v          RECORD;
  v_months   TEXT;
BEGIN
  IF NOT public.loan_limit_counted_type(NEW.loan_type) OR NEW.status = 'paid'
     OR NEW.approval_status NOT IN ('pending', 'approved') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND public.loan_limit_is_recovery(NEW.id) THEN
    RETURN NEW;   -- an overpayment recovery
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_check := v_app;   -- the database's own functions (subsidy conversion) are not checked
    v_amount := NEW.principal;
  ELSE
    v_amount := GREATEST(0, NEW.principal - (OLD.principal - public.loan_limit_remaining_principal(OLD.principal, OLD.interest_pct, OLD.remaining_balance)));
    v_check := (OLD.approval_status = 'pending' AND NEW.approval_status = 'approved')
            OR (OLD.approval_status = 'rejected')
            OR NEW.principal > OLD.principal
            OR NOT public.loan_limit_counted_type(OLD.loan_type);
  END IF;
  IF NOT v_check THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('loan_limit:' || NEW.employee_id::TEXT, 0));
  SELECT * INTO v FROM public.loan_limit_overview(ARRAY[NEW.employee_id], NEW.id);
  IF round(v.owed + v_amount, 2) > v.loan_limit THEN
    v_months := CASE WHEN v.multiplier = 1 THEN '1 month''s salary'
                     ELSE trim(to_char(v.multiplier, 'FM999990.##')) || ' months'' salary' END;
    RAISE EXCEPTION 'loan_limit: This cash advance would make the total ₱%, which is more than the limit of ₱% (%). The most that can be added is ₱%.',
      to_char(round(v.owed + v_amount, 2), 'FM999,999,990.00'), to_char(v.loan_limit, 'FM999,999,990.00'), v_months,
      to_char(GREATEST(0, v.room), 'FM999,999,990.00')
      USING ERRCODE = 'check_violation',
            DETAIL = json_build_object('amount', v_amount, 'loan_limit', v.loan_limit, 'owed', v.owed, 'room', GREATEST(0, v.room),
                                       'monthly_basic', v.monthly_basic, 'multiplier', v.multiplier)::TEXT;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.payroll_loans_salary_limit_guard() FROM PUBLIC, anon, authenticated;
