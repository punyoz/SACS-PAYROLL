-- ═══════════════════════════════════════════════════════════════════════════
-- Browsers and signed-in users cannot write tables directly
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every write this app makes goes through its own API routes, which use the
-- service-role key. The anon and authenticated roles never need to write, yet
-- they still held INSERT/UPDATE/DELETE/TRUNCATE on every public table.
--
-- That mattered because every account has a real Supabase Auth password: with
-- the project URL and the public anon key, anyone can get a Supabase access
-- token for their own account and call the REST API directly. The row-level
-- security policy profiles_update_branch lets a user update their OWN row with
-- no limit on columns, so an Employee could set their own role to
-- 'super_admin', their branch_id to another branch, or their basic_salary.
-- audit_logs_insert_any likewise let anyone signed in write fake audit rows.
--
-- Removing the write privileges closes all of that at once. SELECT is kept:
-- reads stay governed by the row-level security policies. The service role,
-- the SECURITY DEFINER functions (attendance engine, corrections) and pg_cron
-- are unaffected.
--
-- The default privileges are changed too, so a table added later does not
-- quietly hand the write privileges back.
--
-- Safe to run more than once.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public
  FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES
  FROM anon, authenticated;
