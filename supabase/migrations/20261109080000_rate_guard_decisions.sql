-- Rate and table writes after the decisions of 2026-11-09 (#3, #4, #6).
--
-- Replaces payroll_rate_writer_guard (20261109020000). For every write the
-- API server (service role) or a client role makes:
--
--   payroll_tax_brackets          LOCKED for everyone (#3): the withholding
--                                 tax table is fixed by law and changes only
--                                 through a migration (run as the owner).
--   payroll_sss_msc_brackets      Super Admin or HR (#4), with a reason, from
--                                 today or later, never inside a pay period
--                                 being processed.
--   payroll_contribution_amounts  Super Admin or HR (#4): exemptions or
--                                 special cases with a reason, never the
--                                 writer's own record, same date rules.
--   payroll_rate_configs          as 20261109020000 (HR: daily and government
--                                 rates; Super Admin: everything; never one's
--                                 own rate; a reason; not in the past), and now
--                                 never inside a pay period being processed (#6).
--
-- "Being processed" = a payroll_runs row in draft or pending whose period
-- holds the effective date. History stays append-only (unchanged triggers).
-- Migrations run as the database owner and are not affected.
-- Additive. Safe to run more than once.

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
  v_note TEXT;
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
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- #3: the tax table changes only through a migration.
  IF TG_TABLE_NAME = 'payroll_tax_brackets' THEN
    RAISE EXCEPTION 'tax_table_locked: the withholding tax table is fixed by law and changes only through a system update.'
      USING ERRCODE = 'insufficient_privilege';
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
    IF NEW.scope::TEXT = 'employee' AND NEW.scope_ref IS NOT NULL AND NEW.scope_ref::TEXT = NEW.created_by::TEXT THEN
      RAISE EXCEPTION 'forbidden: own_rate: nobody changes a rate set for themselves; another HR or the Super Admin makes it.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_TABLE_NAME IN ('payroll_sss_msc_brackets', 'payroll_contribution_amounts') THEN
    -- #4
    IF v_role NOT IN ('super_admin', 'hr') THEN
      RAISE EXCEPTION 'forbidden: only HR and the Super Admin change % (by %).', TG_TABLE_NAME, v_role
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Read through jsonb: payroll_sss_msc_brackets has no employee_id.
    IF TG_TABLE_NAME = 'payroll_contribution_amounts' AND (to_jsonb(NEW) ->> 'employee_id') = NEW.created_by::TEXT THEN
      RAISE EXCEPTION 'forbidden: own_rate: nobody changes their own contribution amounts; another HR or the Super Admin makes it.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF v_role IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'forbidden: only the Super Admin changes % (by %).', TG_TABLE_NAME, v_role
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- Every rate / table version: a reason, not in the past, never inside a
  -- pay period being processed (#6).
  v_note := to_jsonb(NEW) ->> 'note';
  IF NULLIF(btrim(COALESCE(v_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reason_required: give a reason for the change.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.effective_date < (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RAISE EXCEPTION 'future_periods_only: a change cannot take effect in the past (%).', NEW.effective_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payroll_runs r
    WHERE r.status IN ('draft', 'pending') AND NEW.effective_date BETWEEN r.period_start AND r.period_end
  ) THEN
    RAISE EXCEPTION 'period_in_processing: a change cannot start inside a pay period being processed (%).', NEW.effective_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_rate_writer_guard() FROM PUBLIC, anon, authenticated;
