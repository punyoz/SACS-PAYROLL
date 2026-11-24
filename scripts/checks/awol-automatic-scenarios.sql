-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261124190000_awol_fully_automatic.sql (AWOL fully
-- automatic until separation, with automatic stops).
-- LOCAL ONLY (a local stack or a local copy of live). One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/awol-automatic-scenarios.sql
-- Ends with NOTICE "all AWOL automation scenarios passed".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;
SET LOCAL session_replication_role = replica;  -- planted rows only; the functions below run with triggers on

INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-00000000a0b1', 'AWOL Test Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-00000000a0e1', 'erin@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a0e2', 'fred@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a0e3', 'demo@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a0c1', 'c1@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a0c2', 'c2@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a0c3', 'c3@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a0c4', 'c4@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a0c5', 'c5@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a0c6', 'c6@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a0e4', 'nick@awol.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
INSERT INTO public.profiles (id, email, full_name, role, branch_id, employee_type, position, on_payroll, employee_status, is_demo, date_hired) VALUES
  ('00000000-0000-4000-8000-00000000a0e1', 'erin@awol.test', 'Erin Absent', 'employee', '00000000-0000-4000-8000-00000000a0b1', 'Teaching', 'Teacher', TRUE, 'Active', FALSE, '2024-06-03'),
  ('00000000-0000-4000-8000-00000000a0e2', 'fred@awol.test', 'Fred Returns', 'employee', '00000000-0000-4000-8000-00000000a0b1', 'Teaching', 'Teacher', TRUE, 'Active', FALSE, '2024-06-03'),
  ('00000000-0000-4000-8000-00000000a0e3', 'demo@awol.test', 'Dina Demo', 'employee', '00000000-0000-4000-8000-00000000a0b1', 'Teaching', 'Teacher', TRUE, 'Active', TRUE, '2024-06-03'),
  ('00000000-0000-4000-8000-00000000a0c1', 'c1@awol.test', 'Colleague One', 'employee', '00000000-0000-4000-8000-00000000a0b1', 'Teaching', 'Teacher', TRUE, 'Active', FALSE, '2024-06-03'),
  ('00000000-0000-4000-8000-00000000a0c2', 'c2@awol.test', 'Colleague Two', 'employee', '00000000-0000-4000-8000-00000000a0b1', 'Teaching', 'Teacher', TRUE, 'Active', FALSE, '2024-06-03'),
  ('00000000-0000-4000-8000-00000000a0c3', 'c3@awol.test', 'Colleague Three', 'employee', '00000000-0000-4000-8000-00000000a0b1', 'Teaching', 'Teacher', TRUE, 'Active', FALSE, '2024-06-03'),
  ('00000000-0000-4000-8000-00000000a0c4', 'c4@awol.test', 'Colleague Four', 'employee', '00000000-0000-4000-8000-00000000a0b1', 'Teaching', 'Teacher', TRUE, 'Active', FALSE, '2024-06-03'),
  ('00000000-0000-4000-8000-00000000a0c5', 'c5@awol.test', 'Colleague Five', 'employee', '00000000-0000-4000-8000-00000000a0b1', 'Teaching', 'Teacher', TRUE, 'Active', FALSE, '2024-06-03'),
  ('00000000-0000-4000-8000-00000000a0c6', 'c6@awol.test', 'Colleague Six', 'employee', '00000000-0000-4000-8000-00000000a0b1', 'Teaching', 'Teacher', TRUE, 'Active', FALSE, '2024-06-03'),
  ('00000000-0000-4000-8000-00000000a0e4', 'nick@awol.test', 'Nick No Card', 'employee', '00000000-0000-4000-8000-00000000a0b1', 'Teaching', 'Teacher', TRUE, 'Active', FALSE, '2024-06-03');
-- Active cards since October (the whole period); Nick has none.
INSERT INTO public.rfid_cards (employee_id, branch_id, uid, uid_last4, status, registered_by_name, registered_by_role, registered_at) VALUES
  ('00000000-0000-4000-8000-00000000a0e1', '00000000-0000-4000-8000-00000000a0b1', '9990009001', '9001', 'active', 'Test', 'hr', TIMESTAMPTZ '2026-10-01 08:00+08'),
  ('00000000-0000-4000-8000-00000000a0e2', '00000000-0000-4000-8000-00000000a0b1', '9990009002', '9002', 'active', 'Test', 'hr', TIMESTAMPTZ '2026-10-01 08:00+08'),
  ('00000000-0000-4000-8000-00000000a0e3', '00000000-0000-4000-8000-00000000a0b1', '9990009003', '9003', 'active', 'Test', 'hr', TIMESTAMPTZ '2026-10-01 08:00+08');
UPDATE public.profiles SET rfid_uid = '9990009001' WHERE id = '00000000-0000-4000-8000-00000000a0e1';

-- Mon Nov 9 to Fri Nov 13, 2026: the three are absent, no taps; six colleagues tap every day.
INSERT INTO public.attendance_logs (employee_id, employee_name, branch_id, log_date, status, time_in, time_out)
SELECT p.id, p.full_name, '00000000-0000-4000-8000-00000000a0b1', d::DATE,
       CASE WHEN p.email LIKE 'c%' THEN 'On Time' ELSE 'Absent' END,
       CASE WHEN p.email LIKE 'c%' THEN (d::DATE + TIME '07:50') AT TIME ZONE 'Asia/Manila' END,
       CASE WHEN p.email LIKE 'c%' THEN (d::DATE + TIME '17:05') AT TIME ZONE 'Asia/Manila' END
FROM public.profiles p CROSS JOIN generate_series(DATE '2026-11-09', DATE '2026-11-13', INTERVAL '1 day') d
WHERE p.branch_id = '00000000-0000-4000-8000-00000000a0b1';

SET LOCAL session_replication_role = origin;
UPDATE public.system_config SET value = '2026-11-01' WHERE section = 'hr' AND key = 'awol_auto_from';
UPDATE public.system_config SET value = 'false' WHERE section = 'automation' AND key IN ('paused', 'paused_awol_cases');

DO $$
DECLARE
  e1 CONSTANT UUID := '00000000-0000-4000-8000-00000000a0e1';
  e2 CONSTANT UUID := '00000000-0000-4000-8000-00000000a0e2';
  e3 CONSTANT UUID := '00000000-0000-4000-8000-00000000a0e3';
  c RECORD;
  v_existing INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_existing FROM public.employee_awol_cases WHERE stage <> 'closed' AND automation = 'needs_review';

  -- 1. Day 5, all guards pass: confirmed (status AWOL = pay on hold) and the 1st notice sent (in-app now; e-mail queued).
  PERFORM public.awol_flag_candidates(DATE '2026-11-13');
  SELECT * INTO c FROM public.employee_awol_cases WHERE employee_id = e1;
  IF c.stage <> 'first_notice' OR c.automation <> 'auto' OR c.first_notice_reply_by <> DATE '2026-11-19' OR c.confirmed_by_name <> 'System' THEN
    RAISE EXCEPTION '1: day 5 should confirm and send the 1st notice (got % / % / %)', c.stage, c.automation, c.first_notice_reply_by;
  END IF;
  IF (SELECT employee_status FROM public.profiles WHERE id = e1) <> 'AWOL' THEN RAISE EXCEPTION '1: status AWOL (pay on hold)'; END IF;
  IF NOT (c.guards->>'ok')::BOOLEAN THEN RAISE EXCEPTION '1: the guards should pass: %', c.guards; END IF;
  IF (SELECT COUNT(*) FROM public.awol_notices WHERE case_id = c.id AND kind = 'first' AND inapp_at IS NOT NULL AND emailed_at IS NULL AND email_to = 'erin@awol.test') <> 1 THEN RAISE EXCEPTION '1: the 1st notice kept, in-app, e-mail queued'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = e1 AND kind = 'awol_first_notice') THEN RAISE EXCEPTION '1: the employee is told'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.automation_actions WHERE module = 'awol_cases' AND entity_id = c.id::TEXT AND status = 'done') THEN RAISE EXCEPTION '1: logged by System'; END IF;

  -- 2. A demo / test account: a guard fails, nothing automatic, "Needs review".
  SELECT * INTO c FROM public.employee_awol_cases WHERE employee_id = e3;
  IF c.automation <> 'needs_review' OR c.stage <> 'flagged' OR c.automation_reason NOT LIKE '%demo / test account%' THEN RAISE EXCEPTION '2: a demo account is never automatic (got % / %)', c.automation, c.automation_reason; END IF;
  IF (SELECT employee_status FROM public.profiles WHERE id = e3) <> 'Active' THEN RAISE EXCEPTION '2: status unchanged'; END IF;
  IF EXISTS (SELECT 1 FROM public.awol_notices WHERE case_id = c.id) THEN RAISE EXCEPTION '2: no notice'; END IF;

  -- 3. Fred taps in after the 1st notice: the automation stops ("Response received: HR decides").
  IF (SELECT stage FROM public.employee_awol_cases WHERE employee_id = e2) <> 'first_notice' THEN RAISE EXCEPTION '3: Fred''s 1st notice'; END IF;
  INSERT INTO public.attendance_logs (employee_id, employee_name, branch_id, log_date, time_in) VALUES (e2, 'Fred Returns', '00000000-0000-4000-8000-00000000a0b1', DATE '2026-11-16', TIMESTAMPTZ '2026-11-16 07:55+08');
  PERFORM public.awol_daily_review(DATE '2026-11-16');
  SELECT * INTO c FROM public.employee_awol_cases WHERE employee_id = e2;
  IF c.automation <> 'response' OR c.automation_reason NOT LIKE 'Response received%' THEN RAISE EXCEPTION '3: a tap stops it (got % / %)', c.automation, c.automation_reason; END IF;

  -- 4. Erin: no response by the deadline (Nov 19) -> "Ready for HR decision" on Nov 20 (no automatic 2nd notice).
  PERFORM public.awol_daily_review(DATE '2026-11-19');
  IF (SELECT stage FROM public.employee_awol_cases WHERE employee_id = e1) <> 'first_notice' THEN RAISE EXCEPTION '4: not before the deadline has passed'; END IF;
  PERFORM public.awol_daily_review(DATE '2026-11-20');
  SELECT * INTO c FROM public.employee_awol_cases WHERE employee_id = e1;
  IF c.stage <> 'for_decision' OR EXISTS (SELECT 1 FROM public.awol_notices WHERE case_id = c.id AND kind = 'second') THEN RAISE EXCEPTION '4: ready for HR decision, no 2nd notice (got %)', c.stage; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE kind = 'awol_ready_for_decision' AND body LIKE 'Erin Absent did not reply by Nov 19, 2026.%') THEN RAISE EXCEPTION '4: HR told'; END IF;
  -- HR decides "Separate" (as /api/hr/awol-cases does): the notice of separation, effective in 3 days.
  UPDATE public.employee_awol_cases SET stage = 'second_notice', second_notice_sent_on = DATE '2026-11-20', second_notice_reply_by = DATE '2026-11-23', separation_scheduled_on = DATE '2026-11-23' WHERE id = c.id;
  PERFORM public.awol_send_notice(c.id, 'second', DATE '2026-11-20', DATE '2026-11-19', DATE '2026-11-23');

  -- 5. The effective date: separated, card deactivated, final pay started; pay stays on hold.
  PERFORM public.awol_daily_review(DATE '2026-11-22');
  IF (SELECT stage FROM public.employee_awol_cases WHERE employee_id = e1) <> 'second_notice' THEN RAISE EXCEPTION '5: not before the date'; END IF;
  PERFORM public.awol_daily_review(DATE '2026-11-23');
  SELECT * INTO c FROM public.employee_awol_cases WHERE employee_id = e1;
  IF c.stage <> 'closed' OR c.outcome <> 'separated' OR c.separation_effective <> DATE '2026-11-23' OR c.decided_by_name <> 'System' THEN RAISE EXCEPTION '5: separated by System (got % / %)', c.stage, c.outcome; END IF;
  IF (SELECT employee_status || '|' || separated_on || '|' || separation_reason FROM public.profiles WHERE id = e1) <> 'Separated|2026-11-23|AWOL / abandonment' THEN RAISE EXCEPTION '5: the profile'; END IF;
  IF EXISTS (SELECT 1 FROM public.rfid_cards WHERE employee_id = e1 AND status = 'active') OR (SELECT rfid_uid FROM public.profiles WHERE id = e1) IS NOT NULL THEN RAISE EXCEPTION '5: card deactivated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rfid_card_events WHERE employee_id = e1 AND action = 'deactivated' AND actor_name = 'System') THEN RAISE EXCEPTION '5: card history'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE kind = 'final_pay_due' AND body LIKE 'Erin Absent was separated%') THEN RAISE EXCEPTION '5: final pay started'; END IF;
  IF (SELECT COUNT(*) FROM public.employee_status_changes WHERE employee_id = e1 AND changed_by_name = 'System') <> 2 THEN RAISE EXCEPTION '5: both status changes logged'; END IF;

  -- 3b. Fred's case was stopped by the tap: never a 2nd notice or a separation afterwards.
  PERFORM public.awol_daily_review(DATE '2026-11-30');
  IF (SELECT stage FROM public.employee_awol_cases WHERE employee_id = e2) <> 'first_notice' THEN RAISE EXCEPTION '3b: a stopped case stays where it was'; END IF;

  -- 5b. Nick has no active card: no case at all.
  IF EXISTS (SELECT 1 FROM public.employee_awol_cases WHERE employee_id = '00000000-0000-4000-8000-00000000a0e4') THEN RAISE EXCEPTION '5b: no active card, no case'; END IF;

  -- 6. The cases that existed before were never touched.
  IF (SELECT COUNT(*) FROM public.employee_awol_cases WHERE stage <> 'closed' AND automation = 'needs_review' AND employee_id NOT IN (e1, e2, e3)) <> v_existing THEN RAISE EXCEPTION '6: the existing cases stay HR''s'; END IF;

  -- 7. Paused: nothing runs.
  UPDATE public.system_config SET value = 'true' WHERE section = 'automation' AND key = 'paused_awol_cases';
  IF public.awol_daily_review(DATE '2026-12-31') <> 0 OR public.awol_flag_candidates(DATE '2026-12-31') <> 0 THEN RAISE EXCEPTION '7: paused'; END IF;

  RAISE NOTICE 'all AWOL automation scenarios passed';
END $$;

ROLLBACK;
