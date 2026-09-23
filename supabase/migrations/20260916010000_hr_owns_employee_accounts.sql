-- ═══════════════════════════════════════════════════════════════════════════
-- HR owns employee accounts and transfers; Admin runs RFID maintenance
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Brings public.role_permissions in line with src/lib/rbac/permissions.js:
--
--   * HR manages Employee and Accountant accounts, their records and branch
--     transfers for EVERY branch (scope 'all' on those modules only).
--   * Admin no longer manages accounts or transfers; it gains System
--     Maintenance (RFID card registration and scans) for its own branch.
--
-- The application does not depend on this migration: every API route enforces
-- the JavaScript matrix itself (the service-role key bypasses RLS). This keeps
-- the table — read by has_permission() for any client that talks to Postgres
-- directly — telling the same story. Safe to run more than once.
--
-- No schema change is needed for the rest of this release:
--   * one-active-sign-in and the mandatory first password change keep their
--     markers in auth.users.raw_app_meta_data (session_id, temp_password_hash),
--     which only the service role can write;
--   * sex, civil status, employment type/status and TIN are stored with the
--     rest of the employee record in auth user metadata;
--   * the first-tap / last-tap RFID rule is enforced in the attendance API.

INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('admin', 'user_management',        'none',   false, false, false, false),
  ('admin', 'employee_information',   'branch', false, true,  false, false),
  ('admin', 'branch_assignment',      'none',   false, false, false, false),
  ('admin', 'transfer_requests',      'none',   false, false, false, false),
  ('admin', 'rfid_devices',           'branch', false, true,  true,  false),
  ('admin', 'system_maintenance',     'branch', false, true,  true,  false),

  ('hr', 'user_management',           'all',    true,  true,  true,  true),
  ('hr', 'employee_information',      'all',    true,  true,  true,  true),
  ('hr', 'employee_info_readonly',    'all',    false, true,  false, false),
  ('hr', 'branch_assignment',         'all',    false, true,  true,  false),
  ('hr', 'transfer_requests',         'all',    true,  true,  true,  true)
ON CONFLICT (role, module) DO UPDATE SET
  scope      = EXCLUDED.scope,
  can_create = EXCLUDED.can_create,
  can_read   = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update,
  can_delete = EXCLUDED.can_delete,
  updated_at = NOW();
