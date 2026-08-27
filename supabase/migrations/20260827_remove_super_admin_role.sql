-- Remove the 'super_admin' value from the user_role enum entirely.
-- super_admin has been merged into 'admin' at the application layer;
-- this migration brings the database in line.
--
-- IMPORTANT — run this manually, and read before running:
-- Postgres cannot drop a single enum label in place, so the only way to
-- remove one is to rebuild the type. The base `CREATE TYPE user_role AS ENUM (...)`
-- statement predates this repo's migration history and isn't tracked here, so
-- the label list below is inferred from the incremental migrations that exist
-- (20260520_add_hr_role_enum.sql, 20260522_add_super_admin_role_enum.sql) plus
-- the roles referenced in application code (admin, accountant, employee, hr, it).
-- Before running this in any environment, confirm the current full label set
-- with:
--   SELECT enum_range(NULL::public.user_role);
-- and adjust the CREATE TYPE list below if it differs.

-- 1. Reassign any existing super_admin auth accounts to admin.
--    auth.users.raw_user_meta_data is what /api/legacy-auth/login primarily
--    reads the role from, so this must be updated alongside profiles.role.
UPDATE auth.users
SET raw_user_meta_data = raw_user_meta_data || '{"role":"admin"}'::jsonb
WHERE raw_user_meta_data->>'role' = 'super_admin';

-- 2. Reassign any existing profiles rows.
UPDATE public.profiles
SET role = 'admin'
WHERE role = 'super_admin';

-- 3. Rebuild the enum without 'super_admin'.
--    DROP/SET DEFAULT below assumes profiles.role defaults to 'employee'
--    (matching normalizeRole()'s fallback in src/lib/auth/normalize.js).
--    If this column has no default in your database, drop those two clauses.
ALTER TYPE public.user_role RENAME TO user_role_old;

CREATE TYPE public.user_role AS ENUM ('admin', 'accountant', 'employee', 'hr', 'it');

ALTER TABLE public.profiles
  ALTER COLUMN role DROP DEFAULT,
  ALTER COLUMN role TYPE public.user_role USING role::text::public.user_role,
  ALTER COLUMN role SET DEFAULT 'employee';

DROP TYPE public.user_role_old;
