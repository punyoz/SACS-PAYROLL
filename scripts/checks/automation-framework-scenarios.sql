-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261124010000_automation_framework.sql (Part E step 1)
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/automation-framework-scenarios.sql
-- Ends with NOTICE "all automation framework scenarios passed".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-0000000009a1', 'emp@auto.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000009d1', 'adm@auto.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000009d2', 'adm2@auto.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000009e1', 'hr@auto.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES
  ('00000000-0000-4000-8000-0000000009f1', 'Auto Branch'), ('00000000-0000-4000-8000-0000000009f2', 'Other Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status) VALUES
  ('00000000-0000-4000-8000-0000000009a1', 'emp@auto.test', 'Ella Employee', 'employee', '00000000-0000-4000-8000-0000000009f1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-0000000009d1', 'adm@auto.test', 'Andy Admin', 'admin', '00000000-0000-4000-8000-0000000009f1', FALSE, FALSE, 'Active'),
  ('00000000-0000-4000-8000-0000000009d2', 'adm2@auto.test', 'Olive Other', 'admin', '00000000-0000-4000-8000-0000000009f2', FALSE, FALSE, 'Active'),
  ('00000000-0000-4000-8000-0000000009e1', 'hr@auto.test', 'Hugo HR', 'hr', NULL, FALSE, TRUE, 'Active')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, branch_id = EXCLUDED.branch_id, archived = FALSE;
-- A holiday on Wed 2027-03-03 at every branch.
SET LOCAL session_replication_role = replica;
INSERT INTO public.attendance_holidays (holiday_date, name, type, day_part)
VALUES ('2027-03-03', 'Test Holiday', 'holiday', 'whole');
SET LOCAL session_replication_role = origin;

DO $$
DECLARE
  emp CONSTANT UUID := '00000000-0000-4000-8000-0000000009a1';
  br  CONSTANT UUID := '00000000-0000-4000-8000-0000000009f1';
  hr  CONSTANT UUID := '00000000-0000-4000-8000-0000000009e1';
  adm CONSTANT UUID := '00000000-0000-4000-8000-0000000009d1';
  adm2 CONSTANT UUID := '00000000-0000-4000-8000-0000000009d2';
  v_id UUID;
  v_flag UUID;
  v_r JSONB;
BEGIN
  -- 1. Paused (the release default): nothing is logged, nothing runs.
  UPDATE public.system_config SET value = 'true' WHERE section = 'automation' AND key = 'paused';
  ASSERT public.automation_log('test', 'a rule', 'applied', 'A test action') IS NULL, '1: paused logs nothing';
  ASSERT (public.automation_daily('2027-03-01')->>'paused')::BOOLEAN, '1b: paused daily does nothing';

  -- 2. Working days: Mon Mar 1 + 1 = Tue Mar 2; Tue + 1 skips the Wed holiday = Thu Mar 4; Fri Mar 5 + 1 = Mon Mar 8.
  ASSERT public.automation_add_working_days('2027-03-01', 1, br) = '2027-03-02', '2: Mon + 1';
  ASSERT public.automation_add_working_days('2027-03-02', 1, br) = '2027-03-04', '2b: the holiday is skipped';
  ASSERT public.automation_add_working_days('2027-03-05', 1, br) = '2027-03-08', '2c: the weekend is skipped';

  -- 3. Resumed: an applied action is logged "by System, rule: …" with its data.
  UPDATE public.system_config SET value = 'false' WHERE section = 'automation' AND key = 'paused';
  v_id := public.automation_log('test', 'default schedule for a new hire', 'applied', 'Ella: Mon-Fri 08:00-17:00', '{"schedule":"Mon-Fri"}'::JSONB, emp, br);
  ASSERT (SELECT status = 'done' AND data->>'schedule' = 'Mon-Fri' FROM public.automation_actions WHERE id = v_id), '3: applied = done, with its data';
  ASSERT EXISTS (SELECT 1 FROM public.audit_logs WHERE metadata->>'automation_action_id' = v_id::TEXT
                 AND description LIKE 'by System, rule: default schedule for a new hire.%' AND actor_name = 'System'), '3b: audited by System with the rule';

  -- 4. A proposal waits for the Admin's check until the next working day, then goes to HR by itself.
  v_id := public.automation_log('test', 'recommend from credits', 'proposal', 'Recommend approving Ella''s leave', '{}'::JSONB, emp, br);
  UPDATE public.automation_actions SET admin_due_on = '2027-03-02' WHERE id = v_id;  -- as if made on Mon Mar 1
  v_r := public.automation_daily('2027-03-01');
  ASSERT (SELECT status FROM public.automation_actions WHERE id = v_id) = 'admin_check', '4: not before its due date';
  v_r := public.automation_daily('2027-03-02');
  ASSERT (SELECT status = 'with_hr' AND forwarded_by = 'System' FROM public.automation_actions WHERE id = v_id), '4b: no objection: to HR by the system';
  ASSERT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = hr AND kind = 'automation_forwarded'), '4c: HR told';

  -- 5. Couldn't decide: goes to HR with the reason.
  v_id := public.automation_log('test', 'recommend from credits', 'proposal', 'Ella''s leave', '{}'::JSONB, emp, br, NULL, NULL, NULL, 'no leave credits on file for this type');
  ASSERT (SELECT status = 'couldnt_decide' AND reason LIKE 'no leave credits%' FROM public.automation_actions WHERE id = v_id), '5: couldn''t decide, with why';

  -- 6. Stale: an open flag waiting more than 3 working days is escalated once (HR and that branch's Admin, not the other branch's).
  v_flag := public.automation_log('test', 'missing time-out', 'flag', 'Ella: no time-out on Mar 1', '{}'::JSONB, emp, br);
  UPDATE public.automation_actions SET created_at = '2027-03-01 09:00+08' WHERE id = v_flag;
  PERFORM public.automation_daily('2027-03-05');  -- Mar 1 + 3 working days (Wed holiday) = Fri Mar 5
  ASSERT (SELECT escalated_at IS NOT NULL FROM public.automation_actions WHERE id = v_flag), '6: escalated';
  ASSERT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = adm AND kind = 'automation_escalated'), '6b: the branch Admin told';
  ASSERT NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = adm2 AND kind = 'automation_escalated'), '6c: not the other branch''s Admin';
  PERFORM public.automation_daily('2027-03-08');
  ASSERT (SELECT COUNT(*) FROM public.notifications WHERE recipient_id = hr AND kind = 'automation_escalated' AND body LIKE 'Ella: no time-out%') = 1, '6d: once';

  -- 7. Past its effective date: escalated even if recent.
  v_id := public.automation_log('test', 'apply on effective date', 'proposal', 'Ella: new schedule from Mar 2', '{}'::JSONB, emp, br, NULL, NULL, '2027-03-02');
  PERFORM public.automation_daily('2027-03-04');
  ASSERT (SELECT escalated_at IS NOT NULL FROM public.automation_actions WHERE id = v_id), '7: past its effective date';

  -- 8. The digest: HR and the branch Admin; the other branch's Admin has nothing.
  ASSERT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = hr AND kind = 'automation_digest'), '8: HR digest';
  ASSERT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = adm AND kind = 'automation_digest'), '8b: Admin digest';
  ASSERT NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = adm2 AND kind = 'automation_digest'), '8c: nothing for the other branch';

  -- 9. A module closes its flag when fixed.
  PERFORM public.automation_close(v_flag, 'time correction approved');
  ASSERT (SELECT status = 'closed' FROM public.automation_actions WHERE id = v_flag), '9: closed';

  RAISE NOTICE 'all automation framework scenarios passed';
END $$;

ROLLBACK;
