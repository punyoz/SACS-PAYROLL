-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261124140000_framework_tracking.sql (Part E)
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/framework-tracking-scenarios.sql
-- Ends with NOTICE "all framework tracking scenarios passed".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO auth.users (id, email, aud, role, instance_id)
VALUES ('00000000-0000-4000-8000-00000000ee01', 'ot@trk.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-00000000eef1', 'Track Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status)
VALUES ('00000000-0000-4000-8000-00000000ee01', 'ot@trk.test', 'Otto Tracked', 'employee', '00000000-0000-4000-8000-00000000eef1', FALSE, TRUE, 'Active')
ON CONFLICT (id) DO UPDATE SET archived = FALSE;
UPDATE public.system_config SET value = 'false' WHERE section = 'automation' AND key IN ('paused', 'paused_overtime_requests');

DO $$
DECLARE r UUID; n INTEGER;
BEGIN
  SET LOCAL session_replication_role = origin;
  INSERT INTO public.overtime_requests (employee_id, branch_id, request_date, planned_start, planned_end, minutes, reason, status, filed_by, filed_by_name)
  VALUES ('00000000-0000-4000-8000-00000000ee01', '00000000-0000-4000-8000-00000000eef1', '2027-03-02', '17:00', '19:00', 120, 'Inventory count', 'pending',
          '00000000-0000-4000-8000-00000000ee01', 'Otto Tracked') RETURNING id INTO r;
  SELECT COUNT(*) INTO n FROM public.automation_actions WHERE module = 'overtime_requests' AND entity_id = r::TEXT AND status = 'open';
  ASSERT n = 1, format('a pending request is one open item, got %s', n);
  ASSERT (SELECT effective_on FROM public.automation_actions WHERE module = 'overtime_requests' AND entity_id = r::TEXT) = '2027-03-02', 'escalates past its date';
  UPDATE public.overtime_requests SET status = 'approved', decided_by_name = 'HR' WHERE id = r;
  ASSERT (SELECT status FROM public.automation_actions WHERE module = 'overtime_requests' AND entity_id = r::TEXT) = 'closed', 'closes when decided';

  -- Paused module: nothing is logged.
  UPDATE public.system_config SET value = 'true' WHERE section = 'automation' AND key = 'paused_overtime_requests';
  INSERT INTO public.overtime_requests (employee_id, branch_id, request_date, planned_start, planned_end, minutes, reason, status, filed_by, filed_by_name)
  VALUES ('00000000-0000-4000-8000-00000000ee01', '00000000-0000-4000-8000-00000000eef1', '2027-03-03', '17:00', '18:00', 60, 'Inventory count', 'pending',
          '00000000-0000-4000-8000-00000000ee01', 'Otto Tracked') RETURNING id INTO r;
  ASSERT NOT EXISTS (SELECT 1 FROM public.automation_actions WHERE module = 'overtime_requests' AND entity_id = r::TEXT), 'paused: not tracked';
  RAISE NOTICE 'all framework tracking scenarios passed';
END $$;
ROLLBACK;
