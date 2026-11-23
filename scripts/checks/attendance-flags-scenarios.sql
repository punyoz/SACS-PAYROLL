-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261124020000_attendance_flags.sql (Part E step 2)
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/attendance-flags-scenarios.sql
-- Ends with NOTICE "all attendance flag scenarios passed".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id)
SELECT ('00000000-0000-4000-8000-00000000aa0' || n)::UUID, 'f' || n || '@flags.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
FROM generate_series(1, 9) n ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES
  ('00000000-0000-4000-8000-00000000aaf1', 'Flag Branch'), ('00000000-0000-4000-8000-00000000aaf2', 'Dead Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status) VALUES
  ('00000000-0000-4000-8000-00000000aa01', 'f1@flags.test', 'Mia Missing',   'employee',   '00000000-0000-4000-8000-00000000aaf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000aa02', 'f2@flags.test', 'Abe Absent',    'employee',   '00000000-0000-4000-8000-00000000aaf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000aa03', 'f3@flags.test', 'Sam Short',     'accountant', '00000000-0000-4000-8000-00000000aaf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000aa04', 'f4@flags.test', 'Otto Overtime', 'employee',   '00000000-0000-4000-8000-00000000aaf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000aa05', 'f5@flags.test', 'Lea Leave',     'employee',   '00000000-0000-4000-8000-00000000aaf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000aa06', 'f6@flags.test', 'Pat Present',   'employee',   '00000000-0000-4000-8000-00000000aaf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000aa07', 'f7@flags.test', 'Ada Admin',     'admin',      '00000000-0000-4000-8000-00000000aaf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000aa08', 'f8@flags.test', 'Dee Dead',      'employee',   '00000000-0000-4000-8000-00000000aaf2', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000aa09', 'f9@flags.test', 'Dan Dead',      'employee',   '00000000-0000-4000-8000-00000000aaf2', FALSE, TRUE, 'Active')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, branch_id = EXCLUDED.branch_id, archived = FALSE, on_payroll = TRUE, employee_status = 'Active';

-- Tue 2027-03-02. Shift 08:00-17:00 (480-1020 min).
SET LOCAL session_replication_role = replica;
INSERT INTO public.attendance_logs (id, employee_id, employee_name, branch_id, log_date, time_in, time_out, status, shift_end_minutes, late_minutes, undertime_minutes) VALUES
  ('00000000-0000-4000-8000-00000000ab01', '00000000-0000-4000-8000-00000000aa01', 'Mia Missing',   '00000000-0000-4000-8000-00000000aaf1', '2027-03-02', '2027-03-02 08:00+08', NULL, 'Incomplete', 1020, 0, 0),
  ('00000000-0000-4000-8000-00000000ab02', '00000000-0000-4000-8000-00000000aa02', 'Abe Absent',    '00000000-0000-4000-8000-00000000aaf1', '2027-03-02', NULL, NULL, 'Absent', 1020, 0, 0),
  ('00000000-0000-4000-8000-00000000ab03', '00000000-0000-4000-8000-00000000aa03', 'Sam Short',     '00000000-0000-4000-8000-00000000aaf1', '2027-03-02', '2027-03-02 08:00+08', '2027-03-02 15:00+08', 'Undertime', 1020, 0, 120),
  ('00000000-0000-4000-8000-00000000ab04', '00000000-0000-4000-8000-00000000aa04', 'Otto Overtime', '00000000-0000-4000-8000-00000000aaf1', '2027-03-02', '2027-03-02 08:00+08', '2027-03-02 18:00+08', 'On Time', 1020, 0, 0),
  ('00000000-0000-4000-8000-00000000ab05', '00000000-0000-4000-8000-00000000aa05', 'Lea Leave',     '00000000-0000-4000-8000-00000000aaf1', '2027-03-02', NULL, NULL, 'Absent', 1020, 0, 0),
  ('00000000-0000-4000-8000-00000000ab06', '00000000-0000-4000-8000-00000000aa06', 'Pat Present',   '00000000-0000-4000-8000-00000000aaf1', '2027-03-02', '2027-03-02 08:20+08', '2027-03-02 17:00+08', 'Late', 1020, 20, 0),
  ('00000000-0000-4000-8000-00000000ab07', '00000000-0000-4000-8000-00000000aa07', 'Ada Admin',     '00000000-0000-4000-8000-00000000aaf1', '2027-03-02', NULL, NULL, 'Absent', 1020, 0, 0),
  ('00000000-0000-4000-8000-00000000ab08', '00000000-0000-4000-8000-00000000aa08', 'Dee Dead',      '00000000-0000-4000-8000-00000000aaf2', '2027-03-02', NULL, NULL, 'Absent', 1020, 0, 0),
  ('00000000-0000-4000-8000-00000000ab09', '00000000-0000-4000-8000-00000000aa09', 'Dan Dead',      '00000000-0000-4000-8000-00000000aaf2', '2027-03-02', NULL, NULL, 'Absent', 1020, 0, 0),
  -- Pat: two earlier lates this cutoff (Mar 1 and Feb... no: Mar 1 only is this cutoff) and one more on Mar 1.
  ('00000000-0000-4000-8000-00000000ab10', '00000000-0000-4000-8000-00000000aa06', 'Pat Present',   '00000000-0000-4000-8000-00000000aaf1', '2027-03-01', '2027-03-01 08:15+08', '2027-03-01 17:00+08', 'Late', 1020, 15, 0),
  ('00000000-0000-4000-8000-00000000ab11', '00000000-0000-4000-8000-00000000aa06', 'Pat Present',   '00000000-0000-4000-8000-00000000aaf1', '2027-02-26', '2027-02-26 08:15+08', '2027-02-26 17:00+08', 'Late', 1020, 15, 0);
SET LOCAL session_replication_role = origin;
INSERT INTO public.leave_requests (id, employee_id, employee_name, start_date, end_date, status)
VALUES ('flags-lea', '00000000-0000-4000-8000-00000000aa05', 'Lea Leave', '2027-03-02', '2027-03-02', 'pending_accountant');

DO $$
DECLARE
  v JSONB;
  code_of TEXT;
BEGIN
  -- 0. Paused: nothing.
  UPDATE public.system_config SET value = 'true' WHERE section = 'automation' AND key = 'paused';
  ASSERT (public.automation_attendance_flags('2027-03-02')->>'paused')::BOOLEAN, '0: paused does nothing';
  UPDATE public.system_config SET value = 'false' WHERE section = 'automation' AND key = 'paused';

  v := public.automation_attendance_flags('2027-03-02');

  ASSERT EXISTS (SELECT 1 FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000ab01' AND data->>'code' = 'missing_tap' AND status = 'open'), '1: missing tap flagged';
  ASSERT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = '00000000-0000-4000-8000-00000000aa01' AND kind = 'attendance_fix' AND link_page = 'emp-attendance'), '1b: Mia told, to her attendance page';
  ASSERT EXISTS (SELECT 1 FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000ab02' AND data->>'code' = 'absent_no_request'), '2: absent with no request flagged';
  ASSERT EXISTS (SELECT 1 FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000ab03' AND data->>'code' = 'short_day'), '3: short day flagged';
  ASSERT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = '00000000-0000-4000-8000-00000000aa03' AND link_page = 'ac-my-attendance'), '3b: the Accountant goes to her own attendance page';
  ASSERT EXISTS (SELECT 1 FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000ab04' AND data->>'code' = 'overtime_unfiled'), '4: 60 min past the shift with no request';
  ASSERT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = '00000000-0000-4000-8000-00000000aa04' AND link_page = 'emp-leave'), '4b: Otto goes to Leave & Overtime';
  ASSERT NOT EXISTS (SELECT 1 FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000ab05'), '5: a pending leave covers Lea';
  ASSERT NOT EXISTS (SELECT 1 FROM public.automation_actions WHERE employee_id = '00000000-0000-4000-8000-00000000aa07'), '6: never an Admin';
  ASSERT NOT EXISTS (SELECT 1 FROM public.automation_actions WHERE employee_id IN ('00000000-0000-4000-8000-00000000aa08', '00000000-0000-4000-8000-00000000aa09')), '7: a dead-terminal branch-day is never flagged';
  ASSERT NOT EXISTS (SELECT 1 FROM public.automation_actions WHERE employee_id = '00000000-0000-4000-8000-00000000aa06' AND data->>'code' = 'late_pattern'), '8: 2 lates this cutoff (Feb 26 is the last cutoff): no pattern';

  -- 9. Twice: no duplicates.
  PERFORM public.automation_attendance_flags('2027-03-02');
  ASSERT (SELECT COUNT(*) FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000ab01') = 1, '9: once';

  -- 10. Fixed: Mia files the correction; Otto files a late overtime request -> closed on the next run.
  INSERT INTO public.attendance_corrections (log_id, employee_id, employee_name, branch_id, log_date, reason, status)
  VALUES ('00000000-0000-4000-8000-00000000ab01', '00000000-0000-4000-8000-00000000aa01', 'Mia Missing', '00000000-0000-4000-8000-00000000aaf1', '2027-03-02', 'forgot to tap out', 'pending');
  INSERT INTO public.overtime_requests (employee_id, branch_id, request_date, planned_start, planned_end, minutes, reason)
  VALUES ('00000000-0000-4000-8000-00000000aa04', '00000000-0000-4000-8000-00000000aaf1', '2027-03-02', '17:00', '18:00', 60, 'grading');
  v := public.automation_attendance_flags('2027-03-03');
  ASSERT (SELECT status FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000ab01') = 'closed', '10: Mia''s flag closed';
  ASSERT (SELECT status FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000ab04') = 'closed', '10b: Otto''s flag closed';
  ASSERT (SELECT status FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000ab02') = 'open', '10c: Abe still open';

  -- 11. A third late in the cutoff -> one late pattern for HR / the Admin.
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.attendance_logs (employee_id, employee_name, branch_id, log_date, time_in, time_out, status, shift_end_minutes, late_minutes)
  VALUES ('00000000-0000-4000-8000-00000000aa06', 'Pat Present', '00000000-0000-4000-8000-00000000aaf1', '2027-03-03', '2027-03-03 08:30+08', '2027-03-03 17:00+08', 'Late', 1020, 30);
  SET LOCAL session_replication_role = origin;
  PERFORM public.automation_attendance_flags('2027-03-03');
  PERFORM public.automation_attendance_flags('2027-03-03');
  ASSERT (SELECT COUNT(*) FROM public.automation_actions WHERE employee_id = '00000000-0000-4000-8000-00000000aa06' AND data->>'code' = 'late_pattern') = 1, '11: one late pattern per cutoff';

  RAISE NOTICE 'all attendance flag scenarios passed';
END $$;

ROLLBACK;
