-- ════════════════════════════════════════════════════════════════════════════
-- Revokes HR's Payroll Records view access
--
-- DECISION
-- HR does not have payroll view access. SACS-Payroll-Permission-Matrix.md row 11
-- previously gave HR "V (own branch)" on Payroll Records; that entry is now
-- confirmed wrong and has been corrected to "—" in the same change, alongside
-- src/lib/rbac/permissions.js.
--
-- HOW THIS REACHES THE POLICY
-- payroll_records_select_branch (20260903010000_rbac_branch_scoping.sql) names no
-- roles of its own:
--
--   employee_id::text = auth.uid()::text
--   OR (has_permission('payroll_records','read') AND can_reach_branch(branch_id))
--
-- The role list lives in the role_permissions table, which has_permission()
-- reads. Revoking the row IS the policy change -- the policy text needs no
-- edit, and every other table keyed on payroll_records inherits the same
-- revocation automatically. This follows the pattern established by
-- 20260919010000_revoke_accountant_leave_approval.sql.
--
-- WHAT REMAINS
-- Accountant (full, own branch), Admin (view, own branch) and Super Admin
-- (full, all branches) keep payroll access. Each employee still reads their own
-- rows through the policy's first clause, which is keyed on auth.uid() and does
-- not consult role_permissions at all.
--
-- NOTHING BREAKS
-- The grant was already inert in the UI: MODULES.payroll_records in
-- src/lib/rbac/permissions.js maps a page for `accountant` only, so HR never
-- rendered a Payroll Records menu item or screen, and no route under
-- src/app/api/hr/** queries payroll.
--
-- NOT CHANGED HERE
-- HR keeps payslips(scope='branch', can_read) -- matrix row 12, a separate cell
-- this decision did not cover. It is likewise inert (payslips maps a page for
-- `accountant` only). Flagged for a follow-up decision rather than assumed.
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
  AND module = 'payroll_records';
