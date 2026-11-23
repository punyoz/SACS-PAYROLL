-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261124040000_attendance_correction_requests.sql
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/attendance-correction-requests-scenarios.sql
-- Ends with NOTICE "all attendance correction request scenarios passed".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-00000000dd01', 'cora@corr.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000dde1', 'hugo@corr.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-00000000ddf1', 'Corr Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status) VALUES
  ('00000000-0000-4000-8000-00000000dd01', 'cora@corr.test', 'Cora Correct', 'employee', '00000000-0000-4000-8000-00000000ddf1', FALSE, TRUE, 'Active'),
  ('00000000-0000-4000-8000-00000000dde1', 'hugo@corr.test', 'Hugo HR', 'hr', NULL, FALSE, TRUE, 'Active')
ON CONFLICT (id) DO UPDATE SET branch_id = EXCLUDED.branch_id, role = EXCLUDED.role, archived = FALSE;

-- Today (Manila) and the last working days before it, so the filing window holds.
CREATE TEMP TABLE d AS
SELECT (now() AT TIME ZONE 'Asia/Manila')::DATE AS today,
       (SELECT x::DATE FROM generate_series((now() AT TIME ZONE 'Asia/Manila')::DATE - 1, (now() AT TIME ZONE 'Asia/Manila')::DATE - 10, INTERVAL '-1 day') x
        WHERE EXTRACT(ISODOW FROM x) BETWEEN 1 AND 5 LIMIT 1) AS day1,
       (SELECT x::DATE FROM generate_series((now() AT TIME ZONE 'Asia/Manila')::DATE - 20, (now() AT TIME ZONE 'Asia/Manila')::DATE - 40, INTERVAL '-1 day') x
        WHERE EXTRACT(ISODOW FROM x) BETWEEN 1 AND 5 LIMIT 1) AS old_day;

SET LOCAL session_replication_role = replica;
INSERT INTO public.attendance_logs (id, employee_id, employee_name, branch_id, log_date, time_in, time_out, status, late_minutes, undertime_minutes)
SELECT '00000000-0000-4000-8000-00000000da01'::UUID, '00000000-0000-4000-8000-00000000dd01'::UUID, 'Cora Correct', '00000000-0000-4000-8000-00000000ddf1'::UUID, day1, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, 'Absent', 0, 0 FROM d
UNION ALL
SELECT '00000000-0000-4000-8000-00000000da02', '00000000-0000-4000-8000-00000000dd01', 'Cora Correct', '00000000-0000-4000-8000-00000000ddf1', old_day, NULL, NULL, 'Absent', 0, 0 FROM d;
SET LOCAL session_replication_role = origin;

DO $$
DECLARE
  cora CONSTANT UUID := '00000000-0000-4000-8000-00000000dd01';
  hugo CONSTANT UUID := '00000000-0000-4000-8000-00000000dde1';
  v_day DATE := (SELECT day1 FROM d);
  v_req public.attendance_corrections;
  v_prev JSONB;
  v_log public.attendance_logs;
  v_ok BOOLEAN;
BEGIN
  -- 1. Outside the filing window: refused.
  BEGIN
    PERFORM public.attendance_request_correction_v2('00000000-0000-4000-8000-00000000da02', cora, 'missing_in',
      ((SELECT old_day FROM d) || ' 08:00+08')::TIMESTAMPTZ, ((SELECT old_day FROM d) || ' 17:00+08')::TIMESTAMPTZ, 'forgot_in', NULL);
    RAISE EXCEPTION 'late filing accepted';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE 'File it within%', '1: ' || SQLERRM;
  END;

  -- 2. Bad input: time out before time in; a time on another date; "Other" without a reason.
  v_ok := FALSE;
  BEGIN PERFORM public.attendance_request_correction_v2('00000000-0000-4000-8000-00000000da01', cora, 'missing_in', (v_day || ' 17:00+08')::TIMESTAMPTZ, (v_day || ' 08:00+08')::TIMESTAMPTZ, 'forgot_in', NULL);
  EXCEPTION WHEN check_violation THEN v_ok := SQLERRM LIKE 'The time out must be after%'; END;
  ASSERT v_ok, '2: out before in';
  v_ok := FALSE;
  BEGIN PERFORM public.attendance_request_correction_v2('00000000-0000-4000-8000-00000000da01', cora, 'missing_in', ((v_day - 1) || ' 08:00+08')::TIMESTAMPTZ, (v_day || ' 17:00+08')::TIMESTAMPTZ, 'forgot_in', NULL);
  EXCEPTION WHEN check_violation THEN v_ok := SQLERRM LIKE 'The corrected times must be on%'; END;
  ASSERT v_ok, '2b: another date';
  v_ok := FALSE;
  BEGIN PERFORM public.attendance_request_correction_v2('00000000-0000-4000-8000-00000000da01', cora, 'missing_in', (v_day || ' 08:00+08')::TIMESTAMPTZ, (v_day || ' 17:00+08')::TIMESTAMPTZ, 'other', 'x');
  EXCEPTION WHEN check_violation THEN v_ok := SQLERRM LIKE 'Describe the reason%'; END;
  ASSERT v_ok, '2c: other needs a reason';

  -- 3. Absent (no taps) -> missing time in, both times: filed, the day is Pending Correction; usage 1.
  v_req := public.attendance_request_correction_v2('00000000-0000-4000-8000-00000000da01', cora, 'missing_in',
    (v_day || ' 08:00+08')::TIMESTAMPTZ, (v_day || ' 17:00+08')::TIMESTAMPTZ, 'card_not_working', NULL);
  ASSERT v_req.correction_type = 'both' AND v_req.original_status = 'Absent', '3: filed as both';
  ASSERT (SELECT status FROM public.attendance_logs WHERE id = '00000000-0000-4000-8000-00000000da01') = 'Pending Correction', '3b: pending';
  ASSERT public.attendance_corrections_used(cora, v_day) = 1, '3c: 1 used';

  -- 4. One open request per date.
  v_ok := FALSE;
  BEGIN PERFORM public.attendance_request_correction_v2('00000000-0000-4000-8000-00000000da01', cora, 'missing_in', (v_day || ' 08:00+08')::TIMESTAMPTZ, (v_day || ' 17:00+08')::TIMESTAMPTZ, 'forgot_in', NULL);
  EXCEPTION WHEN check_violation THEN v_ok := TRUE; WHEN unique_violation THEN v_ok := TRUE; END;
  ASSERT v_ok, '4: one open request per date';

  -- 5. Preview: the engine's day with the new times; nothing kept.
  v_prev := public.attendance_preview_correction(v_req.id);
  ASSERT v_prev->'before'->>'status' = 'Absent', '5: before';
  ASSERT v_prev->'after'->>'status' NOT IN ('Absent', 'Pending Correction', 'Incomplete'), '5b: after ' || (v_prev->'after'->>'status');
  ASSERT (SELECT status FROM public.attendance_logs WHERE id = '00000000-0000-4000-8000-00000000da01') = 'Pending Correction', '5c: nothing kept';

  -- 6. The employee cannot decide; HR approves: times applied, the day recalculated.
  v_ok := FALSE;
  BEGIN PERFORM public.attendance_review_correction_v2(v_req.id, 'approve', cora, 'Cora', NULL, NULL);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := TRUE; END;
  ASSERT v_ok, '6: not your own';
  v_req := public.attendance_review_correction_v2(v_req.id, 'approve', hugo, 'Hugo HR', 'ok', NULL);
  SELECT * INTO v_log FROM public.attendance_logs WHERE id = '00000000-0000-4000-8000-00000000da01';
  ASSERT v_req.status = 'approved' AND v_log.time_in IS NOT NULL AND v_log.time_out IS NOT NULL, '6b: times applied';
  ASSERT v_log.status = v_prev->'after'->>'status', format('6c: recalculated like the preview (%s vs %s)', v_log.status, v_prev->'after'->>'status');
  ASSERT v_req.original_time_in IS NULL AND v_req.original_status = 'Absent', '6d: the original taps stay on the request';
  ASSERT v_req.pay_correction_id IS NULL, '6e: no paid payslip: no adjustment';

  -- 7. The limit per cutoff (setting 1 for the test).
  UPDATE public.system_config SET value = '1' WHERE section = 'attendance' AND key = 'correction_max_per_cutoff';
  v_ok := FALSE;
  BEGIN PERFORM public.attendance_request_correction_v2('00000000-0000-4000-8000-00000000da01', cora, 'wrong_out', NULL, (v_day || ' 16:00+08')::TIMESTAMPTZ, 'forgot_out', NULL);
  EXCEPTION WHEN check_violation THEN v_ok := SQLERRM LIKE 'You have used all 1%'; END;
  ASSERT v_ok, '7: limit per cutoff';

  RAISE NOTICE 'all attendance correction request scenarios passed';
END $$;

ROLLBACK;
