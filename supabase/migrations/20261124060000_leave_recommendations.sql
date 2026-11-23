-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 3, Part E step 4 (2026-11-23): leave recommendations. The system fills
-- the branch Admin's recommendation from the credits, the filing time, the
-- calendar and minimum staffing (src/lib/automation/leave-recommendations.js);
-- HR still decides. Staffing (user decision): for a leave date, the branch's
-- scheduled on-payroll staff minus those with an approved or pending leave or
-- half day that date, against automation.min_staff_present_pct (default 80,
-- pending the policy manual). A warning only: the Admin and HR decide.
-- Additive: a setting and one function.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'automation', 'min_staff_present_pct', '80', 'System'
WHERE NOT EXISTS (SELECT 1 FROM public.system_config WHERE section = 'automation' AND key = 'min_staff_present_pct');

/** Staffing on a date for a branch: { scheduled, away, present, pct, min_pct, below }. */
CREATE OR REPLACE FUNCTION public.automation_leave_staffing(p_branch UUID, p_day DATE)
 RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH staff AS (
    SELECT p.id FROM public.profiles p
    WHERE p.branch_id = p_branch AND p.archived = FALSE AND p.on_payroll
      AND lower(p.role::TEXT) IN ('employee', 'accountant', 'hr')
      AND COALESCE(p.employee_status, 'Active') = 'Active'
      AND public.attendance_is_working_day_for(p.id, p_branch, p_day)
  ), away AS (
    SELECT DISTINCT s.id FROM staff s
    JOIN public.leave_requests r ON r.employee_id::TEXT = s.id::TEXT
    WHERE lower(r.status) NOT IN ('rejected', 'cancelled', 'denied')
      AND r.start_date::TEXT <= p_day::TEXT AND r.end_date::TEXT >= p_day::TEXT
  ), n AS (SELECT (SELECT COUNT(*) FROM staff) AS scheduled, (SELECT COUNT(*) FROM away) AS away)
  SELECT jsonb_build_object('date', p_day, 'scheduled', n.scheduled, 'away', n.away, 'present', n.scheduled - n.away,
    'pct', CASE WHEN n.scheduled = 0 THEN 100 ELSE ROUND((n.scheduled - n.away) * 100.0 / n.scheduled) END,
    'min_pct', public.automation_setting_int('min_staff_present_pct', 80),
    'below', n.scheduled > 0 AND (n.scheduled - n.away) * 100.0 / n.scheduled < public.automation_setting_int('min_staff_present_pct', 80))
  FROM n;
$function$;
REVOKE ALL ON FUNCTION public.automation_leave_staffing(UUID, DATE) FROM PUBLIC, anon, authenticated;
