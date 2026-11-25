-- Perfect Attendance undo (20261126080000). LOCAL DATABASE ONLY; everything is rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/checks/perfect-attendance-undo-scenarios.sql
BEGIN;

CREATE TEMP TABLE t_ctx AS
SELECT
  (SELECT p.id FROM profiles p WHERE p.role = 'employee' AND NOT COALESCE(p.archived, false) ORDER BY p.id LIMIT 1) AS emp,
  (SELECT p.id FROM profiles p WHERE p.role = 'hr' AND NOT COALESCE(p.archived, false) ORDER BY p.id LIMIT 1) AS hr,
  (SELECT p.id FROM profiles p WHERE p.role = 'accountant' AND NOT COALESCE(p.archived, false) ORDER BY p.id LIMIT 1) AS acct;

CREATE OR REPLACE FUNCTION pg_temp.refused(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL;
EXCEPTION WHEN check_violation OR insufficient_privilege OR unique_violation OR no_data_found THEN RETURN SQLERRM; END $$;

DO $$
DECLARE
  emp UUID := (SELECT emp FROM t_ctx); hr UUID := (SELECT hr FROM t_ctx); acct UUID := (SELECT acct FROM t_ctx);
  r1 UUID; r2 UUID; eb UUID; v RECORD; msg TEXT; ledger_before NUMERIC; ledger_after NUMERIC;
BEGIN
  -- Two automatic Perfect Attendance records (as payroll writes them) and one Early Bird pending.
  INSERT INTO incentive_recommendations (employee_id, pay_period, period_start, period_end, kind, amount, status, decided_by_name, decided_at, decision_note)
  VALUES (emp, 'December 1-15, 2026', '2026-12-01', '2026-12-15', 'perfect_attendance', 500, 'approved', 'System (attendance)', NOW(), 'Paid automatically')
  RETURNING id INTO r1;
  INSERT INTO incentive_recommendations (employee_id, pay_period, period_start, period_end, kind, amount, status, decided_by_name, decided_at, decision_note)
  VALUES (emp, 'December 16-31, 2026', '2026-12-16', '2026-12-31', 'perfect_attendance', 500, 'approved', 'System (attendance)', NOW(), 'Paid automatically')
  RETURNING id INTO r2;
  INSERT INTO incentive_recommendations (employee_id, pay_period, period_start, period_end, kind, amount, status)
  VALUES (emp, 'December 1-15, 2026', '2026-12-01', '2026-12-15', 'early_bird', 300, 'pending') RETURNING id INTO eb;

  -- The Dec 1-15 payslip is already processed with the ₱500 paid (a stored payslip, set up for the test).
  SET LOCAL session_replication_role = replica;
  INSERT INTO payroll_entries (employee_id, employee_name, pay_period, status, payroll, created_at, updated_at)
  VALUES (emp, 'Test', 'December 1-15, 2026', 'paid',
    jsonb_build_object('totals', jsonb_build_object('perfect_attendance_incentive', 500, 'gross_pay', 16000),
                       'audit', jsonb_build_object('period', jsonb_build_object('start_key', '2026-12-01', 'end_key', '2026-12-15'))), NOW(), NOW());
  SET LOCAL session_replication_role = origin;
  SELECT COALESCE(SUM(amount), 0) INTO ledger_before FROM payroll_exempt_benefits_paid WHERE employee_id = emp AND tax_year = 2026 AND kind = 'bonus';

  msg := pg_temp.refused(format('SELECT * FROM incentive_recommendation_undo(%L, %L, ''Not earned after review'')', acct, r1));
  IF msg IS NULL THEN RAISE EXCEPTION 'a non-HR undid it'; END IF;
  RAISE NOTICE 'PASS only HR undoes: %', msg;
  msg := pg_temp.refused(format('SELECT * FROM incentive_recommendation_undo(%L, %L, ''no'')', hr, r1));
  IF msg IS NULL THEN RAISE EXCEPTION 'no reason accepted'; END IF;
  RAISE NOTICE 'PASS a reason is required: %', msg;
  msg := pg_temp.refused(format('SELECT * FROM incentive_recommendation_undo(%L, %L, ''Not earned after review'')', hr, eb));
  IF msg IS NULL THEN RAISE EXCEPTION 'early bird undone'; END IF;
  RAISE NOTICE 'PASS Early Bird is not undone this way (it still waits for HR): %', msg;

  -- After processing: the payslip stays; the next payslip takes it back as a labelled adjustment.
  SELECT * INTO v FROM incentive_recommendation_undo(hr, r1, 'Late on Dec 3 found after the payslip was processed');
  IF v.adjustment_id IS NULL OR v.adjustment_amount <> -500 OR v.status <> 'rejected' THEN RAISE EXCEPTION 'undo after processing: %', row_to_json(v); END IF;
  PERFORM 1 FROM payroll_monthly_incentives i WHERE i.id = v.adjustment_id AND i.kind = 'adjustment' AND i.amount = -500 AND i.non_taxable
    AND i.approval_status = 'approved' AND i.description = 'Perfect attendance undone (December 1-15, 2026)' AND i.undoes_recommendation_id = r1;
  IF NOT FOUND THEN RAISE EXCEPTION 'adjustment not as expected'; END IF;
  IF (SELECT (payroll->'totals'->>'perfect_attendance_incentive')::NUMERIC FROM payroll_entries WHERE employee_id = emp AND pay_period = 'December 1-15, 2026') <> 500 THEN
    RAISE EXCEPTION 'the processed payslip changed'; END IF;
  RAISE NOTICE 'PASS undone after processing: the processed payslip keeps its ₱500; the next payslip takes back ₱500 ("Perfect attendance undone (December 1-15, 2026)", non-taxable, approved)';

  SELECT COALESCE(SUM(amount), 0) INTO ledger_after FROM payroll_exempt_benefits_paid WHERE employee_id = emp AND tax_year = 2026 AND kind = 'bonus';
  IF ledger_after <> ledger_before - 500 THEN RAISE EXCEPTION 'ceiling ledger: % -> %', ledger_before, ledger_after; END IF;
  RAISE NOTICE 'PASS the ₱90,000 ledger counts it back: bonus total % -> %', ledger_before, ledger_after;

  msg := pg_temp.refused(format('SELECT * FROM incentive_recommendation_undo(%L, %L, ''Again, by mistake'')', hr, r1));
  IF msg IS NULL THEN RAISE EXCEPTION 'undone twice'; END IF;
  RAISE NOTICE 'PASS undone only once: %', msg;

  -- Before processing (no processed payslip for Dec 16-31): simply not paid, no adjustment.
  SELECT * INTO v FROM incentive_recommendation_undo(hr, r2, 'Absent on Dec 18 (correction approved)');
  IF v.adjustment_id IS NOT NULL OR v.status <> 'rejected' THEN RAISE EXCEPTION 'undo before processing: %', row_to_json(v); END IF;
  RAISE NOTICE 'PASS undone before processing: no adjustment, it is simply not paid';

  -- Never their own.
  UPDATE incentive_recommendations SET employee_id = hr, status = 'approved' WHERE id = r2;
  msg := pg_temp.refused(format('SELECT * FROM incentive_recommendation_undo(%L, %L, ''My own, by mistake'')', hr, r2));
  IF msg IS NULL THEN RAISE EXCEPTION 'HR undid their own'; END IF;
  RAISE NOTICE 'PASS never their own: %', msg;
END $$;

ROLLBACK;
