-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261122020000_leave_half_day.sql (Part B, half day)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/half-day-leave-scenarios.sql
--
-- Ends with NOTICE "all half-day leave scenarios passed".

BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-0000000004a1', 'ana@half.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-0000000004f1', 'Half Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived) VALUES
  ('00000000-0000-4000-8000-0000000004a1', 'ana@half.test', 'Ana Halfday', 'employee', '00000000-0000-4000-8000-0000000004f1', FALSE)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, branch_id = EXCLUDED.branch_id, archived = FALSE;

-- Ana works 08:00-17:00, Mon-Fri (her own schedule, back-dated for the test).
SET LOCAL session_replication_role = replica;
INSERT INTO public.work_schedules (schedule_key, name, work_start, work_end, working_days, effective_from)
VALUES ('00000000-0000-4000-8000-0000000004c1', 'Half 8-5', '08:00', '17:00', '{1,2,3,4,5}', '2026-01-01');
INSERT INTO public.work_schedule_assignments (employee_id, schedule_key, effective_from)
VALUES ('00000000-0000-4000-8000-0000000004a1', '00000000-0000-4000-8000-0000000004c1', '2026-01-01');
SET LOCAL session_replication_role = origin;

DO $$
DECLARE
  ana CONSTANT UUID := '00000000-0000-4000-8000-0000000004a1';
  v_log public.attendance_logs;
  v_mid INTEGER;
BEGIN
  SELECT work_start + (work_end - work_start) / 2 INTO v_mid FROM public.attendance_schedule_for(ana, '00000000-0000-4000-8000-0000000004f1', '2026-10-06');

  -- 1. Without a request a short day is never "Half Day": below half the day's hours it is Absent.
  INSERT INTO public.attendance_logs (employee_id, employee_name, log_date, time_in, time_out, branch_id)
  VALUES (ana, 'Ana Halfday', '2026-10-05', '2026-10-05 08:00+08', '2026-10-05 10:00+08', '00000000-0000-4000-8000-0000000004f1')
  RETURNING * INTO v_log;
  ASSERT v_log.status = 'Absent' AND NOT v_log.is_half_day, format('1: short day is Absent, got %s', v_log.status);
  -- 1b. Above the minimum it is undertime minutes, not Half Day.
  INSERT INTO public.attendance_logs (employee_id, employee_name, log_date, time_in, time_out, branch_id)
  VALUES (ana, 'Ana Halfday', '2026-10-09', '2026-10-09 08:00+08', '2026-10-09 14:00+08', '00000000-0000-4000-8000-0000000004f1')
  RETURNING * INTO v_log;
  ASSERT v_log.status = 'Undertime' AND v_log.undertime_minutes = 180 AND NOT v_log.is_half_day, format('1b: got %s / %s', v_log.status, v_log.undertime_minutes);

  -- 2. An approved AM half day: the kiosk accepts taps (no full-day leave), no On Leave day is written.
  INSERT INTO public.leave_requests (id, employee_id, employee_name, leave_type, start_date, end_date, status, pay_status, half_day)
  VALUES ('half-am', ana, 'Ana Halfday', 'Sick Leave', '2026-10-06', '2026-10-06', 'approved', 'with_pay', 'AM');
  ASSERT NOT EXISTS (SELECT 1 FROM public.attendance_approved_leave(ana, '2026-10-06')), '2a: half day does not refuse taps';
  ASSERT NOT EXISTS (SELECT 1 FROM public.attendance_logs WHERE employee_id = ana AND log_date = '2026-10-06'), '2b: no On Leave day';

  -- 3. Ana works the PM half from mid-shift: on time, no late, no undertime.
  INSERT INTO public.attendance_logs (employee_id, employee_name, log_date, time_in, time_out, branch_id)
  VALUES (ana, 'Ana Halfday', '2026-10-06',
          ('2026-10-06'::TIMESTAMP + make_interval(mins => v_mid)) AT TIME ZONE 'Asia/Manila', '2026-10-06 17:00+08', '00000000-0000-4000-8000-0000000004f1')
  RETURNING * INTO v_log;
  ASSERT v_log.status = 'On Time' AND v_log.late_minutes = 0 AND v_log.undertime_minutes = 0, format('3: got %s late %s under %s', v_log.status, v_log.late_minutes, v_log.undertime_minutes);
  ASSERT v_log.shift_start_minutes = v_mid, '3b: the shift starts at mid-shift';

  -- 4. Rejecting the request afterwards recomputes the day against the full shift: late again.
  UPDATE public.leave_requests SET status = 'rejected' WHERE id = 'half-am';
  SELECT * INTO v_log FROM public.attendance_logs WHERE id = v_log.id;
  ASSERT v_log.late_minutes > 0 AND v_log.shift_start_minutes = 480, format('4: rejected → late from 08:00, got %s', v_log.late_minutes);

  -- 5. A PM half day: leaving at mid-shift is no undertime; arriving 30 min late is still late.
  INSERT INTO public.leave_requests (id, employee_id, employee_name, leave_type, start_date, end_date, status, pay_status, half_day)
  VALUES ('half-pm', ana, 'Ana Halfday', 'Vacation Leave', '2026-10-07', '2026-10-07', 'approved', 'without_pay', 'PM');
  INSERT INTO public.attendance_logs (employee_id, employee_name, log_date, time_in, time_out, branch_id)
  VALUES (ana, 'Ana Halfday', '2026-10-07', '2026-10-07 08:30+08',
          ('2026-10-07'::TIMESTAMP + make_interval(mins => v_mid)) AT TIME ZONE 'Asia/Manila', '00000000-0000-4000-8000-0000000004f1')
  RETURNING * INTO v_log;
  ASSERT v_log.undertime_minutes = 0 AND v_log.late_minutes = 30 AND v_log.status = 'Late', format('5: got %s late %s under %s', v_log.status, v_log.late_minutes, v_log.undertime_minutes);

  -- 6. A half day needs one date (start = end) and AM or PM.
  BEGIN
    INSERT INTO public.leave_requests (id, employee_id, start_date, end_date, status, half_day)
    VALUES ('half-bad', ana, '2026-10-08', '2026-10-09', 'pending_accountant', 'AM');
    RAISE EXCEPTION '6: two-day half day accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 7. AWOL counts no-shows only: three short days with taps are not a streak.
  INSERT INTO public.attendance_logs (employee_id, employee_name, log_date, time_in, time_out, branch_id)
  SELECT ana, 'Ana Halfday', d, d + TIME '08:00' AT TIME ZONE 'Asia/Manila', d + TIME '09:00' AT TIME ZONE 'Asia/Manila', '00000000-0000-4000-8000-0000000004f1'
  FROM unnest(ARRAY['2026-10-12', '2026-10-13', '2026-10-14']::DATE[]) d;
  ASSERT (SELECT bool_and(status = 'Absent') FROM public.attendance_logs WHERE employee_id = ana AND log_date BETWEEN '2026-10-12' AND '2026-10-14'), '7a: short days are Absent';
  PERFORM public.awol_flag_candidates('2026-10-14');
  ASSERT NOT EXISTS (SELECT 1 FROM public.employee_awol_cases WHERE employee_id = ana), '7b: no AWOL case for days with taps';
  -- 7c. Control: three no-show days do open a case (the check above is not vacuous).
  INSERT INTO public.attendance_logs (employee_id, employee_name, log_date, branch_id)
  SELECT ana, 'Ana Halfday', d, '00000000-0000-4000-8000-0000000004f1'
  FROM unnest(ARRAY['2026-10-19', '2026-10-20', '2026-10-21']::DATE[]) d;
  PERFORM public.awol_flag_candidates('2026-10-21');
  ASSERT EXISTS (SELECT 1 FROM public.employee_awol_cases WHERE employee_id = ana AND first_absent_on = '2026-10-19'), '7c: no-shows open a case';

  RAISE NOTICE 'all half-day leave scenarios passed';
END $$;

ROLLBACK;
