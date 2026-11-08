-- The hourly rate is always the daily rate / 8 (2026-11-08).
--
-- Since 2026-10-26 (src/lib/payroll/rates.js resolveRates) payroll never
-- reads a stored hourly version for a period from Oct 1, 2026: it uses the
-- resolved daily rate / 8, rounded to centavos. The API refused new hourly
-- versions dated from Oct 1, but the table still accepted them, and two
-- versions typed before that fix (75.00 from Oct 1, typed 2026-09-28; 72.00
-- from Oct 16, typed 2026-10-13) still showed in the history as if in force.
--
-- Now:
--   * payroll_rate_configs refuses ANY new 'hourly' row, whoever sends it
--     (service role included), with a clear message: change the daily rate.
--   * a new 'daily' row must be more than 0.
--   * the stored hourly rows are KEPT (append-only table; nothing deleted or
--     changed). From Oct 1, 2026 they are superseded: shown as
--     "superseded: now automatic" and never read by payroll. Rows dated
--     before Oct 1, 2026 remain the history of what was in force then.
--   * pay_rates: a read-only view of the daily / hourly rates for HR (every
--     branch), the Accountant and the branch Admin (their own branch).
--     Only the Super Admin changes rates (system_configuration).
--
-- Safe to run more than once.

CREATE OR REPLACE FUNCTION public.payroll_rate_configs_derived_hourly()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.rate_type = 'hourly' THEN
    RAISE EXCEPTION 'hourly_rate_derived: the hourly rate is always the daily rate / 8 and is never set on its own. Change the daily rate instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.rate_type = 'daily' AND COALESCE(NEW.value, 0) <= 0 THEN
    RAISE EXCEPTION 'invalid_daily_rate: the daily rate must be more than 0.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS payroll_rate_configs_derived_hourly ON public.payroll_rate_configs;
CREATE TRIGGER payroll_rate_configs_derived_hourly BEFORE INSERT ON public.payroll_rate_configs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_rate_configs_derived_hourly();

-- The matrix (src/lib/rbac/permissions.js): pay_rates, read-only.
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'pay_rates', 'all',    false, true,  false, false),
  ('admin',       'pay_rates', 'branch', false, true,  false, false),
  ('hr',          'pay_rates', 'all',    false, true,  false, false),
  ('accountant',  'pay_rates', 'branch', false, true,  false, false),
  ('employee',    'pay_rates', 'none',   false, false, false, false)
ON CONFLICT (role, module) DO UPDATE SET scope = EXCLUDED.scope, can_create = EXCLUDED.can_create,
  can_read = EXCLUDED.can_read, can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete, updated_at = now();
