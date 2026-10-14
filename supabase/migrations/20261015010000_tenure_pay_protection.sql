-- ═══════════════════════════════════════════════════════════════════════════
-- Tenure Pay Protection
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20261014010000_payroll_run_approval.sql.
--
-- Some employees with long service have a contract clause: their pay is NOT
-- deducted for absence, lateness, holiday work, suspensions, summer break or
-- Christmas break. Payroll (src/lib/payroll/tenure-protection.js, used by
-- src/app/api/accountant/payroll/route.js) waives a deduction only when:
--
--   * the policy for the employee's branch is active (the branch's own, or
--     the system-wide one) and covers the day's category;
--   * HR (or an Admin / Super Admin) GRANTED it to that employee, and the
--     grant is in force on the day: effective_from <= day < revoked_on.
--     Tenure alone never applies it -- it rests on a signed contract;
--   * the employee has the minimum tenure on that day (date_hired +
--     min_tenure_years, counted in whole months).
--
-- Without it nothing changes: summer / Christmas break days the nightly
-- close marks Absent stay unpaid, as before.
--
--   tenure_protection_policies      one system-wide row (branch_id NULL) and
--                                   optional per-branch rows; a branch row
--                                   with use_global = TRUE follows the
--                                   system-wide one again.
--   tenure_protection_grants        who has it, from when, who granted it
--                                   (must be HR / Admin / Super Admin), notes
--                                   (contract reference). Revoking sets
--                                   revoked_on (today or later): history is
--                                   never edited or deleted.
--   school_break_periods            summer / Christmas break per school year,
--                                   set by HR; editable (payroll not yet
--                                   final picks up the new dates).
--   tenure_protection_applications  every deduction a payslip waived, tied to
--                                   the payslip, the attendance log and the
--                                   grant -- copied by a trigger from
--                                   payroll_entries.payroll.audit.attendance
--                                   .tenure_protection whenever a payslip is
--                                   saved, so it always matches the payslip.
--
-- Functions (service role only):
--   tenure_protection_policy_for(branch)               the policy in force
--   tenure_meets_threshold(employee, day)              tenure check
--   school_break_kind_on(day)                          'summer' | 'christmas' | NULL
--   tenure_protection_grant_for(employee, category, day)
--                                                      the grant that protects
--                                                      that category that day, or NULL
--
-- Access: the tables are closed to anon / authenticated; the API routes
-- (service role) enforce the role matrix (module tenure_protection: Super
-- Admin and HR everywhere, Admin its own branch; Accountant and Employee
-- none), and the triggers refuse a grant / policy / break written by anyone
-- who is not HR, Admin or Super Admin, whoever asks.
--
-- Safe to run more than once.

-- ── 1. Policy ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tenure_protection_policies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id              UUID REFERENCES public.branches(id),   -- NULL: system-wide
  use_global             BOOLEAN NOT NULL DEFAULT FALSE,
  min_tenure_years       NUMERIC(5, 2) NOT NULL DEFAULT 2 CHECK (min_tenure_years >= 0 AND min_tenure_years <= 50),
  cover_absence          BOOLEAN NOT NULL DEFAULT TRUE,
  cover_late             BOOLEAN NOT NULL DEFAULT TRUE,
  cover_holiday          BOOLEAN NOT NULL DEFAULT TRUE,
  cover_suspension       BOOLEAN NOT NULL DEFAULT TRUE,
  cover_summer_break     BOOLEAN NOT NULL DEFAULT TRUE,
  cover_christmas_break  BOOLEAN NOT NULL DEFAULT TRUE,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by             UUID,
  updated_by_name        TEXT,
  updated_by_role        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenure_protection_policies_global_chk CHECK (branch_id IS NOT NULL OR use_global = FALSE)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenure_protection_policies_scope_uidx
  ON public.tenure_protection_policies ((COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::UUID)));
-- Covers the branches foreign key (the expression index above does not).
CREATE INDEX IF NOT EXISTS tenure_protection_policies_branch_id_idx
  ON public.tenure_protection_policies (branch_id);

-- The system-wide default: 2 years, every category, active. Nobody is
-- protected until HR grants it.
INSERT INTO public.tenure_protection_policies (branch_id)
SELECT NULL
WHERE NOT EXISTS (SELECT 1 FROM public.tenure_protection_policies WHERE branch_id IS NULL);

-- ── 2. Summer / Christmas break per school year ───────────────────────────

CREATE TABLE IF NOT EXISTS public.school_break_periods (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year      TEXT NOT NULL CHECK (
    school_year ~ '^\d{4}-\d{4}$'
    AND split_part(school_year, '-', 2)::INTEGER = split_part(school_year, '-', 1)::INTEGER + 1
  ),
  kind             TEXT NOT NULL CHECK (kind IN ('summer', 'christmas')),
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  archived         BOOLEAN NOT NULL DEFAULT FALSE,
  note             TEXT,
  created_by       UUID,
  created_by_name  TEXT,
  updated_by       UUID,
  updated_by_name  TEXT,
  updated_by_role  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT school_break_periods_span_chk CHECK (end_date >= start_date AND end_date - start_date < 120),
  CONSTRAINT school_break_periods_year_kind_key UNIQUE (school_year, kind)
);

CREATE INDEX IF NOT EXISTS school_break_periods_dates_idx
  ON public.school_break_periods (start_date, end_date) WHERE archived = FALSE;

-- ── 3. Grants ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tenure_protection_grants (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      UUID NOT NULL REFERENCES public.profiles(id),
  effective_from   DATE NOT NULL,
  notes            TEXT,                                -- e.g. the contract reference
  granted_by       UUID NOT NULL,
  granted_by_name  TEXT,
  granted_by_role  TEXT NOT NULL,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_on       DATE,                                -- protection ends the day before
  revoked_by       UUID,
  revoked_by_name  TEXT,
  revoked_by_role  TEXT,
  revoked_at       TIMESTAMPTZ,
  revoke_notes     TEXT,
  CONSTRAINT tenure_protection_grants_revoke_chk CHECK (
    (revoked_on IS NULL) = (revoked_by IS NULL) AND (revoked_on IS NULL) = (revoked_at IS NULL)
  ),
  CONSTRAINT tenure_protection_grants_revoke_after_chk CHECK (revoked_on IS NULL OR revoked_on >= effective_from)
);

-- One open grant per employee.
CREATE UNIQUE INDEX IF NOT EXISTS tenure_protection_grants_open_uidx
  ON public.tenure_protection_grants (employee_id) WHERE revoked_on IS NULL;
CREATE INDEX IF NOT EXISTS tenure_protection_grants_employee_idx
  ON public.tenure_protection_grants (employee_id, effective_from DESC);

-- ── 4. Guards: only HR / Admin / Super Admin, history never rewritten ─────

CREATE OR REPLACE FUNCTION public.tenure_protection_actor_role(p_user UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT lower(role::TEXT) FROM public.profiles WHERE id = p_user;
$$;

CREATE OR REPLACE FUNCTION public.tenure_protection_grants_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_role TEXT;
  v_employee_role TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A Tenure Pay Protection grant is never deleted: revoke it instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_role := public.tenure_protection_actor_role(NEW.granted_by);
    IF v_role IS NULL OR v_role NOT IN ('hr', 'admin', 'super_admin') THEN
      RAISE EXCEPTION 'Only HR, an Admin or the Super Admin can grant Tenure Pay Protection.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_employee_role := public.tenure_protection_actor_role(NEW.employee_id);
    IF v_employee_role IS NULL OR v_employee_role NOT IN ('employee', 'accountant') THEN
      RAISE EXCEPTION 'Tenure Pay Protection is granted to employees and accountants only.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.effective_from < v_today THEN
      RAISE EXCEPTION 'A grant cannot take effect before today: payroll already worked out is never recalculated.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_on IS NOT NULL THEN
      RAISE EXCEPTION 'A new grant cannot already be revoked.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.granted_by_role := v_role;
    NEW.granted_at := NOW();
    RETURN NEW;
  END IF;

  -- UPDATE: only revoking, once.
  IF OLD.revoked_on IS NOT NULL THEN
    RAISE EXCEPTION 'This grant is already revoked; its history is kept as it is.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.granted_by_name IS DISTINCT FROM OLD.granted_by_name
     OR NEW.granted_by_role IS DISTINCT FROM OLD.granted_by_role
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'A grant is never edited: revoke it and grant it again.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_on IS NULL THEN
    RAISE EXCEPTION 'Revoking needs the date protection ends.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_on < v_today THEN
    RAISE EXCEPTION 'Protection can only end today or later: past payroll is never changed.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_role := public.tenure_protection_actor_role(NEW.revoked_by);
  IF v_role IS NULL OR v_role NOT IN ('hr', 'admin', 'super_admin') THEN
    RAISE EXCEPTION 'Only HR, an Admin or the Super Admin can revoke Tenure Pay Protection.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.revoked_by_role := v_role;
  NEW.revoked_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenure_protection_grants_guard ON public.tenure_protection_grants;
CREATE TRIGGER tenure_protection_grants_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.tenure_protection_grants
  FOR EACH ROW EXECUTE FUNCTION public.tenure_protection_grants_guard();

-- Policies and break periods: written only by HR / Admin / Super Admin
-- (updated_by), never deleted (a break is archived, a branch policy set back
-- to use_global).
CREATE OR REPLACE FUNCTION public.tenure_protection_settings_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Tenure Pay Protection settings are never deleted: switch them off or archive them instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The seeded system-wide row has no author yet; every later write has one.
  -- (Nested: school_break_periods has no branch_id to read.)
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'tenure_protection_policies' AND NEW.updated_by IS NULL THEN
    IF to_jsonb(NEW)->>'branch_id' IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  v_role := public.tenure_protection_actor_role(NEW.updated_by);
  IF v_role IS NULL OR v_role NOT IN ('hr', 'admin', 'super_admin') THEN
    RAISE EXCEPTION 'Only HR, an Admin or the Super Admin can change Tenure Pay Protection settings.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_by_role := v_role;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenure_protection_policies_guard ON public.tenure_protection_policies;
CREATE TRIGGER tenure_protection_policies_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.tenure_protection_policies
  FOR EACH ROW EXECUTE FUNCTION public.tenure_protection_settings_guard();

DROP TRIGGER IF EXISTS school_break_periods_guard ON public.school_break_periods;
CREATE TRIGGER school_break_periods_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.school_break_periods
  FOR EACH ROW EXECUTE FUNCTION public.tenure_protection_settings_guard();

-- ── 5. Applied protection, per payslip ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tenure_protection_applications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        UUID NOT NULL REFERENCES public.payroll_entries(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL,
  pay_period      TEXT NOT NULL,
  grant_id        UUID NOT NULL REFERENCES public.tenure_protection_grants(id),
  category        TEXT NOT NULL CHECK (category IN ('absence', 'late', 'holiday', 'suspension', 'summer_break', 'christmas_break')),
  deduction_type  TEXT NOT NULL,                       -- absent | half_day | late | undertime
  log_id          UUID,                                -- the attendance_logs row
  log_date        DATE,
  quantity        NUMERIC(12, 2),
  unit            TEXT,
  amount          NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),  -- what would have been deducted
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tenure_protection_applications_grant_idx ON public.tenure_protection_applications (grant_id);
CREATE INDEX IF NOT EXISTS tenure_protection_applications_entry_idx ON public.tenure_protection_applications (entry_id);
CREATE INDEX IF NOT EXISTS tenure_protection_applications_employee_idx ON public.tenure_protection_applications (employee_id, log_date);

-- Mirrors the payslip's waived deductions. A payslip regenerated while still
-- a draft replaces its rows; a Final payslip is never rewritten, so neither
-- are its rows. A problem here never stops payroll: the payslip itself keeps
-- the same lines (payroll.audit.attendance.tenure_protection).
CREATE OR REPLACE FUNCTION public.tenure_protection_record_applications()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lines JSONB;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.payroll IS NOT DISTINCT FROM OLD.payroll THEN
    RETURN NULL;
  END IF;
  BEGIN
    DELETE FROM public.tenure_protection_applications WHERE entry_id = NEW.id;
    v_lines := NEW.payroll #> '{audit,attendance,tenure_protection}';
    IF NEW.employee_id IS NULL OR v_lines IS NULL OR jsonb_typeof(v_lines) <> 'array' THEN
      RETURN NULL;
    END IF;
    INSERT INTO public.tenure_protection_applications
      (entry_id, employee_id, pay_period, grant_id, category, deduction_type, log_id, log_date, quantity, unit, amount)
    SELECT
      NEW.id,
      NEW.employee_id,
      COALESCE(NEW.pay_period, ''),
      g.id,
      line->>'category',
      COALESCE(line->>'type', 'unknown'),
      CASE WHEN line->>'source_log_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (line->>'source_log_id')::UUID END,
      CASE WHEN line->>'log_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (line->>'log_date')::DATE END,
      CASE WHEN line->>'quantity' ~ '^-?\d+(\.\d+)?$' THEN (line->>'quantity')::NUMERIC END,
      line->>'unit',
      CASE WHEN line->>'amount' ~ '^\d+(\.\d+)?$' THEN (line->>'amount')::NUMERIC ELSE 0 END
    FROM jsonb_array_elements(v_lines) AS line
    JOIN public.tenure_protection_grants g ON g.id::TEXT = line->>'grant_id' AND g.employee_id = NEW.employee_id
    WHERE line->>'category' IN ('absence', 'late', 'holiday', 'suspension', 'summer_break', 'christmas_break');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tenure_protection_applications not recorded for payslip %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS payroll_entries_tenure_protection ON public.payroll_entries;
CREATE TRIGGER payroll_entries_tenure_protection
  AFTER INSERT OR UPDATE OF payroll ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.tenure_protection_record_applications();

-- ── 6. The checks, in SQL (payroll's own copy: src/lib/payroll/tenure-protection.js) ──

-- The policy for a branch: its own row unless it follows the system-wide one.
CREATE OR REPLACE FUNCTION public.tenure_protection_policy_for(p_branch UUID)
RETURNS public.tenure_protection_policies
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p.*
  FROM public.tenure_protection_policies p
  WHERE (p.branch_id = p_branch AND p.use_global = FALSE) OR p.branch_id IS NULL
  ORDER BY (p.branch_id IS NULL) ASC
  LIMIT 1;
$$;

-- Has the employee served the policy's minimum tenure on p_day?
CREATE OR REPLACE FUNCTION public.tenure_meets_threshold(
  p_employee UUID,
  p_day DATE DEFAULT (NOW() AT TIME ZONE 'Asia/Manila')::DATE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT pr.date_hired IS NOT NULL
       AND pr.date_hired + make_interval(months => ROUND(pol.min_tenure_years * 12)::INTEGER) <= p_day
    FROM public.profiles pr
    CROSS JOIN LATERAL public.tenure_protection_policy_for(pr.branch_id) pol
    WHERE pr.id = p_employee
  ), FALSE);
$$;

-- The break period a day falls in.
CREATE OR REPLACE FUNCTION public.school_break_kind_on(p_day DATE)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT b.kind FROM public.school_break_periods b
  WHERE b.archived = FALSE AND p_day BETWEEN b.start_date AND b.end_date
  ORDER BY b.start_date
  LIMIT 1;
$$;

-- The grant that protects this category for the employee on p_day, or NULL.
-- summer_break / christmas_break also need p_day inside that break; holiday /
-- suspension, p_day on the holiday calendar as that type.
CREATE OR REPLACE FUNCTION public.tenure_protection_grant_for(
  p_employee UUID,
  p_category TEXT,
  p_day DATE DEFAULT (NOW() AT TIME ZONE 'Asia/Manila')::DATE
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_policy public.tenure_protection_policies;
  v_branch UUID;
  v_grant UUID;
  v_covered BOOLEAN;
BEGIN
  SELECT branch_id INTO v_branch FROM public.profiles WHERE id = p_employee;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_policy := public.tenure_protection_policy_for(v_branch);
  IF v_policy.id IS NULL OR NOT v_policy.is_active THEN RETURN NULL; END IF;

  -- A break / holiday / suspension day is judged only by that day's category
  -- (an absence in summer is protected only when summer break is covered).
  v_covered := CASE p_category
    WHEN 'absence' THEN v_policy.cover_absence AND public.school_break_kind_on(p_day) IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.attendance_holidays h WHERE h.holiday_date = p_day)
    WHEN 'late' THEN v_policy.cover_late AND public.school_break_kind_on(p_day) IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.attendance_holidays h WHERE h.holiday_date = p_day)
    WHEN 'holiday' THEN v_policy.cover_holiday AND public.school_break_kind_on(p_day) IS NULL
      AND EXISTS (SELECT 1 FROM public.attendance_holidays h WHERE h.holiday_date = p_day AND h.type IN ('holiday', 'special'))
    WHEN 'suspension' THEN v_policy.cover_suspension AND public.school_break_kind_on(p_day) IS NULL
      AND EXISTS (SELECT 1 FROM public.attendance_holidays h WHERE h.holiday_date = p_day AND h.type = 'suspension')
    WHEN 'summer_break' THEN v_policy.cover_summer_break AND public.school_break_kind_on(p_day) = 'summer'
    WHEN 'christmas_break' THEN v_policy.cover_christmas_break AND public.school_break_kind_on(p_day) = 'christmas'
    ELSE FALSE
  END;
  IF NOT COALESCE(v_covered, FALSE) THEN RETURN NULL; END IF;
  IF NOT public.tenure_meets_threshold(p_employee, p_day) THEN RETURN NULL; END IF;

  SELECT g.id INTO v_grant
  FROM public.tenure_protection_grants g
  WHERE g.employee_id = p_employee
    AND g.effective_from <= p_day
    AND (g.revoked_on IS NULL OR p_day < g.revoked_on)
  ORDER BY g.effective_from DESC
  LIMIT 1;
  RETURN v_grant;
END;
$$;

-- ── 7. Access ──────────────────────────────────────────────────────────────

ALTER TABLE public.tenure_protection_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenure_protection_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_break_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenure_protection_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenure_protection_policies FROM anon, authenticated;
REVOKE ALL ON public.tenure_protection_grants FROM anon, authenticated;
REVOKE ALL ON public.school_break_periods FROM anon, authenticated;
REVOKE ALL ON public.tenure_protection_applications FROM anon, authenticated;

-- The rule above as a policy too (as 20261014040000 does for the other
-- server-only tables): clients get nothing; the service role bypasses RLS.
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['tenure_protection_policies', 'tenure_protection_grants', 'school_break_periods', 'tenure_protection_applications'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table AND policyname = v_table || '_no_client_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
        v_table || '_no_client_access', v_table
      );
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.tenure_protection_actor_role(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenure_protection_grants_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenure_protection_settings_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenure_protection_record_applications() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenure_protection_policy_for(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenure_meets_threshold(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.school_break_kind_on(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenure_protection_grant_for(UUID, TEXT, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenure_protection_policy_for(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tenure_meets_threshold(UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.school_break_kind_on(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.tenure_protection_grant_for(UUID, TEXT, DATE) TO service_role;

-- Permissions (mirrors src/lib/rbac/permissions.js).
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'tenure_protection', 'all',    true,  true,  true,  false),
  ('hr',          'tenure_protection', 'all',    true,  true,  true,  false),
  ('admin',       'tenure_protection', 'branch', true,  true,  true,  false),
  ('accountant',  'tenure_protection', 'none',   false, false, false, false),
  ('employee',    'tenure_protection', 'none',   false, false, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope      = EXCLUDED.scope,
  can_create = EXCLUDED.can_create,
  can_read   = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update,
  can_delete = EXCLUDED.can_delete,
  updated_at = NOW();
