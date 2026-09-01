-- attendance_logs has a live UPDATE trigger (created directly in the Supabase
-- dashboard, not tracked anywhere in this repo's migration history) that sets
-- NEW.updated_at on every update. The column was never added to the table, so
-- recording a time-out (which UPDATEs the day's row — see
-- persistScanToTable() in src/app/api/admin/attendance/route.js) has been
-- failing outright with: record "new" has no field "updated_at".
ALTER TABLE public.attendance_logs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
