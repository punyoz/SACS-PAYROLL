-- Year-end tax annualization (2026-10-29). Accountant only.
--
--   1. payroll_tax_annualizations: one row per employee and tax year, the
--      Accountant's annualization of the year's payslips (src/lib/payroll/
--      bir-2316.js compute2316: gross, non-taxable, taxable, tax due from the
--      BIR annual table, tax withheld). Re-running it updates the row in place
--      and appends to its history; nothing is ever deleted.
--   2. The Accountant schedules the difference onto a 2nd-cutoff payslip
--      (normally December 16-31). That payslip computes the final amount when
--      it is processed (tax due on the whole year, this payslip included, less
--      everything withheld) and carries it as its own line, "Year-end tax
--      adjustment": a deduction when under-withheld, a refund when
--      over-withheld (payroll.year_end_tax). The regular withholding tax of
--      every payslip, that one included, is never changed.
--   3. Two payslip line types for those lines (payroll_deductions
--      'year_end_tax', payroll_incentives 'year_end_tax_refund').
--
-- Who: the Accountant of the employee's (current) branch, checked here as in
-- the API. HR, Admin and Super Admin have no access (payroll_reports module).
--
-- Additive: one table, two functions, one index, two widened CHECKs. No
-- existing row is changed.

CREATE TABLE IF NOT EXISTS public.payroll_tax_annualizations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year              INTEGER NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  employee_id           UUID NOT NULL REFERENCES public.profiles(id),
  branch_id             UUID REFERENCES public.branches(id),
  employee_name         TEXT,
  employee_code         TEXT,
  gross_compensation    NUMERIC(14, 2) NOT NULL DEFAULT 0,
  non_taxable           NUMERIC(14, 2) NOT NULL DEFAULT 0,
  taxable_compensation  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  tax_due               NUMERIC(14, 2) NOT NULL DEFAULT 0,
  -- The regular withholding tax of the year's payslips.
  tax_withheld          NUMERIC(14, 2) NOT NULL DEFAULT 0,
  -- Year-end adjustment lines already on Final payslips (+ collected, - refunded).
  adjustments_settled   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  -- tax_due - tax_withheld - adjustments_settled: > 0 to collect, < 0 to refund.
  balance               NUMERIC(14, 2) NOT NULL DEFAULT 0,
  payslip_count         INTEGER NOT NULL DEFAULT 0,
  -- The 2316 boxes as computed.
  boxes                 JSONB NOT NULL DEFAULT '{}'::JSONB,
  status                TEXT NOT NULL DEFAULT 'computed' CHECK (status IN ('computed', 'scheduled')),
  -- The 2nd-cutoff payslip that carries the adjustment ("December 16-31, 2026").
  target_period         TEXT,
  scheduled_by          UUID REFERENCES public.profiles(id),
  scheduled_by_name     TEXT,
  scheduled_at          TIMESTAMPTZ,
  computed_by           UUID REFERENCES public.profiles(id),
  computed_by_name      TEXT,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_count             INTEGER NOT NULL DEFAULT 1,
  -- Every run and schedule change: { at, action, by, by_name, tax_due, tax_withheld, balance, period }.
  history               JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_tax_annualizations_one_per_year UNIQUE (tax_year, employee_id),
  CONSTRAINT payroll_tax_annualizations_scheduled_chk CHECK (status <> 'scheduled' OR target_period IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS payroll_tax_annualizations_employee_idx ON public.payroll_tax_annualizations (employee_id);
CREATE INDEX IF NOT EXISTS payroll_tax_annualizations_branch_idx ON public.payroll_tax_annualizations (branch_id, tax_year);
CREATE INDEX IF NOT EXISTS payroll_tax_annualizations_target_idx ON public.payroll_tax_annualizations (target_period) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS payroll_tax_annualizations_scheduled_by_idx ON public.payroll_tax_annualizations (scheduled_by);
CREATE INDEX IF NOT EXISTS payroll_tax_annualizations_computed_by_idx ON public.payroll_tax_annualizations (computed_by);

-- Payslips carrying a year-end adjustment (the BIR forms read them by tax year).
CREATE INDEX IF NOT EXISTS payroll_entries_year_end_tax_idx ON public.payroll_entries (employee_id)
  WHERE (payroll -> 'year_end_tax') IS NOT NULL;

-- Server only (the API uses the service role after its own permission check).
ALTER TABLE public.payroll_tax_annualizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_tax_annualizations FROM anon, authenticated;
DROP POLICY IF EXISTS payroll_tax_annualizations_no_client_access ON public.payroll_tax_annualizations;
CREATE POLICY payroll_tax_annualizations_no_client_access ON public.payroll_tax_annualizations
  FOR ALL TO anon, authenticated USING (FALSE) WITH CHECK (FALSE);

DROP TRIGGER IF EXISTS payroll_tax_annualizations_block_hard_delete ON public.payroll_tax_annualizations;
CREATE TRIGGER payroll_tax_annualizations_block_hard_delete BEFORE DELETE ON public.payroll_tax_annualizations
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

-- The acting Accountant, or an error.
CREATE OR REPLACE FUNCTION public.payroll_tax_annualization_actor(p_actor UUID)
RETURNS public.profiles
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.profiles;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id = p_actor;
  IF v_actor.id IS NULL OR v_actor.role::TEXT <> 'accountant' OR COALESCE(v_actor.archived, FALSE) THEN
    RAISE EXCEPTION 'forbidden: only the Accountant runs the year-end tax annualization.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.branch_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: your account has no branch.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_actor;
END;
$$;

/*
 * Save one annualization run: p_rows is [{ employee_id, employee_name,
 * employee_code, gross_compensation, non_taxable, taxable_compensation,
 * tax_due, tax_withheld, adjustments_settled, balance, payslip_count, boxes }].
 * Every employee must be in the Accountant's branch now. A row already there
 * is updated (its schedule is kept); returns how many were saved.
 */
CREATE OR REPLACE FUNCTION public.payroll_tax_annualization_save(p_actor UUID, p_year INTEGER, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.profiles;
  v_row JSONB;
  v_employee public.profiles;
  v_count INTEGER := 0;
  v_step JSONB;
  num CONSTANT TEXT := '0';
BEGIN
  v_actor := public.payroll_tax_annualization_actor(p_actor);
  IF p_year IS NULL OR p_year < 2000 OR p_year > EXTRACT(YEAR FROM (NOW() AT TIME ZONE 'Asia/Manila'))::INTEGER THEN
    RAISE EXCEPTION 'invalid: choose a tax year up to this one.' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(COALESCE(p_rows, 'null'::JSONB)) <> 'array' THEN
    RAISE EXCEPTION 'invalid: nothing to save.' USING ERRCODE = 'check_violation';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    SELECT * INTO v_employee FROM public.profiles WHERE id = NULLIF(v_row ->> 'employee_id', '')::UUID;
    IF v_employee.id IS NULL THEN
      RAISE EXCEPTION 'not_found: no such employee.' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_employee.branch_id IS DISTINCT FROM v_actor.branch_id THEN
      RAISE EXCEPTION 'forbidden: % is not in your branch.', COALESCE(v_employee.full_name, 'that employee') USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_step := jsonb_build_array(jsonb_build_object(
      'at', NOW(), 'action', 'computed', 'by', v_actor.id, 'by_name', v_actor.full_name,
      'tax_due', COALESCE(v_row ->> 'tax_due', num)::NUMERIC,
      'tax_withheld', COALESCE(v_row ->> 'tax_withheld', num)::NUMERIC,
      'adjustments_settled', COALESCE(v_row ->> 'adjustments_settled', num)::NUMERIC,
      'balance', COALESCE(v_row ->> 'balance', num)::NUMERIC));

    INSERT INTO public.payroll_tax_annualizations AS t (
      tax_year, employee_id, branch_id, employee_name, employee_code,
      gross_compensation, non_taxable, taxable_compensation, tax_due, tax_withheld, adjustments_settled, balance,
      payslip_count, boxes, computed_by, computed_by_name, computed_at, history)
    VALUES (
      p_year, v_employee.id, v_employee.branch_id,
      COALESCE(NULLIF(v_row ->> 'employee_name', ''), v_employee.full_name), NULLIF(v_row ->> 'employee_code', ''),
      ROUND(COALESCE(v_row ->> 'gross_compensation', num)::NUMERIC, 2),
      ROUND(COALESCE(v_row ->> 'non_taxable', num)::NUMERIC, 2),
      ROUND(COALESCE(v_row ->> 'taxable_compensation', num)::NUMERIC, 2),
      ROUND(COALESCE(v_row ->> 'tax_due', num)::NUMERIC, 2),
      ROUND(COALESCE(v_row ->> 'tax_withheld', num)::NUMERIC, 2),
      ROUND(COALESCE(v_row ->> 'adjustments_settled', num)::NUMERIC, 2),
      ROUND(COALESCE(v_row ->> 'balance', num)::NUMERIC, 2),
      COALESCE(v_row ->> 'payslip_count', num)::INTEGER,
      COALESCE(v_row -> 'boxes', '{}'::JSONB),
      v_actor.id, v_actor.full_name, NOW(), v_step)
    ON CONFLICT (tax_year, employee_id) DO UPDATE SET
      branch_id            = EXCLUDED.branch_id,
      employee_name        = EXCLUDED.employee_name,
      employee_code        = EXCLUDED.employee_code,
      gross_compensation   = EXCLUDED.gross_compensation,
      non_taxable          = EXCLUDED.non_taxable,
      taxable_compensation = EXCLUDED.taxable_compensation,
      tax_due              = EXCLUDED.tax_due,
      tax_withheld         = EXCLUDED.tax_withheld,
      adjustments_settled  = EXCLUDED.adjustments_settled,
      balance              = EXCLUDED.balance,
      payslip_count        = EXCLUDED.payslip_count,
      boxes                = EXCLUDED.boxes,
      computed_by          = EXCLUDED.computed_by,
      computed_by_name     = EXCLUDED.computed_by_name,
      computed_at          = NOW(),
      run_count            = t.run_count + 1,
      history              = t.history || EXCLUDED.history,
      updated_at           = NOW();
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

/*
 * Schedule an annualization's adjustment onto a 2nd-cutoff payslip
 * ("December 16-31, 2026"), or clear the schedule (p_period NULL). The period
 * is a 16-end cutoff of the tax year, or January 16-31 of the next year, and
 * that payslip must not be Final yet.
 */
CREATE OR REPLACE FUNCTION public.payroll_tax_annualization_schedule(p_actor UUID, p_id UUID, p_period TEXT)
RETURNS public.payroll_tax_annualizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.profiles;
  v_row public.payroll_tax_annualizations;
  v_employee public.profiles;
  v_period TEXT := NULLIF(btrim(COALESCE(p_period, '')), '');
  v_match TEXT[];
  v_year INTEGER;
BEGIN
  v_actor := public.payroll_tax_annualization_actor(p_actor);
  SELECT * INTO v_row FROM public.payroll_tax_annualizations WHERE id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'not_found: no such annualization.' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_employee FROM public.profiles WHERE id = v_row.employee_id;
  IF v_employee.branch_id IS DISTINCT FROM v_actor.branch_id THEN
    RAISE EXCEPTION 'forbidden: that employee is not in your branch.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_period IS NULL THEN
    UPDATE public.payroll_tax_annualizations SET
      status = 'computed', target_period = NULL, scheduled_by = NULL, scheduled_by_name = NULL, scheduled_at = NULL,
      history = history || jsonb_build_array(jsonb_build_object('at', NOW(), 'action', 'unscheduled', 'by', v_actor.id,
        'by_name', v_actor.full_name, 'period', v_row.target_period)),
      updated_at = NOW()
    WHERE id = v_row.id RETURNING * INTO v_row;
    RETURN v_row;
  END IF;

  v_match := regexp_match(v_period, '^([A-Z][a-z]+) 16-(\d{2}), (\d{4})$');
  IF v_match IS NULL THEN
    RAISE EXCEPTION 'invalid: choose a 2nd-cutoff (16-end) payslip.' USING ERRCODE = 'check_violation';
  END IF;
  v_year := v_match[3]::INTEGER;
  IF NOT (v_year = v_row.tax_year OR (v_year = v_row.tax_year + 1 AND v_match[1] = 'January')) THEN
    RAISE EXCEPTION 'invalid: the adjustment goes on a payslip of % or on January 16-31, %.', v_row.tax_year, v_row.tax_year + 1 USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payroll_entries e WHERE e.employee_id = v_row.employee_id AND e.pay_period = v_period AND e.status::TEXT = 'paid') THEN
    RAISE EXCEPTION 'invalid: the % payslip is already Final; choose a later one.', v_period USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.payroll_tax_annualizations SET
    status = 'scheduled', target_period = v_period,
    scheduled_by = v_actor.id, scheduled_by_name = v_actor.full_name, scheduled_at = NOW(),
    history = history || jsonb_build_array(jsonb_build_object('at', NOW(), 'action', 'scheduled', 'by', v_actor.id,
      'by_name', v_actor.full_name, 'period', v_period, 'balance', v_row.balance)),
    updated_at = NOW()
  WHERE id = v_row.id RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_tax_annualization_actor(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_tax_annualization_save(UUID, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_tax_annualization_schedule(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_tax_annualization_actor(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_tax_annualization_save(UUID, INTEGER, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_tax_annualization_schedule(UUID, UUID, TEXT) TO service_role;

-- The year-end adjustment's payslip lines.
ALTER TABLE public.payroll_deductions DROP CONSTRAINT IF EXISTS payroll_deductions_type_check;
ALTER TABLE public.payroll_deductions ADD CONSTRAINT payroll_deductions_type_check CHECK (type IN (
  'late', 'undertime', 'half_day', 'absent', 'leave_without_pay',
  'sss', 'philhealth', 'pagibig', 'withholding_tax', 'carry_over', 'cash_advance',
  'loan', 'unpaid_holiday', 'year_end_tax'
));

ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_type_check;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_type_check CHECK (type IN (
  'early_bird', 'perfect_attendance', 'overtime', 'holiday_premium', 'incentive', 'overload',
  'subsidy', 'subsidy_adjustment', 'year_end_tax_refund'
));

ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_traceable_chk;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_traceable_chk CHECK (
  is_override
  OR type IN ('incentive', 'overload', 'subsidy', 'subsidy_adjustment', 'year_end_tax_refund')
  OR source_log_id IS NOT NULL
  OR COALESCE(array_length(source_log_ids, 1), 0) > 0
);

-- ════════════════════════════════════════════════════════════════════════════
-- Who may read, who may generate (decisions 2026-10-29)
--
--   Accountant   runs the annualization and generates 2316s for its own
--                branch only; generates the 1604-C alphalist school-wide (one
--                filing under one TIN) — a read of every branch's approved
--                payroll for that export only, never an edit.
--   Super Admin  read-only oversight: the annualization records and the BIR
--                files already generated (payroll_bir_exports), every branch.
--                It never runs, generates, schedules or edits anything.
--   Everyone else (HR, Admin, Employee): nothing here. An employee still
--                downloads their own 2316 through /api/employee/bir-2316.
-- ════════════════════════════════════════════════════════════════════════════

-- Every 2316 / alphalist file the Accountant generates, as it was generated:
-- the figures (not the TINs, which stay encrypted in profiles and are filled
-- in again when the file is shown), so it can be viewed later without
-- computing anything again.
CREATE TABLE IF NOT EXISTS public.payroll_bir_exports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               TEXT NOT NULL CHECK (kind IN ('bir_2316', 'alphalist')),
  tax_year           INTEGER NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  format             TEXT NOT NULL CHECK (format IN ('pdf', 'xlsx', 'csv')),
  -- 'branch': the generating Accountant's branch (2316); 'school': every branch (alphalist).
  scope              TEXT NOT NULL CHECK (scope IN ('branch', 'school')),
  branch_id          UUID REFERENCES public.branches(id),
  employee_id        UUID REFERENCES public.profiles(id),
  employee_count     INTEGER NOT NULL DEFAULT 0,
  employer           JSONB NOT NULL DEFAULT '{}'::JSONB,
  rows               JSONB NOT NULL DEFAULT '[]'::JSONB,
  totals             JSONB NOT NULL DEFAULT '{}'::JSONB,
  generated_by       UUID REFERENCES public.profiles(id),
  generated_by_name  TEXT,
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_bir_exports_scope_chk CHECK ((kind = 'alphalist') = (scope = 'school'))
);

CREATE INDEX IF NOT EXISTS payroll_bir_exports_year_idx ON public.payroll_bir_exports (tax_year, generated_at DESC);
CREATE INDEX IF NOT EXISTS payroll_bir_exports_branch_idx ON public.payroll_bir_exports (branch_id);
CREATE INDEX IF NOT EXISTS payroll_bir_exports_employee_idx ON public.payroll_bir_exports (employee_id);
CREATE INDEX IF NOT EXISTS payroll_bir_exports_generated_by_idx ON public.payroll_bir_exports (generated_by);

ALTER TABLE public.payroll_bir_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_bir_exports FROM anon, authenticated;
DROP POLICY IF EXISTS payroll_bir_exports_no_client_access ON public.payroll_bir_exports;
CREATE POLICY payroll_bir_exports_no_client_access ON public.payroll_bir_exports
  FOR ALL TO anon, authenticated USING (FALSE) WITH CHECK (FALSE);

DROP TRIGGER IF EXISTS payroll_bir_exports_block_hard_delete ON public.payroll_bir_exports;
CREATE TRIGGER payroll_bir_exports_block_hard_delete BEFORE DELETE ON public.payroll_bir_exports
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

-- A generated file is kept exactly as it was generated.
CREATE OR REPLACE FUNCTION public.payroll_bir_exports_no_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'forbidden: a generated BIR file is kept as it was generated.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS payroll_bir_exports_no_update ON public.payroll_bir_exports;
CREATE TRIGGER payroll_bir_exports_no_update BEFORE UPDATE ON public.payroll_bir_exports
  FOR EACH ROW EXECUTE FUNCTION public.payroll_bir_exports_no_update();

/*
 * What an account may READ of the year-end records and generated BIR files:
 * the Accountant its own branch (branch_id), the Super Admin every branch
 * (branch_id NULL, read only). Anyone else is refused.
 */
CREATE OR REPLACE FUNCTION public.payroll_bir_read_scope(p_actor UUID)
RETURNS TABLE (role TEXT, branch_id UUID, read_only BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.profiles;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id = p_actor;
  IF v_actor.id IS NULL OR COALESCE(v_actor.archived, FALSE) THEN
    RAISE EXCEPTION 'forbidden: no such account.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.role::TEXT = 'accountant' THEN
    IF v_actor.branch_id IS NULL THEN
      RAISE EXCEPTION 'forbidden: your account has no branch.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY SELECT 'accountant'::TEXT, v_actor.branch_id, FALSE;
  ELSIF v_actor.role::TEXT = 'super_admin' THEN
    RETURN QUERY SELECT 'super_admin'::TEXT, NULL::UUID, TRUE;
  ELSE
    RAISE EXCEPTION 'forbidden: only the Accountant and (read-only) the Super Admin see the year-end tax records.' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

/*
 * Record a generated file. The Accountant only. A 2316 covers only
 * employees of its own branch; the alphalist is school-wide.
 * p_rows: [{ employee_id, ... the file's figures }].
 */
CREATE OR REPLACE FUNCTION public.payroll_bir_export_save(
  p_actor UUID, p_kind TEXT, p_year INTEGER, p_format TEXT, p_employee UUID, p_rows JSONB, p_employer JSONB, p_totals JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.profiles;
  v_id UUID;
  v_outside INTEGER;
BEGIN
  v_actor := public.payroll_tax_annualization_actor(p_actor);
  IF p_kind NOT IN ('bir_2316', 'alphalist') THEN
    RAISE EXCEPTION 'invalid: unknown BIR file.' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(COALESCE(p_rows, 'null'::JSONB)) <> 'array' THEN
    RAISE EXCEPTION 'invalid: nothing to record.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind = 'bir_2316' THEN
    SELECT count(*) INTO v_outside
    FROM jsonb_array_elements(p_rows) r
    LEFT JOIN public.profiles p ON p.id = NULLIF(r ->> 'employee_id', '')::UUID
    WHERE p.id IS NULL OR p.branch_id IS DISTINCT FROM v_actor.branch_id;
    IF v_outside > 0 THEN
      RAISE EXCEPTION 'forbidden: a 2316 covers only employees of your branch.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  INSERT INTO public.payroll_bir_exports (kind, tax_year, format, scope, branch_id, employee_id, employee_count, employer, rows, totals,
    generated_by, generated_by_name)
  VALUES (p_kind, p_year, p_format, CASE WHEN p_kind = 'alphalist' THEN 'school' ELSE 'branch' END, v_actor.branch_id, p_employee,
    jsonb_array_length(p_rows), COALESCE(p_employer, '{}'::JSONB), p_rows, COALESCE(p_totals, '{}'::JSONB), v_actor.id, v_actor.full_name)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_bir_read_scope(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_bir_export_save(UUID, TEXT, INTEGER, TEXT, UUID, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_bir_read_scope(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_bir_export_save(UUID, TEXT, INTEGER, TEXT, UUID, JSONB, JSONB, JSONB) TO service_role;
