-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-11-22: accounts made by Super Admin's "Add staff account"
-- (/api/admin/staff-accounts) kept the date hired in auth user_metadata only;
-- profiles.date_hired (what tenure, proration and HR's Action needed read)
-- stayed empty. Data only: copy a valid metadata date into an empty column.
-- Never overwrites a date already set.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.profiles p
SET date_hired = (u.raw_user_meta_data->>'date_hired')::DATE
FROM auth.users u
WHERE u.id = p.id
  AND p.date_hired IS NULL
  AND (u.raw_user_meta_data->>'date_hired') ~ '^\d{4}-\d{2}-\d{2}$';
