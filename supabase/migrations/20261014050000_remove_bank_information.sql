-- ═══════════════════════════════════════════════════════════════════════════
-- Remove bank information
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The school does not use bank details: they are removed from the system
-- (user's decision, Oct 14, 2026). Run AFTER the code that no longer reads
-- them is deployed -- the previous version selects these columns.
--
--   1. private.profiles_protect_pii   no longer handles bank columns (the
--                                     government ID numbers are unchanged).
--   2. public.get_profiles_pii        recreated without its bank column
--                                     (same owner and grants: service_role).
--   3. profiles                       bank_name, bank_account_number,
--                                     bank_account_number_enc and
--                                     bank_account_number_last4 dropped, with
--                                     their CHECK constraint. THE STORED BANK
--                                     DETAILS ARE DELETED.
--   4. auth.users                     the bank keys left in user_metadata
--                                     are removed.
--   5. Vault                          the encryption key's description no
--                                     longer mentions bank accounts (the key
--                                     itself is untouched).
--
-- Safe to run more than once.

-- ── 1. The encrypt-on-write trigger, without the bank columns ─────────────

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
    NEW.sss_number_enc   := private.encrypt_pii(NEW.sss_number);
    NEW.sss_number_last4 := right(NEW.sss_number, 4);
  END IF;

  IF TG_OP = 'INSERT' OR NEW.philhealth_number IS DISTINCT FROM OLD.philhealth_number THEN
    NEW.philhealth_number       := NULLIF(btrim(NEW.philhealth_number), '');
    NEW.philhealth_number_enc   := private.encrypt_pii(NEW.philhealth_number);
    NEW.philhealth_number_last4 := right(NEW.philhealth_number, 4);
  END IF;

  IF TG_OP = 'INSERT' OR NEW.pagibig_number IS DISTINCT FROM OLD.pagibig_number THEN
    NEW.pagibig_number       := NULLIF(btrim(NEW.pagibig_number), '');
    NEW.pagibig_number_enc   := private.encrypt_pii(NEW.pagibig_number);
    NEW.pagibig_number_last4 := right(NEW.pagibig_number, 4);
  END IF;

  IF TG_OP = 'INSERT' OR NEW.tin_number IS DISTINCT FROM OLD.tin_number THEN
    NEW.tin_number       := NULLIF(btrim(NEW.tin_number), '');
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

-- ── 2. The decrypting read, without the bank column ───────────────────────
-- Its result columns change, so it is dropped and created again.

DROP FUNCTION IF EXISTS public.get_profiles_pii(uuid[]);

CREATE FUNCTION public.get_profiles_pii(p_profile_ids uuid[])
RETURNS TABLE(id uuid, sss_number text, philhealth_number text, pagibig_number text, tin_number text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT p.id,
         private.decrypt_pii(p.sss_number_enc),
         private.decrypt_pii(p.philhealth_number_enc),
         private.decrypt_pii(p.pagibig_number_enc),
         private.decrypt_pii(p.tin_number_enc)
  FROM public.profiles p
  WHERE p.id = ANY (p_profile_ids);
$function$;

REVOKE EXECUTE ON FUNCTION public.get_profiles_pii(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_profiles_pii(uuid[]) TO service_role;

-- ── 3. The columns (and the stored values) ────────────────────────────────

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS bank_account_number_last4,
  DROP COLUMN IF EXISTS bank_account_number_enc,
  DROP COLUMN IF EXISTS bank_account_number,
  DROP COLUMN IF EXISTS bank_name;

-- ── 4. Copies left in Auth user_metadata ──────────────────────────────────

UPDATE auth.users
   SET raw_user_meta_data = raw_user_meta_data - 'bank_name' - 'bank_account_number'
 WHERE raw_user_meta_data ?| ARRAY['bank_name', 'bank_account_number'];

-- ── 5. The Vault key's description (the secret is not changed) ────────────

DO $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'pii_encryption_key';
  IF v_id IS NOT NULL THEN
    PERFORM vault.update_secret(
      v_id,
      NULL,
      NULL,
      'AES-256 key for profiles government ID numbers. Do not rotate without re-encrypting.'
    );
  END IF;
END $$;
