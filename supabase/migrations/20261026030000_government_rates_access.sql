-- Who may see and change the government deduction tables (2026-10-26):
--
--   payroll_rate_configs           SSS / PhilHealth / Pag-IBIG rates and limits
--                                  (and the other payroll rates)
--   payroll_sss_msc_brackets       SSS monthly salary credit table
--   payroll_tax_brackets           withholding tax table
--   payroll_contribution_amounts   per-employee contribution amounts
--
--   Super Admin   adds new versions (System Configuration)
--   Accountant    reads them (Government Rates, read-only)
--   HR            reads them (Government Rates, read-only)
--   Admin, Employee  nothing; an employee sees only its own deductions on
--                 its payslip
--
-- How it is enforced:
--   * Browsers never reach these tables: every one keeps its
--     *_no_client_access policy (anon / authenticated: nothing) and has no
--     table grants. Reads and writes go through the API, which checks the
--     signed session against src/lib/rbac/permissions.js (government_rates).
--     Role-based SELECT policies are deliberately NOT added: the app never
--     queries with user JWTs, and granting SELECT to authenticated would let
--     a password-only JWT read the tables without the login OTP (readiness
--     audit 2026-10-12).
--   * The database checks every write the API server makes: an insert by
--     the service role must carry created_by = an active Super Admin, or it
--     is refused (payroll_rate_writer_guard). Migrations, which run as the
--     database owner, are not affected.
--   * History is never rewritten: rows of all four tables can only be added
--     (payroll_rate_configs already was append-only).
--   * role_permissions gains the government_rates module, so the matrix the
--     database helpers read (private.has_permission) matches the app.
--
-- Additive. Safe to run more than once.

-- ── 1. The permission matrix ────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'government_rates', 'all',    true,  true,  true,  false),
  ('hr',          'government_rates', 'all',    false, true,  false, false),
  ('accountant',  'government_rates', 'branch', false, true,  false, false),
  ('admin',       'government_rates', 'none',   false, false, false, false),
  ('employee',    'government_rates', 'none',   false, false, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope = EXCLUDED.scope, can_create = EXCLUDED.can_create, can_read = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete, updated_at = NOW();

-- ── 2. Only a Super Admin's change is written ───────────────────────────────
-- SECURITY INVOKER on purpose: current_user must be the caller's role
-- (service_role for the API server), not the function's owner.
CREATE OR REPLACE FUNCTION public.payroll_rate_writer_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_archived BOOLEAN;
BEGIN
  -- The API server (service_role) and any client role: the change must be
  -- stamped with the Super Admin who made it. Migrations run as the owner.
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by IS NULL THEN
    RAISE EXCEPTION 'forbidden: % changes must record the Super Admin who made them.', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.role::TEXT, COALESCE(p.archived, false) INTO v_role, v_archived FROM public.profiles p WHERE p.id = NEW.created_by;
  IF v_role IS DISTINCT FROM 'super_admin' OR v_archived THEN
    RAISE EXCEPTION 'forbidden: only the Super Admin changes government rates and tables (% by %).', TG_TABLE_NAME, COALESCE(v_role, 'unknown')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 3. History is never rewritten ───────────────────────────────────────────
-- For the app's roles (the API server and any client). The database owner
-- keeps maintenance access: scripts/go-live/clear-test-data.sql clears test
-- contribution amounts and test authors' created_by.
CREATE OR REPLACE FUNCTION public.payroll_rate_history_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'append_only: % keeps every version; save a new version instead.', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_rate_configs', 'payroll_tax_brackets', 'payroll_contribution_amounts', 'payroll_sss_msc_brackets'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    -- Each created only when missing (no DROP statements).
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_writer_guard' AND tgrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payroll_rate_writer_guard()', t || '_writer_guard', t);
    END IF;
    -- payroll_rate_configs (payroll_rate_configs_no_update) and
    -- payroll_sss_msc_brackets (its own append-only trigger) already have one.
    IF t IN ('payroll_tax_brackets', 'payroll_contribution_amounts')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_append_only' AND tgrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payroll_rate_history_append_only()', t || '_append_only', t);
    END IF;
    -- Browsers: nothing (as since 20261014040000).
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_no_client_access') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)', t || '_no_client_access', t);
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.payroll_rate_writer_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_rate_history_append_only() FROM PUBLIC, anon, authenticated;
