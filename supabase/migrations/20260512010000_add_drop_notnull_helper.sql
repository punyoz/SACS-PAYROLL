-- Helper function so the API can auto-fix unknown NOT NULL constraints on
-- payroll_entries without requiring a manual migration each time a new
-- pre-existing column blocks our upsert.
-- Restricted to payroll_entries only; runs as SECURITY DEFINER so the
-- service-role caller has sufficient privilege.

CREATE OR REPLACE FUNCTION public.drop_column_not_null(tbl text, col text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF tbl <> 'payroll_entries' THEN
    RAISE EXCEPTION 'drop_column_not_null: not allowed on table %', tbl;
  END IF;
  EXECUTE format(
    'ALTER TABLE public.payroll_entries ALTER COLUMN %I DROP NOT NULL',
    col
  );
END;
$$;
