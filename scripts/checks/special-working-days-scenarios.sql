-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261124130000_special_working_days.sql
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/special-working-days-scenarios.sql
-- Ends with NOTICE "all special working day scenarios passed".
-- Sat 2027-03-06 (a rest day on the default Mon-Fri week).
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id)
SELECT ('00000000-0000-4000-8000-00000000dd0' || n)::UUID, 's' || n || '@swd.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
FROM generate_series(1, 3) n ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-00000000ddf1', 'Saturday Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status, employee_type, date_hired) VALUES
  ('00000000-0000-4000-8000-00000000dd01', 's1@swd.test', 'Tess Teacher', 'employee', '00000000-0000-4000-8000-00000000ddf1', FALSE, TRUE, 'Active', 'Teaching', '2024-01-01'),
  ('00000000-0000-4000-8000-00000000dd02', 's2@swd.test', 'Nico NonTeaching', 'employee', '00000000-0000-4000-8000-00000000ddf1', FALSE, TRUE, 'Active', 'Non-Teaching', '2024-01-01'),
  ('00000000-0000-4000-8000-00000000dd03', 's3@swd.test', 'Ella Extra', 'employee', '00000000-0000-4000-8000-00000000ddf1', FALSE, TRUE, 'Active', 'Non-Teaching', '2024-01-01')
ON CONFLICT (id) DO UPDATE SET employee_type = EXCLUDED.employee_type, branch_id = EXCLUDED.branch_id, archived = FALSE, on_payroll = TRUE, employee_status = 'Active', date_hired = EXCLUDED.date_hired;

DO $$
DECLARE
  t CONSTANT UUID := '00000000-0000-4000-8000-00000000dd01';
  nt CONSTANT UUID := '00000000-0000-4000-8000-00000000dd02';
  ex CONSTANT UUID := '00000000-0000-4000-8000-00000000dd03';
  br CONSTANT UUID := '00000000-0000-4000-8000-00000000ddf1';
  sat CONSTANT DATE := '2027-03-06';
  s RECORD;
BEGIN
  -- Before anything is declared: Saturday is a rest day for all three; nobody is missing.
  ASSERT public.attendance_is_rest_day_for(t, br, sat), 'Saturday is a rest day';
  ASSERT NOT EXISTS (SELECT 1 FROM public.attendance_missing_days(sat, sat) m WHERE m.employee_id IN (t, nt, ex)), 'nobody missing on a rest day';

  -- Make-up day for Teaching, 08:00-12:00; extra day for Ella only.
  INSERT INTO public.special_working_days (work_date, branch_ids, audience, start_time, end_time, reason, pay_type)
  VALUES (sat, ARRAY[br], 'teaching', '08:00', '12:00', 'Make-up classes', 'makeup');
  INSERT INTO public.special_working_days (work_date, branch_ids, audience, employee_ids, start_time, end_time, reason, pay_type, premium_pct)
  VALUES (sat, ARRAY[br], 'employees', ARRAY[ex], '07:00', '11:00', 'Inventory', 'extra', 130);

  -- The teacher: the day's hours, a working day, missing (Absent) without taps.
  SELECT * INTO s FROM public.attendance_schedule_for(t, br, sat);
  ASSERT s.work_start = 480 AND s.work_end = 720 AND s.source = 'special_day', format('make-up hours, got %s', row_to_json(s));
  ASSERT NOT public.attendance_is_rest_day_for(t, br, sat), 'a make-up day is a working day';
  ASSERT public.attendance_is_working_day_for(t, br, sat), 'scheduled for AWOL / RFID checks';
  ASSERT EXISTS (SELECT 1 FROM public.attendance_missing_days(sat, sat) m WHERE m.employee_id = t), 'make-up day absence counted';

  -- Not covered: unchanged (rest day, never Absent).
  ASSERT public.attendance_is_rest_day_for(nt, br, sat), 'not covered: still a rest day';
  ASSERT NOT EXISTS (SELECT 1 FROM public.attendance_missing_days(sat, sat) m WHERE m.employee_id = nt), 'not covered: no Absent';
  SELECT * INTO s FROM public.attendance_schedule_for(nt, br, sat);
  ASSERT s.source <> 'special_day', 'not covered: own schedule';

  -- Extra day: its hours, but never Absent for missing it (paid only when tapped, in payroll).
  SELECT * INTO s FROM public.attendance_schedule_for(ex, br, sat);
  ASSERT s.work_start = 420 AND s.source = 'special_day', 'extra-day hours';
  ASSERT NOT EXISTS (SELECT 1 FROM public.attendance_missing_days(sat, sat) m WHERE m.employee_id = ex), 'extra day: no Absent';

  -- A weekday is untouched; a cancelled day stops counting.
  ASSERT (SELECT source FROM public.attendance_schedule_for(t, br, sat + 2)) <> 'special_day', 'Monday: own schedule';
  UPDATE public.special_working_days SET cancelled_at = NOW() WHERE work_date = sat AND pay_type = 'makeup';
  ASSERT public.attendance_is_rest_day_for(t, br, sat), 'cancelled: a rest day again';

  -- Payslip lines: substitution and the extra day are allowed types.
  ASSERT (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'payroll_incentives_type_check') LIKE '%special_working_day%', 'line type';
  ASSERT (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'payroll_incentives_type_check') LIKE '%substitution%', 'substitution line type';

  RAISE NOTICE 'all special working day scenarios passed';
END $$;

ROLLBACK;
