-- ════════════════════════════════════════════════════════════════════════════
-- "My Account" and "Items waiting on fallback" (2026-11-09 Parts D/E): the
-- role_permissions rows for src/lib/rbac/permissions.js.
--   my_account          HR, Accountant, Employee: their OWN records (self).
--                       Admin and Super Admin: none (not on payroll).
--   fallback_approvals  Super Admin only: decide an HR's own item when no
--                       other HR is active.
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'my_account', 'none', false, false, false, false),
  ('admin', 'my_account', 'none', false, false, false, false),
  ('hr', 'my_account', 'self', true, true, true, false),
  ('accountant', 'my_account', 'self', true, true, true, false),
  ('employee', 'my_account', 'self', true, true, true, false),
  ('super_admin', 'fallback_approvals', 'all', true, true, true, false),
  ('admin', 'fallback_approvals', 'none', false, false, false, false),
  ('hr', 'fallback_approvals', 'none', false, false, false, false),
  ('accountant', 'fallback_approvals', 'none', false, false, false, false),
  ('employee', 'fallback_approvals', 'none', false, false, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope = EXCLUDED.scope, can_create = EXCLUDED.can_create, can_read = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete;
