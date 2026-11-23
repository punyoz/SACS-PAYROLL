-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261124090000_rfid_issues.sql (Part E step 7)
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/rfid-issues-scenarios.sql
-- Ends with NOTICE "all RFID issue scenarios passed".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id)
SELECT ('00000000-0000-4000-8000-00000000cc0' || n)::UUID, 'r' || n || '@rfid.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
FROM generate_series(1, 4) n ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES
  ('00000000-0000-4000-8000-00000000ccf1', 'Busy Branch'), ('00000000-0000-4000-8000-00000000ccf2', 'Quiet Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status) VALUES
  ('00000000-0000-4000-8000-00000000cc01', 'r1@rfid.test', 'Tina Tapper', 'employee', '00000000-0000-4000-8000-00000000ccf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000cc02', 'r2@rfid.test', 'Lou Lost',    'employee', '00000000-0000-4000-8000-00000000ccf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000cc03', 'r3@rfid.test', 'Quin Quiet',  'employee', '00000000-0000-4000-8000-00000000ccf2', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000cc04', 'r4@rfid.test', 'Ike Late',    'employee', '00000000-0000-4000-8000-00000000ccf2', FALSE, TRUE, 'Active')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, branch_id = EXCLUDED.branch_id, archived = FALSE, on_payroll = TRUE, employee_status = 'Active';

UPDATE public.system_config SET value = 'false' WHERE section = 'automation' AND key IN ('paused', 'paused_rfid_issues');

-- Tue 2027-03-02. Busy Branch: Tina tapped at 07:50. Quiet Branch: both due 08:00, first tap 10:30.
SET LOCAL session_replication_role = replica;
INSERT INTO public.attendance_logs (employee_id, employee_name, branch_id, log_date, time_in, time_out, status, shift_start_minutes, shift_end_minutes) VALUES
  ('00000000-0000-4000-8000-00000000cc01', 'Tina Tapper', '00000000-0000-4000-8000-00000000ccf1', '2027-03-02', '2027-03-02 07:50+08', '2027-03-02 17:00+08', 'On Time', 480, 1020),
  ('00000000-0000-4000-8000-00000000cc03', 'Quin Quiet',  '00000000-0000-4000-8000-00000000ccf2', '2027-03-02', NULL, NULL, 'Absent', 480, 1020),
  ('00000000-0000-4000-8000-00000000cc04', 'Ike Late',    '00000000-0000-4000-8000-00000000ccf2', '2027-03-02', '2027-03-02 10:30+08', '2027-03-02 17:00+08', 'Late', 480, 1020);
INSERT INTO public.attendance_taps (employee_id, employee_name, branch_id, log_date, tapped_at, source) VALUES
  ('00000000-0000-4000-8000-00000000cc01', 'Tina Tapper', '00000000-0000-4000-8000-00000000ccf1', '2027-03-02', '2027-03-02 07:50+08', 'rfid_tap'),
  ('00000000-0000-4000-8000-00000000cc04', 'Ike Late',    '00000000-0000-4000-8000-00000000ccf2', '2027-03-02', '2027-03-02 10:30+08', 'rfid_tap');
INSERT INTO public.attendance_blocked_taps (employee_id, employee_name, branch_id, log_date, attempted_at, reason, rfid_code, source) VALUES
  (NULL, NULL, '00000000-0000-4000-8000-00000000ccf1', '2027-03-02', '2027-03-02 08:01+08', 'Unregistered RFID card ••••••9999.', '••••••9999', 'rfid_tap'),
  (NULL, NULL, '00000000-0000-4000-8000-00000000ccf1', '2027-03-02', '2027-03-02 08:02+08', 'Unregistered RFID card ••••••9999.', '••••••9999', 'rfid_tap'),
  ('00000000-0000-4000-8000-00000000cc02', 'Lou Lost', '00000000-0000-4000-8000-00000000ccf1', '2027-03-02', '2027-03-02 08:05+08', 'Card ••••••0002 is lost: it no longer records attendance.', '••••••0002', 'rfid_tap'),
  ('00000000-0000-4000-8000-00000000cc01', 'Tina Tapper', '00000000-0000-4000-8000-00000000ccf2', '2027-03-02', '2027-03-02 12:00+08', 'Wrong branch: Tina Tapper belongs to another branch.', '••••••0001', 'rfid_tap'),
  -- Leave refusals are not RFID problems.
  ('00000000-0000-4000-8000-00000000cc01', 'Tina Tapper', '00000000-0000-4000-8000-00000000ccf1', '2027-03-02', '2027-03-02 13:00+08', 'On approved leave', '••••••0001', 'rfid_tap');
SET LOCAL session_replication_role = origin;

DO $$
DECLARE
  v JSONB;
  codes TEXT[];
BEGIN
  -- A dry run counts and writes nothing.
  PERFORM set_config('automation.dry_run', 'on', true);
  v := public.automation_rfid_issues('2027-03-02');
  ASSERT (v->>'flagged')::INT = 4, format('dry run counts 4, got %s', v);
  ASSERT NOT EXISTS (SELECT 1 FROM public.automation_actions WHERE module = 'rfid_issues' AND data->>'log_date' = '2027-03-02'), 'dry run wrote nothing';
  PERFORM set_config('automation.dry_run', 'off', true);

  v := public.automation_rfid_issues('2027-03-02');
  SELECT array_agg(data->>'code' ORDER BY data->>'code') INTO codes FROM public.automation_actions WHERE module = 'rfid_issues' AND data->>'log_date' = '2027-03-02';
  ASSERT codes = ARRAY['lost_card_used', 'terminal_quiet', 'unknown_card', 'wrong_branch'], format('one of each, got %s', codes);
  ASSERT (SELECT (data->>'taps')::INT FROM public.automation_actions WHERE module = 'rfid_issues' AND data->>'code' = 'unknown_card' AND data->>'log_date' = '2027-03-02') = 2, 'two taps of one unknown card: one flag';
  ASSERT (SELECT branch_id FROM public.automation_actions WHERE module = 'rfid_issues' AND data->>'code' = 'terminal_quiet' AND data->>'log_date' = '2027-03-02') = '00000000-0000-4000-8000-00000000ccf2', 'only the quiet branch';
  ASSERT (SELECT summary FROM public.automation_actions WHERE module = 'rfid_issues' AND data->>'code' = 'terminal_quiet' AND data->>'log_date' = '2027-03-02') LIKE '%first tap was at 10:30 AM%', 'says when the first tap came';
  ASSERT (SELECT bool_and(kind = 'flag' AND summary LIKE '%Suggested fix%') FROM public.automation_actions WHERE module = 'rfid_issues' AND data->>'log_date' = '2027-03-02'), 'flags with a suggested fix, never applied';

  -- Once: running again adds nothing.
  v := public.automation_rfid_issues('2027-03-02');
  ASSERT (v->>'flagged')::INT = 0, format('second run adds nothing, got %s', v);

  -- A later cutoff (10:45) makes the quiet branch normal; the module pause stops everything.
  UPDATE public.system_config SET value = 'true' WHERE section = 'automation' AND key = 'paused_rfid_issues';
  v := public.automation_rfid_issues('2027-03-02');
  ASSERT (v->>'paused')::BOOLEAN, 'paused with its module';
  UPDATE public.system_config SET value = 'false' WHERE section = 'automation' AND key = 'paused_rfid_issues';
  DELETE FROM public.automation_actions WHERE module = 'rfid_issues' AND data->>'code' = 'terminal_quiet' AND data->>'log_date' = '2027-03-02';
  UPDATE public.system_config SET value = '10:45' WHERE section = 'automation' AND key = 'rfid_offline_cutoff';
  v := public.automation_rfid_issues('2027-03-02');
  ASSERT (v->>'flagged')::INT = 0, format('a 10:30 tap before a 10:45 cutoff is fine, got %s', v);

  RAISE NOTICE 'all RFID issue scenarios passed';
END $$;

ROLLBACK;
