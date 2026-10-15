-- Supabase performance advisor (multiple_permissive_policies): payroll_entries
-- had two permissive SELECT policies for authenticated, payroll_entries_all_branch
-- (FOR ALL: payroll staff of a reachable branch) and
-- payroll_entries_own_after_approval (an employee's own payslip once released),
-- so Postgres evaluated both on every read.
--
-- Same access as before, written as one SELECT policy (either rule) plus the
-- write policies payroll_entries_all_branch used to cover. Clients hold no
-- table grants on payroll_entries (20261012020000), so this changes nothing
-- for the app, which reads with the service role.

DROP POLICY IF EXISTS payroll_entries_all_branch ON public.payroll_entries;
DROP POLICY IF EXISTS payroll_entries_own_after_approval ON public.payroll_entries;
DROP POLICY IF EXISTS payroll_entries_select ON public.payroll_entries;
DROP POLICY IF EXISTS payroll_entries_insert_branch ON public.payroll_entries;
DROP POLICY IF EXISTS payroll_entries_update_branch ON public.payroll_entries;
DROP POLICY IF EXISTS payroll_entries_delete_branch ON public.payroll_entries;

CREATE POLICY payroll_entries_select ON public.payroll_entries FOR SELECT TO authenticated
  USING (
    (private.has_permission('process_payroll', 'read') AND private.can_reach_branch(branch_id))
    OR (
      employee_id = (SELECT auth.uid())
      AND status::TEXT <> 'draft'
      AND (
        NOT public.payroll_period_requires_approval(pay_period)
        OR EXISTS (
          SELECT 1 FROM public.payroll_runs r
          WHERE r.id = payroll_entries.run_id AND r.status = 'approved'
        )
      )
    )
  );

CREATE POLICY payroll_entries_insert_branch ON public.payroll_entries FOR INSERT TO authenticated
  WITH CHECK (private.has_permission('process_payroll', 'update') AND private.can_reach_branch(branch_id));

CREATE POLICY payroll_entries_update_branch ON public.payroll_entries FOR UPDATE TO authenticated
  USING (private.has_permission('process_payroll', 'read') AND private.can_reach_branch(branch_id))
  WITH CHECK (private.has_permission('process_payroll', 'update') AND private.can_reach_branch(branch_id));

CREATE POLICY payroll_entries_delete_branch ON public.payroll_entries FOR DELETE TO authenticated
  USING (private.has_permission('process_payroll', 'read') AND private.can_reach_branch(branch_id));
