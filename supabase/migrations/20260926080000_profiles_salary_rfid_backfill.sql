-- ═══════════════════════════════════════════════════════════════════════════
-- profiles becomes the trusted copy of basic salary and RFID card
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Until now basic_salary and rfid_uid were kept only in auth user_metadata
-- (profiles.basic_salary sat at 0, profiles.rfid_uid was empty). A user can
-- change their own user_metadata through Supabase Auth, so payroll and the RFID
-- terminal were trusting values the employee could edit.
--
-- From now on the API routes write both copies and read these fields from
-- profiles (src/lib/auth/users-cache.js). This copies today's values across
-- once so nobody's pay or card changes when the reads switch over.
--
-- Safe to run more than once: it only fills rows that differ.

-- Basic salary: only well-formed, non-negative numbers are copied.
UPDATE public.profiles p
SET basic_salary = (u.raw_user_meta_data->>'basic_salary')::numeric,
    updated_at = NOW()
FROM auth.users u
WHERE u.id = p.id
  AND (u.raw_user_meta_data->>'basic_salary') ~ '^[0-9]+(\.[0-9]+)?$'
  AND p.basic_salary IS DISTINCT FROM (u.raw_user_meta_data->>'basic_salary')::numeric;

-- RFID card: copied when the profile has none and no other profile already
-- holds that card (profiles_rfid_uid_unique_idx).
UPDATE public.profiles p
SET rfid_uid = btrim(u.raw_user_meta_data->>'rfid_uid'),
    updated_at = NOW()
FROM auth.users u
WHERE u.id = p.id
  AND p.rfid_uid IS NULL
  AND btrim(COALESCE(u.raw_user_meta_data->>'rfid_uid', '')) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.profiles other
    WHERE other.id <> p.id
      AND other.rfid_uid = btrim(u.raw_user_meta_data->>'rfid_uid')
  );
