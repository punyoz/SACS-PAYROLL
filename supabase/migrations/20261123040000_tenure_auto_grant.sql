-- ═══════════════════════════════════════════════════════════════════════════
-- Part G (2026-11-22, user decision: automate the EXISTING Tenure Pay
-- Protection; no new earning). A setting and functions, plus two NON-additive changes raised in the release
-- plan: granted_by may be empty (a system grant), and the grants guard accepts the System's grant.
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

-- A system grant has no person behind it: granted_by (a profile) may be empty;
-- granted_by_role 'system' and granted_by_name 'System' say who. Relaxes a
-- NOT NULL only (existing rows and writers are unaffected).
ALTER TABLE public.tenure_protection_grants ALTER COLUMN granted_by DROP NOT NULL;

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'tenure', 'eligible_statuses', 'Regular', 'System'
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'tenure' AND c.key = 'eligible_statuses');

/** The first day of the cutoff containing a date: the 1st (days 1-15) or the 16th. */
CREATE OR REPLACE FUNCTION public.cutoff_start_of(p_day DATE)
 RETURNS DATE LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE WHEN EXTRACT(DAY FROM p_day) <= 15 THEN date_trunc('month', p_day)::DATE ELSE (date_trunc('month', p_day)::DATE + 15) END;
$function$;

/**
 * The grants guard (20261110010000_hr_on_payroll.sql), unchanged for people,
 * plus the System's grant (Part G). Replaces that function: raised in the
 * Batch 2 release plan as the one non-additive change.
 */
CREATE OR REPLACE FUNCTION public.tenure_protection_grants_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_role TEXT;
  v_employee_role TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A Tenure Pay Protection grant is never deleted: revoke it instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Part G (2026-11-22): the System's years-of-service grant (public.tenure_auto_grant,
  -- run by the scheduled job inside the database, never through the API: no JWT
  -- claims). It has no person behind it, and it may start at the cutoff in
  -- progress (never earlier; the job checks the cutoff is not processed yet).
  IF TG_OP = 'INSERT' AND NEW.granted_by IS NULL AND NEW.granted_by_role = 'system'
     AND COALESCE(current_setting('request.jwt.claims', true), '') = '' THEN
    v_employee_role := public.tenure_protection_actor_role(NEW.employee_id);
    IF v_employee_role IS NULL OR v_employee_role NOT IN ('employee', 'accountant', 'hr') THEN
      RAISE EXCEPTION 'Tenure Pay Protection is granted to employees, accountants and HR only.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.effective_from < public.cutoff_start_of(v_today) THEN
      RAISE EXCEPTION 'A system grant cannot take effect before the cutoff in progress.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_on IS NOT NULL THEN
      RAISE EXCEPTION 'A new grant cannot already be revoked.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.granted_by_name := 'System';
    NEW.granted_at := NOW();
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_role := public.tenure_protection_actor_role(NEW.granted_by);
    IF v_role IS NULL OR v_role <> 'hr' THEN
      RAISE EXCEPTION 'Only HR can grant Tenure Pay Protection.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_employee_role := public.tenure_protection_actor_role(NEW.employee_id);
    IF v_employee_role IS NULL OR v_employee_role NOT IN ('employee', 'accountant', 'hr') THEN
      RAISE EXCEPTION 'Tenure Pay Protection is granted to employees, accountants and HR only.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.effective_from < v_today THEN
      RAISE EXCEPTION 'A grant cannot take effect before today: payroll already worked out is never recalculated.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_on IS NOT NULL THEN
      RAISE EXCEPTION 'A new grant cannot already be revoked.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.granted_by_role := v_role;
    NEW.granted_at := NOW();
    RETURN NEW;
  END IF;

  -- UPDATE: only revoking, once.
  IF OLD.revoked_on IS NOT NULL THEN
    RAISE EXCEPTION 'This grant is already revoked; its history is kept as it is.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.granted_by_name IS DISTINCT FROM OLD.granted_by_name
     OR NEW.granted_by_role IS DISTINCT FROM OLD.granted_by_role
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'A grant is never edited: revoke it and grant it again.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_on IS NULL THEN
    RAISE EXCEPTION 'Revoking needs the date protection ends.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_on < v_today THEN
    RAISE EXCEPTION 'Protection can only end today or later: past payroll is never changed.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_role := public.tenure_protection_actor_role(NEW.revoked_by);
  IF v_role IS NULL OR v_role <> 'hr' THEN
    RAISE EXCEPTION 'Only HR can revoke Tenure Pay Protection.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.revoked_by_role := v_role;
  NEW.revoked_at := NOW();
  RETURN NEW;
END;
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
      -- every account on payroll (HR, Accountant, Employee); Admin / Super Admin never, whatever the flag says (user decisions 2026-11-22)
      AND lower(p.role::TEXT) IN ('employee', 'accountant', 'hr')
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
