-- Prevent two concurrent RFID taps for the same employee on the same day from
-- creating two attendance_logs rows. persistScanToTable() in
-- src/app/api/admin/attendance/route.js reads "does a row exist for this
-- employee+day" and then inserts or updates based on the answer; two
-- near-simultaneous taps (two kiosks, or a retried request) can both read
-- "no row yet" and both insert. collapseDailyTaps() papers over this on every
-- read path, but the extra un-reconciled row still persists in the raw table.
--
-- employee_id and log_date are both NOT NULL on this table (see
-- 20260401010000_backfill_core_schema.sql), so a duplicate row can't be "archived"
-- by blanking its identifying columns the way earlier drafts of this
-- migration tried (that failed with a not-null violation on log_date).
-- Instead this adds a boolean flag column and archives duplicates by setting
-- that flag, leaving every column's original value untouched — no data is
-- blanked, changed, or hard-deleted.

-- 1. The archive flag itself.
ALTER TABLE public.attendance_logs
  ADD COLUMN IF NOT EXISTS archived_duplicate BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Fold every tap in a duplicated employee+day group into the row that will
--    stay active (the earliest-created one), matching collapseDailyTaps()'s
--    own read-time logic: earliest tap becomes time_in, latest becomes
--    time_out. Only touches groups that actually have more than one row.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY employee_id, log_date ORDER BY created_at ASC, id ASC
    ) AS rn,
    COUNT(*) OVER (PARTITION BY employee_id, log_date) AS group_size,
    MIN(COALESCE(time_in, created_at)) OVER (PARTITION BY employee_id, log_date) AS earliest_tap,
    MAX(COALESCE(time_out, time_in, created_at)) OVER (PARTITION BY employee_id, log_date) AS latest_tap
  FROM public.attendance_logs
  WHERE archived_duplicate = FALSE
)
UPDATE public.attendance_logs a
SET time_in = r.earliest_tap,
    time_out = CASE WHEN r.latest_tap > r.earliest_tap THEN r.latest_tap ELSE a.time_out END,
    updated_at = NOW()
FROM ranked r
WHERE a.id = r.id AND r.rn = 1 AND r.group_size > 1;

-- 3. Flag the now-redundant duplicate rows as archived — their tap data is
--    already folded into the row from step 2, and the original row itself is
--    left completely intact (no columns blanked, nothing deleted).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY employee_id, log_date ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM public.attendance_logs
  WHERE archived_duplicate = FALSE
)
UPDATE public.attendance_logs a
SET archived_duplicate = TRUE,
    updated_at = NOW()
FROM ranked r
WHERE a.id = r.id AND r.rn > 1;

-- 4. Enforce the invariant at the database level going forward — one active
--    (non-archived) row per employee per day — and give the app a retry
--    target (23505) instead of a delete-then-insert race. Archived rows are
--    excluded from the constraint so this can never fail on old data again.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_logs_employee_day_unique
  ON public.attendance_logs (employee_id, log_date)
  WHERE archived_duplicate = FALSE;
