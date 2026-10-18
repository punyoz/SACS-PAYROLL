-- ════════════════════════════════════════════════════════════════════════════
-- HR views every branch's payroll records and payslips (read-only)
--
-- DECISION (2026-10-18, the school)
-- HR approves each branch's payroll run and now also views every employee's
-- processed payslips and their history. This reverses, for reading only,
-- 20260923051901_revoke_hr_payroll_records.sql and
-- 20260923055345_revoke_hr_payslips.sql. SACS-Payroll-Permission-Matrix.md
-- rows 11-12 and src/lib/rbac/permissions.js are changed in the same commit.
--
-- HOW THIS REACHES THE POLICY
-- payroll_records_select_branch and the other policies keyed on these modules
-- read role_permissions through private.has_permission(); scope 'all' makes
-- private.can_reach_branch() true for every branch. Updating the rows IS the
-- policy change, as it was for the revokes.
--
-- WHAT DOES NOT CHANGE
-- HR gets read only: no create, update or delete. Processing, editing and
-- finalizing payroll stay with the Accountant (process_payroll).
--
-- Idempotent: re-running changes nothing.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('hr', 'payroll_records', 'all', false, true, false, false),
  ('hr', 'payslips',        'all', false, true, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope      = EXCLUDED.scope,
  can_create = EXCLUDED.can_create,
  can_read   = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update,
  can_delete = EXCLUDED.can_delete,
  updated_at = NOW();
