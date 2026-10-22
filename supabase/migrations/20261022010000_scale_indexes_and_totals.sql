-- Scale: 1,000+ employees, 5 years (scenario catalog SCENARIOS.md, SC-*).
-- Measured on the local scale dataset (1.56M attendance rows, 142k payslips,
-- 1M audit rows) on 2026-10-22. Additive only: indexes and one read-only
-- function; nothing is changed or removed.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Audit log search (Super Admin → Audit & Monitoring, HR-07 / SA-03): words
-- anywhere in the description or the actor's name. 556 ms → a few ms.
CREATE INDEX IF NOT EXISTS audit_logs_description_trgm_idx
  ON public.audit_logs USING gin (description extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_logs_actor_name_trgm_idx
  ON public.audit_logs USING gin (actor_name extensions.gin_trgm_ops);
-- Filters by module and by person, newest first.
CREATE INDEX IF NOT EXISTS audit_logs_module_created_idx
  ON public.audit_logs (module, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_created_idx
  ON public.audit_logs (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;

-- A branch's attendance over a date range (Admin daily view, HR filters):
-- the branch index alone walked 234k rows for one branch-month.
CREATE INDEX IF NOT EXISTS attendance_logs_branch_date_idx
  ON public.attendance_logs (branch_id, log_date DESC) WHERE archived_duplicate = FALSE;

-- HR → Payroll Records lists processed payslips newest first, a page at a time.
CREATE INDEX IF NOT EXISTS payroll_entries_updated_idx
  ON public.payroll_entries (updated_at DESC, id) WHERE status <> 'draft';

-- The totals of the payslips HR's Payroll Records filters match, summed in
-- the database instead of in the browser over every payslip.
CREATE OR REPLACE FUNCTION public.payroll_entries_totals(p_period TEXT, p_branch UUID, p_q TEXT)
RETURNS TABLE (entries BIGINT, gross NUMERIC, deductions NUMERIC, net NUMERIC)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    COUNT(*),
    COALESCE(SUM(COALESCE((e.payroll #>> '{monthly,cutoff,gross_pay}')::NUMERIC, (e.payroll #>> '{totals,gross_pay}')::NUMERIC, e.gross_pay, 0)), 0),
    COALESCE(SUM(COALESCE((e.payroll #>> '{totals,total_deductions}')::NUMERIC, e.total_deductions, 0)), 0),
    COALESCE(SUM(GREATEST(0, COALESCE((e.payroll #>> '{totals,net_pay}')::NUMERIC, e.net_pay, 0))), 0)
  FROM public.payroll_entries e
  WHERE e.status <> 'draft'
    AND (p_period IS NULL OR e.pay_period = p_period)
    AND (p_branch IS NULL OR e.branch_id = p_branch)
    AND (p_q IS NULL OR e.employee_name ILIKE '%' || p_q || '%' OR e.employee_code ILIKE '%' || p_q || '%'
      OR e.payslip_no ILIKE '%' || p_q || '%' OR e.pay_period ILIKE '%' || p_q || '%');
$$;

REVOKE ALL ON FUNCTION public.payroll_entries_totals(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_entries_totals(TEXT, UUID, TEXT) TO service_role;

-- attendance_close_days: the same work, the cheap test first. The planner
-- called attendance_is_rest_day_for() and attendance_approved_leave() for
-- every employee-day (12,090 for 1,200 people x 14 days, ~0.33 ms each)
-- before the index test that removes the days already recorded, so every
-- Process Payroll load spent ~4 s here even with nothing to insert (scale
-- test 2026-10-22). Days with a row are now dropped first (MATERIALIZED), and
-- the two functions run only on the days really missing. Same rows, same
-- result; nothing else changed.
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
    WITH missing AS MATERIALIZED (
      SELECT pr.id, pr.full_name, pr.employee_type, pr.branch_id, d.day
      FROM public.profiles pr
      CROSS JOIN LATERAL (
        SELECT gs::DATE AS day FROM generate_series(p_from, v_last_closed, INTERVAL '1 day') gs
      ) d
      WHERE lower(pr.role::TEXT) IN ('employee', 'accountant')
        AND COALESCE(pr.archived, FALSE) = FALSE
        AND lower(COALESCE(pr.employee_status, 'active')) <> 'inactive'
        AND d.day >= COALESCE(pr.date_hired, pr.created_at::DATE)
        AND NOT EXISTS (
          SELECT 1 FROM public.attendance_logs l
          WHERE l.employee_id = pr.id AND l.log_date = d.day AND l.archived_duplicate = FALSE
        )
    )
    INSERT INTO public.attendance_logs
      (employee_id, employee_name, employee_type, time_in, time_out, total_hours, status, log_date, branch_id)
    SELECT m.id, m.full_name, m.employee_type, NULL, NULL, 0, 'Absent', m.day, m.branch_id
    FROM missing m
    WHERE NOT EXISTS (SELECT 1 FROM public.attendance_approved_leave(m.id, m.day))
      AND NOT public.attendance_is_rest_day_for(m.id, m.branch_id, m.day)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_absent = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('reevaluated', v_reevaluated, 'absent_inserted', v_absent);
END;
$function$;

-- The database's size, for the Super Admin's health panel (SC-14 / decision
-- 2026-10-22: stay online, move to Supabase Pro before the Free plan's
-- 500 MB, warned at 350 MB).
CREATE OR REPLACE FUNCTION public.system_database_size()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_database_size(current_database());
$$;

REVOKE ALL ON FUNCTION public.system_database_size() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.system_database_size() TO service_role;
