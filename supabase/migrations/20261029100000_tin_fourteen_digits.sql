-- TIN: 9, 12 or 14 digits (decision 2026-10-29). BIR has issued 9-digit
-- TINs (older registrations), 12 with the 3-digit branch code and 14 with
-- the 5-digit one; refusing any of them would refuse a real employee's TIN.
--
--   profiles.tin_number         varchar(12) -> varchar(14) (it is emptied by
--                               the trigger once encrypted; the width only has
--                               to admit the value on its way in)
--   profiles_tin_number_check   9, 12 or 14 digits
--   private.profiles_protect_pii()
--                               the 20261029090000 trigger, TIN rule widened
--
-- Safe to run more than once.

ALTER TABLE public.profiles ALTER COLUMN tin_number TYPE varchar(14);

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_tin_number_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_tin_number_check
  CHECK (tin_number IS NULL OR tin_number::text ~ '^([0-9]{9}|[0-9]{12}|[0-9]{14})$') NOT VALID;
ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_tin_number_check;

CREATE OR REPLACE FUNCTION private.profiles_protect_pii()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  retired boolean := private.pii_plaintext_retired();
BEGIN
  IF TG_OP = 'INSERT' OR NEW.sss_number IS DISTINCT FROM OLD.sss_number THEN
    NEW.sss_number       := NULLIF(btrim(NEW.sss_number), '');
    IF NEW.sss_number !~ '^[0-9]{10}$' THEN
      RAISE EXCEPTION 'SSS number must be exactly 10 digits.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.sss_number_enc   := private.encrypt_pii(NEW.sss_number);
    NEW.sss_number_last4 := right(NEW.sss_number, 4);
  END IF;

  IF TG_OP = 'INSERT' OR NEW.philhealth_number IS DISTINCT FROM OLD.philhealth_number THEN
    NEW.philhealth_number       := NULLIF(btrim(NEW.philhealth_number), '');
    IF NEW.philhealth_number !~ '^[0-9]{12}$' THEN
      RAISE EXCEPTION 'PhilHealth number must be exactly 12 digits.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.philhealth_number_enc   := private.encrypt_pii(NEW.philhealth_number);
    NEW.philhealth_number_last4 := right(NEW.philhealth_number, 4);
  END IF;

  IF TG_OP = 'INSERT' OR NEW.pagibig_number IS DISTINCT FROM OLD.pagibig_number THEN
    NEW.pagibig_number       := NULLIF(btrim(NEW.pagibig_number), '');
    IF NEW.pagibig_number !~ '^[0-9]{12}$' THEN
      RAISE EXCEPTION 'Pag-IBIG number must be exactly 12 digits.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.pagibig_number_enc   := private.encrypt_pii(NEW.pagibig_number);
    NEW.pagibig_number_last4 := right(NEW.pagibig_number, 4);
  END IF;

  IF TG_OP = 'INSERT' OR NEW.tin_number IS DISTINCT FROM OLD.tin_number THEN
    NEW.tin_number       := NULLIF(btrim(NEW.tin_number), '');
    IF NEW.tin_number !~ '^([0-9]{9}|[0-9]{12}|[0-9]{14})$' THEN
      RAISE EXCEPTION 'TIN must be 9, 12 or 14 digits (with the branch code).' USING ERRCODE = 'check_violation';
    END IF;
    NEW.tin_number_enc   := private.encrypt_pii(NEW.tin_number);
    NEW.tin_number_last4 := right(NEW.tin_number, 4);
  END IF;

  IF retired THEN
    NEW.sss_number := NULL;
    NEW.philhealth_number := NULL;
    NEW.pagibig_number := NULL;
    NEW.tin_number := NULL;
  END IF;

  RETURN NEW;
END;
$function$;
