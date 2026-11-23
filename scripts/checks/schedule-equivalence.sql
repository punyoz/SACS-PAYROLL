-- ═══════════════════════════════════════════════════════════════════════════
-- Old vs new attendance_schedule_for (20261124130000), on whatever data the
-- database has (the local stack or a local copy of the live backup). With no
-- special working day declared, the new function must return exactly what the
-- old one did, for every person and every day from the first attendance record
-- to 30 days ahead. Then one
-- declared day changes only the covered person on that date. Rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/schedule-equivalence.sql
-- Ends with NOTICE "schedule: old and new agree on N person-days".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;
UPDATE public.special_working_days SET cancelled_at = NOW() WHERE cancelled_at IS NULL;

DO $$
DECLARE
  n INTEGER;
  bad INTEGER;
  who UUID;
  b UUID;
  d DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE + 3;
BEGIN
  -- Every profile (archived and off-payroll too), every day from the first attendance record to 30 days ahead.
  WITH people AS (
    SELECT id, branch_id FROM public.profiles
  ), days AS (
    SELECT gs::DATE AS day FROM generate_series(
      LEAST(COALESCE((SELECT MIN(log_date) FROM public.attendance_logs), (NOW() AT TIME ZONE 'Asia/Manila')::DATE - 30), (NOW() AT TIME ZONE 'Asia/Manila')::DATE - 30),
      (NOW() AT TIME ZONE 'Asia/Manila')::DATE + 30, INTERVAL '1 day') gs
  ), cmp AS (
    SELECT (SELECT row_to_json(o) FROM public.attendance_schedule_base_for(p.id, p.branch_id, d.day) o)::TEXT AS old_s,
           (SELECT row_to_json(x) FROM public.attendance_schedule_for(p.id, p.branch_id, d.day) x)::TEXT AS new_s
    FROM people p CROSS JOIN days d
  )
  SELECT COUNT(*), COUNT(*) FILTER (WHERE old_s IS DISTINCT FROM new_s) INTO n, bad FROM cmp;
  ASSERT n > 0, 'nobody to compare';
  ASSERT bad = 0, format('%s of %s person-days differ with no special day declared', bad, n);

  -- One declared day: only that person, only that date.
  SELECT id, branch_id INTO who, b FROM public.profiles WHERE on_payroll AND NOT COALESCE(archived, FALSE) AND branch_id IS NOT NULL LIMIT 1;
  INSERT INTO public.special_working_days (work_date, branch_ids, audience, employee_ids, start_time, end_time, reason, pay_type)
  VALUES (d, ARRAY[b], 'employees', ARRAY[who], '07:30', '11:30', 'Equivalence check', 'makeup');
  ASSERT (SELECT source FROM public.attendance_schedule_for(who, b, d)) = 'special_day', 'the covered person gets the day';
  ASSERT (SELECT row_to_json(x)::TEXT FROM public.attendance_schedule_for(who, b, d + 1) x)
       = (SELECT row_to_json(o)::TEXT FROM public.attendance_schedule_base_for(who, b, d + 1) o), 'the next day is unchanged';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.on_payroll AND NOT COALESCE(p.archived, FALSE) AND p.id <> who
      AND (SELECT row_to_json(x)::TEXT FROM public.attendance_schedule_for(p.id, p.branch_id, d) x)
          IS DISTINCT FROM (SELECT row_to_json(o)::TEXT FROM public.attendance_schedule_base_for(p.id, p.branch_id, d) o)), 'nobody else changes';
  RAISE NOTICE 'schedule: old and new agree on % person-days', n;
END $$;
ROLLBACK;
