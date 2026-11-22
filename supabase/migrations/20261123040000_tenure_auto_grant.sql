-- ═══════════════════════════════════════════════════════════════════════════
-- Part G (2026-11-22, user decision: automate the EXISTING Tenure Pay
-- Protection; no new earning). Additive: a setting and three functions.
-- The daily job is NOT scheduled here: the first-run list is reviewed first
-- (tenure_auto_grant_candidates), then the job is enabled on the user's yes:
--   SELECT cron.schedule('tenure-auto-grant', '45 16 * * *', 'SELECT public.tenure_auto_grant();');
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Eligible: any account on payroll (HR, Accountant or Employee), active, an eligible employment status (setting
-- tenure.eligible_statuses, default Regular; pending the policy manual), at
-- least the policy's min_tenure_years (default 2) of continuous service, and
-- the branch's (or the school-wide) policy active; not protected now; never
-- revoked by HR since the service started (only HR re-grants). Continuous
-- service starts at date hired, or at the last return after a separation
-- (status history) — a break restarts the count.
-- A grant NEVER applies backwards (user decision 2026-11-22): it takes effect
-- from the cutoff in progress on the day it is granted, or the next one when
-- that cutoff's branch run is already submitted or approved. A new
-- anniversary reached while the job runs daily falls in the cutoff in
-- progress, so it takes effect from the cutoff containing it; someone already
-- past it at the first run (or whose date hired is filled in later) starts
-- from the current cutoff, never the old anniversary. No retroactive
-- adjustments; processed payslips are stored and never change. Logged "by System, rule: N years of service"; HR and the
-- employee are notified. Existing manual grants stay as they are.

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'tenure', 'eligible_statuses', 'Regular', 'System'
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'tenure' AND c.key = 'eligible_statuses');

/** The first day of the cutoff containing a date: the 1st (days 1-15) or the 16th. */
CREATE OR REPLACE FUNCTION public.cutoff_start_of(p_day DATE)
 RETURNS DATE LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE WHEN EXTRACT(DAY FROM p_day) <= 15 THEN date_trunc('month', p_day)::DATE ELSE (date_trunc('month', p_day)::DATE + 15) END;
$function$;

/** The first day of the cutoff after the one starting on p_start. */
CREATE OR REPLACE FUNCTION public.next_cutoff_start(p_start DATE)
 RETURNS DATE LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE WHEN EXTRACT(DAY FROM p_start) = 1 THEN p_start + 15 ELSE (date_trunc('month', p_start) + INTERVAL '1 month')::DATE END;
$function$;

/** The cutoff a grant made on p_today starts from: the one in progress, or the next if its branch run is submitted / approved. */
CREATE OR REPLACE FUNCTION public.tenure_grant_start(p_branch UUID, p_today DATE)
 RETURNS DATE LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.branch_id = p_branch AND r.period_start = public.cutoff_start_of(p_today)
                                                            AND r.status IN ('pending', 'approved'))
              THEN public.next_cutoff_start(public.cutoff_start_of(p_today))
              ELSE public.cutoff_start_of(p_today) END;
$function$;
REVOKE ALL ON FUNCTION public.tenure_grant_start(UUID, DATE) FROM PUBLIC, anon, authenticated;

/** Who the job would grant today, and from when (also the first-run review list). */
CREATE OR REPLACE FUNCTION public.tenure_auto_grant_candidates(p_today DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::DATE))
 RETURNS TABLE (employee_id UUID, full_name TEXT, employee_code TEXT, branch_id UUID, employment_status TEXT, date_hired DATE,
                service_start DATE, years NUMERIC, anniversary DATE, effective_from DATE)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH statuses AS (
    SELECT string_to_array(regexp_replace(COALESCE(
      (SELECT value FROM public.system_config WHERE section = 'tenure' AND key = 'eligible_statuses' LIMIT 1), 'Regular'), '\s*,\s*', ',', 'g'), ',') AS list
  ), people AS (
    SELECT p.id, p.full_name, p.employee_id AS code, p.branch_id, p.employment_status, p.date_hired::DATE AS date_hired,
           -- a break in service (Separated, then back) restarts the count
           GREATEST(p.date_hired::DATE, COALESCE((SELECT MAX(c.effective_on) FROM public.employee_status_changes c
                                                  WHERE c.employee_id = p.id AND c.old_status = 'Separated' AND c.new_status = 'Active'), p.date_hired::DATE)) AS service_start,
           COALESCE(bp.min_tenure_years, gp.min_tenure_years) AS years,
           COALESCE(CASE WHEN bp.id IS NOT NULL THEN bp.is_active END, gp.is_active, FALSE) AS active
    FROM public.profiles p
    CROSS JOIN statuses s
    LEFT JOIN public.tenure_protection_policies bp ON bp.branch_id = p.branch_id AND NOT COALESCE(bp.use_global, FALSE)
    LEFT JOIN public.tenure_protection_policies gp ON gp.branch_id IS NULL
    WHERE p.archived = FALSE AND p.on_payroll AND COALESCE(p.employee_status, 'Active') = 'Active'
      -- every account on payroll, whatever its login role (user decision 2026-11-22)
      AND p.date_hired IS NOT NULL
      AND p.employment_status = ANY (s.list)
  )
  SELECT pe.id, pe.full_name, pe.code, pe.branch_id, pe.employment_status, pe.date_hired, pe.service_start, pe.years,
         (pe.service_start + make_interval(months => (pe.years * 12)::INTEGER))::DATE AS anniversary,
         -- never backwards: the cutoff in progress today (or the next if processed), not the old anniversary
         public.tenure_grant_start(pe.branch_id, p_today) AS effective_from
  FROM people pe
  WHERE pe.active AND pe.years IS NOT NULL
    AND (pe.service_start + make_interval(months => (pe.years * 12)::INTEGER))::DATE <= p_today
    -- protected now: nothing to do
    AND NOT EXISTS (SELECT 1 FROM public.tenure_protection_grants g WHERE g.employee_id = pe.id AND (g.revoked_on IS NULL OR g.revoked_on > p_today))
    -- HR revoked it since the service started: never re-granted automatically (only HR re-grants)
    AND NOT EXISTS (SELECT 1 FROM public.tenure_protection_grants g WHERE g.employee_id = pe.id AND g.revoked_on IS NOT NULL
                    AND g.revoked_by_role IS DISTINCT FROM 'system' AND g.granted_at::DATE >= pe.service_start)
  ORDER BY pe.full_name;
$function$;
REVOKE ALL ON FUNCTION public.tenure_auto_grant_candidates(DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tenure_auto_grant(p_today DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::DATE))
 RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  WITH granted AS (
    INSERT INTO public.tenure_protection_grants (employee_id, effective_from, notes, granted_by, granted_by_name, granted_by_role, granted_at)
    SELECT c.employee_id, c.effective_from,
           format('by System, rule: %s years of service (service from %s)', trim(to_char(c.years, 'FM990.##')), to_char(c.service_start, 'Mon DD, YYYY')),
           NULL, 'System', 'system', NOW()
    FROM public.tenure_auto_grant_candidates(p_today) c
    RETURNING employee_id, effective_from
  ), told AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT g.employee_id, 'tenure_granted', 'Tenure Pay Protection granted',
           format('You have it from %s, by the years-of-service rule. HR checks it.', to_char(g.effective_from, 'Mon DD, YYYY')), 'emp-dash'
    FROM granted g
    UNION ALL
    SELECT h.id, 'tenure_granted_hr', 'Tenure Pay Protection granted by the system',
           format('%s, from %s (rule: years of service). Check it; revoke with a reason if it does not apply.', COALESCE(p.full_name, 'An employee'), to_char(g.effective_from, 'Mon DD, YYYY')), 'hr-tenure'
    FROM granted g JOIN public.profiles p ON p.id = g.employee_id
    JOIN public.profiles h ON h.role = 'hr' AND h.archived = FALSE
    RETURNING 1
  ), logged AS (
    INSERT INTO public.audit_logs (module, action, entity_type, entity_id, description, status, source, metadata, is_system_event, actor_name, actor_role)
    SELECT 'hr', 'tenure_auto_grant', 'tenure_protection_grant', g.employee_id::TEXT,
           format('Tenure Pay Protection granted by System from %s (rule: years of service).', g.effective_from), 'success', 'system',
           jsonb_build_object('employee_id', g.employee_id, 'effective_from', g.effective_from), TRUE, 'System', 'system'
    FROM granted g
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM granted;
  RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.tenure_auto_grant(DATE) FROM PUBLIC, anon, authenticated;
