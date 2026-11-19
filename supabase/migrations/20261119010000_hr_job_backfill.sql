-- ════════════════════════════════════════════════════════════════════════════
-- An HR account is "HR Officer", Non-Teaching (src/lib/hr/positions.js). HR
-- accounts made by the Super Admin before 2026-11-19 carried neither, so HR's
-- staff list showed "Teaching" / "Employee" and the dashboard's Staff
-- breakdown left them out. The create route now stores both; this fixes the
-- accounts already made. A licensed teacher stays Teaching (profiles CHECK).
-- Data only. Idempotent.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE public.profiles p
SET position = 'HR Officer', employee_type = 'Non-Teaching'
WHERE p.role::text = 'hr'
  AND NOT COALESCE(p.is_licensed_teacher, false)
  AND (p.position IS DISTINCT FROM 'HR Officer' OR p.employee_type IS DISTINCT FROM 'Non-Teaching');

UPDATE auth.users u
SET raw_user_meta_data = COALESCE(u.raw_user_meta_data, '{}'::jsonb)
  || jsonb_build_object('employee_type', 'Non-Teaching', 'position', 'HR Officer')
FROM public.profiles p
WHERE p.id = u.id
  AND p.role::text = 'hr'
  AND NOT COALESCE(p.is_licensed_teacher, false)
  AND (u.raw_user_meta_data->>'position' IS DISTINCT FROM 'HR Officer'
    OR u.raw_user_meta_data->>'employee_type' IS DISTINCT FROM 'Non-Teaching');
