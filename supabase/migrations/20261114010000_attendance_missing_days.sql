-- ════════════════════════════════════════════════════════════════════════════
-- One rule for "who is missing on a day" (decision 2026-11-14).
--
-- The nightly close (attendance_close_days) decided inline who gets an Absent
-- record. That query moves, unchanged, into attendance_missing_days(), and the
-- close now inserts from it. The app's "Absent today" cards and the boards'
-- "Not tapped yet" lists call the same function for today, so a card, its
-- list and the Absent records the close writes later always agree:
--
--   role employee / accountant / hr, not archived, status not 'inactive',
--   hired on or before the day, no attendance record that day,
--   no approved leave (attendance_approved_leave), and not a rest day for
--   that person (attendance_is_rest_day_for: their schedule's working days
--   and the holidays / suspensions that apply to their branch).
--
-- attendance_close_days behaves exactly as in 20261110010000 (same days, same
-- people, same rows); only where the list comes from changed.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.attendance_missing_days(p_from DATE, p_to DATE)
RETURNS TABLE (employee_id UUID, full_name TEXT, employee_type TEXT, branch_id UUID, day DATE)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH missing AS MATERIALIZED (
    SELECT pr.id, pr.full_name, pr.employee_type, pr.branch_id, d.day
    FROM public.profiles pr
    CROSS JOIN LATERAL (
      SELECT gs::DATE AS day FROM generate_series(p_from, p_to, INTERVAL '1 day') gs
    ) d
    WHERE lower(pr.role::TEXT) IN ('employee', 'accountant', 'hr')
      AND COALESCE(pr.archived, FALSE) = FALSE
      AND lower(COALESCE(pr.employee_status, 'active')) <> 'inactive'
      AND d.day >= COALESCE(pr.date_hired, pr.created_at::DATE)
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_logs l
        WHERE l.employee_id = pr.id AND l.log_date = d.day AND l.archived_duplicate = FALSE
      )
  )
  SELECT m.id, m.full_name, m.employee_type, m.branch_id, m.day
  FROM missing m
  WHERE NOT EXISTS (SELECT 1 FROM public.attendance_approved_leave(m.id, m.day))
    AND NOT public.attendance_is_rest_day_for(m.id, m.branch_id, m.day);
$function$;

REVOKE ALL ON FUNCTION public.attendance_missing_days(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_missing_days(DATE, DATE) TO service_role;

CREATE OR REPLACE FUNCTION public.attendance_close_days(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_last_closed DATE := LEAST(p_to, v_today - 1);
  v_reevaluated INTEGER := 0;
  v_absent INTEGER := 0;
BEGIN
  PERFORM set_config('app.change_source', 'day_close', true);
  PERFORM set_config('app.actor_id', COALESCE('', ''), true);
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RETURN jsonb_build_object('reevaluated', 0, 'absent_inserted', 0);
  END IF;

  UPDATE public.attendance_logs
  SET status_computed_at = NOW()
  WHERE time_in IS NOT NULL
    AND time_out IS NULL
    AND archived_duplicate = FALSE
    AND status NOT IN ('Incomplete', 'Pending Correction', 'Corrected')
    AND log_date BETWEEN p_from AND LEAST(p_to, v_today);
  GET DIAGNOSTICS v_reevaluated = ROW_COUNT;

  IF v_last_closed >= p_from THEN
    INSERT INTO public.attendance_logs
      (employee_id, employee_name, employee_type, time_in, time_out, total_hours, status, log_date, branch_id)
    SELECT m.employee_id, m.full_name, m.employee_type, NULL, NULL, 0, 'Absent', m.day, m.branch_id
    FROM public.attendance_missing_days(p_from, v_last_closed) m
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_absent = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('reevaluated', v_reevaluated, 'absent_inserted', v_absent);
END;
$function$;
