-- ════════════════════════════════════════════════════════════════════════════
-- Role separation (2026-10-20, the user's instruction)
--
--   * Payroll is processed and submitted by the Accountant only; HR approves
--     or rejects it. The Super Admin no longer processes, generates,
--     overrides or submits payroll, nor views payroll runs.
--   * Managing employees (attendance, corrections, work schedules, leave,
--     AWOL, transfers, Tenure Pay Protection) is HR's alone. The Admin keeps
--     its branch dashboard, reports, RFID card maintenance and audit log; the
--     Super Admin keeps system functions (configuration, branches, roles,
--     staff login accounts, RFID maintenance, audit, backups). Read-only
--     employee / attendance access stays for the Super Admin's backup export
--     and payroll-rate picker (no page, no writes).
--   * Subsidy approvals (missed-month adjustments, refused-consent excess
--     subsidy advances) are decided by HR only.
--
-- The server routes enforce src/lib/rbac/permissions.js; these rows are the
-- same matrix for the RLS policies (private.has_permission). The functions
-- and policies below drop the role names they hard-coded.
--
-- Checked against the live database on 2026-10-20: the four function bodies
-- below match the live ones exactly before this change; no subsidy decision,
-- tenure grant or Admin / Super Admin tenure policy exists yet.
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. role_permissions: Super Admin and Admin rows (src/lib/rbac/permissions.js) ──
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'dashboard', 'all', false, true, false, false),
  ('super_admin', 'attendance', 'all', false, true, false, false),
  ('super_admin', 'user_management', 'all', true, true, true, true),
  ('super_admin', 'employee_information', 'all', false, true, false, false),
  ('super_admin', 'employee_info_readonly', 'all', false, true, false, false),
  ('super_admin', 'branch_management', 'all', true, true, true, true),
  ('super_admin', 'branch_assignment', 'all', false, true, true, false),
  ('super_admin', 'roles_permissions', 'all', true, true, true, true),
  ('super_admin', 'transfer_requests', 'none', false, false, false, false),
  ('super_admin', 'leave_approval', 'none', false, false, false, false),
  ('super_admin', 'rfid_devices', 'all', true, true, true, true),
  ('super_admin', 'process_payroll', 'none', false, false, false, false),
  ('super_admin', 'payroll_records', 'none', false, false, false, false),
  ('super_admin', 'payslips', 'none', false, false, false, false),
  ('super_admin', 'payroll_monitoring', 'none', false, false, false, false),
  ('super_admin', 'system_maintenance', 'all', true, true, true, true),
  ('super_admin', 'system_configuration', 'all', true, true, true, true),
  ('super_admin', 'audit_logs', 'all', true, true, true, true),
  ('super_admin', 'backup_recovery', 'all', true, true, true, true),
  ('super_admin', 'hr_reports', 'none', false, false, false, false),
  ('super_admin', 'payroll_reports', 'none', false, false, false, false),
  ('super_admin', 'branch_reports', 'all', false, true, false, false),
  ('super_admin', 'profile', 'self', true, true, true, true),
  ('super_admin', 'timesheet', 'none', false, false, false, false),
  ('super_admin', 'attendance_corrections', 'none', false, false, false, false),
  ('super_admin', 'loans', 'none', false, false, false, false),
  ('super_admin', 'awol_cases', 'none', false, false, false, false),
  ('super_admin', 'payroll_approvals', 'none', false, false, false, false),
  ('super_admin', 'teacher_license', 'none', false, false, false, false),
  ('super_admin', 'work_schedules', 'none', false, false, false, false),
  ('super_admin', 'early_bird_incentive', 'all', false, true, true, false),
  ('super_admin', 'payroll_run_approval', 'none', false, false, false, false),
  ('super_admin', 'tenure_protection', 'none', false, false, false, false),
  ('admin', 'dashboard', 'branch', false, true, false, false),
  ('admin', 'attendance', 'none', false, false, false, false),
  ('admin', 'user_management', 'none', false, false, false, false),
  ('admin', 'employee_information', 'none', false, false, false, false),
  ('admin', 'employee_info_readonly', 'branch', false, true, false, false),
  ('admin', 'branch_management', 'none', false, false, false, false),
  ('admin', 'branch_assignment', 'none', false, false, false, false),
  ('admin', 'roles_permissions', 'none', false, false, false, false),
  ('admin', 'transfer_requests', 'none', false, false, false, false),
  ('admin', 'leave_approval', 'none', false, false, false, false),
  ('admin', 'rfid_devices', 'branch', false, true, true, false),
  ('admin', 'process_payroll', 'none', false, false, false, false),
  ('admin', 'payroll_records', 'none', false, false, false, false),
  ('admin', 'payslips', 'none', false, false, false, false),
  ('admin', 'payroll_monitoring', 'none', false, false, false, false),
  ('admin', 'system_maintenance', 'branch', false, true, true, false),
  ('admin', 'system_configuration', 'none', false, false, false, false),
  ('admin', 'audit_logs', 'branch', false, true, false, false),
  ('admin', 'backup_recovery', 'none', false, false, false, false),
  ('admin', 'hr_reports', 'none', false, false, false, false),
  ('admin', 'payroll_reports', 'none', false, false, false, false),
  ('admin', 'branch_reports', 'branch', false, true, false, false),
  ('admin', 'profile', 'self', true, true, true, true),
  ('admin', 'timesheet', 'none', false, false, false, false),
  ('admin', 'attendance_corrections', 'none', false, false, false, false),
  ('admin', 'loans', 'none', false, false, false, false),
  ('admin', 'awol_cases', 'none', false, false, false, false),
  ('admin', 'payroll_approvals', 'none', false, false, false, false),
  ('admin', 'teacher_license', 'none', false, false, false, false),
  ('admin', 'work_schedules', 'none', false, false, false, false),
  ('admin', 'early_bird_incentive', 'none', false, false, false, false),
  ('admin', 'payroll_run_approval', 'none', false, false, false, false),
  ('admin', 'tenure_protection', 'none', false, false, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope      = EXCLUDED.scope,
  can_create = EXCLUDED.can_create,
  can_read   = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update,
  can_delete = EXCLUDED.can_delete,
  updated_at = NOW();

-- ── 2. Payroll runs: only the Accountant starts and submits one ──
CREATE OR REPLACE FUNCTION public.ensure_payroll_run(p_branch uuid, p_period_label text, p_actor uuid)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start DATE := public.payroll_period_start(p_period_label);
  v_actor RECORD;
  v_run public.payroll_runs;
BEGIN
  IF v_start IS NULL THEN
    RAISE EXCEPTION 'invalid_period: % is not a pay period.', p_period_label USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  IF v_actor.id IS NULL OR v_actor.role <> 'accountant' THEN
    RAISE EXCEPTION 'forbidden: only an Accountant starts a payroll run.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.role = 'accountant' AND v_actor.branch_id IS DISTINCT FROM p_branch THEN
    RAISE EXCEPTION 'forbidden: that is another branch''s payroll.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.payroll_runs (branch_id, period_label, period_start, period_end, cutoff_type, status, processed_by, processed_by_name)
  VALUES (
    p_branch, public.payroll_period_label(v_start), v_start,
    CASE WHEN EXTRACT(DAY FROM v_start) = 1 THEN v_start + 14 ELSE (date_trunc('month', v_start) + INTERVAL '1 month - 1 day')::DATE END,
    CASE WHEN EXTRACT(DAY FROM v_start) = 1 THEN 'first' ELSE 'second' END,
    'draft', v_actor.id, v_actor.full_name
  )
  ON CONFLICT (branch_id, period_start) DO NOTHING;
  SELECT * INTO v_run FROM public.payroll_runs WHERE branch_id = p_branch AND period_start = v_start;
  RETURN v_run;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.submit_payroll_run(p_run_id uuid, p_actor uuid, p_items jsonb)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run public.payroll_runs;
  v_actor RECORD;
  v_from TEXT;
  v_expected UUID[];
  v_given UUID[];
  v_bad TEXT;
  v_hr UUID[];
  v_branch TEXT;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'not_found: no such payroll run.' USING ERRCODE = 'no_data_found'; END IF;

  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  IF v_actor.id IS NULL OR v_actor.role <> 'accountant' THEN
    RAISE EXCEPTION 'forbidden: only an Accountant submits payroll.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.role = 'accountant' AND v_actor.branch_id IS DISTINCT FROM v_run.branch_id THEN
    RAISE EXCEPTION 'forbidden: that is another branch''s payroll.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_run.status NOT IN ('draft', 'rejected') THEN
    RAISE EXCEPTION 'invalid_transition: this run is % and cannot be submitted.', v_run.status USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM public.payroll_entries e
             WHERE e.branch_id = v_run.branch_id AND e.pay_period = v_run.period_label AND e.status::TEXT = 'draft') THEN
    RAISE EXCEPTION 'drafts_open: finish or cancel the Draft payslips of this run first.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT array_agg(e.id ORDER BY e.id) INTO v_expected FROM public.payroll_entries e
  WHERE e.branch_id = v_run.branch_id AND e.pay_period = v_run.period_label AND e.status::TEXT = 'paid';
  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'nothing_processed: no Final payslip in this run yet.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT array_agg((x->>'entry_id')::UUID ORDER BY (x->>'entry_id')::UUID) INTO v_given FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) x;
  IF v_given IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'snapshot_mismatch: the snapshot must cover exactly the run''s Final payslips.' USING ERRCODE = 'check_violation';
  END IF;

  -- Every figure HR will approve equals the payslip's own.
  SELECT x->>'employee_name' INTO v_bad
  FROM jsonb_array_elements(p_items) x
  JOIN public.payroll_entries e ON e.id = (x->>'entry_id')::UUID
  WHERE (x->>'employee_id')::UUID IS DISTINCT FROM e.employee_id
     OR round(COALESCE((x->>'net_pay')::NUMERIC, 0), 2) <> round(GREATEST(COALESCE((e.payroll->'totals'->>'net_pay')::NUMERIC, 0), 0), 2)
     OR round(COALESCE((x->>'total_deductions')::NUMERIC, 0), 2) <> round(COALESCE((e.payroll->'totals'->>'total_deductions')::NUMERIC, 0), 2)
     OR round(COALESCE((x->>'gross_pay')::NUMERIC, 0), 2) <> round(COALESCE((e.payroll->'totals'->>'gross_pay')::NUMERIC, 0)
                                                           + COALESCE((e.payroll->'totals'->>'total_incentives')::NUMERIC, 0), 2)
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'snapshot_mismatch: % does not match the payslip.', v_bad USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('sacs.payroll_run_action', 'on', true);
  v_from := v_run.status;

  INSERT INTO public.payroll_run_items (
    run_id, submission_no, entry_id, employee_id, employee_name, employee_code, employee_level, schedule_name, payslip_no,
    processed_by, basic_pay, gross_pay, total_deductions, net_pay, attendance_deduction, absence_deduction, late_deduction,
    undertime_deduction, half_day_deduction, leave_without_pay_deduction, withholding_tax, sss, philhealth, pagibig, loans,
    other_deductions, early_bird_incentive, total_incentives, days_worked, absent_days, late_days, late_minutes,
    undertime_minutes, half_days, previous_net_pay, flags, breakdown
  )
  SELECT v_run.id, v_run.submission_no + 1, x.entry_id, x.employee_id, x.employee_name, x.employee_code, x.employee_level,
         x.schedule_name, e.payslip_no,
         (SELECT r.processed_by FROM public.payroll_records r
           WHERE r.employee_id = x.employee_id AND r.period_label = v_run.period_label AND r.archived = FALSE
           ORDER BY r.processed_at DESC LIMIT 1),
         x.basic_pay, x.gross_pay, x.total_deductions, x.net_pay, x.attendance_deduction, x.absence_deduction, x.late_deduction,
         x.undertime_deduction, x.half_day_deduction, x.leave_without_pay_deduction, x.withholding_tax, x.sss, x.philhealth,
         x.pagibig, x.loans, x.other_deductions, x.early_bird_incentive, x.total_incentives, x.days_worked, x.absent_days,
         x.late_days, x.late_minutes, x.undertime_minutes, x.half_days, x.previous_net_pay, COALESCE(x.flags, '{}'),
         COALESCE(x.breakdown, '{}'::JSONB)
  FROM jsonb_to_recordset(p_items) AS x(
    entry_id UUID, employee_id UUID, employee_name TEXT, employee_code TEXT, employee_level TEXT, schedule_name TEXT,
    basic_pay NUMERIC, gross_pay NUMERIC, total_deductions NUMERIC, net_pay NUMERIC, attendance_deduction NUMERIC,
    absence_deduction NUMERIC, late_deduction NUMERIC, undertime_deduction NUMERIC, half_day_deduction NUMERIC,
    leave_without_pay_deduction NUMERIC, withholding_tax NUMERIC, sss NUMERIC, philhealth NUMERIC, pagibig NUMERIC,
    loans NUMERIC, other_deductions NUMERIC, early_bird_incentive NUMERIC, total_incentives NUMERIC, days_worked NUMERIC,
    absent_days NUMERIC, late_days NUMERIC, late_minutes NUMERIC, undertime_minutes NUMERIC, half_days NUMERIC,
    previous_net_pay NUMERIC, flags TEXT[], breakdown JSONB
  )
  JOIN public.payroll_entries e ON e.id = x.entry_id;

  UPDATE public.payroll_entries SET run_id = v_run.id WHERE id = ANY (v_expected);

  UPDATE public.payroll_runs r SET
    status = 'pending',
    submission_no = v_run.submission_no + 1,
    submitted_by = v_actor.id,
    submitted_by_name = v_actor.full_name,
    submitted_at = NOW(),
    processed_by = COALESCE(r.processed_by, v_actor.id),
    processed_by_name = COALESCE(r.processed_by_name, v_actor.full_name),
    reviewed_by = NULL, reviewed_by_name = NULL, reviewed_at = NULL, remarks = NULL,
    total_employees = t.n, total_gross = t.gross, total_deductions = t.deductions, total_net = t.net
  FROM (
    SELECT count(*) AS n, COALESCE(sum(i.gross_pay), 0) AS gross, COALESCE(sum(i.total_deductions), 0) AS deductions,
           COALESCE(sum(i.net_pay), 0) AS net
    FROM public.payroll_run_items i WHERE i.run_id = v_run.id AND i.submission_no = v_run.submission_no + 1
  ) t
  WHERE r.id = v_run.id
  RETURNING r.* INTO v_run;

  PERFORM public.payroll_run_record(v_run, CASE WHEN v_from = 'rejected' THEN 'resubmitted' ELSE 'submitted' END, v_from,
    v_actor.id, v_actor.role, v_actor.full_name, NULL);

  SELECT name INTO v_branch FROM public.branches WHERE id = v_run.branch_id;
  SELECT array_agg(p.id) INTO v_hr FROM public.profiles p
  WHERE lower(p.role::TEXT) = 'hr' AND COALESCE(p.archived, FALSE) = FALSE;
  PERFORM public.payroll_run_notify(v_hr, 'payroll_run_submitted',
    format('Payroll waiting for approval: %s', COALESCE(v_branch, 'a branch')),
    format('%s · %s employees · net %s · %s by %s', v_run.period_label, v_run.total_employees,
      to_char(v_run.total_net, 'FM999,999,990.00'), CASE WHEN v_from = 'rejected' THEN 'resubmitted' ELSE 'submitted' END, v_actor.full_name),
    'hr-payroll-approval', v_run.id);
  RETURN v_run;
END;
$function$

;

-- ── 3. Payroll runs, snapshots and history: HR reads every branch, the
--       Accountant its own (the Super Admin no longer) ──
DROP POLICY IF EXISTS payroll_runs_read ON public.payroll_runs;
CREATE POLICY payroll_runs_read ON public.payroll_runs FOR SELECT TO authenticated
  USING (private.has_permission('payroll_run_approval', 'read')
    AND (private.current_role_name() = 'hr' OR private.can_reach_branch(branch_id)));

DROP POLICY IF EXISTS payroll_run_items_read ON public.payroll_run_items;
CREATE POLICY payroll_run_items_read ON public.payroll_run_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.payroll_runs r
    WHERE r.id = payroll_run_items.run_id
      AND private.has_permission('payroll_run_approval', 'read')
      AND (private.current_role_name() = 'hr' OR private.can_reach_branch(r.branch_id))));

DROP POLICY IF EXISTS payroll_approval_history_read ON public.payroll_approval_history;
CREATE POLICY payroll_approval_history_read ON public.payroll_approval_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.payroll_runs r
    WHERE r.id = payroll_approval_history.run_id
      AND private.has_permission('payroll_run_approval', 'read')
      AND (private.current_role_name() = 'hr' OR private.can_reach_branch(r.branch_id))));

-- ── 4. Tenure Pay Protection: HR only ──
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

  IF TG_OP = 'INSERT' THEN
    v_role := public.tenure_protection_actor_role(NEW.granted_by);
    IF v_role IS NULL OR v_role <> 'hr' THEN
      RAISE EXCEPTION 'Only HR can grant Tenure Pay Protection.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_employee_role := public.tenure_protection_actor_role(NEW.employee_id);
    IF v_employee_role IS NULL OR v_employee_role NOT IN ('employee', 'accountant') THEN
      RAISE EXCEPTION 'Tenure Pay Protection is granted to employees and accountants only.'
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
$function$

;

CREATE OR REPLACE FUNCTION public.tenure_protection_settings_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Tenure Pay Protection settings are never deleted: switch them off or archive them instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The seeded system-wide row has no author yet; every later write has one.
  -- (Nested: school_break_periods has no branch_id to read.)
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'tenure_protection_policies' AND NEW.updated_by IS NULL THEN
    IF to_jsonb(NEW)->>'branch_id' IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  v_role := public.tenure_protection_actor_role(NEW.updated_by);
  IF v_role IS NULL OR v_role <> 'hr' THEN
    RAISE EXCEPTION 'Only HR can change Tenure Pay Protection settings.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_by_role := v_role;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$

;

-- ── 5. Subsidy adjustments: decided by HR (the Accountant requests) ──
-- NOT VALID: every new or changed row must carry an HR decision; a decision
-- an Admin recorded before today (none on live) is kept as it is.
ALTER TABLE public.payroll_subsidy_adjustments DROP CONSTRAINT IF EXISTS payroll_subsidy_adjustments_decided_by_role_check;
ALTER TABLE public.payroll_subsidy_adjustments DROP CONSTRAINT IF EXISTS payroll_subsidy_adjustments_decided_chk;
ALTER TABLE public.payroll_subsidy_adjustments
  ADD CONSTRAINT payroll_subsidy_adjustments_decided_by_role_check CHECK (decided_by_role = 'hr') NOT VALID,
  ADD CONSTRAINT payroll_subsidy_adjustments_decided_chk CHECK (
    status = 'pending' OR (decided_by IS NOT NULL AND decided_by_role = 'hr' AND decided_at IS NOT NULL)) NOT VALID;

-- ── 6. Transfer requests: HR (transfer_requests), not Admin / Super Admin ──
DROP POLICY IF EXISTS transfer_requests_insert_branch_admin ON public.transfer_requests;
DROP POLICY IF EXISTS transfer_requests_update_super_admin ON public.transfer_requests;
DROP POLICY IF EXISTS transfer_requests_insert_hr ON public.transfer_requests;
DROP POLICY IF EXISTS transfer_requests_update_hr ON public.transfer_requests;
CREATE POLICY transfer_requests_insert_hr ON public.transfer_requests FOR INSERT TO authenticated
  WITH CHECK (requested_by = (SELECT auth.uid()) AND private.has_permission('transfer_requests', 'create'));
CREATE POLICY transfer_requests_update_hr ON public.transfer_requests FOR UPDATE TO authenticated
  USING (private.has_permission('transfer_requests', 'update'))
  WITH CHECK (private.has_permission('transfer_requests', 'update'));
