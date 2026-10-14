-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261013010000_employee_schedules_cutoffs_early_bird.sql
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY (docs/local-migration-replay.md): never run against the
-- live project. Everything runs in one transaction and is rolled back, so
-- the local database is left as it was.
--
--   npx supabase db reset
--   npx supabase db query < scripts/checks/employee-schedules-scenarios.sql
--   (or paste into the local Studio SQL editor)
--
-- Each check RAISEs an exception with what was expected when it fails; the
-- script ends with NOTICE "all employee schedule scenarios passed".
--
-- The guard that refuses past effective dates is switched off inside the
-- transaction so the scenarios can use October 2026 dates; check 8 switches
-- it back on and proves it works.

BEGIN;

ALTER TABLE public.work_schedules DISABLE TRIGGER work_schedules_guard;
ALTER TABLE public.work_schedule_assignments DISABLE TRIGGER work_schedule_assignments_guard;

-- ── Setup: one branch, three employees on three schedules ───────────────────
INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'pre@scenario.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000000b1', 'shs@scenario.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000000c1', 'staff@scenario.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-0000000000f1', 'Scenario Branch')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email, full_name, role, branch_id, employee_level, date_hired) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'pre@scenario.test', 'Pia Preschool', 'employee', '00000000-0000-4000-8000-0000000000f1', 'preschool', '2026-01-01'),
  ('00000000-0000-4000-8000-0000000000b1', 'shs@scenario.test', 'Sam SeniorHigh', 'employee', '00000000-0000-4000-8000-0000000000f1', 'senior_high', '2026-01-01'),
  ('00000000-0000-4000-8000-0000000000c1', 'staff@scenario.test', 'Nora NonTeaching', 'employee', '00000000-0000-4000-8000-0000000000f1', 'non_teaching', '2026-01-01')
ON CONFLICT (id) DO UPDATE SET branch_id = EXCLUDED.branch_id, employee_level = EXCLUDED.employee_level;

-- Branch schedule 08:00–17:00 (the default), and three profiles.
INSERT INTO public.work_schedules (schedule_key, name, work_start, work_end, grace_minutes, work_hours, working_days, effective_from) VALUES
  ('00000000-0000-4000-8000-00000000aaaa', 'Pre-school Teacher',         '07:30', '12:30', 10, 5, '{1,2,3,4,5}',   '2026-09-01'),
  ('00000000-0000-4000-8000-00000000bbbb', 'Senior High School Teacher', '08:00', '17:00', 15, 8, '{1,2,3,4,5}',   '2026-09-01'),
  ('00000000-0000-4000-8000-00000000cccc', 'Non-teaching Staff',         '08:00', '17:00', 15, 8, '{1,2,3,4,5,6}', '2026-09-01');

-- Pre-school and Non-teaching by level; Sam has his own schedule.
INSERT INTO public.work_schedule_assignments (employee_level, schedule_key, effective_from) VALUES
  ('preschool',    '00000000-0000-4000-8000-00000000aaaa', '2026-09-01'),
  ('non_teaching', '00000000-0000-4000-8000-00000000cccc', '2026-09-01');
INSERT INTO public.work_schedule_assignments (employee_id, schedule_key, effective_from) VALUES
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000bbbb', '2026-09-01');

DO $$
DECLARE
  s RECORD;
BEGIN
  -- ── 1. Priority: own → level → branch → default ────────────────────────
  SELECT * INTO s FROM public.attendance_schedule_for('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000f1', '2026-10-05');
  IF s.source <> 'level' OR s.work_start <> 450 OR s.grace <> 10 THEN
    RAISE EXCEPTION '1: Pia should follow her level (07:30, grace 10), got % % %', s.source, s.work_start, s.grace;
  END IF;
  SELECT * INTO s FROM public.attendance_schedule_for('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000f1', '2026-10-05');
  IF s.source <> 'employee' OR s.work_start <> 480 THEN
    RAISE EXCEPTION '1: Sam should follow his own schedule (08:00), got % %', s.source, s.work_start;
  END IF;
  SELECT * INTO s FROM public.attendance_schedule_for(NULL, '00000000-0000-4000-8000-0000000000f1', '2026-10-05');
  IF s.source NOT IN ('branch', 'default') OR s.working_days IS NOT NULL THEN
    RAISE EXCEPTION '1: no employee should fall back to the branch / default, got %', s.source;
  END IF;
END $$;

-- ── 2. Pre-school vs Senior High, same day, same 7:45 AM tap ────────────────
-- Monday Oct 5, 2026. Pia (07:30, grace 10): 15 min late → Late.
-- Sam (08:00): 15 min early → Early Bird.
INSERT INTO public.attendance_logs (id, employee_id, employee_name, log_date, time_in, time_out, branch_id) VALUES
  ('00000000-0000-4000-8000-000000000a05', '00000000-0000-4000-8000-0000000000a1', 'Pia Preschool', '2026-10-05',
   '2026-10-05 07:45+08', '2026-10-05 12:00+08', '00000000-0000-4000-8000-0000000000f1'),
  ('00000000-0000-4000-8000-000000000b05', '00000000-0000-4000-8000-0000000000b1', 'Sam SeniorHigh', '2026-10-05',
   '2026-10-05 07:45+08', '2026-10-05 17:00+08', '00000000-0000-4000-8000-0000000000f1');

DO $$
DECLARE
  l RECORD;
BEGIN
  SELECT * INTO l FROM public.attendance_logs WHERE id = '00000000-0000-4000-8000-000000000a05';
  IF l.status <> 'Late' OR l.late_minutes <> 15 OR l.undertime_minutes <> 30 OR l.shift_start_minutes <> 450 THEN
    RAISE EXCEPTION '2: Pia should be Late 15 min with 30 min undertime on 07:30–12:30, got % late % under % start %',
      l.status, l.late_minutes, l.undertime_minutes, l.shift_start_minutes;
  END IF;
  SELECT * INTO l FROM public.attendance_logs WHERE id = '00000000-0000-4000-8000-000000000b05';
  IF l.status <> 'Early Bird' OR NOT l.is_early_bird OR l.arrival_offset_minutes <> -15 OR l.late_minutes <> 0 THEN
    RAISE EXCEPTION '2: Sam should be Early Bird (offset -15), got % % %', l.status, l.is_early_bird, l.arrival_offset_minutes;
  END IF;
END $$;

-- ── 3. 15 minutes early counts, 14 does not (Sam, 08:00 start) ──────────────
INSERT INTO public.attendance_logs (id, employee_id, employee_name, log_date, time_in, time_out, branch_id) VALUES
  ('00000000-0000-4000-8000-000000000b06', '00000000-0000-4000-8000-0000000000b1', 'Sam SeniorHigh', '2026-10-06',
   '2026-10-06 07:46+08', '2026-10-06 17:00+08', '00000000-0000-4000-8000-0000000000f1');

DO $$
DECLARE
  l RECORD;
BEGIN
  SELECT * INTO l FROM public.attendance_logs WHERE id = '00000000-0000-4000-8000-000000000b06';
  IF l.is_early_bird OR l.status <> 'On Time' OR l.arrival_offset_minutes <> -14 THEN
    RAISE EXCEPTION '3: 7:46 for an 08:00 start is not early (offset -14), got % % %', l.status, l.is_early_bird, l.arrival_offset_minutes;
  END IF;
END $$;

-- ── 4. A schedule change that starts mid-period ─────────────────────────────
-- From Thu Oct 8 Sam follows the Pre-school schedule. Oct 7 stays on his old
-- one, even when recomputed later.
INSERT INTO public.work_schedule_assignments (employee_id, schedule_key, effective_from) VALUES
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000aaaa', '2026-10-08');
INSERT INTO public.attendance_logs (id, employee_id, employee_name, log_date, time_in, time_out, branch_id) VALUES
  ('00000000-0000-4000-8000-000000000b07', '00000000-0000-4000-8000-0000000000b1', 'Sam SeniorHigh', '2026-10-07',
   '2026-10-07 07:45+08', '2026-10-07 17:00+08', '00000000-0000-4000-8000-0000000000f1'),
  ('00000000-0000-4000-8000-000000000b08', '00000000-0000-4000-8000-0000000000b1', 'Sam SeniorHigh', '2026-10-08',
   '2026-10-08 07:45+08', '2026-10-08 12:30+08', '00000000-0000-4000-8000-0000000000f1');
UPDATE public.attendance_logs SET status_computed_at = NOW() WHERE id = '00000000-0000-4000-8000-000000000b07';

DO $$
DECLARE
  l RECORD;
BEGIN
  SELECT * INTO l FROM public.attendance_logs WHERE id = '00000000-0000-4000-8000-000000000b07';
  IF l.status <> 'Early Bird' OR l.shift_start_minutes <> 480 THEN
    RAISE EXCEPTION '4: Oct 7 is before the change and stays on 08:00, got % start %', l.status, l.shift_start_minutes;
  END IF;
  SELECT * INTO l FROM public.attendance_logs WHERE id = '00000000-0000-4000-8000-000000000b08';
  IF l.status <> 'Late' OR l.late_minutes <> 15 OR l.shift_start_minutes <> 450 THEN
    RAISE EXCEPTION '4: Oct 8 is on the new 07:30 schedule: Late 15, got % % start %', l.status, l.late_minutes, l.shift_start_minutes;
  END IF;
END $$;

-- ── 5. Working days: Saturday is a working day only for Mon–Sat ─────────────
-- Sat Oct 10, nobody tapped. The nightly close marks Nora (Mon–Sat) Absent,
-- not Pia or Sam (Mon–Fri).
SELECT public.attendance_close_days('2026-10-10', '2026-10-10');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.attendance_logs WHERE employee_id = '00000000-0000-4000-8000-0000000000c1' AND log_date = '2026-10-10' AND status = 'Absent') THEN
    RAISE EXCEPTION '5: Nora works Saturdays and should be Absent on Sat Oct 10';
  END IF;
  IF EXISTS (SELECT 1 FROM public.attendance_logs WHERE employee_id IN ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1') AND log_date = '2026-10-10') THEN
    RAISE EXCEPTION '5: Pia and Sam do not work Saturdays and must not be marked Absent';
  END IF;
END $$;

-- ── 6. The Early Bird threshold is a setting ────────────────────────────────
INSERT INTO public.system_config (section, key, value) VALUES ('early_bird', 'threshold_minutes', '10')
ON CONFLICT (section, key) DO UPDATE SET value = EXCLUDED.value;
UPDATE public.attendance_logs SET status_computed_at = NOW() WHERE id = '00000000-0000-4000-8000-000000000b06';

DO $$
BEGIN
  IF NOT (SELECT is_early_bird FROM public.attendance_logs WHERE id = '00000000-0000-4000-8000-000000000b06') THEN
    RAISE EXCEPTION '6: with a 10-minute threshold, 14 minutes early counts';
  END IF;
END $$;

-- ── 7. A locked winner never changes; payroll_entries.cutoff is stamped ─────
-- (From 20261014010000 the winner locks when HR approves the period's first
-- run, scripts/checks/payroll-run-approval-scenarios.sql; here it is locked
-- by hand.)
INSERT INTO public.early_bird_winners (period_label, period_start, period_end, window_start, window_end, employee_id, employee_name, early_count, amount, threshold_minutes)
VALUES ('October 1-15, 2026', '2026-10-01', '2026-10-15', '2026-10-01', '2026-10-14', '00000000-0000-4000-8000-0000000000b1', 'Sam SeniorHigh', 2, 500, 15);
UPDATE public.early_bird_winners SET amount = 600 WHERE period_label = 'October 1-15, 2026';  -- still open: allowed
INSERT INTO public.payroll_entries (id, employee_id, employee_name, pay_period, status, payroll)
VALUES ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-0000000000a1', 'Pia Preschool', 'October 1-15, 2026', 'paid', '{}'::JSONB);

DO $$
BEGIN
  IF (SELECT cutoff FROM public.payroll_entries WHERE id = '00000000-0000-4000-8000-00000000e001') <> 'first' THEN
    RAISE EXCEPTION '7: payroll_entries.cutoff should be first for "October 1-15, 2026"';
  END IF;
  UPDATE public.early_bird_winners SET finalized_at = NOW()
   WHERE period_label = 'October 1-15, 2026' AND finalized_at IS NULL;
  BEGIN
    UPDATE public.early_bird_winners SET amount = 700 WHERE period_label = 'October 1-15, 2026';
    RAISE EXCEPTION '7: a locked winner must not change';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ── 8. Schedule history: append-only, never from a past date ───────────────
ALTER TABLE public.work_schedules ENABLE TRIGGER work_schedules_guard;
ALTER TABLE public.work_schedule_assignments ENABLE TRIGGER work_schedule_assignments_guard;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.work_schedule_assignments (employee_id, schedule_key, effective_from)
    VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000bbbb', (NOW() AT TIME ZONE 'Asia/Manila')::DATE - 1);
    RAISE EXCEPTION '8: an assignment from yesterday must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.work_schedules SET grace_minutes = 30 WHERE schedule_key = '00000000-0000-4000-8000-00000000aaaa';
    RAISE EXCEPTION '8: a schedule version must not be edited in place';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'all employee schedule scenarios passed';
END $$;

ROLLBACK;
