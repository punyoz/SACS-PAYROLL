-- ════════════════════════════════════════════════════════════════════════════
-- HR reaches every branch, and HR accounts carry no branch
--
-- DECISION
-- HR serves all branches. Its accounts are now created with no branch (shown as
-- "All Branches" on Admin & HR Logins), the same way Super Admin has none.
-- Before this, HR had every-branch reach only on employee records, user
-- accounts and transfers (SCOPE_ALL) and was boxed into one branch on the
-- rest. An HR account with no branch would have been refused on those
-- modules ("not assigned to a branch"), so they move to 'all' as well:
--
--   dashboard, attendance, leave_approval, hr_reports, timesheet
--
-- The actions are unchanged -- only how far they reach. HR still has no
-- payroll, payslip, audit, system or branch-management access; those rows
-- stay 'none'. Kept in step with src/lib/rbac/permissions.js,
-- SACS-Payroll-Permission-Matrix.md and the seed in
-- 20260903010000_rbac_branch_scoping.sql.
--
-- can_reach_branch() learns the same rule. Every policy pairs it with
-- has_permission() (except transfer_requests' read policy, where HR already
-- has 'all'), so it widens nothing HR is not already granted in the matrix.
--
-- EXISTING HR ACCOUNTS
-- Their branch is cleared in profiles, employee_branch_assignments and the
-- auth user's metadata, so e.g. "HR Officer / Pasig Branch" now reads
-- "All Branches". Attendance, leave and other history rows keep the branch_id
-- they were stamped with.
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE public.role_permissions
SET scope = 'all'
WHERE role = 'hr'
  AND module IN ('dashboard', 'attendance', 'leave_approval', 'hr_reports', 'timesheet');

CREATE OR REPLACE FUNCTION public.can_reach_branch(target UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin()
      OR public.current_role_name() = 'hr'
      OR (target IS NOT NULL AND target = public.current_branch_id());
$$;

DELETE FROM public.employee_branch_assignments
WHERE user_id IN (
  SELECT id FROM public.profiles WHERE LOWER(COALESCE(role::text, '')) = 'hr'
);

UPDATE public.profiles
SET branch_id = NULL,
    updated_at = NOW()
WHERE LOWER(COALESCE(role::text, '')) = 'hr'
  AND branch_id IS NOT NULL;

UPDATE auth.users
SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('branch_id', NULL)
WHERE LOWER(COALESCE(raw_user_meta_data->>'role', '')) = 'hr'
  AND raw_user_meta_data->>'branch_id' IS NOT NULL;
