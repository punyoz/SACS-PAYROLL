-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 of 20260927080000_profiles_pii_encryption.sql: retire plain text
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The app no longer reads profiles.sss_number / philhealth_number /
-- pagibig_number / tin_number / bank_account_number: it shows the masked
-- <field>_last4 and decrypts through public.get_profiles_pii() where the full
-- number is needed (src/lib/employees/pii.js). So:
--
--   1. private.pii_plaintext_retired() now returns true: the
--      profiles_protect_pii trigger still encrypts whatever is written to
--      those columns, then stores NULL in them.
--   2. The plain text already stored is cleared -- only after checking that
--      every value has a ciphertext that decrypts back to it.
--   3. The same keys are removed from auth.users.raw_user_meta_data, which
--      Supabase copies into every access token.
--
-- Safe to run more than once.

-- 1. The switch.
CREATE OR REPLACE FUNCTION private.pii_plaintext_retired()
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT true; $$;

-- 2a. Refuse to discard anything that is not safely encrypted.
DO $$
DECLARE
  unsafe integer;
BEGIN
  SELECT count(*) INTO unsafe
    FROM public.profiles p
   WHERE (p.sss_number IS NOT NULL
          AND private.decrypt_pii(p.sss_number_enc) IS DISTINCT FROM p.sss_number)
      OR (p.philhealth_number IS NOT NULL
          AND private.decrypt_pii(p.philhealth_number_enc) IS DISTINCT FROM p.philhealth_number)
      OR (p.pagibig_number IS NOT NULL
          AND private.decrypt_pii(p.pagibig_number_enc) IS DISTINCT FROM p.pagibig_number)
      OR (p.tin_number IS NOT NULL
          AND private.decrypt_pii(p.tin_number_enc) IS DISTINCT FROM p.tin_number)
      OR (p.bank_account_number IS NOT NULL
          AND private.decrypt_pii(p.bank_account_number_enc) IS DISTINCT FROM p.bank_account_number);
  IF unsafe > 0 THEN
    RAISE EXCEPTION '% profile(s) have plain text with no matching ciphertext; not clearing', unsafe;
  END IF;
END;
$$;

-- 2b. Clear the plain text. profiles_protect_pii is off for this one
-- statement: it would read "set to NULL" as a change and re-encrypt NULL,
-- wiping the ciphertext.
ALTER TABLE public.profiles DISABLE TRIGGER profiles_protect_pii;

UPDATE public.profiles
   SET sss_number = NULL,
       philhealth_number = NULL,
       pagibig_number = NULL,
       tin_number = NULL,
       bank_account_number = NULL
 WHERE sss_number IS NOT NULL
    OR philhealth_number IS NOT NULL
    OR pagibig_number IS NOT NULL
    OR tin_number IS NOT NULL
    OR bank_account_number IS NOT NULL;

ALTER TABLE public.profiles ENABLE TRIGGER profiles_protect_pii;

-- 3. Out of Auth metadata (and so out of access tokens). TIN was only ever
-- kept there; it was encrypted into profiles by the phase 1 backfill.
UPDATE auth.users
   SET raw_user_meta_data = raw_user_meta_data
       - 'sss_number' - 'philhealth_number' - 'pagibig_number'
       - 'tin_number' - 'bank_account_number'
 WHERE raw_user_meta_data ?| ARRAY['sss_number', 'philhealth_number', 'pagibig_number',
                                  'tin_number', 'bank_account_number'];
