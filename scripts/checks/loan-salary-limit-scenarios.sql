-- Loan limit (20261125010000) scenarios. LOCAL DATABASE ONLY; everything is rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/checks/loan-salary-limit-scenarios.sql
-- Prints PASS lines; any failure raises and stops.
BEGIN;

CREATE TEMP TABLE t_ctx AS
SELECT
  (SELECT p.id FROM profiles p WHERE p.role = 'employee' AND NOT COALESCE(p.archived, false)
     AND NOT EXISTS (SELECT 1 FROM employee_salary_changes c WHERE c.employee_id = p.id)
   ORDER BY p.id LIMIT 1) AS emp,
  (SELECT p.id FROM profiles p WHERE p.role = 'hr' AND NOT COALESCE(p.archived, false) ORDER BY p.id LIMIT 1) AS hr;
GRANT SELECT ON t_ctx TO service_role;

-- A clean slate for the test employee: salary 20,000, no loans counted.
UPDATE profiles SET basic_salary = 20000 WHERE id = (SELECT emp FROM t_ctx);
SET LOCAL session_replication_role = replica;   -- leave existing loans out without triggers
UPDATE payroll_loans SET approval_status = 'rejected' WHERE employee_id = (SELECT emp FROM t_ctx);
SET LOCAL session_replication_role = origin;

CREATE OR REPLACE FUNCTION pg_temp.file_loan(p_amount NUMERIC, p_type TEXT DEFAULT 'salary_loan', p_interest NUMERIC DEFAULT 0)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  SET LOCAL ROLE service_role;
  INSERT INTO payroll_loans (employee_id, loan_type, date_granted, principal, interest_pct, number_of_payrolls, amortization, start_period, approval_status, created_by_name)
  VALUES ((SELECT emp FROM t_ctx), p_type, CURRENT_DATE, p_amount, p_interest, 6, ceil(p_amount * (1 + p_interest / 100) / 6 * 100) / 100,
          (date_trunc('month', CURRENT_DATE)::DATE + 15), 'pending', 'Scenario')
  RETURNING id INTO v;
  RESET ROLE;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.refused(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN check_violation THEN
  RESET ROLE;
  RETURN SQLERRM;
END $$;

DO $$
DECLARE
  a UUID; b UUID; c UUID; msg TEXT; v RECORD;
  emp UUID := (SELECT emp FROM t_ctx);
  hr UUID := (SELECT hr FROM t_ctx);
BEGIN
  IF emp IS NULL OR hr IS NULL THEN RAISE EXCEPTION 'No test employee / HR in the local database.'; END IF;

  SELECT * INTO v FROM loan_limit_overview(ARRAY[emp]);
  IF v.loan_limit <> 20000 OR v.owed <> 0 THEN RAISE EXCEPTION 'overview: % %', v.loan_limit, v.owed; END IF;
  RAISE NOTICE 'PASS limit = 1.0 x monthly basic (20,000), owed 0';

  a := pg_temp.file_loan(5000);
  RAISE NOTICE 'PASS below the limit allowed (5,000)';
  b := pg_temp.file_loan(15000);
  RAISE NOTICE 'PASS exactly at the limit allowed (5,000 pending + 15,000 = 20,000): a pending loan counts';
  SET LOCAL session_replication_role = replica;   -- set it aside (no hard delete on loans)
  UPDATE payroll_loans SET approval_status = 'rejected' WHERE id = b;
  SET LOCAL session_replication_role = origin;

  msg := pg_temp.refused('SELECT pg_temp.file_loan(15001)');
  IF msg IS NULL OR msg NOT LIKE 'loan_limit:%' THEN RAISE EXCEPTION 'one peso above was allowed'; END IF;
  RAISE NOTICE 'PASS one peso above refused: %', msg;

  msg := pg_temp.refused('SELECT pg_temp.file_loan(14000, ''salary_loan'', 10)');
  IF msg IS NULL THEN RAISE EXCEPTION 'interest not counted'; END IF;
  RAISE NOTICE 'PASS interest counts (14,000 + 10%% = 15,400 > room 15,000)';

  -- Cash advance: not counted, not checked (its own cap).
  c := pg_temp.file_loan(16000, 'cash_advance');
  RAISE NOTICE 'PASS cash advance not limited (16,000 filed with 5,000 owed)';

  -- A paid loan no longer counts.
  SET LOCAL session_replication_role = replica;
  UPDATE payroll_loans SET status = 'paid', remaining_balance = 0 WHERE id = a;
  SET LOCAL session_replication_role = origin;
  b := pg_temp.file_loan(20000);
  RAISE NOTICE 'PASS a paid loan no longer counts (20,000 allowed after the 5,000 was paid)';

  -- Approval re-checks: salary lowered after filing -> refused at approval.
  UPDATE profiles SET basic_salary = 19000 WHERE id = emp;
  msg := pg_temp.refused(format('SELECT * FROM payroll_adjustment_decide(%L, ''loan'', %L, ''approve'', NULL)', hr, b));
  IF msg IS NULL OR msg NOT LIKE 'loan_limit:%' THEN RAISE EXCEPTION 'approval after a salary cut was allowed'; END IF;
  IF (SELECT approval_status FROM payroll_loans WHERE id = b) <> 'pending' THEN RAISE EXCEPTION 'loan changed'; END IF;
  RAISE NOTICE 'PASS approval refused when the loan no longer fits (salary now 19,000): %', msg;

  UPDATE profiles SET basic_salary = 20000 WHERE id = emp;
  PERFORM * FROM payroll_adjustment_decide(hr, 'loan', b, 'approve', NULL);
  RAISE NOTICE 'PASS approval allowed when it fits';

  -- Two loans that together exceed: the second is refused.
  msg := pg_temp.refused('SELECT pg_temp.file_loan(1)');
  IF msg IS NULL THEN RAISE EXCEPTION 'second loan over the limit was allowed'; END IF;
  RAISE NOTICE 'PASS second loan over the limit refused';

  -- Upward edit refused; status change and balance moves are not checked.
  msg := pg_temp.refused(format('UPDATE payroll_loans SET principal = 20001 WHERE id = %L', b));
  IF msg IS NULL THEN RAISE EXCEPTION 'upward edit allowed'; END IF;
  RAISE NOTICE 'PASS upward edit refused';
  UPDATE profiles SET basic_salary = 1000 WHERE id = emp;   -- now far over: stored loans stay as they are
  UPDATE payroll_loans SET status = 'suspended', status_reason = 'scenario' WHERE id = b;
  UPDATE payroll_loans SET status = 'active' WHERE id = b;
  RAISE NOTICE 'PASS existing loan over a lowered limit is untouched; suspend / resume not blocked';

  -- An overpayment recovery (DB function, owner role) is not limited.
  INSERT INTO payroll_loans (employee_id, loan_type, description, date_granted, principal, interest_pct, number_of_payrolls, amortization, start_period, remaining_balance, status, created_by_name)
  VALUES (emp, 'other', 'Overpayment recovery (scenario)', CURRENT_DATE, 5000, 0, 1, 5000, date_trunc('month', CURRENT_DATE)::DATE + 15, 5000, 'active', 'System');
  RAISE NOTICE 'PASS database-written recovery not limited';
END $$;

ROLLBACK;
