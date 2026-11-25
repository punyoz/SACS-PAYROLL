-- Cash advance limit + government loans (20261126050000 + 20261126060000). LOCAL DATABASE ONLY; all rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/checks/loan-salary-limit-scenarios.sql
-- Prints PASS lines; any failure raises and stops.
BEGIN;

CREATE TEMP TABLE t_ctx AS
SELECT
  (SELECT p.id FROM profiles p WHERE p.role = 'employee' AND NOT COALESCE(p.archived, false)
     AND NOT EXISTS (SELECT 1 FROM employee_salary_changes c WHERE c.employee_id = p.id)
   ORDER BY p.id LIMIT 1) AS emp,
  (SELECT p.id FROM profiles p WHERE p.role = 'hr' AND NOT COALESCE(p.archived, false) ORDER BY p.id LIMIT 1) AS hr,
  (SELECT p.id FROM profiles p WHERE p.role = 'accountant' AND NOT COALESCE(p.archived, false) ORDER BY p.id LIMIT 1) AS acct;
GRANT SELECT ON t_ctx TO service_role;

UPDATE profiles SET basic_salary = 20000 WHERE id = (SELECT emp FROM t_ctx);
SET LOCAL session_replication_role = replica;   -- the employee's existing loans set aside (test only)
UPDATE payroll_loans SET approval_status = 'rejected' WHERE employee_id = (SELECT emp FROM t_ctx);
SET LOCAL session_replication_role = origin;

-- A cash advance filed by the app (pending, like the Accountant's form).
CREATE OR REPLACE FUNCTION pg_temp.advance(p_amount NUMERIC, p_type TEXT DEFAULT 'cash_advance')
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  SET LOCAL ROLE service_role;
  INSERT INTO payroll_loans (employee_id, loan_type, date_granted, principal, interest_pct, number_of_payrolls, amortization, start_period, approval_status, created_by, created_by_name)
  VALUES ((SELECT emp FROM t_ctx), p_type, CURRENT_DATE, p_amount, 0, 6, ceil(p_amount / 6 * 100) / 100,
          (date_trunc('month', CURRENT_DATE)::DATE + 15), 'pending', (SELECT acct FROM t_ctx), 'Scenario')
  RETURNING id INTO v;
  RESET ROLE;
  RETURN v;
END $$;

-- A government loan encoded by HR (approved at once).
CREATE OR REPLACE FUNCTION pg_temp.gov(p_type TEXT, p_amount NUMERIC, p_ref TEXT, p_by UUID DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  SET LOCAL ROLE service_role;
  INSERT INTO payroll_loans (employee_id, loan_type, agency, loan_kind, reference_no, date_granted, principal, interest_pct, number_of_payrolls, amortization, start_period, approval_status, final_pay_authorized, created_by, created_by_name)
  VALUES ((SELECT emp FROM t_ctx), p_type, CASE WHEN p_type = 'sss_loan' THEN 'SSS' ELSE 'Pag-IBIG' END,
          CASE WHEN p_type = 'sss_loan' THEN 'Salary loan' ELSE 'Multi-purpose loan' END, p_ref, CURRENT_DATE, p_amount, 0, 24,
          ceil(p_amount / 24 * 100) / 100, (date_trunc('month', CURRENT_DATE)::DATE + 15), 'approved', false,
          COALESCE(p_by, (SELECT hr FROM t_ctx)), 'HR (scenario)')
  RETURNING id INTO v;
  RESET ROLE;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.refused(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN check_violation OR insufficient_privilege OR unique_violation THEN
  RESET ROLE;
  RETURN SQLERRM;
END $$;

DO $$
DECLARE
  a UUID; b UUID; g UUID; msg TEXT; v RECORD;
  emp UUID := (SELECT emp FROM t_ctx);
  hr UUID := (SELECT hr FROM t_ctx);
BEGIN
  IF emp IS NULL OR hr IS NULL THEN RAISE EXCEPTION 'No test employee / HR in the local database.'; END IF;

  SELECT * INTO v FROM loan_limit_overview(ARRAY[emp]);
  IF v.loan_limit <> 20000 OR v.owed <> 0 THEN RAISE EXCEPTION 'overview: % %', v.loan_limit, v.owed; END IF;
  RAISE NOTICE 'PASS limit = 1.0 x monthly basic (20,000), owed 0';

  -- Government loans of any amount: never limited, never counted, no cap.
  g := pg_temp.gov('sss_loan', 900000, 'SSS-12345');
  PERFORM pg_temp.gov('pagibig_loan', 60000, 'PAG-777');
  SELECT * INTO v FROM loan_limit_overview(ARRAY[emp]);
  IF v.owed <> 0 THEN RAISE EXCEPTION 'government loans counted: %', v.owed; END IF;
  RAISE NOTICE 'PASS SSS ₱900,000 and Pag-IBIG ₱60,000 encoded: not limited, no cap, not counted (owed 0)';

  msg := pg_temp.refused('SELECT pg_temp.gov(''sss_loan'', 1000, ''sss-12345'')');
  IF msg IS NULL THEN RAISE EXCEPTION 'duplicate reference allowed'; END IF;
  RAISE NOTICE 'PASS the same SSS reference number cannot be encoded twice (case ignored)';

  msg := pg_temp.refused(format('SELECT pg_temp.gov(''sss_loan'', 1000, ''SELF-1'', %L)', emp));
  IF msg IS NULL THEN RAISE EXCEPTION 'an employee encoded a government loan'; END IF;
  RAISE NOTICE 'PASS an employee cannot encode a government loan: %', msg;
  -- HR encoding a loan about themselves.
  BEGIN
    SET LOCAL ROLE service_role;
    INSERT INTO payroll_loans (employee_id, loan_type, agency, loan_kind, reference_no, date_granted, principal, interest_pct, number_of_payrolls, amortization, start_period, approval_status, created_by, created_by_name)
    VALUES (hr, 'sss_loan', 'SSS', 'Salary loan', 'OWN-1', CURRENT_DATE, 1000, 0, 2, 500, date_trunc('month', CURRENT_DATE)::DATE + 15, 'approved', hr, 'HR');
    RAISE EXCEPTION 'HR encoded their own loan';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PASS HR cannot encode their own government loan: %', SQLERRM;
  END;

  msg := pg_temp.refused('SELECT pg_temp.advance(5000, ''salary_loan'')');
  IF msg IS NULL OR msg NOT LIKE 'loan_kind:%' THEN RAISE EXCEPTION 'school loan created'; END IF;
  RAISE NOTICE 'PASS no new school loan (salary / emergency / other): %', msg;

  -- Cash advance limit.
  a := pg_temp.advance(5000);
  RAISE NOTICE 'PASS cash advance below the limit allowed (5,000)';
  b := pg_temp.advance(15000);
  RAISE NOTICE 'PASS exactly at the limit allowed (5,000 pending + 15,000 = 20,000)';
  SET LOCAL session_replication_role = replica;
  UPDATE payroll_loans SET approval_status = 'rejected' WHERE id = b;
  SET LOCAL session_replication_role = origin;
  msg := pg_temp.refused('SELECT pg_temp.advance(15001)');
  IF msg IS NULL OR msg NOT LIKE 'loan_limit:%' THEN RAISE EXCEPTION 'one peso above was allowed'; END IF;
  RAISE NOTICE 'PASS one peso above refused: %', msg;

  -- Paid no longer counts.
  SET LOCAL session_replication_role = replica;
  UPDATE payroll_loans SET status = 'paid', remaining_balance = 0 WHERE id = a;
  SET LOCAL session_replication_role = origin;
  b := pg_temp.advance(19999);
  RAISE NOTICE 'PASS a paid cash advance no longer counts (19,999 allowed after the 5,000 was paid)';
  msg := pg_temp.refused('SELECT pg_temp.advance(2)');
  IF msg IS NULL THEN RAISE EXCEPTION 'two together over the limit allowed'; END IF;
  RAISE NOTICE 'PASS two together over the limit: the second refused';

  -- Approval re-check after a salary cut.
  UPDATE profiles SET basic_salary = 15000 WHERE id = emp;
  msg := pg_temp.refused(format('SELECT * FROM payroll_adjustment_decide(%L, ''loan'', %L, ''approve'', NULL)', hr, b));
  IF msg IS NULL OR msg NOT LIKE 'loan_limit:%' THEN RAISE EXCEPTION 'approval after a salary cut allowed'; END IF;
  RAISE NOTICE 'PASS approval refused when the cash advance no longer fits (salary now 15,000): %', msg;
  UPDATE profiles SET basic_salary = 20000 WHERE id = emp;

  -- The ₱50,000 cash advance cap stays.
  UPDATE profiles SET basic_salary = 200000 WHERE id = emp;
  msg := pg_temp.refused('SELECT pg_temp.advance(50001)');
  IF msg IS NULL THEN RAISE EXCEPTION 'cash advance cap gone'; END IF;
  RAISE NOTICE 'PASS the ₱50,000 cash advance cap stays';
  UPDATE profiles SET basic_salary = 20000 WHERE id = emp;

  -- A recovery written by the database (owner) is not limited and not counted.
  INSERT INTO payroll_loans (employee_id, loan_type, description, date_granted, principal, interest_pct, number_of_payrolls, amortization, start_period, remaining_balance, status, created_by_name)
  VALUES (emp, 'other', 'Overpayment recovery (scenario)', CURRENT_DATE, 5000, 0, 1, 5000, date_trunc('month', CURRENT_DATE)::DATE + 15, 5000, 'active', 'System');
  RAISE NOTICE 'PASS database-written recovery still allowed and not limited';

  -- Suspended cash advances still count.
  SET LOCAL session_replication_role = replica;
  UPDATE payroll_loans SET approval_status = 'approved', status = 'suspended' WHERE id = b;
  SET LOCAL session_replication_role = origin;
  SELECT * INTO v FROM loan_limit_overview(ARRAY[emp]);
  IF v.owed <> 19999 THEN RAISE EXCEPTION 'suspended not counted: %', v.owed; END IF;
  RAISE NOTICE 'PASS a suspended cash advance still counts (owed 19,999)';
END $$;

ROLLBACK;
