-- The Super Admin's backup includes demo people (decided 2026-11-15).
--
-- While the demo data is live, the backup keeps demo people and their rows;
-- every CSV with a profile link has an "Is demo" column (Yes / No) so they can
-- be filtered out. 20261108040000 had left them out of backup_export_counts and
-- backup_export_page; this puts back the 20261108010000 bodies (no demo
-- filter). Same signatures, same Super Admin check, same hidden columns.
--
-- Functions only: no table or row is changed. Safe to run more than once.
-- public.backup_demo_filter and public.backup_payroll_export are left as they
-- are (the CSV backup no longer calls backup_payroll_export).

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
      EXECUTE format('SELECT count(*) FROM public.%I', v_table) INTO v_count;
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
    'SELECT t.%1$I::text, (to_jsonb(t) - $3) FROM public.%2$I t WHERE ($1::text IS NULL OR t.%1$I > $1::%3$s) ORDER BY t.%1$I LIMIT $2',
    v_pk, p_table, v_type)
  USING p_after, v_limit, public.backup_export_hidden_columns();
END;
$function$;

REVOKE ALL ON FUNCTION public.backup_export_counts(uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_page(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backup_export_counts(uuid, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_page(uuid, text, text, integer) TO service_role;
