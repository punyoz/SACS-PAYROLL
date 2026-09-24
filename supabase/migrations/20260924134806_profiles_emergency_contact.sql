-- ════════════════════════════════════════════════════════════════════════════
-- Emergency contact on profiles
--
-- WHY
-- Every new account now records the person to contact in an emergency: name,
-- relationship, address and an active mobile number. Collected by HR's Add
-- Employee (POST /api/admin/employees) and Super Admin's Add Staff Account
-- (POST /api/admin/staff-accounts); validated by
-- src/lib/employees/emergency-contact.js, whose rules the CHECKs below repeat
-- so a direct write cannot store a malformed value.
--
-- The columns are nullable: accounts created before this have none on file,
-- and the rule that a new account must supply all four is enforced by the
-- create routes.
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS emergency_contact_name         TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_relationship TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_address      TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_number       TEXT;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_emergency_contact_name_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_emergency_contact_name_valid
  CHECK (
    emergency_contact_name IS NULL
    OR (
      char_length(emergency_contact_name) BETWEEN 1 AND 100
      AND emergency_contact_name ~ '^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .''-]*$'
    )
  );

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_emergency_contact_relationship_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_emergency_contact_relationship_valid
  CHECK (
    emergency_contact_relationship IS NULL
    OR emergency_contact_relationship IN (
      'Spouse', 'Parent', 'Child', 'Sibling', 'Guardian', 'Relative', 'Partner', 'Friend', 'Other'
    )
  );

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_emergency_contact_address_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_emergency_contact_address_valid
  CHECK (emergency_contact_address IS NULL OR char_length(emergency_contact_address) BETWEEN 5 AND 200);

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_emergency_contact_number_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_emergency_contact_number_valid
  CHECK (emergency_contact_number IS NULL OR emergency_contact_number ~ '^09[0-9]{9}$');
