-- ═══════════════════════════════════════════════════════════════════════════
-- Attendance change history: every edit keeps its before and after values
-- ═══════════════════════════════════════════════════════════════════════════
--
-- attendance_logs rows are edited in place: a later tap moves time_out, a
-- correction or resolution rewrites time_in / time_out / status. Only
-- updated_at recorded that anything changed, so a record could be altered
-- with nothing left to show what it said before.
--
-- attendance_logs_history now receives one row per change to the fields pay
-- depends on (time in, time out, hours, status, day), with the old and new
-- values. It is append-only: no role can update or delete it, and neither the
-- browser roles nor the API can read or write it directly except through the
-- service role.
--
-- WHO MADE THE CHANGE
-- A row-level trigger cannot see the API's signed-in user, so the API
-- annotates its own writes: it sets changed_by / change_source and a fresh
-- random change_token on the row it updates (src/app/api/admin/attendance
-- route.js). An update that does not supply a new change_token did not come
-- from an annotated API write -- the attendance engine, a correction approval
-- (whose reviewer is kept on attendance_corrections) or the nightly close --
-- so attendance_logs_00_change_actor clears the annotation and the history
-- row reads change_source = 'database'. A stale actor is never carried
-- forward onto somebody else's change.
--
-- Safe to run more than once.

ALTER TABLE public.attendance_logs
  ADD COLUMN IF NOT EXISTS changed_by    UUID,
  ADD COLUMN IF NOT EXISTS change_source TEXT,
  ADD COLUMN IF NOT EXISTS change_token  UUID;

CREATE TABLE IF NOT EXISTS public.attendance_logs_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  log_id          UUID NOT NULL REFERENCES public.attendance_logs(id),
  employee_id     UUID,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by      UUID,
  change_source   TEXT NOT NULL DEFAULT 'database',
  old_log_date    DATE,
  new_log_date    DATE,
  old_time_in     TIMESTAMPTZ,
  new_time_in     TIMESTAMPTZ,
  old_time_out    TIMESTAMPTZ,
  new_time_out    TIMESTAMPTZ,
  old_total_hours NUMERIC,
  new_total_hours NUMERIC,
  old_status      TEXT,
  new_status      TEXT
);

CREATE INDEX IF NOT EXISTS attendance_logs_history_log_idx
  ON public.attendance_logs_history (log_id, changed_at);
CREATE INDEX IF NOT EXISTS attendance_logs_history_employee_idx
  ON public.attendance_logs_history (employee_id, changed_at);

ALTER TABLE public.attendance_logs_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_logs_history FROM anon, authenticated;

-- Clears an annotation the current UPDATE did not supply itself. Named 00_
-- so it runs before attendance_logs_zz_compute_status.
CREATE OR REPLACE FUNCTION public.attendance_logs_change_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.change_token IS NOT DISTINCT FROM OLD.change_token THEN
    NEW.changed_by := NULL;
    NEW.change_source := 'database';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_logs_00_change_actor ON public.attendance_logs;
CREATE TRIGGER attendance_logs_00_change_actor
  BEFORE UPDATE ON public.attendance_logs
  FOR EACH ROW EXECUTE FUNCTION public.attendance_logs_change_actor();

-- AFTER, so it records the final values (status is recomputed by the
-- BEFORE triggers).
CREATE OR REPLACE FUNCTION public.attendance_logs_capture_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.time_in     IS DISTINCT FROM OLD.time_in
  OR NEW.time_out    IS DISTINCT FROM OLD.time_out
  OR NEW.total_hours IS DISTINCT FROM OLD.total_hours
  OR NEW.status      IS DISTINCT FROM OLD.status
  OR NEW.log_date    IS DISTINCT FROM OLD.log_date THEN
    INSERT INTO public.attendance_logs_history (
      log_id, employee_id, changed_by, change_source,
      old_log_date, new_log_date,
      old_time_in, new_time_in,
      old_time_out, new_time_out,
      old_total_hours, new_total_hours,
      old_status, new_status
    ) VALUES (
      NEW.id, NEW.employee_id, NEW.changed_by, COALESCE(NEW.change_source, 'database'),
      OLD.log_date, NEW.log_date,
      OLD.time_in, NEW.time_in,
      OLD.time_out, NEW.time_out,
      OLD.total_hours, NEW.total_hours,
      OLD.status, NEW.status
    );
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.attendance_logs_capture_history() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.attendance_logs_change_actor() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS attendance_logs_history_capture ON public.attendance_logs;
CREATE TRIGGER attendance_logs_history_capture
  AFTER UPDATE ON public.attendance_logs
  FOR EACH ROW EXECUTE FUNCTION public.attendance_logs_capture_history();

-- Append-only.
CREATE OR REPLACE FUNCTION public.block_history_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: history rows cannot be changed or deleted.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS attendance_logs_history_append_only ON public.attendance_logs_history;
CREATE TRIGGER attendance_logs_history_append_only
  BEFORE UPDATE OR DELETE ON public.attendance_logs_history
  FOR EACH ROW EXECUTE FUNCTION public.block_history_rewrite();
