-- ═══════════════════════════════════════════════════════════════════════════
-- Schema tidy-up: missing foreign keys, Supabase advisor findings
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. Foreign keys from every employee column to public.profiles(id). Rows
--    could point at an employee who does not exist; now they cannot. Each is
--    added NOT VALID and then validated, so an orphan already present fails
--    with its constraint's name instead of half-applying.
--
-- 2. leave_requests.employee_id becomes UUID like every other employee
--    column. Requests filed long ago under an employee code (SACS-XXX) are
--    first rewritten to that employee's id; any value that still is not an
--    id stops the migration with a message instead of being lost.
--
-- 3. Row-level security policies, rewritten without changing who can see
--    what, except where noted:
--      - auth.uid() is wrapped as (SELECT auth.uid()), so it is evaluated
--        once per query instead of once per row (advisor: auth_rls_initplan);
--      - policies apply TO authenticated only: the anon role matches no
--        policy and so reads nothing, without evaluating the helpers below;
--      - "FOR ALL" write policies are split into INSERT / UPDATE / DELETE, so
--        reads are decided by the SELECT policy alone
--        (advisor: multiple_permissive_policies);
--      - dropped: audit_logs_insert_any (anyone signed in could write an
--        audit row -- the server writes them all), and the "own row" branch
--        of profiles_update_branch (a user could change their own role or
--        salary). Neither is used by the app, which writes with the service
--        role; table writes were already revoked from browsers by
--        20260926070000_revoke_client_table_writes.sql;
--      - transfer_requests_select_scoped: seeing other people's transfers
--        now also needs the transfer_requests read permission (an Employee
--        could list every transfer into or out of their branch).
--
-- 4. The RLS helper functions are no longer executable by anon (advisor:
--    anon_security_definer_function_executable). Signed-in users keep them:
--    the policies call them.
--
-- 5. Indexes for the foreign keys the advisor found unindexed, and the
--    duplicate unique index on profiles.email dropped (profiles_email_key,
--    the constraint's own index, stays).
--
-- Safe to run more than once.

-- ── 1. Foreign keys ────────────────────────────────────────────────────────

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN SELECT * FROM (VALUES
    ('attendance_logs',             'employee_id', 'attendance_logs_employee_id_fkey'),
    ('payroll_records',             'employee_id', 'payroll_records_employee_id_fkey'),
    ('payroll_entries',             'employee_id', 'payroll_entries_employee_id_fkey'),
    ('attendance_corrections',      'employee_id', 'attendance_corrections_employee_id_fkey'),
    ('payroll_deductions',          'employee_id', 'payroll_deductions_employee_id_fkey'),
    ('payroll_incentives',          'employee_id', 'payroll_incentives_employee_id_fkey'),
    ('employee_branch_assignments', 'user_id',     'employee_branch_assignments_user_id_fkey')
  ) AS t(tbl, col, name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.profiles(id) NOT VALID',
        fk.tbl, fk.name, fk.col);
    END IF;
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', fk.tbl, fk.name);
  END LOOP;
END;
$$;

-- ── 2. leave_requests.employee_id → UUID ───────────────────────────────────

DROP POLICY IF EXISTS leave_requests_insert_own ON public.leave_requests;
DROP POLICY IF EXISTS leave_requests_select_branch ON public.leave_requests;
DROP POLICY IF EXISTS leave_requests_update_approver ON public.leave_requests;

DO $$
DECLARE
  v_type TEXT;
  v_bad INTEGER;
BEGIN
  SELECT data_type INTO v_type
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'leave_requests' AND column_name = 'employee_id';

  IF v_type = 'text' OR v_type = 'character varying' THEN
    -- Old requests filed under the employee code: move them to the id.
    UPDATE public.leave_requests l
       SET employee_id = p.id::TEXT
      FROM public.profiles p
     WHERE l.employee_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND p.employee_id IS NOT NULL
       AND p.employee_id = l.employee_id;

    SELECT COUNT(*) INTO v_bad
      FROM public.leave_requests
     WHERE employee_id IS NOT NULL
       AND employee_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'leave_requests has % row(s) whose employee_id is neither a user id nor a known employee code; fix them before running this migration.', v_bad;
    END IF;

    ALTER TABLE public.leave_requests ALTER COLUMN employee_id TYPE UUID USING NULLIF(employee_id, '')::UUID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_requests_employee_id_fkey') THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.profiles(id) NOT VALID;
  END IF;
  ALTER TABLE public.leave_requests VALIDATE CONSTRAINT leave_requests_employee_id_fkey;
END;
$$;

-- attendance_close_days compared leave_requests.employee_id as text (either
-- the id or the employee code). With the column now a UUID that comparison
-- would fail when the function runs, so it compares ids. Otherwise unchanged
-- from 20260926050000_attendance_function_hardening.sql's version.
CREATE OR REPLACE FUNCTION public.attendance_close_days(p_from DATE, p_to DATE)
RETURNS JSONB
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
    INSERT INTO public.attendance_logs
      (employee_id, employee_name, employee_type, time_in, time_out, total_hours, status, log_date, branch_id)
    SELECT pr.id, pr.full_name, pr.employee_type, NULL, NULL, 0, 'Absent', d.day, pr.branch_id
    FROM public.profiles pr
    CROSS JOIN LATERAL (
      SELECT gs::DATE AS day FROM generate_series(p_from, v_last_closed, INTERVAL '1 day') gs
    ) d
    WHERE lower(pr.role::TEXT) IN ('employee', 'accountant')
      AND COALESCE(pr.archived, FALSE) = FALSE
      AND lower(COALESCE(pr.employee_status, 'active')) <> 'inactive'
      AND d.day >= COALESCE(pr.date_hired, pr.created_at::DATE)
      AND NOT public.attendance_is_rest_day(d.day)
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_logs l
        WHERE l.employee_id = pr.id AND l.log_date = d.day AND l.archived_duplicate = FALSE
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.leave_requests lr
        WHERE lower(lr.status) = 'approved'
          AND lr.employee_id = pr.id
          AND d.day BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
      )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_absent = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('reevaluated', v_reevaluated, 'absent_inserted', v_absent);
END;
$function$;

REVOKE ALL ON FUNCTION public.attendance_close_days(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_close_days(DATE, DATE) TO service_role;

-- ── 3. Row-level security policies ─────────────────────────────────────────

-- attendance_logs
DROP POLICY IF EXISTS attendance_insert_branch ON public.attendance_logs;
DROP POLICY IF EXISTS attendance_select_branch ON public.attendance_logs;
DROP POLICY IF EXISTS attendance_update_branch ON public.attendance_logs;
CREATE POLICY attendance_insert_branch ON public.attendance_logs FOR INSERT TO authenticated
  WITH CHECK (has_permission('attendance', 'create') AND can_reach_branch(branch_id));
CREATE POLICY attendance_select_branch ON public.attendance_logs FOR SELECT TO authenticated
  USING (employee_id = (SELECT auth.uid()) OR (has_permission('attendance', 'read') AND can_reach_branch(branch_id)));
CREATE POLICY attendance_update_branch ON public.attendance_logs FOR UPDATE TO authenticated
  USING (has_permission('attendance', 'update') AND can_reach_branch(branch_id))
  WITH CHECK (can_reach_branch(branch_id));

-- audit_logs
DROP POLICY IF EXISTS audit_logs_insert_any ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_select_scoped ON public.audit_logs;
CREATE POLICY audit_logs_select_scoped ON public.audit_logs FOR SELECT TO authenticated
  USING (is_super_admin() OR (has_permission('audit_logs', 'read') AND is_system_event = FALSE AND can_reach_branch(branch_id)));

-- branches
DROP POLICY IF EXISTS branches_select_all ON public.branches;
DROP POLICY IF EXISTS branches_write_super_admin ON public.branches;
DROP POLICY IF EXISTS branches_insert_super_admin ON public.branches;
DROP POLICY IF EXISTS branches_update_super_admin ON public.branches;
DROP POLICY IF EXISTS branches_delete_super_admin ON public.branches;
CREATE POLICY branches_select_all ON public.branches FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);
CREATE POLICY branches_insert_super_admin ON public.branches FOR INSERT TO authenticated
  WITH CHECK (has_permission('branch_management', 'create'));
CREATE POLICY branches_update_super_admin ON public.branches FOR UPDATE TO authenticated
  USING (has_permission('branch_management', 'update'))
  WITH CHECK (has_permission('branch_management', 'create'));
CREATE POLICY branches_delete_super_admin ON public.branches FOR DELETE TO authenticated
  USING (has_permission('branch_management', 'update'));

-- employee_branch_assignments
DROP POLICY IF EXISTS branch_assignments_select_branch ON public.employee_branch_assignments;
DROP POLICY IF EXISTS branch_assignments_write_branch ON public.employee_branch_assignments;
DROP POLICY IF EXISTS branch_assignments_insert_branch ON public.employee_branch_assignments;
DROP POLICY IF EXISTS branch_assignments_update_branch ON public.employee_branch_assignments;
DROP POLICY IF EXISTS branch_assignments_delete_branch ON public.employee_branch_assignments;
CREATE POLICY branch_assignments_select_branch ON public.employee_branch_assignments FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (has_permission('branch_assignment', 'read') AND can_reach_branch(branch_id)));
CREATE POLICY branch_assignments_insert_branch ON public.employee_branch_assignments FOR INSERT TO authenticated
  WITH CHECK (has_permission('branch_assignment', 'update') AND can_reach_branch(branch_id));
CREATE POLICY branch_assignments_update_branch ON public.employee_branch_assignments FOR UPDATE TO authenticated
  USING (has_permission('branch_assignment', 'update') AND can_reach_branch(branch_id))
  WITH CHECK (has_permission('branch_assignment', 'update') AND can_reach_branch(branch_id));
CREATE POLICY branch_assignments_delete_branch ON public.employee_branch_assignments FOR DELETE TO authenticated
  USING (has_permission('branch_assignment', 'update') AND can_reach_branch(branch_id));

-- leave_requests (dropped in section 2)
CREATE POLICY leave_requests_insert_own ON public.leave_requests FOR INSERT TO authenticated
  WITH CHECK (employee_id = (SELECT auth.uid()) OR (has_permission('leave_approval', 'create') AND can_reach_branch(branch_id)));
CREATE POLICY leave_requests_select_branch ON public.leave_requests FOR SELECT TO authenticated
  USING (employee_id = (SELECT auth.uid()) OR (has_permission('leave_approval', 'read') AND can_reach_branch(branch_id)));
CREATE POLICY leave_requests_update_approver ON public.leave_requests FOR UPDATE TO authenticated
  USING (has_permission('leave_approval', 'update') AND can_reach_branch(branch_id))
  WITH CHECK (can_reach_branch(branch_id));

-- payroll_entries
DROP POLICY IF EXISTS payroll_entries_all_branch ON public.payroll_entries;
CREATE POLICY payroll_entries_all_branch ON public.payroll_entries FOR ALL TO authenticated
  USING (has_permission('process_payroll', 'read') AND can_reach_branch(branch_id))
  WITH CHECK (has_permission('process_payroll', 'update') AND can_reach_branch(branch_id));

-- payroll_records
DROP POLICY IF EXISTS payroll_records_insert_branch ON public.payroll_records;
DROP POLICY IF EXISTS payroll_records_select_branch ON public.payroll_records;
DROP POLICY IF EXISTS payroll_records_update_branch ON public.payroll_records;
CREATE POLICY payroll_records_insert_branch ON public.payroll_records FOR INSERT TO authenticated
  WITH CHECK (has_permission('payroll_records', 'create') AND can_reach_branch(branch_id));
CREATE POLICY payroll_records_select_branch ON public.payroll_records FOR SELECT TO authenticated
  USING (employee_id = (SELECT auth.uid()) OR (has_permission('payroll_records', 'read') AND can_reach_branch(branch_id)));
CREATE POLICY payroll_records_update_branch ON public.payroll_records FOR UPDATE TO authenticated
  USING (has_permission('payroll_records', 'update') AND can_reach_branch(branch_id))
  WITH CHECK (can_reach_branch(branch_id));

-- profiles
DROP POLICY IF EXISTS profiles_insert_branch ON public.profiles;
DROP POLICY IF EXISTS profiles_select_branch ON public.profiles;
DROP POLICY IF EXISTS profiles_update_branch ON public.profiles;
CREATE POLICY profiles_insert_branch ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (has_permission('user_management', 'create') AND can_reach_branch(branch_id)
    AND (is_super_admin() OR lower(COALESCE(role::TEXT, 'employee')) <> ALL (ARRAY['admin', 'super_admin'])));
CREATE POLICY profiles_select_branch ON public.profiles FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid())
    OR (has_permission('user_management', 'read') AND can_reach_branch(branch_id))
    OR (has_permission('employee_information', 'read') AND can_reach_branch(branch_id)));
CREATE POLICY profiles_update_branch ON public.profiles FOR UPDATE TO authenticated
  USING (has_permission('user_management', 'update') AND can_reach_branch(branch_id)
    AND (is_super_admin() OR lower(COALESCE(role::TEXT, 'employee')) <> ALL (ARRAY['admin', 'super_admin'])))
  WITH CHECK (can_reach_branch(branch_id)
    AND (is_super_admin() OR lower(COALESCE(role::TEXT, 'employee')) <> ALL (ARRAY['admin', 'super_admin'])));

-- role_permissions
DROP POLICY IF EXISTS role_permissions_select_all ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_write_super_admin ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_insert_super_admin ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_update_super_admin ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_delete_super_admin ON public.role_permissions;
CREATE POLICY role_permissions_select_all ON public.role_permissions FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);
CREATE POLICY role_permissions_insert_super_admin ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (has_permission('roles_permissions', 'update'));
CREATE POLICY role_permissions_update_super_admin ON public.role_permissions FOR UPDATE TO authenticated
  USING (has_permission('roles_permissions', 'update'))
  WITH CHECK (has_permission('roles_permissions', 'update'));
CREATE POLICY role_permissions_delete_super_admin ON public.role_permissions FOR DELETE TO authenticated
  USING (has_permission('roles_permissions', 'update'));

-- system_config
DROP POLICY IF EXISTS system_config_select_scoped ON public.system_config;
DROP POLICY IF EXISTS system_config_write_super_admin ON public.system_config;
DROP POLICY IF EXISTS system_config_insert_super_admin ON public.system_config;
DROP POLICY IF EXISTS system_config_update_super_admin ON public.system_config;
DROP POLICY IF EXISTS system_config_delete_super_admin ON public.system_config;
CREATE POLICY system_config_select_scoped ON public.system_config FOR SELECT TO authenticated
  USING (has_permission('system_configuration', 'read'));
CREATE POLICY system_config_insert_super_admin ON public.system_config FOR INSERT TO authenticated
  WITH CHECK (has_permission('system_configuration', 'update'));
CREATE POLICY system_config_update_super_admin ON public.system_config FOR UPDATE TO authenticated
  USING (has_permission('system_configuration', 'update'))
  WITH CHECK (has_permission('system_configuration', 'update'));
CREATE POLICY system_config_delete_super_admin ON public.system_config FOR DELETE TO authenticated
  USING (has_permission('system_configuration', 'update'));

-- transfer_requests
DROP POLICY IF EXISTS transfer_requests_insert_branch_admin ON public.transfer_requests;
DROP POLICY IF EXISTS transfer_requests_select_scoped ON public.transfer_requests;
DROP POLICY IF EXISTS transfer_requests_update_super_admin ON public.transfer_requests;
CREATE POLICY transfer_requests_insert_branch_admin ON public.transfer_requests FOR INSERT TO authenticated
  WITH CHECK (requested_by = (SELECT auth.uid())
    AND (is_super_admin() OR (current_role_name() = 'admin' AND (from_branch_id IS NULL OR can_reach_branch(from_branch_id)))));
CREATE POLICY transfer_requests_select_scoped ON public.transfer_requests FOR SELECT TO authenticated
  USING (employee_id = (SELECT auth.uid())
    OR (has_permission('transfer_requests', 'read') AND (can_reach_branch(from_branch_id) OR can_reach_branch(to_branch_id))));
CREATE POLICY transfer_requests_update_super_admin ON public.transfer_requests FOR UPDATE TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

-- ── 4. RLS helpers: signed-in users only ───────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.can_reach_branch(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_branch_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_role_name() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_user_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_permission(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_reach_branch(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_branch_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_role_name() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_permission(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;

-- ── 5. Indexes ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS payroll_deductions_rate_config_id_idx ON public.payroll_deductions (rate_config_id);
CREATE INDEX IF NOT EXISTS payroll_entries_approved_by_idx ON public.payroll_entries (approved_by);
CREATE INDEX IF NOT EXISTS payroll_entries_submitted_by_idx ON public.payroll_entries (submitted_by);
CREATE INDEX IF NOT EXISTS payroll_incentives_rate_config_id_idx ON public.payroll_incentives (rate_config_id);
CREATE INDEX IF NOT EXISTS payroll_incentives_source_log_id_idx ON public.payroll_incentives (source_log_id);
CREATE INDEX IF NOT EXISTS profiles_archived_by_idx ON public.profiles (archived_by);
CREATE INDEX IF NOT EXISTS transfer_requests_requested_by_idx ON public.transfer_requests (requested_by);
CREATE INDEX IF NOT EXISTS transfer_requests_reviewed_by_idx ON public.transfer_requests (reviewed_by);

DROP INDEX IF EXISTS public.profiles_email_unique_idx;
