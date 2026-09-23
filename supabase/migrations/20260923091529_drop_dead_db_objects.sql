-- ════════════════════════════════════════════════════════════════════════════
-- Remove database objects nothing uses any more
--
-- Each object below was checked for dependents before being listed here:
-- no policy, view, function, trigger, column default or check constraint in
-- the `public` schema references any of them, and `grep -rn "\.rpc("` over
-- src/, scripts/ and public/legacy/ finds no RPC call anywhere in the repo.
--
-- Idempotent throughout (IF EXISTS). Safe to run more than once.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. drop_column_not_null(text, text) — dead, and a live privilege hole ───
--
-- Added by 20260512010000_add_drop_notnull_helper.sql so the payroll upsert could
-- clear an unexpected NOT NULL on payroll_entries without a hand-written
-- migration each time. Later migrations settled that schema
-- (20260512040000_payroll_entries_all_nullable.sql,
-- 20260512030000_fix_payroll_period_id_nullable.sql), and the helper has had no
-- caller since.
--
-- It is not merely unused. It is SECURITY DEFINER, it runs ALTER TABLE, and
-- EXECUTE was never revoked -- so it is reachable unauthenticated at
-- POST /rest/v1/rpc/drop_column_not_null with only the publishable anon key:
--
--   {"tbl": "payroll_entries", "col": "<any column>"}
--
-- The `tbl <> 'payroll_entries'` guard inside it limits the blast radius to
-- that one table but does nothing about who may call it. Any passer-by could
-- strip NOT NULL from payroll columns and leave the table accepting
-- half-written payroll rows.
DROP FUNCTION IF EXISTS public.drop_column_not_null(text, text);


-- ── 2. is_admin_user() — superseded ────────────────────────────────────────
--
-- The original "is this caller an admin" helper, read from user_metadata.
-- 20260923045144_role_helper_reads_profiles.sql made public.profiles authoritative
-- for role and 20260923050109_drop_legacy_is_admin_user_policies.sql dropped the
-- last policies that called this; has_permission()/is_super_admin() replaced
-- it everywhere. Zero remaining references.
DROP FUNCTION IF EXISTS public.is_admin_user();


-- ── 3. Duplicate indexes ───────────────────────────────────────────────────
--
-- Three index pairs are byte-for-byte identical, so Postgres maintains both on
-- every write and the planner can only ever use one. In each pair the name the
-- repo's migrations declare is kept and the undeclared twin (created by hand
-- through the dashboard) is dropped, so re-running the migrations reproduces
-- the surviving name. None of the six backs a constraint, so dropping them
-- cannot weaken uniqueness -- profiles.employee_id stays unique through
-- profiles_employee_id_unique, from 20260917050000_profiles_employee_id_unique.sql.
DROP INDEX IF EXISTS public.idx_payroll_entries_status;      -- keeps payroll_entries_status_idx  (20260512020000_add_payroll_entries.sql)
DROP INDEX IF EXISTS public.profiles_employee_id_unique_idx; -- keeps profiles_employee_id_unique (20260917050000_profiles_employee_id_unique.sql)
DROP INDEX IF EXISTS public.idx_profiles_role;               -- keeps profiles_role_idx           (neither declared; kept name matches this repo's <table>_<col>_idx convention)


-- ── 4. Duplicate updated_at trigger on profiles ────────────────────────────
--
-- profiles carries trg_profiles_set_updated_at AND trg_profiles_updated_at,
-- both BEFORE UPDATE FOR EACH ROW EXECUTE set_updated_at(). The second run is
-- pure overhead: it recomputes the same now() onto the same column. The name
-- kept matches every other table here (trg_audit_logs_set_updated_at,
-- trg_attendance_logs_set_updated_at, trg_leave_requests_set_updated_at,
-- trg_payroll_records_set_updated_at).
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;


-- ── 5. Redundant permissive policies ───────────────────────────────────────
--
-- audit_logs_insert_admin_accountant allows admin+accountant to INSERT.
-- audit_logs_insert_any (20260903010000_rbac_branch_scoping.sql) allows any caller
-- with a session. Permissive policies are OR'ed, so the narrower one can never
-- decide an outcome the broader one has not already allowed -- it is evaluated
-- on every insert and changes nothing. The broader policy is the intended
-- rule: appending to your own activity trail is not a privileged write (see
-- the POST_IS_READ note in src/proxy.js). Dropping the narrower one leaves
-- behaviour identical.
DROP POLICY IF EXISTS audit_logs_insert_admin_accountant ON public.audit_logs;

-- leave_requests_service_role_all grants ALL to the service_role. The service
-- role bypasses RLS entirely, so this policy has never been consulted. It is
-- the last survivor of the set 20260923045702_drop_blanket_service_role_policies.sql
-- cleared out -- missed only because it carries a different name.
DROP POLICY IF EXISTS leave_requests_service_role_all ON public.leave_requests;


-- ── 6. Pin search_path on the remaining trigger functions ──────────────────
--
-- Every other function here already sets search_path (the linter's
-- function_search_path_mutable check). These three were missed. They run as
-- triggers on writes a caller controls, so an unpinned search_path lets a
-- schema earlier in the resolution order shadow a name they resolve at call
-- time. Setting it is behaviour-preserving: all three already reference only
-- public objects and built-ins.
ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.block_hard_delete() SET search_path = public;
ALTER FUNCTION public.restrict_transfer_request_update() SET search_path = public;
