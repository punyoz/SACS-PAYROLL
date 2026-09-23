-- Indexes for the query patterns the API actually uses.
--
-- attendance_logs already has (employee_id, log_date) from the backfill
-- migration, but that composite can't serve the many queries that filter or
-- sort on log_date / created_at alone:
--   * hr/dashboard + hr/attendance  -> .eq("log_date", today)
--   * hr/reports                    -> .gte/.lte("log_date", ...)
--   * hr/dashboard recent activity  -> .order("created_at", desc)
--   * admin/attendance              -> .order("created_at", desc).limit(3000)
--
-- Safe and idempotent; matters more as a full school year of attendance and
-- leave records accumulates.

CREATE INDEX IF NOT EXISTS attendance_logs_log_date_idx
  ON public.attendance_logs (log_date);

CREATE INDEX IF NOT EXISTS attendance_logs_created_at_idx
  ON public.attendance_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS leave_requests_status_idx
  ON public.leave_requests (status);

CREATE INDEX IF NOT EXISTS leave_requests_employee_id_idx
  ON public.leave_requests (employee_id);
