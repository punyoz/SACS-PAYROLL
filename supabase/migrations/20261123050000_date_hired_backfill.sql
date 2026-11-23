-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-11-22: accounts made by Super Admin's "Add staff account"
-- (/api/admin/staff-accounts) kept the date hired in auth user_metadata only;
-- profiles.date_hired (what tenure, proration and HR's Action needed read)
-- stayed empty. Data only.
--
-- An EXPLICIT list, each row confirmed by the user before release (user
-- decision 2026-11-22): never a blanket copy. A row is copied only while the
-- column is still empty AND the metadata still holds that same date.
-- Nona Guido (metadata 2013-11-06, 13 years before her account was made) is
-- left out until the user confirms her real date. Admin / Super Admin
-- accounts are not on payroll (20261123060000), so they are left out too.
-- Confirmed by the user 2026-11-22: Jane Benitez (HR) only.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.profiles p
SET date_hired = v.hired
FROM (VALUES
  ('7597161e-c4e3-4c83-83b9-ec7737d4a2ec'::UUID, DATE '2026-09-24')   -- Jane Marinel Dela Pena Benitez (HR), account 2026-09-24
) AS v(id, hired)
JOIN auth.users u ON u.id = v.id
WHERE p.id = v.id
  AND p.date_hired IS NULL
  AND (u.raw_user_meta_data->>'date_hired') = v.hired::TEXT;
