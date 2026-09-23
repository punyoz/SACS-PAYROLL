-- ════════════════════════════════════════════════════════════════════════════
-- Remove the six blanket "Service role full access" policies
--
-- Each was defined:
--
--   CREATE POLICY "Service role full access" ON <table>
--     FOR ALL TO public USING (true) WITH CHECK (true);
--
-- "public" in a policy does not mean the service role. It means EVERY role,
-- including `anon` -- the role a request carries when it presents only
-- NEXT_PUBLIC_SUPABASE_ANON_KEY and no session at all. Because permissive
-- policies are OR'ed together, this one policy overrode every branch-scoped
-- policy on the table.
--
-- Measured before this migration, as `anon`, with no JWT:
--
--   profiles         5 rows readable   (incl. bank_account_number, sss_number,
--                                       philhealth_number, address, cp_number)
--   audit_logs    1367 rows readable
--   branches         3 rows readable
--   system_config   16 rows readable
--
-- WITH CHECK (true) made them writable too, so the same caller could have run
-- UPDATE public.profiles SET role = 'super_admin' -- which, since
-- 20260923_role_helper_reads_profiles.sql makes profiles authoritative for
-- role, would then have been believed by every policy in the database.
--
-- Measured after: 0 rows on all six.
--
-- NOTHING DEPENDS ON THEM. The service role bypasses RLS entirely, so the API
-- routes under src/app/api/** (which hold SUPABASE_SERVICE_ROLE_KEY) never
-- consulted this policy. The only browser-side anon client is
-- src/app/reset-password/page.js, which calls auth.updateUser() and queries no
-- table. The branch-scoped policies from 20260903_rbac_branch_scoping.sql take
-- over unchanged.
--
-- Idempotent (DROP POLICY IF EXISTS). Safe to run more than once.
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Service role full access" ON public.profiles;
DROP POLICY IF EXISTS "Service role full access" ON public.audit_logs;
DROP POLICY IF EXISTS "Service role full access" ON public.attendance_logs;
DROP POLICY IF EXISTS "Service role full access" ON public.branches;
DROP POLICY IF EXISTS "Service role full access" ON public.system_config;
DROP POLICY IF EXISTS "Service role full access" ON public.leave_requests;
