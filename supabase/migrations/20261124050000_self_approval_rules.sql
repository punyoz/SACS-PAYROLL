-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-11-23 (user decision): HR files their own attendance correction requests
-- (like their own leave, half day and overtime); another HR officer who covers
-- their branch decides, or the Super Admin as the stand-in. Nobody decides
-- their own (the routes and attendance_review_correction_v2 refuse it).
-- Mirrors src/lib/rbac/permissions.js. Additive (one permission row).
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('hr',          'attendance_corrections', 'all',    true,  true,  true,  false)
ON CONFLICT (role, module) DO UPDATE SET scope = EXCLUDED.scope, can_create = EXCLUDED.can_create, can_read = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete;
