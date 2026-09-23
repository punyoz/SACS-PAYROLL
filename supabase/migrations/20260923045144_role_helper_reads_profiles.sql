-- ════════════════════════════════════════════════════════════════════════════
-- Role resolution for RLS reads profiles, never the JWT's user_metadata
--
-- THE HOLE THIS CLOSES
-- current_role_name() (supabase/migrations/20260903010000_rbac_branch_scoping.sql)
-- resolved the caller's role like this:
--
--   COALESCE(
--     LOWER(NULLIF(auth.jwt() -> 'user_metadata' ->> 'role', '')),   <-- first
--     LOWER((SELECT role::text FROM public.profiles WHERE id = auth.uid())),
--     'employee'
--   )
--
-- user_metadata is writable by the account it belongs to: any client holding a
-- session can call supabase.auth.updateUser({ data: { role: 'super_admin' } }),
-- and the refreshed JWT carries that claim. Because the JWT was consulted
-- BEFORE profiles, is_super_admin() and has_permission() — and therefore every
-- policy in this database — believed it.
--
-- That session is reachable in normal use: src/app/reset-password/page.js signs
-- the browser in with a recovery token so it can call updateUser({ password }),
-- and NEXT_PUBLIC_SUPABASE_ANON_KEY is public by definition. An Employee could
-- start a password reset for their own account, rewrite their own metadata
-- role, and then query PostgREST directly as Super Admin — reading every
-- branch's payroll and attendance with no branch filter at all.
--
-- Role now comes from public.profiles keyed on auth.uid(), which only the
-- service-role routes and the profiles RLS policies can write. A user can still
-- set user_metadata.role to anything they like; nothing reads it any more.
--
-- SCOPE OF THE CHANGE
-- The API routes under src/app/api/** are unaffected — they hold the service
-- role key (bypassing RLS) and take the caller's role from the signed HttpOnly
-- cookie via src/lib/rbac/guard.js. This migration fixes the second layer: any
-- client that reaches Postgres directly with a user JWT.
--
-- get_user_role() is the implementation; current_role_name() stays as a thin
-- wrapper so its existing callers keep working untouched:
--   * is_super_admin(), has_permission()            (20260903)
--   * transfer_requests policies                    (20260910, 20260912)
--
-- KNOWN BEHAVIOUR CHANGE
-- An account whose role lived ONLY in user_metadata, with no profiles row,
-- now resolves as 'employee' under RLS instead of that metadata role.
-- 20260913010000_backfill_missing_profiles.sql gave every existing account a row, and
-- profiles is already the source of truth for the login route and the guard, so
-- this aligns RLS with them. It also fails in the safe direction: a missing
-- profile loses reach rather than gaining it.
--
-- Idempotent (CREATE OR REPLACE only). Safe to run more than once, and safe to
-- run before or after a from-scratch apply of 20260903 — this file sorts last.
-- ════════════════════════════════════════════════════════════════════════════


-- The caller's role, straight out of profiles.
--
-- SECURITY DEFINER + a pinned search_path, exactly as the helper it replaces:
-- the profiles policies call this function, so it must read profiles without
-- re-entering profiles' own RLS.
--
-- Returns '' for an unauthenticated caller rather than NULL, so every caller
-- stays in two-valued boolean logic: '' matches no role_permissions row and
-- equals no role name, making has_permission() and is_super_admin() return a
-- plain false instead of a NULL that each policy would have to absorb.
--
-- An authenticated caller with no profiles row (or a blank role) falls back to
-- 'employee', the least-privileged role — the same fallback as before.
CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN ''
    ELSE COALESCE(
      LOWER(NULLIF((SELECT role::text FROM public.profiles WHERE id = auth.uid()), '')),
      'employee'
    )
  END;
$$;

-- Kept as the name the 20260903/20260910/20260912 policies already call.
CREATE OR REPLACE FUNCTION public.current_role_name()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.get_user_role();
$$;
