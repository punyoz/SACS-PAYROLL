-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261124080000_incentive_recommendations.sql (Part E step 6)
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/incentive-recommendations-scenarios.sql
-- Ends with NOTICE "all incentive recommendation scenarios passed".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-00000000ab01', 'pa@inc.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000ab02', 'hr@inc.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-00000000abf1', 'Incentive Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status) VALUES
  ('00000000-0000-4000-8000-00000000ab01', 'pa@inc.test', 'Pia Perfect', 'employee', '00000000-0000-4000-8000-00000000abf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000ab02', 'hr@inc.test', 'Hugo HR', 'hr', NULL, FALSE, TRUE, 'Active')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, archived = FALSE;
UPDATE public.system_config SET value = 'false' WHERE section = 'automation' AND key IN ('paused', 'paused_incentive_recommendations');

DO $$
DECLARE
  pia CONSTANT UUID := '00000000-0000-4000-8000-00000000ab01';
  hugo CONSTANT UUID := '00000000-0000-4000-8000-00000000ab02';
  br CONSTANT UUID := '00000000-0000-4000-8000-00000000abf1';
  r UUID;
  v_ok BOOLEAN := FALSE;
BEGIN
  -- Recommended (as a saved draft records it): window Oct 30 - Nov 26 for the Nov 16-30 payslip.
  INSERT INTO public.incentive_recommendations (employee_id, branch_id, pay_period, period_start, period_end, window_start, window_end, kind, amount, reasons)
  VALUES (pia, br, 'November 16-30, 2027', '2027-11-16', '2027-11-30', '2027-10-30', '2027-11-26', 'perfect_attendance', 500, '["No late"]') RETURNING id INTO r;

  -- 1. Never a duplicate: one row per employee, period and kind.
  BEGIN
    INSERT INTO public.incentive_recommendations (employee_id, branch_id, pay_period, period_start, period_end, kind, amount)
    VALUES (pia, br, 'November 16-30, 2027', '2027-11-16', '2027-11-30', 'perfect_attendance', 500);
  EXCEPTION WHEN unique_violation THEN v_ok := TRUE;
  END;
  ASSERT v_ok, '1: a second recommendation for the same period and kind was accepted';

  -- 2. A change outside the window: nothing happens.
  SET LOCAL session_replication_role = origin;
  INSERT INTO public.attendance_logs (employee_id, employee_name, branch_id, log_date, status) VALUES (pia, 'Pia Perfect', br, '2027-12-02', 'Absent');
  ASSERT (SELECT status FROM public.incentive_recommendations WHERE id = r) = 'pending', '2: a change outside the window withdrew it';

  -- 3. Recommended, then an absence is added inside the window -> withdrawn (recomputed at the next save).
  INSERT INTO public.attendance_logs (employee_id, employee_name, branch_id, log_date, status) VALUES (pia, 'Pia Perfect', br, '2027-11-05', 'Absent');
  ASSERT (SELECT status FROM public.incentive_recommendations WHERE id = r) = 'withdrawn', '3: an absence in the window did not withdraw it';
  ASSERT (SELECT reasons::TEXT FROM public.incentive_recommendations WHERE id = r) LIKE '%attendance on 2027-11-05 changed%', '3b: the reason says why';

  -- 4. HR cannot approve a withdrawn one.
  v_ok := FALSE;
  BEGIN
    PERFORM public.incentive_recommendation_decide(hugo, r, 'approve', NULL);
  EXCEPTION WHEN unique_violation THEN v_ok := TRUE;
  END;
  ASSERT v_ok, '4: a withdrawn recommendation was approved';

  -- 5. Re-saved and still qualifying: pending again, then approved; attendance changes later -> flagged, not changed.
  UPDATE public.incentive_recommendations SET status = 'pending' WHERE id = r;
  PERFORM public.incentive_recommendation_decide(hugo, r, 'approve', NULL);
  UPDATE public.attendance_logs SET status = 'Present', time_in = '2027-11-05 07:55+08' WHERE employee_id = pia AND log_date = '2027-11-05';
  ASSERT (SELECT status FROM public.incentive_recommendations WHERE id = r) = 'approved', '5: an approved recommendation was changed silently';
  ASSERT (SELECT needs_review FROM public.incentive_recommendations WHERE id = r) LIKE 'Attendance on 2027-11-05 changed%', '5b: not marked for review';
  ASSERT (SELECT COUNT(*) FROM public.automation_actions WHERE module = 'incentive_recommendations' AND entity_id = r::TEXT AND status = 'open') = 1, '5c: HR not flagged';
  -- Flagged once: another change does not flag again.
  UPDATE public.attendance_logs SET time_out = '2027-11-05 17:05+08' WHERE employee_id = pia AND log_date = '2027-11-05';
  ASSERT (SELECT COUNT(*) FROM public.automation_actions WHERE module = 'incentive_recommendations' AND entity_id = r::TEXT) = 1, '5d: flagged twice';

  RAISE NOTICE 'all incentive recommendation scenarios passed';
END $$;
ROLLBACK;
