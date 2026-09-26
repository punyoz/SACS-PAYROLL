-- ═══════════════════════════════════════════════════════════════════════════
-- attendance_close_days: read leave dates as dates
-- ═══════════════════════════════════════════════════════════════════════════
--
-- leave_requests.start_date / end_date are TEXT ("YYYY-MM-DD"), but the
-- approved-leave check compared them with a DATE:
--
--     d.day BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
--
-- Postgres has no date >= text operator, so every call whose range included
-- a finished day failed with 42883 -- since
-- 20260926010000_attendance_status_engine.sql. The nightly close recorded no
-- Absent days, and the payroll and attendance screens, which run this before
-- reading, treated the engine as not ready.
--
-- The dates are now cast, and only when they are well-formed: a CASE is
-- evaluated in order, so one malformed row is skipped instead of failing the
-- whole close. Otherwise the function is unchanged from
-- 20260926100000_schema_tidy_up.sql.
--
-- Safe to run more than once.

CREATE OR REPLACE FUNCTION public.attendance_close_days(p_from DATE, p_to DATE)
RETURNS JSONB
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
    SELECT pr.id, pr.full_name, pr.employee_type, NULL, NULL, 0, 'Absent', d.day, pr.branch_id
    FROM public.profiles pr
    CROSS JOIN LATERAL (
      SELECT gs::DATE AS day FROM generate_series(p_from, v_last_closed, INTERVAL '1 day') gs
    ) d
    WHERE lower(pr.role::TEXT) IN ('employee', 'accountant')
      AND COALESCE(pr.archived, FALSE) = FALSE
      AND lower(COALESCE(pr.employee_status, 'active')) <> 'inactive'
      AND d.day >= COALESCE(pr.date_hired, pr.created_at::DATE)
      AND NOT public.attendance_is_rest_day(d.day)
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_logs l
        WHERE l.employee_id = pr.id AND l.log_date = d.day AND l.archived_duplicate = FALSE
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.leave_requests lr
        WHERE lower(lr.status) = 'approved'
          AND lr.employee_id = pr.id
          AND d.day BETWEEN
            (CASE WHEN lr.start_date ~ '^\d{4}-\d{2}-\d{2}$' THEN lr.start_date::DATE END)
            AND
            (CASE WHEN COALESCE(NULLIF(lr.end_date, ''), lr.start_date) ~ '^\d{4}-\d{2}-\d{2}$'
                  THEN COALESCE(NULLIF(lr.end_date, ''), lr.start_date)::DATE END)
      )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_absent = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('reevaluated', v_reevaluated, 'absent_inserted', v_absent);
END;
$function$;

REVOKE ALL ON FUNCTION public.attendance_close_days(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_close_days(DATE, DATE) TO service_role;
