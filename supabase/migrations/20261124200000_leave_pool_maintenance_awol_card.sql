-- ═══════════════════════════════════════════════════════════════════════════
-- Follow-up release 2026-11-24:
--  1. Leave credits: ONE shared pool per employee per year ("Leave Credits"),
--     drawn by Vacation, Sick and Emergency leave (they stay leave TYPES).
--     Defaults per Category x Status: Regular 5, Probationary / Provisional /
--     Contractual 3; from the 1-year service anniversary the Regular rule
--     (pro-rated, as before). Statutory leaves never use the pool. Days used
--     are counted from the approved requests, so nothing is converted: the
--     per-type rules stay as history and are no longer read.
--  2. Maintenance is a POSITION, not a group: "Maintenance" added to the
--     positions; anyone in the Maintenance group with no position gets it
--     (live: none). The group column stays (unused).
--  3. AWOL guard: the employee has an active RFID card.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.leave_credit_rules DROP CONSTRAINT IF EXISTS leave_credit_rules_leave_type_check;
ALTER TABLE public.leave_credit_rules ADD CONSTRAINT leave_credit_rules_leave_type_check
  CHECK (leave_type = ANY (ARRAY['Vacation Leave', 'Sick Leave', 'Emergency Leave', 'Leave Credits']));
ALTER TABLE public.leave_credit_overrides DROP CONSTRAINT IF EXISTS leave_credit_overrides_leave_type_check;
ALTER TABLE public.leave_credit_overrides ADD CONSTRAINT leave_credit_overrides_leave_type_check
  CHECK (leave_type = ANY (ARRAY['Vacation Leave', 'Sick Leave', 'Emergency Leave', 'Leave Credits']));

INSERT INTO public.leave_credit_rules (leave_type, employee_type, employment_status, employment_type, days_per_year, effective_from, note, created_by_name)
SELECT 'Leave Credits', et.v, st.v, ty.v, CASE WHEN st.v = 'Regular' THEN 5 ELSE 3 END, DATE '2026-01-01', 'Default: one shared pool (2026-11-24)', 'System'
FROM (VALUES ('Teaching'), ('Non-Teaching')) et(v)
CROSS JOIN (VALUES ('Regular'), ('Probationary'), ('Provisional'), ('Contractual')) st(v)
CROSS JOIN (VALUES ('Full-time'), ('Part-time')) ty(v)
ON CONFLICT DO NOTHING;

INSERT INTO public.employee_positions (name, created_by_name)
SELECT 'Maintenance', 'System' WHERE NOT EXISTS (SELECT 1 FROM public.employee_positions WHERE lower(name) = 'maintenance');
UPDATE public.profiles SET position = 'Maintenance', updated_at = NOW()
 WHERE staff_group = 'Maintenance' AND NULLIF(btrim(COALESCE(position, '')), '') IS NULL;

CREATE OR REPLACE FUNCTION public.awol_case_guards(p_employee UUID, p_from DATE, p_through DATE)
 RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  p RECORD;
  v_checks JSONB := '[]'::JSONB;
  v_ok BOOLEAN := TRUE;
  v_bad TEXT;
  v_taps INTEGER;
  v_req TEXT;
BEGIN
  SELECT id, branch_id, on_payroll, archived, is_demo, employee_status, lower(role::TEXT) AS role INTO p FROM public.profiles WHERE id = p_employee;
  IF p.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'checks', jsonb_build_array(jsonb_build_object('key', 'person', 'label', 'Employee record', 'ok', FALSE, 'detail', 'Not found')));
  END IF;
  -- 1. A home branch.
  v_checks := v_checks || jsonb_build_object('key', 'home_branch', 'label', 'Has a home branch', 'ok', p.branch_id IS NOT NULL,
    'detail', CASE WHEN p.branch_id IS NULL THEN 'No branch on the record' ELSE 'Yes' END);
  v_ok := v_ok AND p.branch_id IS NOT NULL;
  -- 2. On payroll, active, a real employee account (never a demo / test or an Admin / Super Admin account).
  v_bad := CASE WHEN NOT COALESCE(p.on_payroll, FALSE) THEN 'Not on payroll'
                WHEN p.archived THEN 'Archived'
                WHEN COALESCE(p.is_demo, FALSE) THEN 'A demo / test account'
                WHEN p.role NOT IN ('employee', 'accountant', 'hr') THEN 'Not an employee account'
                WHEN COALESCE(p.employee_status, 'Active') <> 'Active' THEN 'Status ' || p.employee_status
                ELSE NULL END;
  v_checks := v_checks || jsonb_build_object('key', 'on_payroll', 'label', 'On payroll, active, real account', 'ok', v_bad IS NULL, 'detail', COALESCE(v_bad, 'Yes'));
  v_ok := v_ok AND v_bad IS NULL;
  -- 3. Zero taps in the period.
  SELECT COUNT(*) INTO v_taps FROM public.attendance_logs l
   WHERE l.employee_id = p_employee AND l.log_date BETWEEN p_from AND p_through AND l.archived_duplicate = FALSE
     AND (l.time_in IS NOT NULL OR l.time_out IS NOT NULL);
  v_checks := v_checks || jsonb_build_object('key', 'zero_taps', 'label', 'Zero taps', 'ok', v_taps = 0, 'detail', CASE WHEN v_taps = 0 THEN 'No tap since ' || to_char(p_from, 'Mon DD') ELSE v_taps || CASE WHEN v_taps = 1 THEN ' day with taps' ELSE ' days with taps' END END);
  v_ok := v_ok AND v_taps = 0;
  -- 4. No request covering the period (leave or half day not rejected / cancelled, a correction, an overtime request).
  v_req := NULL;
  IF EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.employee_id::TEXT = p_employee::TEXT AND lower(r.status) NOT IN ('rejected', 'cancelled', 'denied')
             AND (CASE WHEN r.start_date::TEXT ~ '^\d{4}-\d{2}-\d{2}$' THEN r.start_date::TEXT::DATE END) <= p_through
             AND (CASE WHEN r.end_date::TEXT ~ '^\d{4}-\d{2}-\d{2}$' THEN r.end_date::TEXT::DATE END) >= p_from) THEN v_req := 'A leave request covers these days';
  ELSIF EXISTS (SELECT 1 FROM public.attendance_corrections c WHERE c.employee_id = p_employee AND c.status = 'pending' AND c.log_date BETWEEN p_from AND p_through) THEN v_req := 'An attendance correction is pending';
  ELSIF EXISTS (SELECT 1 FROM public.overtime_requests o WHERE o.employee_id = p_employee AND o.status IN ('pending', 'approved') AND o.request_date BETWEEN p_from AND p_through) THEN v_req := 'An overtime request covers these days';
  END IF;
  v_checks := v_checks || jsonb_build_object('key', 'no_request', 'label', 'No leave or other request', 'ok', v_req IS NULL, 'detail', COALESCE(v_req, 'None'));
  v_ok := v_ok AND v_req IS NULL;
  -- 4b. An active RFID card (2026-11-24): without one the employee cannot tap at all, so no taps proves nothing.
  v_bad := CASE WHEN EXISTS (SELECT 1 FROM public.rfid_cards k WHERE k.employee_id = p_employee AND k.status = 'active') THEN NULL ELSE 'No active RFID card' END;
  v_checks := v_checks || jsonb_build_object('key', 'active_card', 'label', 'Has an active RFID card', 'ok', v_bad IS NULL, 'detail', COALESCE(v_bad, 'Yes'));
  v_ok := v_ok AND v_bad IS NULL;
  -- 5. The branch had normal taps every one of those days (no device / data problem).
  v_bad := NULL;
  IF p.branch_id IS NOT NULL THEN
    SELECT string_agg(to_char(d::DATE, 'Mon DD'), ', ' ORDER BY d) INTO v_bad
    FROM generate_series(p_from, p_through, INTERVAL '1 day') d
    WHERE public.attendance_is_working_day_for(p_employee, p.branch_id, d::DATE)
      AND (EXISTS (SELECT 1 FROM public.attendance_data_gaps g WHERE g.branch_id = p.branch_id AND g.gap_date = d::DATE)
        OR NOT EXISTS (SELECT 1 FROM public.attendance_logs l WHERE l.branch_id = p.branch_id AND l.log_date = d::DATE AND l.employee_id <> p_employee
                        AND l.archived_duplicate = FALSE AND l.time_in IS NOT NULL));
  ELSE
    v_bad := 'no branch';
  END IF;
  v_checks := v_checks || jsonb_build_object('key', 'branch_normal', 'label', 'Branch had normal taps', 'ok', v_bad IS NULL,
    'detail', CASE WHEN v_bad IS NULL THEN 'Yes, every day' ELSE 'No normal taps / data gap: ' || v_bad END);
  v_ok := v_ok AND v_bad IS NULL;
  RETURN jsonb_build_object('ok', v_ok, 'checks', v_checks, 'from', p_from, 'through', p_through, 'checked_at', NOW());
END;
$function$;
REVOKE ALL ON FUNCTION public.awol_case_guards(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;
