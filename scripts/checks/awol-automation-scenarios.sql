-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261123030000_awol_automation.sql (Part D)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/awol-automation-scenarios.sql
--
-- Ends with NOTICE "all AWOL automation scenarios passed".

BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-0000000006a1', 'abe@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000006a2', 'sat@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000006a3', 'lea@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000006a4', 'gap@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000006a5', 'gp2@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000006e1', 'hr@awol.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES
  ('00000000-0000-4000-8000-0000000006f1', 'Awol Branch'),
  ('00000000-0000-4000-8000-0000000006f2', 'Gap Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status) VALUES
  ('00000000-0000-4000-8000-0000000006a1', 'abe@awol.test', 'Abe Absent',  'employee', '00000000-0000-4000-8000-0000000006f1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-0000000006a2', 'sat@awol.test', 'Sat Monsat',  'employee', '00000000-0000-4000-8000-0000000006f1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-0000000006a3', 'lea@awol.test', 'Lea Pending', 'employee', '00000000-0000-4000-8000-0000000006f1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-0000000006a4', 'gap@awol.test', 'Gab Gap',     'employee', '00000000-0000-4000-8000-0000000006f2', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-0000000006a5', 'gp2@awol.test', 'Gia Gap',     'employee', '00000000-0000-4000-8000-0000000006f2', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-0000000006e1', 'hr@awol.test',  'Hana HR',     'hr',       NULL, FALSE, TRUE, 'Active')
ON CONFLICT (id) DO UPDATE SET branch_id = EXCLUDED.branch_id, archived = FALSE, on_payroll = TRUE, employee_status = 'Active';

-- 2027-03-01 is a Monday. Sat works Mon-Sat; everyone else Mon-Fri.
SET LOCAL session_replication_role = replica;
INSERT INTO public.work_schedules (schedule_key, name, work_start, work_end, working_days, effective_from)
VALUES ('00000000-0000-4000-8000-0000000006c1', 'Awol Mon-Sat', '08:00', '17:00', '{1,2,3,4,5,6}', '2026-01-01');
INSERT INTO public.work_schedule_assignments (employee_id, schedule_key, effective_from)
VALUES ('00000000-0000-4000-8000-0000000006a2', '00000000-0000-4000-8000-0000000006c1', '2026-01-01');
-- Absent rows the nightly close would write (no taps).
INSERT INTO public.attendance_logs (employee_id, employee_name, branch_id, log_date, status)
SELECT e, n, b, d::DATE, 'Absent' FROM (VALUES
  ('00000000-0000-4000-8000-0000000006a1'::UUID, 'Abe Absent', '00000000-0000-4000-8000-0000000006f1'::UUID),
  ('00000000-0000-4000-8000-0000000006a3'::UUID, 'Lea Pending', '00000000-0000-4000-8000-0000000006f1'::UUID)
) p(e, n, b) CROSS JOIN (VALUES ('2027-03-03'), ('2027-03-04'), ('2027-03-05')) d(d);
-- Sat: absent Thu, Fri, Sat (his Saturday is a working day; a Mon-Fri person's is not).
INSERT INTO public.attendance_logs (employee_id, employee_name, branch_id, log_date, status) VALUES
  ('00000000-0000-4000-8000-0000000006a2', 'Sat Monsat', '00000000-0000-4000-8000-0000000006f1', '2027-03-04', 'Absent'),
  ('00000000-0000-4000-8000-0000000006a2', 'Sat Monsat', '00000000-0000-4000-8000-0000000006f1', '2027-03-05', 'Absent'),
  ('00000000-0000-4000-8000-0000000006a2', 'Sat Monsat', '00000000-0000-4000-8000-0000000006f1', '2027-03-06', 'Absent');
-- Gap Branch: both people absent the same three days (a dead terminal).
INSERT INTO public.attendance_logs (employee_id, employee_name, branch_id, log_date, status)
SELECT e, n, '00000000-0000-4000-8000-0000000006f2', d::DATE, 'Absent' FROM (VALUES
  ('00000000-0000-4000-8000-0000000006a4'::UUID, 'Gab Gap'), ('00000000-0000-4000-8000-0000000006a5'::UUID, 'Gia Gap')
) p(e, n) CROSS JOIN (VALUES ('2027-03-03'), ('2027-03-04'), ('2027-03-05')) d(d);
SET LOCAL session_replication_role = origin;
-- Lea filed a leave (pending) for those days.
INSERT INTO public.leave_requests (id, employee_id, employee_name, start_date, end_date, status)
VALUES ('awol-lea', '00000000-0000-4000-8000-0000000006a3', 'Lea Pending', '2027-03-03', '2027-03-05', 'pending_accountant');

DO $$
DECLARE
  abe CONSTANT UUID := '00000000-0000-4000-8000-0000000006a1';
  sat CONSTANT UUID := '00000000-0000-4000-8000-0000000006a2';
  lea CONSTANT UUID := '00000000-0000-4000-8000-0000000006a3';
  gab CONSTANT UUID := '00000000-0000-4000-8000-0000000006a4';
  v_case public.employee_awol_cases;
BEGIN
  PERFORM public.awol_flag_candidates('2027-03-06');

  -- 1. Abe: 3 working days absent, no leave → a case opened by the system, the notice PREPARED (not sent):
  --    no deadline yet; HR told, Abe not yet (HR sends the notice with one click).
  SELECT * INTO v_case FROM public.employee_awol_cases WHERE employee_id = abe;
  ASSERT FOUND, '1: Abe has a case';
  ASSERT v_case.stage = 'flagged' AND v_case.auto_flagged AND v_case.first_absent_on = '2027-03-03', format('1b: %s %s', v_case.stage, v_case.first_absent_on);
  ASSERT v_case.first_notice_sent_on IS NULL AND v_case.first_notice_reply_by IS NULL, '1c: not sent, no deadline';
  ASSERT NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = abe), '1d: Abe not told before HR sends';
  ASSERT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = '00000000-0000-4000-8000-0000000006e1' AND kind = 'awol_case_opened'), '1e: HR told';
  -- No reminder while the notice is not sent.
  PERFORM public.awol_daily_review('2027-04-30');
  ASSERT (SELECT reminded_at IS NULL FROM public.employee_awol_cases WHERE id = v_case.id), '1f: no reminder before the notice is sent';
  -- HR sends it (what the one-click Send writes): the deadline starts now.
  UPDATE public.employee_awol_cases SET stage = 'first_notice', first_notice_sent_on = '2027-03-08', first_notice_reply_by = '2027-03-13' WHERE id = v_case.id
  RETURNING * INTO v_case;

  -- 2. Sat: his own schedule counts Saturday → Thu, Fri, Sat are 3 working days → a case.
  ASSERT EXISTS (SELECT 1 FROM public.employee_awol_cases WHERE employee_id = sat), '2: own schedule (Mon-Sat)';

  -- 3. Lea: a pending leave covers the days → no case.
  ASSERT NOT EXISTS (SELECT 1 FROM public.employee_awol_cases WHERE employee_id = lea), '3: pending leave blocks';

  -- 4. Gap Branch: everyone without taps those days → a data gap per day, HR told, no AWOL case.
  ASSERT (SELECT COUNT(*) FROM public.attendance_data_gaps WHERE branch_id = '00000000-0000-4000-8000-0000000006f2') = 3, '4: three gap days';
  ASSERT EXISTS (SELECT 1 FROM public.notifications WHERE kind = 'attendance_data_gap'), '4b: HR told of a device / data problem';
  ASSERT NOT EXISTS (SELECT 1 FROM public.employee_awol_cases WHERE employee_id = gab), '4c: no AWOL case on gap days';

  -- 5. Running twice never opens a second case.
  PERFORM public.awol_flag_candidates('2027-03-06');
  ASSERT (SELECT COUNT(*) FROM public.employee_awol_cases WHERE employee_id = abe) = 1, '5: idempotent';

  -- 6. Review: the deadline passes with no reply → HR reminded once; never separated.
  PERFORM public.awol_daily_review(v_case.first_notice_reply_by + 1);
  ASSERT (SELECT reminded_at IS NOT NULL AND stage = 'first_notice' FROM public.employee_awol_cases WHERE id = v_case.id), '6: reminded, still first notice';
  ASSERT (SELECT COUNT(*) FROM public.notifications WHERE kind = 'awol_reply_overdue') >= 1, '6b: HR told';
  PERFORM public.awol_daily_review(v_case.first_notice_reply_by + 2);
  ASSERT (SELECT COUNT(*) FROM public.notifications WHERE kind = 'awol_reply_overdue') = (SELECT COUNT(*) FROM public.profiles WHERE role = 'hr' AND archived = FALSE), '6c: reminded once';

  -- 7. 2nd notice served and its deadline passed → Ready for HR decision (not separated).
  UPDATE public.employee_awol_cases SET stage = 'second_notice', second_notice_sent_on = '2027-03-15', second_notice_reply_by = '2027-03-20' WHERE id = v_case.id;
  PERFORM public.awol_daily_review('2027-03-21');
  ASSERT (SELECT stage FROM public.employee_awol_cases WHERE id = v_case.id) = 'for_decision', '7: ready for HR decision';
  ASSERT (SELECT outcome IS NULL AND separation_effective IS NULL FROM public.employee_awol_cases WHERE id = v_case.id), '7b: never separated automatically';

  -- 8. Abe taps in again → marked for HR review (once).
  INSERT INTO public.attendance_logs (employee_id, employee_name, branch_id, log_date, time_in)
  VALUES (abe, 'Abe Absent', '00000000-0000-4000-8000-0000000006f1', '2027-03-22', '2027-03-22 08:00+08');
  PERFORM public.awol_daily_review('2027-03-22');
  ASSERT (SELECT review_reason FROM public.employee_awol_cases WHERE id = v_case.id) = 'returned', '8: returned → review';

  RAISE NOTICE 'all AWOL automation scenarios passed';
END $$;

ROLLBACK;
