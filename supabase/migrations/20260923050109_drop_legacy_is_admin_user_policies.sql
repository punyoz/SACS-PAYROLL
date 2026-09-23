-- ════════════════════════════════════════════════════════════════════════════
-- Remove the pre-RBAC "admin_only" / "self_or_admin" policies
--
-- These six predate SACS-Payroll-Permission-Matrix.md and duplicate, less
-- correctly, what 20260903010000_rbac_branch_scoping.sql already does. Two problems.
--
-- 1. INFINITE RECURSION.
--    is_admin_user() is LANGUAGE sql STABLE with no SECURITY DEFINER, unlike
--    every helper in 20260903. Its "select 1 from public.profiles where
--    p.id = auth.uid()" therefore re-enters profiles' own RLS, where
--    profiles_select_self_or_admin calls is_admin_user() again -- and so on
--    until Postgres raises:
--
--      ERROR: 54001: stack depth limit exceeded
--      CONTEXT: SQL function "is_admin_user" during startup
--
--    This never surfaced because the blanket "Service role full access" policy
--    (USING (true)) short-circuited the OR before is_admin_user() was reached.
--    Removing that policy in 20260923045702_drop_blanket_service_role_policies.sql
--    exposed it: every read of profiles or audit_logs by an `authenticated`
--    caller began failing. (The API routes were unaffected throughout -- the
--    service role skips RLS.)
--
-- 2. THEY CONTRADICT THE MATRIX.
--    is_admin_user() is true for any account whose role is 'admin', with no
--    reference to branch_id. These policies therefore handed an Admin an
--    unscoped, cross-branch read of every profile and every audit log. The
--    matrix boxes Admin inside its own branch (section 3, "Core Rule").
--
-- Dropping them removes the recursion at its source and lets the branch-scoped
-- policies -- which already cover each of these cases -- apply. Verified after:
-- Admin reads 4 profiles and 374 audit rows (own branch, non-system events),
-- Super Admin 5 and 1367.
--
-- is_admin_user() itself is deliberately left in place. Nothing references it
-- once these policies are gone, and removing it is outside this change.
--
-- Idempotent (DROP POLICY IF EXISTS). Safe to run more than once.
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS profiles_select_self_or_admin    ON public.profiles;
DROP POLICY IF EXISTS profiles_update_self_or_admin    ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_admin_only       ON public.profiles;
DROP POLICY IF EXISTS profiles_delete_admin_only       ON public.profiles;
DROP POLICY IF EXISTS audit_logs_select_admin_only     ON public.audit_logs;
DROP POLICY IF EXISTS attendance_logs_write_admin_only ON public.attendance_logs;
