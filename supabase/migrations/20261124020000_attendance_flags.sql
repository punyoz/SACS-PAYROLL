-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 3, Part E step 2 (2026-11-23): attendance flags. Each night (after the
-- attendance close) the system looks at yesterday and flags, per employee:
--   missing_tap        Incomplete (a time-in or a time-out is missing)
--   absent_no_request  Absent, no taps, no leave filed
--   short_day          Undertime / Absent (short day), no half day or leave filed
--   overtime_unfiled   worked past the shift end by automation.overtime_unfiled_minutes
--                      (default 30) with no overtime request for the day
--   late_pattern       automation.late_pattern_count (default 3) late days this cutoff
--   undertime_pattern  automation.undertime_pattern_count (default 3) undertime days this cutoff
-- The employee is told what to file (a time correction, a leave or half day,
-- a late overtime request); "The system found these to fix" on their
-- attendance page opens the correction already filled in. A flag closes by
-- itself when fixed (the day changed, or the request was filed). Never on a
-- branch-day where most people have no taps (a device / data problem), never
-- for Admin / Super Admin, nothing while automation is paused.
-- Additive: settings, two functions, one daily job.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'automation', v.key, v.value, 'System'
FROM (VALUES ('late_pattern_count', '3'), ('undertime_pattern_count', '3'), ('overtime_unfiled_minutes', '30')) v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'automation' AND c.key = v.key);

/** Is this attendance flag fixed now? (the day changed, or the request was filed) */
CREATE OR REPLACE FUNCTION public.automation_attendance_flag_fixed(p_rule TEXT, p_log UUID, p_employee UUID, p_day DATE)
 RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT CASE p_rule
    WHEN 'missing_tap' THEN NOT EXISTS (SELECT 1 FROM public.attendance_logs l WHERE l.id = p_log AND l.status = 'Incomplete')
      OR EXISTS (SELECT 1 FROM public.attendance_corrections c WHERE c.log_id = p_log AND c.status IN ('pending', 'approved'))
    WHEN 'absent_no_request' THEN NOT EXISTS (SELECT 1 FROM public.attendance_logs l WHERE l.id = p_log AND l.status = 'Absent' AND l.time_in IS NULL AND l.time_out IS NULL)
      OR EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.employee_id::TEXT = p_employee::TEXT AND lower(r.status) NOT IN ('rejected', 'cancelled', 'denied')
                 AND r.start_date::TEXT <= p_day::TEXT AND r.end_date::TEXT >= p_day::TEXT)
      OR EXISTS (SELECT 1 FROM public.attendance_corrections c WHERE c.log_id = p_log AND c.status IN ('pending', 'approved'))
    WHEN 'short_day' THEN NOT EXISTS (SELECT 1 FROM public.attendance_logs l WHERE l.id = p_log AND l.status IN ('Undertime', 'Absent (short day)'))
      OR EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.employee_id::TEXT = p_employee::TEXT AND lower(r.status) NOT IN ('rejected', 'cancelled', 'denied')
                 AND r.start_date::TEXT <= p_day::TEXT AND r.end_date::TEXT >= p_day::TEXT)
      OR EXISTS (SELECT 1 FROM public.attendance_corrections c WHERE c.log_id = p_log AND c.status IN ('pending', 'approved'))
    WHEN 'overtime_unfiled' THEN EXISTS (SELECT 1 FROM public.overtime_requests o WHERE o.employee_id = p_employee AND o.request_date = p_day AND o.status <> 'cancelled')
    ELSE FALSE END;
$function$;
REVOKE ALL ON FUNCTION public.automation_attendance_flag_fixed(TEXT, UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

/**
 * Flag yesterday (or p_day) and close what was fixed. Returns the counts.
 * Patterns look at the cutoff containing p_day.
 */
CREATE OR REPLACE FUNCTION public.automation_attendance_flags(p_day DATE DEFAULT (((now() AT TIME ZONE 'Asia/Manila')::DATE) - 1))
 RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_closed INTEGER := 0;
  v_new INTEGER := 0;
  v_ot INTEGER := public.automation_setting_int('overtime_unfiled_minutes', 30);
  v_late INTEGER := public.automation_setting_int('late_pattern_count', 3);
  v_under INTEGER := public.automation_setting_int('undertime_pattern_count', 3);
  v_cut DATE := CASE WHEN EXTRACT(DAY FROM p_day) <= 15 THEN date_trunc('month', p_day)::DATE ELSE date_trunc('month', p_day)::DATE + 15 END;
  r RECORD;
  v_id UUID;
  v_page TEXT;
BEGIN
  IF public.automation_off('attendance_flags') THEN RETURN jsonb_build_object('paused', TRUE); END IF;

  -- 1. Close what was fixed, also one the Admin noted or objected to (with HR); a dry run only counts.
  FOR r IN SELECT a.id, a.rule, a.entity_id, a.employee_id, (a.data->>'log_date')::DATE AS day
           FROM public.automation_actions a
           WHERE a.module = 'attendance_flags' AND a.status IN ('open', 'with_hr') AND a.data->>'code' IN ('missing_tap', 'absent_no_request', 'short_day', 'overtime_unfiled') LOOP
    IF public.automation_attendance_flag_fixed((SELECT data->>'code' FROM public.automation_actions WHERE id = r.id),
         NULLIF(r.entity_id, '')::UUID, r.employee_id, r.day) THEN
      IF NOT public.automation_dry_run() THEN PERFORM public.automation_close(r.id, 'Fixed: the day changed or the request was filed.'); END IF;
      v_closed := v_closed + 1;
    END IF;
  END LOOP;

  -- 2. Yesterday's days to fix (not on a device / data-problem branch-day; on-payroll staff only).
  FOR r IN
    WITH day_rows AS (
      SELECT l.*, p.full_name, lower(p.role::TEXT) AS role
      FROM public.attendance_logs l JOIN public.profiles p ON p.id = l.employee_id
      WHERE l.log_date = p_day AND l.archived_duplicate = FALSE AND l.branch_id IS NOT NULL
        AND p.archived = FALSE AND p.on_payroll AND lower(p.role::TEXT) IN ('employee', 'accountant', 'hr')
        AND COALESCE(p.employee_status, 'Active') = 'Active'
        AND l.status NOT IN ('Holiday', 'On Leave')
    ), gap AS (
      SELECT branch_id FROM day_rows GROUP BY branch_id
      HAVING COUNT(*) >= 2 AND COUNT(*) FILTER (WHERE time_in IS NULL AND time_out IS NULL) * 2 >= COUNT(*)
    )
    SELECT d.*, x.code, x.what FROM day_rows d
    CROSS JOIN LATERAL (VALUES
      (CASE WHEN d.status = 'Incomplete' THEN 'missing_tap' END,
       CASE WHEN d.time_in IS NULL THEN 'no time-in' ELSE 'no time-out' END),
      (CASE WHEN d.status = 'Absent' AND d.time_in IS NULL AND d.time_out IS NULL THEN 'absent_no_request' END, 'absent with no leave filed'),
      (CASE WHEN d.status IN ('Undertime', 'Absent (short day)') THEN 'short_day' END, format('a short day (%s min short)', COALESCE(d.undertime_minutes, 0))),
      (CASE WHEN d.time_out IS NOT NULL AND d.shift_end_minutes IS NOT NULL
             AND (EXTRACT(HOUR FROM d.time_out AT TIME ZONE 'Asia/Manila') * 60 + EXTRACT(MINUTE FROM d.time_out AT TIME ZONE 'Asia/Manila'))::INTEGER - d.shift_end_minutes >= v_ot
            THEN 'overtime_unfiled' END, 'worked past the shift end with no overtime request')
    ) x(code, what)
    WHERE x.code IS NOT NULL AND d.branch_id NOT IN (SELECT branch_id FROM gap)
  LOOP
    IF public.automation_attendance_flag_fixed(r.code, r.id, r.employee_id, p_day) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.automation_actions a WHERE a.module = 'attendance_flags' AND a.entity_id = r.id::TEXT AND a.data->>'code' = r.code) THEN CONTINUE; END IF;
    v_id := public.automation_log('attendance_flags',
      CASE r.code WHEN 'missing_tap' THEN 'missing tap: ask for a time correction'
                  WHEN 'absent_no_request' THEN 'absent with no request: ask for a leave or a time correction'
                  WHEN 'short_day' THEN 'short day: ask for a half day, a leave or a time correction'
                  ELSE format('worked %s min or more past the shift end: ask for a late overtime request', v_ot) END,
      'flag', format('%s, %s: %s', r.full_name, to_char(p_day, 'Mon DD'), r.what),
      jsonb_build_object('code', r.code, 'log_date', p_day, 'status', r.status, 'time_in', r.time_in, 'time_out', r.time_out,
                         'shift_end_minutes', r.shift_end_minutes, 'undertime_minutes', r.undertime_minutes),
      r.employee_id, r.branch_id, 'attendance_log', r.id::TEXT);
    IF v_id IS NULL THEN CONTINUE; END IF;
    v_new := v_new + 1;
    IF public.automation_dry_run() THEN CONTINUE; END IF;
    v_page := CASE r.role WHEN 'hr' THEN 'hr-my-attendance' WHEN 'accountant' THEN 'ac-my-attendance' ELSE 'emp-attendance' END;
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    VALUES (r.employee_id, 'attendance_fix', 'Please check your attendance',
            format('%s: %s. %s', to_char(p_day, 'Mon DD'), r.what,
                   CASE r.code WHEN 'overtime_unfiled' THEN 'File a late overtime request if it was overtime.'
                               WHEN 'missing_tap' THEN 'Request a time correction (it is filled in for you).'
                               ELSE 'File a leave or half day, or request a time correction.' END),
            CASE WHEN r.code = 'overtime_unfiled' THEN CASE r.role WHEN 'hr' THEN 'hr-my-leave' WHEN 'accountant' THEN 'ac-my-leave' ELSE 'emp-leave' END ELSE v_page END);
  END LOOP;

  -- 3. Patterns in this cutoff (once per employee, rule and cutoff): for HR and the branch Admin.
  FOR r IN
    SELECT l.employee_id, max(l.branch_id::TEXT)::UUID AS branch_id, max(p.full_name) AS full_name,
           COUNT(*) FILTER (WHERE l.status = 'Late' OR COALESCE(l.late_minutes, 0) > 0) AS lates,
           COUNT(*) FILTER (WHERE l.status IN ('Undertime', 'Absent (short day)')) AS unders
    FROM public.attendance_logs l JOIN public.profiles p ON p.id = l.employee_id
    WHERE l.log_date BETWEEN v_cut AND p_day AND l.archived_duplicate = FALSE AND p.archived = FALSE AND p.on_payroll
      AND lower(p.role::TEXT) IN ('employee', 'accountant', 'hr')
    GROUP BY l.employee_id
    HAVING COUNT(*) FILTER (WHERE l.status = 'Late' OR COALESCE(l.late_minutes, 0) > 0) >= v_late
        OR COUNT(*) FILTER (WHERE l.status IN ('Undertime', 'Absent (short day)')) >= v_under
  LOOP
    IF r.lates >= v_late AND NOT EXISTS (SELECT 1 FROM public.automation_actions a WHERE a.module = 'attendance_flags' AND a.employee_id = r.employee_id
                                         AND a.data->>'code' = 'late_pattern' AND a.data->>'cutoff' = v_cut::TEXT) THEN
      IF public.automation_log('attendance_flags', format('%s or more late days in a cutoff', v_late), 'flag',
           format('%s: late %s times since %s', r.full_name, r.lates, to_char(v_cut, 'Mon DD')),
           jsonb_build_object('code', 'late_pattern', 'cutoff', v_cut, 'count', r.lates), r.employee_id, r.branch_id) IS NOT NULL THEN
        v_new := v_new + 1;
      END IF;
    END IF;
    IF r.unders >= v_under AND NOT EXISTS (SELECT 1 FROM public.automation_actions a WHERE a.module = 'attendance_flags' AND a.employee_id = r.employee_id
                                           AND a.data->>'code' = 'undertime_pattern' AND a.data->>'cutoff' = v_cut::TEXT) THEN
      IF public.automation_log('attendance_flags', format('%s or more short days in a cutoff', v_under), 'flag',
           format('%s: %s short days since %s', r.full_name, r.unders, to_char(v_cut, 'Mon DD')),
           jsonb_build_object('code', 'undertime_pattern', 'cutoff', v_cut, 'count', r.unders), r.employee_id, r.branch_id) IS NOT NULL THEN
        v_new := v_new + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('flagged', v_new, 'closed', v_closed, 'dry_run', public.automation_dry_run());
END;
$function$;
REVOKE ALL ON FUNCTION public.automation_attendance_flags(DATE) FROM PUBLIC, anon, authenticated;

-- Nightly at 00:45 Manila (16:45 UTC): after the attendance close, before the automation digest. Nothing while paused.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('automation-attendance-flags', '45 16 * * *', 'SELECT public.automation_attendance_flags();');
  END IF;
END $$;
