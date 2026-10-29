-- payroll_entries' flat amount columns follow the payslip (2026-10-29).
--
-- WHY: since the atomic commit (20260926090000) every payslip has been
-- written with its figures in the payroll JSON only. Neither the batch
-- ("Process payroll for all") nor the single-entry / generate path, nor the
-- final pay, sets basic_salary, sss, philhealth, pagibig, withholding_tax,
-- gross_pay, total_deductions or net_pay, so those columns kept their default
-- 0 while the payslip showed the right figures. The app and the SQL readers
-- (payroll_entries_totals, submit_payroll_run) read the JSON first, but a
-- column read on its own was wrong.
--
-- WHAT: a BEFORE INSERT / UPDATE OF payroll trigger copies the figures from
-- the JSON into the columns, for every path at once:
--   basic_salary      payroll.basic_salary
--   sss / philhealth / pagibig / withholding_tax
--                     payroll.deductions.* (a final pay: the sum of its
--                     breakdown lines of that kind). withholding_tax is the
--                     REGULAR withholding tax: a year-end tax adjustment is
--                     never added to it (payroll.year_end_tax).
--   gross_pay         payroll.monthly.cutoff.gross_pay, else payroll.totals.gross_pay
--   total_deductions  payroll.totals.total_deductions
--   net_pay           payroll.totals.net_pay, never below zero
-- A figure missing from the JSON leaves the column as it is.
--
-- NOT DONE HERE: existing rows are not touched (the trigger runs only when a
-- payslip is written). The rows whose columns differ from their JSON are
-- listed for review by the query at the end of this file (commented out);
-- correcting them is a separate, signed-off step.

CREATE OR REPLACE FUNCTION public.payroll_entries_columns_from_payroll()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  p JSONB := NEW.payroll;
  v_lines JSONB;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RETURN NEW;
  END IF;
  v_lines := p #> '{final_pay,breakdown,deductions}';

  NEW.basic_salary := COALESCE(public.payroll_json_amount(p -> 'basic_salary'), NEW.basic_salary);
  IF jsonb_typeof(v_lines) = 'array' THEN
    NEW.sss := (SELECT COALESCE(SUM(public.payroll_json_amount(l -> 'amount')), 0) FROM jsonb_array_elements(v_lines) l WHERE l ->> 'kind' = 'sss');
    NEW.philhealth := (SELECT COALESCE(SUM(public.payroll_json_amount(l -> 'amount')), 0) FROM jsonb_array_elements(v_lines) l WHERE l ->> 'kind' = 'philhealth');
    NEW.pagibig := (SELECT COALESCE(SUM(public.payroll_json_amount(l -> 'amount')), 0) FROM jsonb_array_elements(v_lines) l WHERE l ->> 'kind' = 'pagibig');
    NEW.withholding_tax := (SELECT COALESCE(SUM(public.payroll_json_amount(l -> 'amount')), 0) FROM jsonb_array_elements(v_lines) l WHERE l ->> 'kind' = 'withholding_tax');
  ELSE
    NEW.sss := COALESCE(public.payroll_json_amount(p #> '{deductions,sss}'), NEW.sss);
    NEW.philhealth := COALESCE(public.payroll_json_amount(p #> '{deductions,philhealth}'), NEW.philhealth);
    NEW.pagibig := COALESCE(public.payroll_json_amount(p #> '{deductions,pagibig}'), NEW.pagibig);
    NEW.withholding_tax := COALESCE(public.payroll_json_amount(p #> '{deductions,withholding_tax}'), NEW.withholding_tax);
  END IF;
  NEW.gross_pay := COALESCE(public.payroll_json_amount(p #> '{monthly,cutoff,gross_pay}'), public.payroll_json_amount(p #> '{totals,gross_pay}'), NEW.gross_pay);
  NEW.total_deductions := COALESCE(public.payroll_json_amount(p #> '{totals,total_deductions}'), NEW.total_deductions);
  NEW.net_pay := COALESCE(GREATEST(0, public.payroll_json_amount(p #> '{totals,net_pay}')), NEW.net_pay);
  RETURN NEW;
END;
$$;

-- A JSON number (or numeric string) as NUMERIC rounded to centavos; NULL otherwise.
CREATE OR REPLACE FUNCTION public.payroll_json_amount(v JSONB)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN jsonb_typeof(v) = 'number' THEN ROUND((v #>> '{}')::NUMERIC, 2)
    WHEN jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^-?\d+(\.\d+)?$' THEN ROUND((v #>> '{}')::NUMERIC, 2)
    ELSE NULL
  END;
$$;

DROP TRIGGER IF EXISTS payroll_entries_columns_from_payroll ON public.payroll_entries;
CREATE TRIGGER payroll_entries_columns_from_payroll
  BEFORE INSERT OR UPDATE OF payroll ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.payroll_entries_columns_from_payroll();

REVOKE ALL ON FUNCTION public.payroll_entries_columns_from_payroll() FROM PUBLIC, anon, authenticated;

-- Review query (run by hand; changes nothing): payslips whose columns differ
-- from their payroll JSON.
--
-- SELECT e.id, e.payslip_no, e.employee_name, e.pay_period, e.status, r.status AS run_status,
--        e.net_pay, GREATEST(0, public.payroll_json_amount(e.payroll #> '{totals,net_pay}')) AS json_net_pay,
--        e.withholding_tax, public.payroll_json_amount(e.payroll #> '{deductions,withholding_tax}') AS json_withholding_tax
-- FROM public.payroll_entries e LEFT JOIN public.payroll_runs r ON r.id = e.run_id
-- WHERE e.net_pay IS DISTINCT FROM GREATEST(0, public.payroll_json_amount(e.payroll #> '{totals,net_pay}'))
--    OR e.withholding_tax IS DISTINCT FROM public.payroll_json_amount(e.payroll #> '{deductions,withholding_tax}')
-- ORDER BY e.pay_period, e.employee_name;
