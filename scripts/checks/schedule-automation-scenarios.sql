-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261124030000_schedule_automation.sql (Part E step 3)
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/schedule-automation-scenarios.sql
-- Ends with NOTICE "all schedule automation scenarios passed".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id)
SELECT ('00000000-0000-4000-8000-00000000bb0' || n)::UUID, 's' || n || '@sched.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
FROM generate_series(1, 3) n ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-00000000bbf1', 'Sched Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status, date_hired, employee_level) VALUES
  ('00000000-0000-4000-8000-00000000bb01', 's1@sched.test', 'Nina New',   'employee', '00000000-0000-4000-8000-00000000bbf1', FALSE, TRUE, 'Active', '2027-03-01', 'grade_school'),
  ('00000000-0000-4000-8000-00000000bb02', 's2@sched.test', 'Lou Nolevel','employee', '00000000-0000-4000-8000-00000000bbf1', FALSE, TRUE, 'Active', '2027-03-01', NULL),
  ('00000000-0000-4000-8000-00000000bb03', 's3@sched.test', 'Olga Old',   'employee', '00000000-0000-4000-8000-00000000bbf1', FALSE, TRUE, 'Active', '2015-01-05', NULL)
ON CONFLICT (id) DO UPDATE SET date_hired = EXCLUDED.date_hired, employee_level = EXCLUDED.employee_level, branch_id = EXCLUDED.branch_id, archived = FALSE, on_payroll = TRUE;
INSERT INTO public.branch_admin_requests (id, branch_id, kind, employee_id, details, admin_note, status)
VALUES ('00000000-0000-4000-8000-00000000bbe1', '00000000-0000-4000-8000-00000000bbf1', 'schedule_request', '00000000-0000-4000-8000-00000000bb03',
        '{"employee_name":"Olga Old","request_type":"schedule","effective_from":"2027-03-02","requested":"7-3"}', 'please', 'pending');

DO $$
BEGIN
  UPDATE public.system_config SET value = 'true' WHERE section = 'automation' AND key = 'paused';
  ASSERT (public.automation_schedule_checks('2027-03-05')->>'paused')::BOOLEAN, '0: paused does nothing';
  UPDATE public.system_config SET value = 'false' WHERE section = 'automation' AND key = 'paused';

  PERFORM public.automation_schedule_checks('2027-03-05');
  -- 1. The pending request from Mar 2 has passed: flagged to HR, once.
  ASSERT (SELECT COUNT(*) FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000bbe1' AND data->>'code' = 'past_date' AND status = 'open') = 1, '1: past-date flag';
  -- 2. Nina (level set): the default schedule noted as applied. Lou (no level): a flag. Olga (hired 2015): nothing.
  ASSERT EXISTS (SELECT 1 FROM public.automation_actions WHERE employee_id = '00000000-0000-4000-8000-00000000bb01' AND data->>'code' = 'new_hire_default' AND status = 'done'), '2: Nina noted';
  ASSERT EXISTS (SELECT 1 FROM public.automation_actions WHERE employee_id = '00000000-0000-4000-8000-00000000bb02' AND data->>'code' = 'new_hire_no_level' AND status = 'open'), '2b: Lou flagged';
  ASSERT NOT EXISTS (SELECT 1 FROM public.automation_actions WHERE employee_id = '00000000-0000-4000-8000-00000000bb03' AND data->>'code' LIKE 'new_hire%'), '2c: not a new hire';
  -- 3. Twice: no duplicates.
  PERFORM public.automation_schedule_checks('2027-03-06');
  ASSERT (SELECT COUNT(*) FROM public.automation_actions WHERE module = 'schedule_requests' AND (employee_id IN ('00000000-0000-4000-8000-00000000bb01', '00000000-0000-4000-8000-00000000bb02') OR entity_id = '00000000-0000-4000-8000-00000000bbe1')) = 3, '3: once each';
  -- 4. Fixed: HR decides the request; Lou's level is set -> both flags close.
  UPDATE public.branch_admin_requests SET status = 'rejected', decided_by_name = 'Test HR', decided_by_role = 'hr', decided_at = NOW(), decision_note = 'new date please' WHERE id = '00000000-0000-4000-8000-00000000bbe1';
  UPDATE public.profiles SET employee_level = 'grade_school' WHERE id = '00000000-0000-4000-8000-00000000bb02';
  PERFORM public.automation_schedule_checks('2027-03-07');
  ASSERT (SELECT status FROM public.automation_actions WHERE entity_id = '00000000-0000-4000-8000-00000000bbe1') = 'closed', '4: decided -> closed';
  ASSERT (SELECT status FROM public.automation_actions WHERE employee_id = '00000000-0000-4000-8000-00000000bb02' AND data->>'code' = 'new_hire_no_level') = 'closed', '4b: level set -> closed';
  RAISE NOTICE 'all schedule automation scenarios passed';
END $$;

ROLLBACK;
