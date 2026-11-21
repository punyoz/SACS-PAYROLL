-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261121020000_hand_entry_own_schedule.sql
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/hand-entry-own-schedule-scenarios.sql
--
-- Ends with NOTICE "all hand entry schedule scenarios passed".

BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-0000000003a1', 'sam@hand.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000003a2', 'wes@hand.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000003e1', 'hr@hand.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-0000000003f1', 'Hand Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived) VALUES
  ('00000000-0000-4000-8000-0000000003a1', 'sam@hand.test', 'Sam Saturday', 'employee', '00000000-0000-4000-8000-0000000003f1', FALSE),
  ('00000000-0000-4000-8000-0000000003a2', 'wes@hand.test', 'Wes Weekday',  'employee', '00000000-0000-4000-8000-0000000003f1', FALSE),
  ('00000000-0000-4000-8000-0000000003e1', 'hr@hand.test',  'Hana HR',      'hr',       NULL, FALSE)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, branch_id = EXCLUDED.branch_id, archived = FALSE;

-- Sam works Monday to Saturday; Wes has no schedule of his own (Mon-Fri).
-- Back-dated so a past Saturday counts: the no-back-dating trigger is off for these two rows only.
SET LOCAL session_replication_role = replica;
INSERT INTO public.work_schedules (schedule_key, name, work_start, work_end, working_days, effective_from)
VALUES ('00000000-0000-4000-8000-0000000003c1', 'Hand Mon-Sat', '08:00', '17:00', '{1,2,3,4,5,6}', '2026-01-01');
INSERT INTO public.work_schedule_assignments (employee_id, schedule_key, effective_from)
VALUES ('00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003c1', '2026-01-01');
SET LOCAL session_replication_role = origin;

-- 2027-03-08 (Mon) is a holiday for this branch; Sam has holiday duty on 2027-03-15 (Mon, holiday).
INSERT INTO public.attendance_holidays (holiday_date, name, type, branch_ids) VALUES
  ('2027-03-08', 'Hand test holiday', 'holiday', ARRAY['00000000-0000-4000-8000-0000000003f1']::uuid[]),
  ('2027-03-15', 'Hand test duty holiday', 'holiday', ARRAY['00000000-0000-4000-8000-0000000003f1']::uuid[]);
INSERT INTO public.holiday_duty_assignments (holiday_date, employee_id, branch_id, shift_start, shift_end, required_hours)
VALUES ('2027-03-15', '00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003f1', '08:00', '17:00', 8);

DO $$
DECLARE
  sam CONSTANT UUID := '00000000-0000-4000-8000-0000000003a1';
  wes CONSTANT UUID := '00000000-0000-4000-8000-0000000003a2';
  v_row public.attendance_corrections;
BEGIN
  -- 1. Saturday on Sam's own schedule: a working day.
  ASSERT NOT public.attendance_hand_entry_day_off(sam, '2027-03-06'), '1: Sat is on Sam''s schedule';
  -- 2. Sunday is off for Sam; Saturday is off for Wes (default Mon-Fri).
  ASSERT public.attendance_hand_entry_day_off(sam, '2027-03-07'), '2a: Sun is off for Sam';
  ASSERT public.attendance_hand_entry_day_off(wes, '2027-03-06'), '2b: Sat is off for Wes';
  ASSERT NOT public.attendance_hand_entry_day_off(wes, '2027-03-09'), '2c: Tue is a working day for Wes';
  -- 3. A branch holiday is off, even on a scheduled day.
  ASSERT public.attendance_hand_entry_day_off(sam, '2027-03-08'), '3: holiday is off';
  -- 4. A holiday with HR-assigned duty is a working day for that employee only.
  ASSERT NOT public.attendance_hand_entry_day_off(sam, '2027-03-15'), '4a: duty holiday works for Sam';
  ASSERT public.attendance_hand_entry_day_off(wes, '2027-03-15'), '4b: no duty for Wes';

  -- 5. The RPC itself: a past Saturday on Sam's schedule is accepted.
  v_row := public.attendance_correct_absence(sam, '2026-11-14',
    '2026-11-14 08:00:00+08', '2026-11-14 17:00:00+08',
    '00000000-0000-4000-8000-0000000003e1', 'Hana HR', 'Forgot his card');
  ASSERT v_row.id IS NOT NULL, '5: Saturday hand entry for Sam saved';
  -- 6. The same Saturday for Wes is refused as a rest day.
  BEGIN
    PERFORM public.attendance_correct_absence(wes, '2026-11-14',
      '2026-11-14 08:00:00+08', '2026-11-14 17:00:00+08',
      '00000000-0000-4000-8000-0000000003e1', 'Hana HR', 'Forgot his card');
    RAISE EXCEPTION '6: Wes on Saturday should be refused';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM = 'That day is a rest day or holiday.', '6: ' || SQLERRM;
  END;

  RAISE NOTICE 'all hand entry schedule scenarios passed';
END $$;

ROLLBACK;
