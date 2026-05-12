-- Drop NOT NULL on every column in payroll_entries except the primary key.
-- The table was created with an older schema containing unknown NOT NULL columns
-- that our upsert does not populate, causing silent DB write failures.
-- Making all non-id columns nullable lets our partial upsert always succeed.

DO $$
DECLARE
  col RECORD;
BEGIN
  FOR col IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'payroll_entries'
      AND column_name  <> 'id'
      AND is_nullable  = 'NO'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.payroll_entries ALTER COLUMN %I DROP NOT NULL',
      col.column_name
    );
  END LOOP;
END$$;
