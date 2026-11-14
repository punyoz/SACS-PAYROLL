-- ════════════════════════════════════════════════════════════════════════════
-- Separated staff are not "missing" after their last day (decision 2026-11-14).
--
-- attendance_missing_days (20261114010000, the nightly close's rule) skips an
-- employee with status 'Separated' for every day AFTER separated_on (their last
-- day, as Final Pay reads it). Days up to and including the last day still
-- count. The nightly close inserts from this function, so it stops writing
-- Absent records for them after that day too. Absent records already written
-- are not touched. A 'Separated' status without a date keeps the old rule.
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
      AND NOT (lower(COALESCE(pr.employee_status, '')) = 'separated' AND pr.separated_on IS NOT NULL AND d.day > pr.separated_on)
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
