-- ═══════════════════════════════════════════════════════════════════════════
-- Government loans (2026-11-25): the permission rows for the new module
-- (mirrors src/lib/rbac/permissions.js). HR encodes (every branch); the Super
-- Admin only as the fallback for an HR officer's own loan (the route checks);
-- the Accountant reads its branch's; the employee their own; the Admin none.
-- The "loans" module (cash advances) is unchanged. Additive (rows only).
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'government_loans', 'all',    true,  true,  true,  true),
  ('admin',       'government_loans', 'none',   false, false, false, false),
  ('hr',          'government_loans', 'all',    true,  true,  true,  true),
  ('accountant',  'government_loans', 'branch', false, true,  false, false),
  ('employee',    'government_loans', 'self',   false, true,  false, false)
ON CONFLICT (role, module) DO UPDATE SET scope = EXCLUDED.scope, can_create = EXCLUDED.can_create, can_read = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete;
