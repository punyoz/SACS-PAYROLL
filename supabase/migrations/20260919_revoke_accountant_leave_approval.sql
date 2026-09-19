-- Revokes the Accountant's Leave Approval permission.
--
-- SACS-Payroll-Permission-Matrix.md row 8 gives Accountant "—" (no access) on
-- Leave Approval, but both the JS matrix (src/lib/rbac/permissions.js) and the
-- role_permissions seed granted it 'branch' scope with read+update. That was a
-- first-stage review (status pending_accountant) from before Leave Approval
-- moved to HR.
--
-- Nothing depends on it any more:
--   * New requests are filed as pending_admin
--     (src/app/api/employee/leave-requests/route.js).
--   * src/app/api/hr/leave-requests/route.js already treats any leftover
--     pending_accountant row as part of HR's queue, so no request is stranded.
--   * The Accountant portal has no Leave Approval screen — MODULES.leave_approval
--     maps a page for `hr` only, and pages/accountant.html carries none of the
--     markup public/legacy/js/accountant.js renders into.
--
-- The seed row in 20260903_rbac_branch_scoping.sql is corrected to match, so a
-- database built from scratch is already right. This file exists for databases
-- where that migration has already been applied.
--
-- Idempotent: re-running it changes nothing.

UPDATE public.role_permissions
SET scope      = 'none',
    can_create = false,
    can_read   = false,
    can_update = false,
    can_delete = false,
    updated_at = NOW()
WHERE role = 'accountant'
  AND module = 'leave_approval';
