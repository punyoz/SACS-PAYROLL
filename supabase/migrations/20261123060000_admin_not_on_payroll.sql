-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-11-22 (user decision): Admin and Super Admin accounts are NOT on
-- payroll at this school. Data only: set on_payroll = false for every Admin /
-- Super Admin account still marked on payroll, one audit entry each.
--
-- Checked first (read-only, live, 2026-11-22): none of them has attendance
-- rows, AWOL cases, payslips, leave requests or credits, or tenure grants.
-- If any automatic Absent row or AWOL case exists by the time this runs, it
-- STOPS (nothing changes) so the user decides on those rows first.
-- New accounts: /api/admin/staff-accounts saves them not on payroll; Part G and
-- AWOL detection skip these roles whatever the flag says.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_absent INTEGER;
  v_awol INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_absent FROM public.attendance_logs l JOIN public.profiles p ON p.id = l.employee_id
  WHERE lower(p.role::TEXT) IN ('admin', 'super_admin') AND l.status = 'Absent' AND l.time_in IS NULL;
  SELECT COUNT(*) INTO v_awol FROM public.employee_awol_cases c JOIN public.profiles p ON p.id = c.employee_id
  WHERE lower(p.role::TEXT) IN ('admin', 'super_admin');
  IF v_absent > 0 OR v_awol > 0 THEN
    RAISE EXCEPTION 'Admin / Super Admin accounts have % automatic Absent row(s) and % AWOL case(s): decide on them first', v_absent, v_awol;
  END IF;

  WITH changed AS (
    UPDATE public.profiles SET on_payroll = FALSE
    WHERE lower(role::TEXT) IN ('admin', 'super_admin') AND on_payroll
    RETURNING id, full_name, role
  )
  INSERT INTO public.audit_logs (module, action, entity_type, entity_id, description, status, source, metadata, is_system_event, actor_name, actor_role)
  SELECT 'user_management', 'not_on_payroll', 'account', c.id::TEXT,
         format('%s (%s) set to not on payroll: Admin and Super Admin are not on payroll (decision 2026-11-22).', c.full_name, c.role),
         'success', 'system', jsonb_build_object('on_payroll', jsonb_build_object('from', TRUE, 'to', FALSE)), TRUE, 'System', 'system'
  FROM changed c;
END $$;
