-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 3, Part E step 3 (2026-11-23): schedule requests and new hires.
-- (The approved-request apply is in the HR route: src/lib/automation/schedule-requests.js.)
-- Nightly, nothing while paused:
--   past_date        a PENDING schedule request whose start date has passed:
--                    flagged to HR (once) — decide it or ask the Admin for a new date
--   new_hire_default a new hire (date hired in the last 30 days): the schedule the
--                    system uses for them (own, level or school default) is noted,
--                    "by System"; when their level is not set, a flag for HR
--                    (the school default applies until it is)
-- Additive: one function, one daily job.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.automation_schedule_checks(p_today DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::DATE))
 RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_past INTEGER := 0;
  v_hires INTEGER := 0;
  v_sched RECORD;
BEGIN
  IF public.automation_paused() THEN RETURN jsonb_build_object('paused', TRUE); END IF;

  -- 1. Pending schedule requests whose start date has passed.
  FOR r IN
    SELECT q.id, q.employee_id, q.branch_id, q.details
    FROM public.branch_admin_requests q
    WHERE q.kind = 'schedule_request' AND q.status = 'pending'
      AND (q.details->>'effective_from') ~ '^\d{4}-\d{2}-\d{2}$' AND (q.details->>'effective_from')::DATE < p_today
      AND NOT EXISTS (SELECT 1 FROM public.automation_actions a WHERE a.module = 'schedule_requests' AND a.entity_id = q.id::TEXT AND a.data->>'code' = 'past_date')
  LOOP
    IF public.automation_log('schedule_requests', 'a pending schedule request whose start date has passed', 'flag',
         format('%s: schedule request from %s is still pending and its date has passed', COALESCE(r.details->>'employee_name', 'An employee'), r.details->>'effective_from'),
         jsonb_build_object('code', 'past_date', 'effective_from', r.details->>'effective_from', 'schedule_name', r.details->>'schedule_name'),
         r.employee_id, r.branch_id, 'branch_request', r.id::TEXT, (r.details->>'effective_from')::DATE) IS NOT NULL THEN
      v_past := v_past + 1;
    END IF;
  END LOOP;

  -- 2. New hires: the schedule in use, noted once; a flag when the level is not set.
  FOR r IN
    SELECT p.id, p.full_name, p.branch_id, p.employee_level, p.date_hired::DATE AS hired
    FROM public.profiles p
    WHERE p.archived = FALSE AND p.on_payroll AND lower(p.role::TEXT) IN ('employee', 'accountant', 'hr')
      AND p.date_hired IS NOT NULL AND p.date_hired::DATE BETWEEN p_today - 30 AND p_today + 30
      AND NOT EXISTS (SELECT 1 FROM public.automation_actions a WHERE a.module = 'schedule_requests' AND a.employee_id = p.id AND a.data->>'code' IN ('new_hire_default', 'new_hire_no_level'))
  LOOP
    SELECT s.schedule_name, s.source, s.work_start, s.work_end INTO v_sched
    FROM public.attendance_schedule_for(r.id, r.branch_id, GREATEST(r.hired, p_today)) s;
    IF r.employee_level IS NULL THEN
      PERFORM public.automation_log('schedule_requests', 'a new hire with no level set: the school default schedule applies', 'flag',
        format('%s (hired %s): no level set; using %s until it is', r.full_name, to_char(r.hired, 'Mon DD'), COALESCE(v_sched.schedule_name, 'the school default')),
        jsonb_build_object('code', 'new_hire_no_level', 'schedule_name', v_sched.schedule_name, 'source', v_sched.source), r.id, r.branch_id);
    ELSE
      PERFORM public.automation_log('schedule_requests', 'default schedule for a new hire', 'applied',
        format('%s (hired %s): %s (%s)', r.full_name, to_char(r.hired, 'Mon DD'), COALESCE(v_sched.schedule_name, 'school default'), COALESCE(v_sched.source, 'default')),
        jsonb_build_object('code', 'new_hire_default', 'schedule_name', v_sched.schedule_name, 'source', v_sched.source, 'level', r.employee_level), r.id, r.branch_id);
    END IF;
    v_hires := v_hires + 1;
  END LOOP;

  -- 3. A flag closes once fixed: the request was decided / the level was set.
  UPDATE public.automation_actions a SET status = 'closed', closed_at = NOW(), closed_note = 'Decided by HR.', updated_at = NOW()
  WHERE a.module = 'schedule_requests' AND a.status = 'open' AND a.data->>'code' = 'past_date'
    AND EXISTS (SELECT 1 FROM public.branch_admin_requests q WHERE q.id::TEXT = a.entity_id AND q.status <> 'pending');
  UPDATE public.automation_actions a SET status = 'closed', closed_at = NOW(), closed_note = 'Level set.', updated_at = NOW()
  WHERE a.module = 'schedule_requests' AND a.status = 'open' AND a.data->>'code' = 'new_hire_no_level'
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = a.employee_id AND p.employee_level IS NOT NULL);

  RETURN jsonb_build_object('past_date', v_past, 'new_hires', v_hires);
END;
$function$;
REVOKE ALL ON FUNCTION public.automation_schedule_checks(DATE) FROM PUBLIC, anon, authenticated;

-- Nightly at 00:40 Manila (16:40 UTC). Nothing while paused.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('automation-schedule-checks', '40 16 * * *', 'SELECT public.automation_schedule_checks();');
  END IF;
END $$;
