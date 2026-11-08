-- Demo data flag (decided 2026-11-08).
--
--   profiles.is_demo   TRUE for a demo person, set ONLY by the demo seed
--                      (e2e/scale/demo-60.sql). Default FALSE. This migration
--                      flags NO existing row: which existing accounts (if
--                      any) are demo is the owner's decision, row by row.
--
-- Exports and reports skip demo people and every row that belongs to them
-- (the row's employee_id / user_id is a demo profile). Here: the Super
-- Admin's backup functions (20261108010000) are redefined with that rule;
-- the app's reports use src/lib/demo.js.
--
-- Safe to run more than once.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN public.profiles.is_demo IS 'Demo person (set only by the demo seed). Exports and reports skip it and its rows.';
CREATE INDEX IF NOT EXISTS profiles_is_demo_idx ON public.profiles (id) WHERE is_demo;

-- The WHERE clause that keeps demo people (and their rows) out of a table.
CREATE OR REPLACE FUNCTION public.backup_demo_filter(p_table text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_link text;
BEGIN
  IF p_table = 'profiles' THEN
    RETURN 'NOT COALESCE(t.is_demo, FALSE)';
  END IF;
  SELECT c.column_name INTO v_link
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = p_table AND c.column_name IN ('employee_id', 'user_id') AND c.data_type = 'uuid'
  ORDER BY c.column_name
  LIMIT 1;
  IF v_link IS NULL THEN
    RETURN 'TRUE';
  END IF;
  RETURN format('NOT EXISTS (SELECT 1 FROM public.profiles d WHERE d.id = t.%I AND d.is_demo)', v_link);
END;
$function$;

CREATE OR REPLACE FUNCTION public.backup_export_count(p_actor uuid, p_table text)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count bigint;
BEGIN
  PERFORM public.backup_export_check(p_actor, p_table);
  EXECUTE format('SELECT count(*) FROM public.%I t WHERE %s', p_table, public.backup_demo_filter(p_table)) INTO v_count;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backup_export_counts(p_actor uuid, p_tables text[] DEFAULT NULL)
 RETURNS TABLE (table_name text, row_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_table text;
  v_count bigint;
BEGIN
  PERFORM public.backup_export_check(p_actor, NULL);
  FOREACH v_table IN ARRAY public.backup_export_tables() LOOP
    IF p_tables IS NULL OR v_table = ANY (p_tables) THEN
      EXECUTE format('SELECT count(*) FROM public.%I t WHERE %s', v_table, public.backup_demo_filter(v_table)) INTO v_count;
      table_name := v_table;
      row_count := v_count;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backup_export_page(p_actor uuid, p_table text, p_after text DEFAULT NULL, p_limit integer DEFAULT 1000)
 RETURNS TABLE (row_key text, row_data jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pk text;
  v_type text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
BEGIN
  PERFORM public.backup_export_check(p_actor, p_table);
  IF p_table IS NULL THEN
    RAISE EXCEPTION 'invalid_table: choose a table.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT a.attname, format_type(a.atttypid, a.atttypmod) INTO v_pk, v_type
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
  WHERE i.indrelid = format('public.%I', p_table)::regclass AND i.indisprimary
  LIMIT 1;
  IF v_pk IS NULL THEN
    RAISE EXCEPTION 'invalid_table: % has no primary key.', p_table USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT t.%1$I::text, (to_jsonb(t) - $3) FROM public.%2$I t WHERE ($1::text IS NULL OR t.%1$I > $1::%3$s) AND %4$s ORDER BY t.%1$I LIMIT $2',
    v_pk, p_table, v_type, public.backup_demo_filter(p_table))
  USING p_after, v_limit, public.backup_export_hidden_columns();
END;
$function$;

CREATE OR REPLACE FUNCTION public.backup_payroll_export(p_actor uuid, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 1000)
 RETURNS TABLE (
   id uuid, payslip_no text, employee_id uuid, employee_code text, employee_name text, employee_type text,
   "position" text, branch_id uuid, branch_name text, pay_period text, cutoff text, status text,
   basic_salary numeric, overtime_pay numeric, bonus numeric, gross_pay numeric,
   sss numeric, philhealth numeric, pagibig numeric, withholding_tax numeric,
   absences_deduction numeric, cash_advance numeric, total_deductions numeric, net_pay numeric,
   submitted_at timestamptz, approved_at timestamptz, created_at timestamptz, updated_at timestamptz,
   created_in_testing_mode boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.backup_export_check(p_actor, 'payroll_entries');
  RETURN QUERY
    SELECT e.id, e.payslip_no, e.employee_id, e.employee_code, e.employee_name, e.employee_type,
      e.position, e.branch_id, b.name, e.pay_period, e.cutoff, e.status::text,
      e.basic_salary, e.overtime_pay, e.bonus, e.gross_pay,
      e.sss, e.philhealth, e.pagibig, e.withholding_tax,
      e.absences_deduction, e.cash_advance, e.total_deductions, e.net_pay,
      e.submitted_at, e.approved_at, e.created_at, e.updated_at,
      COALESCE(e.created_in_testing_mode, FALSE)
    FROM public.payroll_entries e
    LEFT JOIN public.branches b ON b.id = e.branch_id
    WHERE (p_after IS NULL OR e.id > p_after)
      AND NOT EXISTS (SELECT 1 FROM public.profiles d WHERE d.id = e.employee_id AND d.is_demo)
    ORDER BY e.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
END;
$function$;

REVOKE ALL ON FUNCTION public.backup_demo_filter(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_count(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_counts(uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_page(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_payroll_export(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backup_export_count(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_counts(uuid, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_page(uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_payroll_export(uuid, uuid, integer) TO service_role;
