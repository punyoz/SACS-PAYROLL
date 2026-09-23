-- Prevent two concurrent "create employee" requests from minting the same
-- SACS-### employee_id. generateUniqueEmployeeId() in
-- src/app/api/admin/employees/route.js computes the next id from a snapshot
-- of existing employees taken just before auth.admin.createUser() — two
-- near-simultaneous hires can both read the same "existing" list and mint an
-- identical id, which then silently doubles as the key payroll and RFID
-- matching group records under.
--
-- profiles.employee_id has existed since 20260401010000_backfill_core_schema.sql
-- but was never written to (only auth.users.user_metadata.employee_id was);
-- this backfills it from metadata and adds the uniqueness the app-level
-- read-then-write check alone can't guarantee under concurrency.

-- 1. Backfill from Auth metadata, same pattern as 20260914010000_profile_id_fields_and_perf.sql.
UPDATE public.profiles p
SET employee_id = COALESCE(p.employee_id, NULLIF(u.raw_user_meta_data->>'employee_id', ''))
FROM auth.users u
WHERE u.id = p.id;

-- 2. Clear any duplicate employee_id that backfilling just exposed, keeping
--    whichever profile was created first. This is metadata that was already
--    silently wrong (two people sharing one employee_id) — clearing the
--    newer duplicate to NULL doesn't erase payroll/attendance history (those
--    reference the auth user id, not employee_id) and lets the affected
--    account be assigned a fresh, unique id through the app going forward.
WITH ranked AS (
  SELECT id, employee_id,
    ROW_NUMBER() OVER (PARTITION BY employee_id ORDER BY created_at ASC, id ASC) AS rn
  FROM public.profiles
  WHERE employee_id IS NOT NULL
)
UPDATE public.profiles p
SET employee_id = NULL
FROM ranked r
WHERE p.id = r.id AND r.rn > 1;

-- 3. Enforce uniqueness at the database level (NULLs remain unconstrained —
--    a profile without an employee_id yet, e.g. Admin/HR/Super Admin logins,
--    is not a conflict).
CREATE UNIQUE INDEX IF NOT EXISTS profiles_employee_id_unique
  ON public.profiles (employee_id)
  WHERE employee_id IS NOT NULL;
