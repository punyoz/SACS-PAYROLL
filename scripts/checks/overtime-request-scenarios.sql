-- Overtime requests (Part B, 20261122010000): what an approved request pays
-- and what the table refuses. LOCAL stack only, all rolled back:
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/overtime-request-scenarios.sql
BEGIN;
SET LOCAL session_replication_role = origin;

DO $$
DECLARE
  bea UUID := (SELECT id FROM profiles WHERE email = 'emp2@e2e.test');
  hr UUID := (SELECT id FROM profiles WHERE email = 'hr@e2e.test');
  v_log UUID;
  v_req UUID;
  v_paid INT;
  v_actual INT;
  failed BOOLEAN;
BEGIN
  SELECT id INTO v_log FROM attendance_logs WHERE employee_id = bea AND log_date = '2026-10-20';
  UPDATE attendance_logs SET time_out = TIMESTAMPTZ '2026-10-20 17:00+08' WHERE id = v_log;
  DELETE FROM attendance_overtime_approvals WHERE log_id = v_log;

  -- 1. Pending pays nothing.
  INSERT INTO overtime_requests (employee_id, branch_id, request_date, planned_start, planned_end, minutes, reason, filed_by, filed_by_name)
  VALUES (bea, (SELECT branch_id FROM profiles WHERE id = bea), '2026-10-20', '17:00', '19:00', 120, 'Grade encoding', bea, 'Bea')
  RETURNING id INTO v_req;
  ASSERT NOT EXISTS (SELECT 1 FROM attendance_overtime_approvals WHERE log_id = v_log), '1: a pending request pays nothing';

  -- 2. Approved, left on time (17:00): 0 minutes paid.
  UPDATE overtime_requests SET status = 'approved', decided_by = hr, decided_by_name = 'HR', decided_at = NOW() WHERE id = v_req;
  SELECT approved_minutes, overtime_minutes INTO v_paid, v_actual FROM attendance_overtime_approvals WHERE log_id = v_log;
  ASSERT v_paid = 0 AND v_actual = 0, format('2: approved, no extra time: paid %s of %s', v_paid, v_actual);

  -- 3. Time out 18:15: 75 minutes worked, 120 approved -> 75 paid.
  UPDATE attendance_logs SET time_out = TIMESTAMPTZ '2026-10-20 18:15+08' WHERE id = v_log;
  SELECT approved_minutes, overtime_minutes INTO v_paid, v_actual FROM attendance_overtime_approvals WHERE log_id = v_log;
  ASSERT v_paid = 75 AND v_actual = 75, format('3: min(120, 75) = 75, got %s of %s', v_paid, v_actual);

  -- 4. Time out 20:30: 210 minutes worked, 120 approved -> 120 paid.
  UPDATE attendance_logs SET time_out = TIMESTAMPTZ '2026-10-20 20:30+08' WHERE id = v_log;
  SELECT approved_minutes, overtime_minutes INTO v_paid, v_actual FROM attendance_overtime_approvals WHERE log_id = v_log;
  ASSERT v_paid = 120 AND v_actual = 210, format('4: min(120, 210) = 120, got %s of %s', v_paid, v_actual);

  -- 5. A decided request is final; hours never change; never deleted.
  failed := FALSE; BEGIN UPDATE overtime_requests SET status = 'cancelled' WHERE id = v_req; EXCEPTION WHEN OTHERS THEN failed := TRUE; END;
  ASSERT failed, '5a: an approved request cannot be cancelled';
  failed := FALSE; BEGIN DELETE FROM overtime_requests WHERE id = v_req; EXCEPTION WHEN OTHERS THEN failed := TRUE; END;
  ASSERT failed, '5b: never deleted';

  -- 6. One open request per day (duplicate refused).
  failed := FALSE;
  BEGIN
    INSERT INTO overtime_requests (employee_id, request_date, planned_start, planned_end, minutes, reason)
    VALUES (bea, '2026-10-20', '18:00', '19:00', 60, 'Again');
  EXCEPTION WHEN unique_violation THEN failed := TRUE; END;
  ASSERT failed, '6: a second open request for the day is refused';

  -- 7. A pending request keeps its hours; a rejection needs a reason.
  INSERT INTO overtime_requests (employee_id, request_date, planned_start, planned_end, minutes, reason)
  VALUES (bea, '2026-10-21', '17:00', '18:00', 60, 'Meeting') RETURNING id INTO v_req;
  failed := FALSE; BEGIN UPDATE overtime_requests SET minutes = 90 WHERE id = v_req; EXCEPTION WHEN OTHERS THEN failed := TRUE; END;
  ASSERT failed, '7a: hours are fixed once filed';
  failed := FALSE; BEGIN UPDATE overtime_requests SET status = 'rejected' WHERE id = v_req; EXCEPTION WHEN check_violation THEN failed := TRUE; END;
  ASSERT failed, '7b: a rejection needs a reason';
  UPDATE overtime_requests SET status = 'rejected', decision_note = 'Not needed' WHERE id = v_req;
  ASSERT NOT EXISTS (SELECT 1 FROM attendance_overtime_approvals a JOIN attendance_logs l ON l.id = a.log_id WHERE l.employee_id = bea AND l.log_date = '2026-10-21'),
    '7c: a rejected request pays nothing';

  -- 8. Clients cannot read or call any of it.
  ASSERT NOT has_table_privilege('authenticated', 'public.overtime_requests', 'SELECT'), '8a: no client access to the table';
  ASSERT NOT has_function_privilege('authenticated', 'public.overtime_request_sync(uuid, date)', 'EXECUTE'), '8b: no client call of the sync';

  RAISE NOTICE 'all overtime request scenarios passed';
END $$;

ROLLBACK;
