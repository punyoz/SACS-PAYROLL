-- ════════════════════════════════════════════════════════════════════════════
-- Revokes HR's Payslips view access
--
-- DECISION
-- HR does not have payslips view access, consistent with the payroll_records
-- decision in 20260923051901_revoke_hr_payroll_records.sql. That earlier audit flagged
-- this exact cell (matrix row 12, payslips scope='branch' on the hr role) as a
-- follow-up rather than assuming it — it is now decided the same way.
-- SACS-Payroll-Permission-Matrix.md row 12 previously gave HR "V (own branch)";
-- corrected to "—" in the same change, alongside src/lib/rbac/permissions.js.
--
-- HOW THIS REACHES THE POLICY
-- payslips has no dedicated table of its own in this schema — the module
-- controls payslip-related reads that other policies key off of via
-- has_permission('payslips', ...). Revoking the role_permissions row IS the
-- policy change, exactly as it was for payroll_records: no policy text needs
-- editing, and any policy keyed on this module inherits the revocation
-- automatically. Follows 20260919010000_revoke_accountant_leave_approval.sql and
-- 20260923051901_revoke_hr_payroll_records.sql.
--
-- WHAT REMAINS
-- Accountant (full, own branch) and Super Admin (full, all branches) keep
-- payslips access; Admin keeps view (own branch). Employee keeps
-- view(scope='self') for their own payslip only — has_permission() already
-- treats 'self' as conveying no reach over anyone else's rows
-- (20260923050346_has_permission_respects_self_scope.sql), so this employee grant was
-- never part of the branch-wide leak the hr row was.
--
-- NOTHING BREAKS
-- The grant was already inert in the UI: MODULES.payslips in
-- src/lib/rbac/permissions.js maps a page for `accountant` only, so HR never
-- rendered a Payslips menu item or screen, and no route under
-- src/app/api/hr/** references payslips.
--
-- Idempotent: re-running changes nothing.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE public.role_permissions
SET scope      = 'none',
    can_create = false,
    can_read   = false,
    can_update = false,
    can_delete = false,
    updated_at = NOW()
WHERE role = 'hr'
  AND module = 'payslips';
