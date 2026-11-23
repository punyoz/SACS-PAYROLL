-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261124070000_transfer_automation.sql (Part E step 5)
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/transfer-automation-scenarios.sql
-- Ends with NOTICE "all transfer automation scenarios passed".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id, raw_user_meta_data, raw_app_meta_data) VALUES
  ('00000000-0000-4000-8000-00000000ee01', 'tess@tr.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"branch_id":"00000000-0000-4000-8000-00000000eef1"}', '{"session_id":"abc"}'),
  ('00000000-0000-4000-8000-00000000ee02', 'mo@tr.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{}', '{}'),
  ('00000000-0000-4000-8000-00000000ee03', 'now@tr.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{}', '{}'),
  ('00000000-0000-4000-8000-00000000eee1', 'hr@tr.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{}', '{}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES
  ('00000000-0000-4000-8000-00000000eef1', 'From Branch'), ('00000000-0000-4000-8000-00000000eef2', 'To Branch'), ('00000000-0000-4000-8000-00000000eef3', 'Elsewhere')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status) VALUES
  ('00000000-0000-4000-8000-00000000ee01', 'tess@tr.test', 'Tess Transfer', 'employee', '00000000-0000-4000-8000-00000000eef1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000ee02', 'mo@tr.test',   'Mo Moved',      'employee', '00000000-0000-4000-8000-00000000eef1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000ee03', 'now@tr.test',  'Nora Now',      'employee', '00000000-0000-4000-8000-00000000eef1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000eee1', 'hr@tr.test',   'Hal HR',        'hr', NULL, FALSE, TRUE, 'Active')
ON CONFLICT (id) DO UPDATE SET branch_id = EXCLUDED.branch_id, role = EXCLUDED.role, archived = FALSE;
-- Tess: an active card and a lost one; her own schedule.
INSERT INTO public.rfid_cards (employee_id, branch_id, uid, uid_last4, status, registered_by_name, registered_by_role) VALUES
  ('00000000-0000-4000-8000-00000000ee01', '00000000-0000-4000-8000-00000000eef1', '9000000001', '0001', 'active', 'HR', 'hr'),
  ('00000000-0000-4000-8000-00000000ee01', '00000000-0000-4000-8000-00000000eef1', '9000000002', '0002', 'lost', 'HR', 'hr');
SET LOCAL session_replication_role = replica;
INSERT INTO public.work_schedules (schedule_key, name, work_start, work_end, working_days, effective_from)
VALUES ('00000000-0000-4000-8000-00000000eec1', 'Tess own', '07:00', '16:00', '{1,2,3,4,5}', '2026-01-01');
INSERT INTO public.work_schedule_assignments (employee_id, schedule_key, effective_from)
VALUES ('00000000-0000-4000-8000-00000000ee01', '00000000-0000-4000-8000-00000000eec1', '2026-01-01');
SET LOCAL session_replication_role = origin;

DO $$
DECLARE
  tess CONSTANT UUID := '00000000-0000-4000-8000-00000000ee01';
  mo   CONSTANT UUID := '00000000-0000-4000-8000-00000000ee02';
  nora CONSTANT UUID := '00000000-0000-4000-8000-00000000ee03';
  hr   CONSTANT UUID := '00000000-0000-4000-8000-00000000eee1';
  f    CONSTANT UUID := '00000000-0000-4000-8000-00000000eef1';
  t    CONSTANT UUID := '00000000-0000-4000-8000-00000000eef2';
  today DATE := (now() AT TIME ZONE 'Asia/Manila')::DATE;
  v_t UUID;
  v_m UUID;
  v_n UUID;
BEGIN
  UPDATE public.system_config SET value = 'false' WHERE section = 'automation' AND key = 'paused';
  INSERT INTO public.transfer_requests (employee_id, from_branch_id, to_branch_id, requested_by, effective_date) VALUES (tess, f, t, hr, today + 7) RETURNING id INTO v_t;
  INSERT INTO public.transfer_requests (employee_id, from_branch_id, to_branch_id, requested_by, effective_date) VALUES (mo, f, t, hr, today + 7) RETURNING id INTO v_m;
  INSERT INTO public.transfer_requests (employee_id, from_branch_id, to_branch_id, requested_by, effective_date) VALUES (nora, f, t, hr, today) RETURNING id INTO v_n;

  -- 1. Approved for today: applied at once (profile, active card), as before.
  UPDATE public.transfer_requests SET status = 'approved', reviewed_by = hr WHERE id = v_n;
  ASSERT (SELECT branch_id FROM public.profiles WHERE id = nora) = t, '1: today = at once';
  ASSERT (SELECT applied_at IS NOT NULL FROM public.transfer_requests WHERE id = v_n), '1b: marked applied';

  -- 2. Approved for a later date: nothing moves yet.
  UPDATE public.transfer_requests SET status = 'approved', reviewed_by = hr WHERE id IN (v_t, v_m);
  ASSERT (SELECT branch_id FROM public.profiles WHERE id = tess) = f, '2: a later date waits';
  ASSERT (SELECT applied_at IS NULL FROM public.transfer_requests WHERE id = v_t), '2b: not applied';
  PERFORM public.transfer_apply_due(today + 6);
  ASSERT (SELECT branch_id FROM public.profiles WHERE id = tess) = f, '2c: not before its date';

  -- 3. Mo moved elsewhere meanwhile: never moved twice, flagged for HR.
  UPDATE public.profiles SET branch_id = '00000000-0000-4000-8000-00000000eef3' WHERE id = mo;

  -- 4. Paused: nothing.
  UPDATE public.system_config SET value = 'true' WHERE section = 'automation' AND key = 'paused';
  PERFORM public.transfer_apply_due(today + 7);
  ASSERT (SELECT branch_id FROM public.profiles WHERE id = tess) = f, '4: paused = nothing';
  UPDATE public.system_config SET value = 'false' WHERE section = 'automation' AND key = 'paused';

  -- 5. Its date: branch, sign-in account (and the session ends), the ACTIVE card only; own schedule flagged; once.
  PERFORM public.transfer_apply_due(today + 7);
  ASSERT (SELECT branch_id FROM public.profiles WHERE id = tess) = t, '5: moved on its date';
  ASSERT (SELECT raw_user_meta_data->>'branch_id' FROM auth.users WHERE id = tess) = t::TEXT, '5b: sign-in account branch';
  ASSERT (SELECT raw_app_meta_data->>'session_id' FROM auth.users WHERE id = tess) LIKE 'revoked:%', '5c: session ended';
  ASSERT (SELECT branch_id FROM public.rfid_cards WHERE employee_id = tess AND status = 'active') = t, '5d: active card moved';
  ASSERT (SELECT branch_id FROM public.rfid_cards WHERE employee_id = tess AND status = 'lost') = f, '5e: lost card left';
  ASSERT EXISTS (SELECT 1 FROM public.automation_actions WHERE module = 'transfer_endorsements' AND entity_type = 'transfer_schedule_check' AND employee_id = tess), '5f: own schedule flagged';
  ASSERT EXISTS (SELECT 1 FROM public.automation_actions WHERE module = 'transfer_endorsements' AND entity_type = 'transfer_request_applied' AND entity_id = v_t::TEXT), '5g: logged by System';
  ASSERT (SELECT branch_id FROM public.profiles WHERE id = mo) = '00000000-0000-4000-8000-00000000eef3', '5h: Mo not moved';
  ASSERT EXISTS (SELECT 1 FROM public.automation_actions WHERE entity_type = 'transfer_request_stuck' AND entity_id = v_m::TEXT), '5i: Mo flagged';
  PERFORM public.transfer_apply_due(today + 8);
  ASSERT (SELECT COUNT(*) FROM public.automation_actions WHERE entity_type = 'transfer_request_applied' AND entity_id = v_t::TEXT) = 1, '6: applied once';
  ASSERT (SELECT COUNT(*) FROM public.automation_actions WHERE entity_type = 'transfer_request_stuck' AND entity_id = v_m::TEXT) = 1, '6b: flagged once';

  -- 7. The release dry run counts and writes nothing.
  ASSERT (public.automation_dry_run_all(today + 30)->'transfers'->>'dry_run')::BOOLEAN, '7: dry run';
  RAISE NOTICE 'all transfer automation scenarios passed';
END $$;

ROLLBACK;
