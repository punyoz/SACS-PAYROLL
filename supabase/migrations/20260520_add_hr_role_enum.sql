-- Add 'hr' value to the user_role enum if it doesn't already exist.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction, so this uses
-- a DO block with a guard to make it idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.user_role'::regtype
      AND enumlabel = 'hr'
  ) THEN
    ALTER TYPE public.user_role ADD VALUE 'hr';
  END IF;
END;
$$;
