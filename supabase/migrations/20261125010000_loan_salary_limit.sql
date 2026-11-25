-- ═══════════════════════════════════════════════════════════════════════════
-- Loan limit (2026-11-25): an employee cannot owe more on loans than their
-- salary. No other limit.
--
--   limit = monthly basic salary in force today × multiplier (default 1.0)
--   owed  = the amount still borrowed (remaining PRINCIPAL, never interest) of
--           every loan not paid, pending or approved (rejected ones do not count)
--   room  = limit − owed;  a new loan's amount borrowed (principal) must fit.
--
-- Remaining principal (decision 2026-11-25): a flat-interest loan repays
-- principal and interest pro-rata, so remaining principal = remaining balance
-- × principal ÷ total payable (= the remaining balance at 0% interest).
--
-- Counted and checked: salary loans, emergency loans and "other" loans the
-- Accountant files. Not counted, not checked: cash advances (their own
-- ₱50,000 cap, unchanged), subsidy advances (taken against the subsidy) and
-- overpayment recoveries (payroll_corrections.applied_loan_id: money the
-- school takes back, not a loan the employee took).
--
-- Checked by the database when a loan is
--   * created by the app (service_role / authenticated / anon),
--   * edited upward (more principal or interest, or changed into a counted type),
--   * approved by HR (pending → approved): a loan that fitted when filed but
--     no longer fits (salary lowered, another loan added) is refused then.
-- Loans already stored are never changed or recomputed; balances moving
-- because of repayments (or their reversal) are never checked.
--
-- Settings (pending policy manual), system_config section 'payroll':
--   loan_limit_basis       'basic_monthly'  (the only basis for now)
--   loan_limit_multiplier  '1.0'
-- Additive. Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'payroll', v.key, v.value, 'System (default, pending policy manual)'
FROM (VALUES ('loan_limit_basis', 'basic_monthly'), ('loan_limit_multiplier', '1.0')) v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'payroll' AND c.key = v.key);

-- The monthly basic salary in force on p_on (mirrors salaryOn, src/lib/employees/salary-history.js):
-- the newest change effective on or before the day; before the first change, its old salary;
-- with no change, the salary on record. Every employee is paid a monthly salary (pay rules).
CREATE OR REPLACE FUNCTION public.loan_limit_monthly_basis(p_employee UUID, p_on DATE)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT c.new_salary FROM public.employee_salary_changes c
      WHERE c.employee_id = p_employee AND c.effective_date <= p_on
      ORDER BY c.effective_date DESC, c.created_at DESC LIMIT 1),
    (SELECT c.old_salary FROM public.employee_salary_changes c
      WHERE c.employee_id = p_employee ORDER BY c.effective_date, c.created_at LIMIT 1),
    (SELECT p.basic_salary FROM public.profiles p WHERE p.id = p_employee),
    0)::NUMERIC;
$$;

CREATE OR REPLACE FUNCTION public.loan_limit_multiplier()
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_text TEXT;
  v NUMERIC;
BEGIN
  SELECT value INTO v_text FROM public.system_config WHERE section = 'payroll' AND key = 'loan_limit_multiplier';
  BEGIN
    v := NULLIF(btrim(COALESCE(v_text, '')), '')::NUMERIC;
  EXCEPTION WHEN others THEN v := NULL;
  END;
  RETURN CASE WHEN v IS NULL OR v <= 0 THEN 1.0 ELSE v END;
END;
$$;

-- The amount still borrowed on a loan: its remaining balance without the interest share.
CREATE OR REPLACE FUNCTION public.loan_limit_remaining_principal(p_principal NUMERIC, p_interest_pct NUMERIC, p_remaining NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN COALESCE(p_principal, 0) <= 0 THEN 0
              ELSE round(COALESCE(p_remaining, 0) * p_principal / (p_principal + round(p_principal * COALESCE(p_interest_pct, 0) / 100, 2)), 2) END;
$$;

-- Whether a loan type counts toward the limit (and is checked against it).
CREATE OR REPLACE FUNCTION public.loan_limit_counted_type(p_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT p_type IN ('salary_loan', 'emergency_loan', 'other'); $$;

-- Each employee's limit, what they owe and the room left. p_exclude leaves one
-- loan out of "owed" (the loan being approved or edited).
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
                        AND NOT EXISTS (SELECT 1 FROM public.payroll_corrections pc WHERE pc.applied_loan_id = l.id)), 0) AS owed
    FROM ids i)
  SELECT b.id, b.monthly, b.mult, round(b.monthly * b.mult, 2), round(b.owed, 2),
         round(b.monthly * b.mult - b.owed, 2)
  FROM base b;
$$;

REVOKE ALL ON FUNCTION public.loan_limit_monthly_basis(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loan_limit_remaining_principal(NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loan_limit_remaining_principal(NUMERIC, NUMERIC, NUMERIC) TO service_role;
REVOKE ALL ON FUNCTION public.loan_limit_multiplier() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loan_limit_overview(UUID[], UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loan_limit_monthly_basis(UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.loan_limit_multiplier() TO service_role;
GRANT EXECUTE ON FUNCTION public.loan_limit_overview(UUID[], UUID) TO service_role;

-- The check. BEFORE trigger named after payroll_loans_open (triggers fire in name
-- order), so NEW.remaining_balance of a new loan is already set.
-- Whether a loan is an overpayment recovery (definer: the trigger runs as the caller).
CREATE OR REPLACE FUNCTION public.loan_limit_is_recovery(p_loan UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.payroll_corrections pc WHERE pc.applied_loan_id = p_loan); $$;
REVOKE ALL ON FUNCTION public.loan_limit_is_recovery(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loan_limit_is_recovery(UUID) TO service_role;

-- SECURITY INVOKER on purpose (like payroll_adjustment_insert_guard): current_user is the app's
-- role for the app's writes, and the owner inside the database's own functions.
CREATE OR REPLACE FUNCTION public.payroll_loans_salary_limit_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_app      BOOLEAN := current_user IN ('service_role', 'authenticated', 'anon');
  v_amount   NUMERIC;   -- what this loan adds to "owed": its amount borrowed (principal), never interest
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
    -- Loans the app files. Recoveries are written by the database's own functions (owner role).
    v_check := v_app;
    v_amount := NEW.principal;
  ELSE
    -- Already repaid stays repaid: the loan adds its new principal less the principal already paid back.
    v_amount := GREATEST(0, NEW.principal - (OLD.principal - public.loan_limit_remaining_principal(OLD.principal, OLD.interest_pct, OLD.remaining_balance)));
    v_check := (OLD.approval_status = 'pending' AND NEW.approval_status = 'approved')
            OR (OLD.approval_status = 'rejected')
            OR NEW.principal > OLD.principal
            OR NOT public.loan_limit_counted_type(OLD.loan_type);
    -- Not checked: status changes (suspend / resume, paid ↔ active when a payslip's
    -- repayment is reversed) and balance moves -- they add nothing new to owe.
  END IF;
  IF NOT v_check THEN RETURN NEW; END IF;

  -- One check at a time per employee, so two loans filed together cannot both slip in.
  PERFORM pg_advisory_xact_lock(hashtextextended('loan_limit:' || NEW.employee_id::TEXT, 0));
  SELECT * INTO v FROM public.loan_limit_overview(ARRAY[NEW.employee_id], NEW.id);
  IF round(v.owed + v_amount, 2) > v.loan_limit THEN
    v_months := CASE WHEN v.multiplier = 1 THEN '1 month''s salary'
                     ELSE trim(to_char(v.multiplier, 'FM999990.##')) || ' months'' salary' END;
    RAISE EXCEPTION 'loan_limit: This loan would make the total ₱%, which is more than the limit of ₱% (%). The most that can be added is ₱%.',
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

DROP TRIGGER IF EXISTS payroll_loans_salary_limit ON public.payroll_loans;
CREATE TRIGGER payroll_loans_salary_limit
  BEFORE INSERT OR UPDATE ON public.payroll_loans
  FOR EACH ROW EXECUTE FUNCTION public.payroll_loans_salary_limit_guard();
