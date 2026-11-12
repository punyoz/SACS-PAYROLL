-- ════════════════════════════════════════════════════════════════════════════
-- BIR forms: the Super Admin only (decision 2026-11-12).
--
-- The BIR belongs to the school and is handled only by the Super Admin:
-- the year-end tax annualization screen, BIR Form 2316, the 1604-C alphalist
-- and the generated BIR files. HR, Accountant, Employee and Admin get nothing
-- here (no page, no API, no database function).
--
--   1. role_permissions: a new module "bir_forms" (src/lib/rbac/permissions.js).
--      Super Admin: create / read / update, every branch. Everyone else: none.
--      "payroll_reports" is NOT changed: the Accountant keeps its Payroll
--      Reports page (remittance, payroll summaries) without the BIR cards.
--   2. The database functions of 20261029010000 now accept the Super Admin
--      only (they accepted the Accountant, and the Super Admin read-only):
--        payroll_tax_annualization_actor     the Super Admin, not archived
--        payroll_tax_annualization_save      no branch check (every branch)
--        payroll_tax_annualization_schedule  no branch check (every branch)
--        payroll_bir_read_scope              the Super Admin, every branch, not read-only
--        payroll_bir_export_save             a 2316 records its employees' branch
--   Signatures, grants (service_role only) and everything the functions
--   write are unchanged.
--
-- NOT changed (payroll processing): the withholding tax, the tax table, and
-- how a scheduled year-end adjustment is computed and carried onto a payslip
-- (the payroll engine reads payroll_tax_annualizations directly, whoever
-- scheduled it). No table is dropped, no row is changed or deleted: every
-- annualization record and generated BIR file stays.
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'bir_forms', 'all', true, true, true, false),
  ('admin', 'bir_forms', 'none', false, false, false, false),
  ('hr', 'bir_forms', 'none', false, false, false, false),
  ('accountant', 'bir_forms', 'none', false, false, false, false),
  ('employee', 'bir_forms', 'none', false, false, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope = EXCLUDED.scope, can_create = EXCLUDED.can_create, can_read = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete;

-- The acting Super Admin, or an error.
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
  IF v_actor.id IS NULL OR v_actor.role::TEXT <> 'super_admin' OR COALESCE(v_actor.archived, FALSE) THEN
    RAISE EXCEPTION 'forbidden: only the Super Admin handles the BIR forms and the year-end tax annualization.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_actor;
END;
$$;

/*
 * Save one annualization run (the Super Admin, any branch): p_rows is
 * [{ employee_id, employee_name, employee_code, gross_compensation,
 * non_taxable, taxable_compensation, tax_due, tax_withheld,
 * adjustments_settled, balance, payslip_count, boxes }]. A row already there
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
 * that payslip must not be Final yet. The Super Admin, any branch.
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
  v_period TEXT := NULLIF(btrim(COALESCE(p_period, '')), '');
  v_match TEXT[];
  v_year INTEGER;
BEGIN
  v_actor := public.payroll_tax_annualization_actor(p_actor);
  SELECT * INTO v_row FROM public.payroll_tax_annualizations WHERE id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'not_found: no such annualization.' USING ERRCODE = 'no_data_found'; END IF;

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

/*
 * What an account may READ of the year-end records and generated BIR files:
 * the Super Admin, every branch (branch_id NULL, not read-only). Anyone else
 * is refused.
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
  IF v_actor.role::TEXT = 'super_admin' THEN
    RETURN QUERY SELECT 'super_admin'::TEXT, NULL::UUID, FALSE;
  ELSE
    RAISE EXCEPTION 'forbidden: only the Super Admin sees the BIR forms and the year-end tax records.' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

/*
 * Record a generated file. The Super Admin only. A 2316 records the branch
 * of its employees (when they share one); the alphalist is school-wide.
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
  v_branches UUID[];
  v_branch UUID;
BEGIN
  v_actor := public.payroll_tax_annualization_actor(p_actor);
  IF p_kind NOT IN ('bir_2316', 'alphalist') THEN
    RAISE EXCEPTION 'invalid: unknown BIR file.' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(COALESCE(p_rows, 'null'::JSONB)) <> 'array' THEN
    RAISE EXCEPTION 'invalid: nothing to record.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind = 'bir_2316' THEN
    SELECT array_agg(DISTINCT p.branch_id) INTO v_branches
    FROM jsonb_array_elements(p_rows) r
    JOIN public.profiles p ON p.id = NULLIF(r ->> 'employee_id', '')::UUID;
    IF COALESCE(array_length(v_branches, 1), 0) = 1 THEN
      v_branch := v_branches[1];
    END IF;
  END IF;
  INSERT INTO public.payroll_bir_exports (kind, tax_year, format, scope, branch_id, employee_id, employee_count, employer, rows, totals,
    generated_by, generated_by_name)
  VALUES (p_kind, p_year, p_format, CASE WHEN p_kind = 'alphalist' THEN 'school' ELSE 'branch' END, v_branch, p_employee,
    jsonb_array_length(p_rows), COALESCE(p_employer, '{}'::JSONB), p_rows, COALESCE(p_totals, '{}'::JSONB), v_actor.id, v_actor.full_name)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Server only, as before (the API calls them with the service role after its own check).
REVOKE ALL ON FUNCTION public.payroll_tax_annualization_actor(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_tax_annualization_save(UUID, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_tax_annualization_schedule(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_bir_read_scope(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_bir_export_save(UUID, TEXT, INTEGER, TEXT, UUID, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_tax_annualization_actor(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_tax_annualization_save(UUID, INTEGER, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_tax_annualization_schedule(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_bir_read_scope(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_bir_export_save(UUID, TEXT, INTEGER, TEXT, UUID, JSONB, JSONB, JSONB) TO service_role;
