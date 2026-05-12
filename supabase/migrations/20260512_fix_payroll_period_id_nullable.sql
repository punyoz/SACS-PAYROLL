-- Drop the NOT NULL constraint on payroll_period_id if it exists.
-- The column is from an older schema; our code uses pay_period (TEXT) instead
-- and never populates payroll_period_id, causing upserts to fail.
-- Safe to run on any environment: the DO block checks before altering.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'payroll_entries'
      AND column_name  = 'payroll_period_id'
      AND is_nullable  = 'NO'
  ) THEN
    ALTER TABLE public.payroll_entries
      ALTER COLUMN payroll_period_id DROP NOT NULL;
  END IF;
END$$;
