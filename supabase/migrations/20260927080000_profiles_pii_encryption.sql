-- ═══════════════════════════════════════════════════════════════════════════
-- Column-level encryption and masking for government IDs and bank accounts
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SSS, PhilHealth, Pag-IBIG and TIN are national identifiers, and a bank
-- account number is what payroll pays into. Until now they were stored as
-- plain text in profiles (and TIN only in Auth user_metadata). This adds:
--
--   * one AES-256 key, generated inside the database and kept in Supabase
--     Vault (never in this file or the repo);
--   * private.encrypt_pii() / private.decrypt_pii() -- pgcrypto
--     pgp_sym_encrypt / pgp_sym_decrypt with that key;
--   * private.mask_pii() -- "••••••7890", for display;
--   * <field>_enc (ciphertext) and <field>_last4 (for masked display)
--     columns on profiles, backfilled from the plain-text columns and, for
--     TIN, from Auth metadata;
--   * a BEFORE INSERT/UPDATE trigger that keeps the encrypted columns in step
--     with whatever the app writes, and that strips bank details from Admin
--     and Super Admin profiles -- an operator login is not paid through
--     payroll (see src/lib/employees/staff-record.js);
--   * public.get_profiles_pii(uuid[]) -- the one decrypting read, callable by
--     service_role only, for the API routes that need the full number
--     (payroll computation, HR's Edit Employee) after their RBAC check.
--
-- pgsodium is not used: Supabase has deprecated it. Vault and pgcrypto are
-- both already installed on this project.
--
-- PHASE 1 (this file) is additive and leaves the plain-text columns in place,
-- so every existing route keeps working while it is moved to the _last4
-- columns / get_profiles_pii(). Phase 2 -- once no code reads the plain-text
-- columns -- sets private.pii_plaintext_retired() to true, clears the
-- plain-text columns and strips these keys from auth.users.raw_user_meta_data
-- (Supabase copies user_metadata into every access token). From then on the
-- trigger encrypts what is written and discards the plain text.
--
-- Clearing a value: write '' (empty string) to the plain-text column. The
-- trigger clears the encrypted and last4 columns and stores NULL, which
-- works the same in both phases.
--
-- Safe to run more than once.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

-- ── The key ────────────────────────────────────────────────────────────────
-- 32 random bytes, base64. Created once; re-running keeps the existing key
-- (replacing it would make every stored value unreadable).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'pii_encryption_key') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'base64'),
      'pii_encryption_key',
      'AES-256 key for profiles government IDs and bank account numbers. Do not rotate without re-encrypting.'
    );
  END IF;
END;
$$;

-- ── Functions ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.pii_key()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pii_encryption_key';
$$;

CREATE OR REPLACE FUNCTION private.encrypt_pii(value text)
RETURNS bytea
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  k text := private.pii_key();
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN
    RETURN NULL;
  END IF;
  IF k IS NULL THEN
    RAISE EXCEPTION 'pii_encryption_key is missing from Vault';
  END IF;
  RETURN extensions.pgp_sym_encrypt(value, k, 'cipher-algo=aes256, compress-algo=0');
END;
$$;

CREATE OR REPLACE FUNCTION private.decrypt_pii(value bytea)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN value IS NULL THEN NULL
              ELSE extensions.pgp_sym_decrypt(value, private.pii_key()) END;
$$;

-- "123456789012" -> "••••••••9012". Anything with no more than `visible`
-- characters is masked completely.
CREATE OR REPLACE FUNCTION private.mask_pii(value text, visible integer DEFAULT 4)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN value IS NULL OR value = '' THEN NULL
    WHEN length(value) <= visible THEN repeat('•', length(value))
    ELSE repeat('•', length(value) - visible) || right(value, visible)
  END;
$$;

-- Phase switch. false: plain-text columns are kept alongside the ciphertext.
-- Phase 2 replaces this body with `SELECT true`.
CREATE OR REPLACE FUNCTION private.pii_plaintext_retired()
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT false; $$;

-- ── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS sss_number_enc           bytea,
  ADD COLUMN IF NOT EXISTS sss_number_last4         text,
  ADD COLUMN IF NOT EXISTS philhealth_number_enc    bytea,
  ADD COLUMN IF NOT EXISTS philhealth_number_last4  text,
  ADD COLUMN IF NOT EXISTS pagibig_number_enc       bytea,
  ADD COLUMN IF NOT EXISTS pagibig_number_last4     text,
  -- Write-only inlet for TIN, like the other plain-text columns (TIN used to
  -- live in Auth metadata only).
  ADD COLUMN IF NOT EXISTS tin_number               varchar(12),
  ADD COLUMN IF NOT EXISTS tin_number_enc           bytea,
  ADD COLUMN IF NOT EXISTS tin_number_last4         text,
  ADD COLUMN IF NOT EXISTS bank_account_number_enc  bytea,
  ADD COLUMN IF NOT EXISTS bank_account_number_last4 text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_tin_number_check') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_tin_number_check
      CHECK (tin_number IS NULL OR tin_number ~ '^([0-9]{9}|[0-9]{12})$');
  END IF;
END;
$$;

-- The ciphertext columns are readable wherever the row is (a column-level
-- REVOKE has no effect while a role holds table-wide SELECT), but they are
-- useless without the key, and only the SECURITY DEFINER functions here can
-- read the key.

-- ── Trigger ────────────────────────────────────────────────────────────────
-- For each plain-text column: on INSERT, or when the written value differs
-- from the stored one, re-encrypt and refresh last4; '' clears. A column the
-- UPDATE does not touch keeps NEW = OLD and is left alone -- in phase 2 both
-- are NULL, so an untouched column never wipes its ciphertext.
CREATE OR REPLACE FUNCTION private.profiles_protect_pii()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  retired boolean := private.pii_plaintext_retired();
BEGIN
  -- Admin and Super Admin are operator logins, not payees.
  IF lower(coalesce(NEW.role::text, '')) IN ('admin', 'super_admin') THEN
    NEW.bank_name := NULL;
    NEW.bank_account_number := NULL;
    NEW.bank_account_number_enc := NULL;
    NEW.bank_account_number_last4 := NULL;
  END IF;

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

  IF TG_OP = 'INSERT' OR NEW.bank_account_number IS DISTINCT FROM OLD.bank_account_number THEN
    NEW.bank_account_number       := NULLIF(btrim(NEW.bank_account_number), '');
    NEW.bank_account_number_enc   := private.encrypt_pii(NEW.bank_account_number);
    NEW.bank_account_number_last4 := right(NEW.bank_account_number, 4);
  END IF;

  IF retired THEN
    NEW.sss_number := NULL;
    NEW.philhealth_number := NULL;
    NEW.pagibig_number := NULL;
    NEW.tin_number := NULL;
    NEW.bank_account_number := NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.pii_key()                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.encrypt_pii(text)            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.decrypt_pii(bytea)           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.profiles_protect_pii()       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION private.mask_pii(text, integer)      TO service_role;

DROP TRIGGER IF EXISTS profiles_protect_pii ON public.profiles;
CREATE TRIGGER profiles_protect_pii
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.profiles_protect_pii();

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Direct column writes: the plain-text values do not change, so the trigger
-- leaves these alone. Only rows not yet encrypted are touched.
UPDATE public.profiles SET
  sss_number_enc             = private.encrypt_pii(sss_number),
  sss_number_last4           = right(sss_number, 4)
WHERE sss_number IS NOT NULL AND sss_number_enc IS NULL;

UPDATE public.profiles SET
  philhealth_number_enc      = private.encrypt_pii(philhealth_number),
  philhealth_number_last4    = right(philhealth_number, 4)
WHERE philhealth_number IS NOT NULL AND philhealth_number_enc IS NULL;

UPDATE public.profiles SET
  pagibig_number_enc         = private.encrypt_pii(pagibig_number),
  pagibig_number_last4       = right(pagibig_number, 4)
WHERE pagibig_number IS NOT NULL AND pagibig_number_enc IS NULL;

UPDATE public.profiles SET
  bank_account_number_enc    = private.encrypt_pii(bank_account_number),
  bank_account_number_last4  = right(bank_account_number, 4)
WHERE bank_account_number IS NOT NULL AND bank_account_number_enc IS NULL;

-- TIN only ever lived in Auth metadata; digits only, as the app stores it.
UPDATE public.profiles p SET
  tin_number_enc   = private.encrypt_pii(t.tin),
  tin_number_last4 = right(t.tin, 4)
FROM (
  SELECT id, NULLIF(regexp_replace(raw_user_meta_data->>'tin_number', '\D', '', 'g'), '') AS tin
  FROM auth.users
) t
WHERE t.id = p.id AND t.tin IS NOT NULL AND p.tin_number_enc IS NULL;

-- ── Service-role API ───────────────────────────────────────────────────────
-- The full numbers for the given profiles. The calling API route has already
-- done its RBAC check (payroll, HR's employee records, the person's own
-- profile). Writes need no function: the app writes the plain-text column
-- and the trigger encrypts it.
CREATE OR REPLACE FUNCTION public.get_profiles_pii(p_profile_ids uuid[])
RETURNS TABLE (
  id uuid,
  sss_number text,
  philhealth_number text,
  pagibig_number text,
  tin_number text,
  bank_account_number text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id,
         private.decrypt_pii(p.sss_number_enc),
         private.decrypt_pii(p.philhealth_number_enc),
         private.decrypt_pii(p.pagibig_number_enc),
         private.decrypt_pii(p.tin_number_enc),
         private.decrypt_pii(p.bank_account_number_enc)
  FROM public.profiles p
  WHERE p.id = ANY (p_profile_ids);
$$;

REVOKE EXECUTE ON FUNCTION public.get_profiles_pii(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_profiles_pii(uuid[]) TO service_role;
