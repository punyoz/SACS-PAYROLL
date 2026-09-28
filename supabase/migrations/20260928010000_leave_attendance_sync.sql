-- ═══════════════════════════════════════════════════════════════════════════
-- Approved leave becomes attendance: On Leave days, tap blocking, sync
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An approved leave request now writes one attendance_logs row per working
-- day it covers (Saturday, Sunday and attendance_holidays are skipped, the
-- same days attendance_is_rest_day() already treats as non-working):
--
--   status = 'On Leave', time_in / time_out NULL, leave_request_id = the request
--
-- The rows are kept in step with the request by a trigger on leave_requests
-- (attendance_sync_leave), whatever changes it -- approval, cancellation, a
-- change of dates:
--
--   * approved      every covered working day without a row gets an On Leave
--                   row; a tapless Absent row the nightly close wrote before
--                   the approval becomes On Leave; a day with a real tap is
--                   never overwritten -- it is returned as a conflict for HR.
--   * anything else (rejected, cancelled, dates moved) the request's On Leave
--                   rows that are no longer covered are archived
--                   (archived_duplicate = TRUE -- hard deletes are blocked on
--                   this table), which frees the day for a tap again. A freed
--                   past day is then closed as Absent by the nightly close,
--                   like any other day without a tap.
--
-- public.attendance_approved_leave(employee, day) is the one definition of
-- "on approved leave that day". The nightly close, the sync and the RFID tap
-- check (isEmployeeOnLeave in src/lib/attendance/leave.js) all use it.
--
-- Taps refused because of leave are kept in attendance_blocked_taps for HR.
--
-- attendance_logs already has a unique index on (employee_id, log_date)
-- (attendance_logs_employee_day_unique), so no new one is needed.
--
-- Safe to run more than once.

-- ─── 1. Columns ─────────────────────────────────────────────────────────────
ALTER TABLE public.attendance_logs
  ADD COLUMN IF NOT EXISTS leave_request_id TEXT REFERENCES public.leave_requests(id);

CREATE INDEX IF NOT EXISTS attendance_logs_leave_request_idx
  ON public.attendance_logs (leave_request_id)
  WHERE leave_request_id IS NOT NULL;

-- Who cancelled an approved request, kept apart from decided_by (the approver).
ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS cancelled_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by      UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS cancelled_by_name TEXT;

ALTER TABLE public.attendance_logs DROP CONSTRAINT IF EXISTS attendance_logs_status_check;
ALTER TABLE public.attendance_logs ADD CONSTRAINT attendance_logs_status_check CHECK (status IN (
  'On Time', 'Early Bird', 'Late', 'Undertime', 'Half Day', 'Absent',
  'Incomplete', 'Pending Correction', 'Corrected', 'On Leave'
));

-- ─── 2. Blocked taps ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_blocked_taps (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      UUID NOT NULL REFERENCES public.profiles(id),
  employee_name    TEXT,
  branch_id        UUID REFERENCES public.branches(id),
  log_date         DATE NOT NULL,
  attempted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason           TEXT NOT NULL,
  leave_request_id TEXT REFERENCES public.leave_requests(id),
  rfid_code        TEXT,
  source           TEXT NOT NULL DEFAULT 'rfid_tap',
  recorded_by      UUID
);

CREATE INDEX IF NOT EXISTS attendance_blocked_taps_date_idx ON public.attendance_blocked_taps (log_date DESC);
CREATE INDEX IF NOT EXISTS attendance_blocked_taps_employee_idx ON public.attendance_blocked_taps (employee_id, log_date);

-- Written and read by the server (service role) only.
ALTER TABLE public.attendance_blocked_taps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_blocked_taps FROM anon, authenticated;

DROP TRIGGER IF EXISTS attendance_blocked_taps_block_hard_delete ON public.attendance_blocked_taps;
CREATE TRIGGER attendance_blocked_taps_block_hard_delete
  BEFORE DELETE ON public.attendance_blocked_taps
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

-- ─── 3. "On approved leave that day" ────────────────────────────────────────
-- leave_requests.start_date / end_date are TEXT; only well-formed dates count
-- (as in 20260926110000_fix_attendance_close_days_leave_dates.sql).
CREATE OR REPLACE FUNCTION public.attendance_leave_date(p_value TEXT)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN COALESCE(p_value, '') ~ '^\d{4}-\d{2}-\d{2}$' THEN p_value::DATE END;
$$;

-- The approved request covering p_day for the employee (at most one: HR
-- cannot approve overlapping requests), or no row.
CREATE OR REPLACE FUNCTION public.attendance_approved_leave(p_employee_id UUID, p_day DATE)
RETURNS TABLE (
  id TEXT, leave_type TEXT, pay_status TEXT, start_date TEXT, end_date TEXT,
  decided_by_name TEXT, decided_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT lr.id, lr.leave_type, lr.pay_status, lr.start_date,
         COALESCE(NULLIF(lr.end_date, ''), lr.start_date), lr.decided_by_name, lr.decided_at
  FROM public.leave_requests lr
  WHERE lr.employee_id = p_employee_id
    AND lower(lr.status) = 'approved'
    AND p_day BETWEEN public.attendance_leave_date(lr.start_date)
                  AND public.attendance_leave_date(COALESCE(NULLIF(lr.end_date, ''), lr.start_date))
  ORDER BY lr.decided_at DESC NULLS LAST
  LIMIT 1;
$$;

-- ─── 4. Status engine: On Leave ─────────────────────────────────────────────
-- Unchanged from the live definition except for the On Leave block: a row
-- tied to a leave request with no tap is On Leave, with nothing to deduct.
CREATE OR REPLACE FUNCTION public.attendance_logs_compute_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p RECORD;
  v_override BOOLEAN := COALESCE(current_setting('sacs.attendance_override', true), '') = 'on';
  v_rest BOOLEAN;
  v_in INTEGER;
  v_out INTEGER;
  v_tardy INTEGER := 0;
  v_late INTEGER := 0;
  v_under INTEGER := 0;
  v_half BOOLEAN := FALSE;
  v_early BOOLEAN := FALSE;
  v_worked NUMERIC := 0;
  v_shift_end TIMESTAMPTZ;
  v_status TEXT;
BEGIN
  SELECT * INTO p FROM public.attendance_policy_for(NEW.branch_id);
  NEW.schedule_id := p.schedule_id;

  IF NEW.leave_request_id IS NOT NULL AND NEW.time_in IS NULL AND NEW.time_out IS NULL THEN
    NEW.status := 'On Leave';
    NEW.total_hours := 0;
    NEW.late_minutes := 0;
    NEW.undertime_minutes := 0;
    NEW.is_half_day := FALSE;
    NEW.is_early_bird := FALSE;
    NEW.status_computed_at := NOW();
    RETURN NEW;
  END IF;

  v_rest := public.attendance_is_rest_day(NEW.log_date);

  IF NEW.time_in IS NULL THEN
    v_status := 'Absent';
  ELSE
    v_in := EXTRACT(HOUR FROM NEW.time_in AT TIME ZONE 'Asia/Manila')::INTEGER * 60
          + EXTRACT(MINUTE FROM NEW.time_in AT TIME ZONE 'Asia/Manila')::INTEGER;
    v_tardy := GREATEST(0, v_in - p.work_start);
    v_late := CASE WHEN v_tardy > p.grace THEN v_tardy ELSE 0 END;
    v_early := v_in < p.work_start - p.grace;

    IF NEW.time_out IS NULL THEN
      v_shift_end := (NEW.log_date::TIMESTAMP + make_interval(mins => p.work_end)) AT TIME ZONE 'Asia/Manila';
      IF NOT v_rest AND NOW() > v_shift_end THEN
        v_status := 'Incomplete';
        v_early := FALSE;
      ELSE
        v_status := CASE WHEN v_late > 0 THEN 'Late' WHEN v_early THEN 'Early Bird' ELSE 'On Time' END;
      END IF;
    ELSE
      v_worked := ROUND(EXTRACT(EPOCH FROM (NEW.time_out - NEW.time_in)) / 3600.0, 2);
      IF v_worked < 0 THEN v_worked := 0; END IF;
      NEW.total_hours := v_worked;

      IF (NEW.time_out AT TIME ZONE 'Asia/Manila')::DATE = NEW.log_date THEN
        v_out := EXTRACT(HOUR FROM NEW.time_out AT TIME ZONE 'Asia/Manila')::INTEGER * 60
               + EXTRACT(MINUTE FROM NEW.time_out AT TIME ZONE 'Asia/Manila')::INTEGER;
        v_under := GREATEST(0, p.work_end - v_out);
      END IF;

      v_half := v_worked < (p.work_hours / 2.0);

      IF v_half THEN
        v_status := 'Half Day';
        v_late := 0;
        v_under := 0;
        v_early := FALSE;
      ELSIF v_late > 0 THEN
        v_status := 'Late';
        v_early := FALSE;
      ELSIF v_under > 0 THEN
        v_status := 'Undertime';
        v_early := FALSE;
      ELSIF v_early THEN
        v_status := 'Early Bird';
      ELSE
        v_status := 'On Time';
      END IF;
    END IF;
  END IF;

  IF v_rest AND NEW.time_in IS NOT NULL THEN
    v_status := 'On Time';
    v_late := 0;
    v_under := 0;
    v_half := FALSE;
    v_early := FALSE;
  END IF;

  IF v_override THEN
    IF NEW.status = 'Absent' THEN
      v_late := 0; v_under := 0; v_half := FALSE; v_early := FALSE;
    ELSIF NEW.status = 'Half Day' THEN
      v_late := 0; v_under := 0; v_half := TRUE; v_early := FALSE;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.status IN ('Pending Correction', 'Corrected') THEN
    NEW.status := OLD.status;
  ELSE
    NEW.status := v_status;
  END IF;

  NEW.late_minutes := v_late;
  NEW.undertime_minutes := v_under;
  NEW.is_half_day := v_half;
  NEW.is_early_bird := v_early;
  NEW.status_computed_at := NOW();
  RETURN NEW;
END;
$$;

-- ─── 5. Keep a request's On Leave days in step with it ──────────────────────
-- Idempotent. Returns what it did and the covered working days that already
-- have a real tap (left untouched, for HR to resolve).
CREATE OR REPLACE FUNCTION public.attendance_sync_leave(p_leave_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.leave_requests;
  v_start DATE;
  v_end DATE;
  v_active BOOLEAN;
  v_removed INTEGER := 0;
  v_converted INTEGER := 0;
  v_inserted INTEGER := 0;
  v_conflicts JSONB := '[]'::JSONB;
BEGIN
  SELECT * INTO r FROM public.leave_requests WHERE id = p_leave_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('leave_id', p_leave_id, 'marked', 0, 'removed', 0, 'conflicts', '[]'::JSONB);
  END IF;

  PERFORM set_config('app.change_source', 'leave_sync', true);

  v_start := public.attendance_leave_date(r.start_date);
  v_end := public.attendance_leave_date(COALESCE(NULLIF(r.end_date, ''), r.start_date));
  v_active := lower(COALESCE(r.status, '')) = 'approved'
    AND r.employee_id IS NOT NULL
    AND v_start IS NOT NULL AND v_end IS NOT NULL AND v_end >= v_start;

  -- Days this request no longer covers.
  UPDATE public.attendance_logs l
  SET archived_duplicate = TRUE
  WHERE l.leave_request_id = r.id
    AND l.archived_duplicate = FALSE
    AND l.time_in IS NULL
    AND l.time_out IS NULL
    AND (NOT v_active
         OR l.employee_id IS DISTINCT FROM r.employee_id
         OR l.log_date NOT BETWEEN v_start AND v_end
         OR public.attendance_is_rest_day(l.log_date));
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF v_active THEN
    -- An Absent the nightly close wrote before the leave was approved.
    UPDATE public.attendance_logs l
    SET leave_request_id = r.id
    WHERE l.employee_id = r.employee_id
      AND l.archived_duplicate = FALSE
      AND l.log_date BETWEEN v_start AND v_end
      AND l.time_in IS NULL
      AND l.time_out IS NULL
      AND l.leave_request_id IS NULL
      AND l.status = 'Absent'
      AND NOT public.attendance_is_rest_day(l.log_date);
    GET DIAGNOSTICS v_converted = ROW_COUNT;

    INSERT INTO public.attendance_logs
      (employee_id, employee_name, employee_type, time_in, time_out, total_hours,
       status, log_date, branch_id, leave_request_id)
    SELECT pr.id, COALESCE(pr.full_name, r.employee_name), pr.employee_type, NULL, NULL, 0,
           'On Leave', d.day, pr.branch_id, r.id
    FROM public.profiles pr
    CROSS JOIN LATERAL (
      SELECT gs::DATE AS day FROM generate_series(v_start, v_end, INTERVAL '1 day') gs
    ) d
    WHERE pr.id = r.employee_id
      AND NOT public.attendance_is_rest_day(d.day)
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_logs l
        WHERE l.employee_id = pr.id AND l.log_date = d.day AND l.archived_duplicate = FALSE
      )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'log_id', l.id, 'log_date', l.log_date, 'status', l.status,
             'time_in', l.time_in, 'time_out', l.time_out
           ) ORDER BY l.log_date), '[]'::JSONB)
    INTO v_conflicts
    FROM public.attendance_logs l
    WHERE l.employee_id = r.employee_id
      AND l.archived_duplicate = FALSE
      AND l.log_date BETWEEN v_start AND v_end
      AND NOT public.attendance_is_rest_day(l.log_date)
      AND (l.time_in IS NOT NULL OR l.time_out IS NOT NULL);
  END IF;

  RETURN jsonb_build_object(
    'leave_id', r.id,
    'marked', v_converted + v_inserted,
    'removed', v_removed,
    'conflicts', v_conflicts
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.leave_requests_sync_attendance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.attendance_sync_leave(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leave_requests_sync_attendance ON public.leave_requests;
CREATE TRIGGER leave_requests_sync_attendance
  AFTER INSERT OR UPDATE OF status, start_date, end_date, employee_id ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_sync_attendance();

-- ─── 6. Nightly close: the shared leave check ───────────────────────────────
-- Unchanged from the live definition except that approved leave is read
-- through attendance_approved_leave().
CREATE OR REPLACE FUNCTION public.attendance_close_days(p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_last_closed DATE := LEAST(p_to, v_today - 1);
  v_reevaluated INTEGER := 0;
  v_absent INTEGER := 0;
BEGIN
  PERFORM set_config('app.change_source', 'day_close', true);
  PERFORM set_config('app.actor_id', COALESCE('', ''), true);
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RETURN jsonb_build_object('reevaluated', 0, 'absent_inserted', 0);
  END IF;

  UPDATE public.attendance_logs
  SET status_computed_at = NOW()
  WHERE time_in IS NOT NULL
    AND time_out IS NULL
    AND archived_duplicate = FALSE
    AND status NOT IN ('Incomplete', 'Pending Correction', 'Corrected')
    AND log_date BETWEEN p_from AND LEAST(p_to, v_today);
  GET DIAGNOSTICS v_reevaluated = ROW_COUNT;

  IF v_last_closed >= p_from THEN
    INSERT INTO public.attendance_logs
      (employee_id, employee_name, employee_type, time_in, time_out, total_hours, status, log_date, branch_id)
    SELECT pr.id, pr.full_name, pr.employee_type, NULL, NULL, 0, 'Absent', d.day, pr.branch_id
    FROM public.profiles pr
    CROSS JOIN LATERAL (
      SELECT gs::DATE AS day FROM generate_series(p_from, v_last_closed, INTERVAL '1 day') gs
    ) d
    WHERE lower(pr.role::TEXT) IN ('employee', 'accountant')
      AND COALESCE(pr.archived, FALSE) = FALSE
      AND lower(COALESCE(pr.employee_status, 'active')) <> 'inactive'
      AND d.day >= COALESCE(pr.date_hired, pr.created_at::DATE)
      AND NOT public.attendance_is_rest_day(d.day)
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_logs l
        WHERE l.employee_id = pr.id AND l.log_date = d.day AND l.archived_duplicate = FALSE
      )
      AND NOT EXISTS (SELECT 1 FROM public.attendance_approved_leave(pr.id, d.day))
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_absent = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('reevaluated', v_reevaluated, 'absent_inserted', v_absent);
END;
$function$;

-- ─── 7. Access ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.leave_requests_sync_attendance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_sync_leave(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_approved_leave(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_close_days(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_sync_leave(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_approved_leave(UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_close_days(DATE, DATE) TO service_role;

-- ─── 8. Backfill: every approved request already on file ────────────────────
SELECT public.attendance_sync_leave(id) FROM public.leave_requests WHERE lower(status) = 'approved';
