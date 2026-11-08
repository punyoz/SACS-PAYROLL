-- HR and the Super Admin change government rates and the daily rate
-- (alpha test Part E, 2026-11-09).
--
-- Before: only the Super Admin could add a version of any payroll rate
-- (payroll_rate_writer_guard, 20261026030000).
--
-- Now, for every write the API server (service role) or a client role makes:
--   payroll_rate_configs
--     * the daily rate and the government deduction rates (SSS, PhilHealth,
--       Pag-IBIG rates, limits and employer shares): an active HR or Super
--       Admin account must be recorded in created_by;
--     * every other payroll rule: an active Super Admin, as before;
--     * the hourly rate is still refused for everyone (20261108030000:
--       always the daily rate / 8);
--     * nobody adds a version of a rate set for themselves (scope 'employee'
--       and scope_ref = created_by): another HR or the Super Admin does it;
--     * a reason (note) is required, and the effective date may not be
--       earlier than today in Manila (the API is stricter: from the next pay
--       period's first day).
--   payroll_tax_brackets, payroll_sss_msc_brackets,
--   payroll_contribution_amounts
--     * an active Super Admin, as before. The withholding tax table is fixed
--       by law; HR never edits these tables.
--   role_permissions
--     * hr: government_rates create + read, pay_rates create + read
--     * super_admin: pay_rates create + read (government_rates unchanged)
--
-- History stays append-only (payroll_rate_configs_no_update and
-- payroll_rate_history_append_only are untouched). Migrations, which run as
-- the database owner, are not affected. Additive. Safe to run more than once.

-- ── 1. The permission matrix ────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('hr',          'government_rates', 'all', true, true, false, false),
  ('hr',          'pay_rates',        'all', true, true, false, false),
  ('super_admin', 'pay_rates',        'all', true, true, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope = EXCLUDED.scope, can_create = EXCLUDED.can_create, can_read = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete, updated_at = NOW();

-- ── 2. Who may write ────────────────────────────────────────────────────────
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
  v_type TEXT;
  v_hr_types CONSTANT TEXT[] := ARRAY[
    'daily',
    'sss_pct', 'sss_msc_min', 'sss_msc_max',
    'philhealth_pct', 'philhealth_floor', 'philhealth_ceiling',
    'pagibig_pct', 'pagibig_max_salary',
    'contribution_method', 'contribution_half', 'sss_fixed', 'philhealth_fixed', 'pagibig_fixed',
    'benefits_exempt_ceiling',
    'sss_er_pct', 'sss_ec_low', 'sss_ec_high', 'sss_ec_threshold', 'philhealth_er_pct', 'pagibig_er_pct'
  ];
BEGIN
  -- Migrations and maintenance run as the owner.
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by IS NULL THEN
    RAISE EXCEPTION 'forbidden: % changes must record the account that made them.', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.role::TEXT, COALESCE(p.archived, false) INTO v_role, v_archived FROM public.profiles p WHERE p.id = NEW.created_by;
  IF v_archived OR v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden: % change by an unknown or archived account.', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_TABLE_NAME = 'payroll_rate_configs' THEN
    v_type := NEW.rate_type::TEXT;
    IF NOT (v_role = 'super_admin' OR (v_role = 'hr' AND v_type = ANY (v_hr_types))) THEN
      RAISE EXCEPTION 'forbidden: % (%) cannot be changed by %. HR and the Super Admin change government rates and the daily rate; other payroll rules are the Super Admin''s.', TG_TABLE_NAME, v_type, v_role
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Nobody changes a rate set for themselves.
    IF NEW.scope::TEXT = 'employee' AND NEW.scope_ref IS NOT NULL AND NEW.scope_ref::TEXT = NEW.created_by::TEXT THEN
      RAISE EXCEPTION 'forbidden: own_rate: nobody changes a rate set for themselves; another HR or the Super Admin makes it.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NULLIF(btrim(COALESCE(NEW.note, '')), '') IS NULL THEN
      RAISE EXCEPTION 'reason_required: give a reason for the rate change.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.effective_date < (now() AT TIME ZONE 'Asia/Manila')::date THEN
      RAISE EXCEPTION 'future_periods_only: a rate change cannot take effect in the past (%).', NEW.effective_date
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- The tax table, the SSS salary credit table, per-employee amounts.
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'forbidden: only the Super Admin changes % (by %).', TG_TABLE_NAME, v_role
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_rate_writer_guard() FROM PUBLIC, anon, authenticated;
