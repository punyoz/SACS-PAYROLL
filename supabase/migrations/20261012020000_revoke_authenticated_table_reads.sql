-- ═══════════════════════════════════════════════════════════════════════════
-- authenticated loses table reads: the emailed sign-in code cannot be skipped
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every role signs in with a password AND an emailed code
-- (src/lib/auth/otp-policy.js). That second factor is enforced by the app's
-- own login routes, but Supabase Auth issues its own access token to anyone
-- who posts a correct password to /auth/v1/token with the public anon key --
-- no code needed. Until now that token still held SELECT on 17 public tables
-- and views, so a password alone could read whatever the RLS policies allow:
-- the account's own payslips, and for Admin / Accountant / HR their branch's
-- profiles, attendance and payroll.
--
-- Nothing in the app reads tables as `authenticated`. Every query runs on the
-- server with the service role (src/lib/supabase/admin.js); the anon-key
-- clients only check passwords. So the grant is removed outright, as
-- 20260927040000 did for anon and 20260926070000 did for writes, and the
-- default privileges are changed so a new table does not get it back.
--
-- The RLS policies are left in place: with no grant they are never reached,
-- and they remain a second line if a grant is ever added back.
-- The private.* RLS helpers keep EXECUTE for authenticated, which the
-- policies need and which reads no table on its own.
--
-- Safe to run more than once.

REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT ON TABLES FROM authenticated;
