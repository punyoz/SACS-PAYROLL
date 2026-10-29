-- HR reads the final-payslip override log (decision 2026-10-29), for
-- compliance visibility: every override of a payslip HR approved, who did it,
-- the old and new values and the reason (GET /api/payroll/overrides).
--
-- Read only. Running an override stays the Super Admin's alone: it needs
-- payroll_override "update", which HR does not get, and the database function
-- payroll_override_final checks for an active Super Admin again.
--
-- One row of the permission matrix changes; nothing else.

INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('hr',          'payroll_override', 'all',  false, true,  false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope = EXCLUDED.scope, can_create = EXCLUDED.can_create, can_read = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete, updated_at = NOW();
