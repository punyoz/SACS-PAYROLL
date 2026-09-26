-- ═══════════════════════════════════════════════════════════════════════════
-- Attendance status engine, missed tap-out handling and correction workflow
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every attendance_logs row now resolves to exactly one status, computed by
-- the database (never typed in by a person):
--
--   On Time             time in within the grace period, full day rendered
--   Early Bird          time in earlier than (work start - grace)
--   Late                time in later than (work start + grace)
--   Undertime           time out before work end
--   Half Day            fewer than half of the required hours rendered
--   Absent              no tap at all on a working day
--   Incomplete          time in, but no time out once the shift has ended
--   Pending Correction  an employee asked to correct the time out
--   Corrected           a correction was approved by HR / Admin
--
-- Only the correction workflow (the functions in section 6 of this file)
-- may set a status by hand. They do it by switching on the transaction-local
-- setting sacs.attendance_override, which the trigger honours; nothing else in
-- the application can set it.
--
-- Next to the label the trigger stores the facts payroll deducts from, so a
-- deduction never depends on reading the label back:
--   late_minutes       minutes after work start (0 when within the grace)
--   undertime_minutes  minutes before work end
--   is_half_day        the day counts as a half day
--   is_early_bird      qualifies for the early-bird incentive
--
-- The schedule is the per-branch policy the Super Admin sets in System
-- Configuration (system_config sections "attendance" and
-- "attendance:<branch id>", read the same way src/lib/attendance/policy.js
-- reads them). schedule_id records which of those sections decided the row.
--
-- Safe to run more than once.

-- ─── 1. Holidays (rest days besides Saturday and Sunday) ────────────────────
-- Same list the employee timesheet uses (src/app/api/employee/timesheet/route.js).
-- No one is marked Absent, Late or Incomplete on these days.
CREATE TABLE IF NOT EXISTS public.attendance_holidays (
  holiday_date DATE PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'holiday' CHECK (type IN ('holiday', 'special')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.attendance_holidays ENABLE ROW LEVEL SECURITY;

INSERT INTO public.attendance_holidays (holiday_date, name, type) VALUES
  ('2024-01-01', 'New Year''s Day', 'holiday'),
  ('2024-03-28', 'Maundy Thursday', 'holiday'),
  ('2024-03-29', 'Good Friday', 'holiday'),
  ('2024-04-09', 'Araw ng Kagitingan', 'holiday'),
  ('2024-05-01', 'Labor Day', 'holiday'),
  ('2024-06-12', 'Independence Day', 'holiday'),
  ('2024-08-26', 'National Heroes Day', 'holiday'),
  ('2024-11-01', 'All Saints Day', 'special'),
  ('2024-11-30', 'Bonifacio Day', 'holiday'),
  ('2024-12-25', 'Christmas Day', 'holiday'),
  ('2024-12-30', 'Rizal Day', 'holiday'),
  ('2025-01-01', 'New Year''s Day', 'holiday'),
  ('2025-04-09', 'Araw ng Kagitingan', 'holiday'),
  ('2025-04-17', 'Maundy Thursday', 'holiday'),
  ('2025-04-18', 'Good Friday', 'holiday'),
  ('2025-05-01', 'Labor Day', 'holiday'),
  ('2025-06-12', 'Independence Day', 'holiday'),
  ('2025-08-25', 'National Heroes Day', 'holiday'),
  ('2025-11-01', 'All Saints Day', 'special'),
  ('2025-11-30', 'Bonifacio Day', 'holiday'),
  ('2025-12-25', 'Christmas Day', 'holiday'),
  ('2025-12-30', 'Rizal Day', 'holiday'),
  ('2026-01-01', 'New Year''s Day', 'holiday'),
  ('2026-04-02', 'Maundy Thursday', 'holiday'),
  ('2026-04-03', 'Good Friday', 'holiday'),
  ('2026-04-09', 'Araw ng Kagitingan', 'holiday'),
  ('2026-05-01', 'Labor Day', 'holiday'),
  ('2026-06-12', 'Independence Day', 'holiday'),
  ('2026-08-31', 'National Heroes Day', 'holiday'),
  ('2026-11-01', 'All Saints Day', 'special'),
  ('2026-11-30', 'Bonifacio Day', 'holiday'),
  ('2026-12-25', 'Christmas Day', 'holiday'),
  ('2026-12-30', 'Rizal Day', 'holiday'),
  ('2027-01-01', 'New Year''s Day', 'holiday'),
  ('2027-04-01', 'Maundy Thursday', 'holiday'),
  ('2027-04-02', 'Good Friday', 'holiday'),
  ('2027-04-09', 'Araw ng Kagitingan', 'holiday'),
  ('2027-05-01', 'Labor Day', 'holiday'),
  ('2027-06-12', 'Independence Day', 'holiday'),
  ('2027-08-30', 'National Heroes Day', 'holiday'),
  ('2027-11-01', 'All Saints Day', 'special'),
  ('2027-11-30', 'Bonifacio Day', 'holiday'),
  ('2027-12-25', 'Christmas Day', 'holiday'),
  ('2027-12-30', 'Rizal Day', 'holiday')
ON CONFLICT (holiday_date) DO NOTHING;

-- ─── 2. New attendance_logs columns ─────────────────────────────────────────
ALTER TABLE public.attendance_logs
  ADD COLUMN IF NOT EXISTS schedule_id        TEXT,
  ADD COLUMN IF NOT EXISTS late_minutes       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS undertime_minutes  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_half_day        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_early_bird      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS status_computed_at TIMESTAMPTZ;

-- A dashboard-created check (outside this repo's history) allowed only
-- 'Present' / 'Late' / 'Absent'. It must go before any row is recomputed; the
-- full status list is enforced again at the end of section 4.
ALTER TABLE public.attendance_logs DROP CONSTRAINT IF EXISTS attendance_logs_status_check;

-- The engine always sets the status; this default only matters for a row
-- that somehow bypasses it.
ALTER TABLE public.attendance_logs ALTER COLUMN status SET DEFAULT 'Absent';

CREATE INDEX IF NOT EXISTS attendance_logs_status_date_idx
  ON public.attendance_logs (status, log_date);

-- ─── 3. Schedule lookup ─────────────────────────────────────────────────────
-- "HH:MM" -> minutes after midnight, NULL for anything else.
CREATE OR REPLACE FUNCTION public.attendance_hhmm_to_minutes(p_value TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_match TEXT[];
  v_h INTEGER;
  v_m INTEGER;
BEGIN
  v_match := regexp_match(COALESCE(p_value, ''), '^\s*(\d{1,2}):(\d{2})');
  IF v_match IS NULL THEN RETURN NULL; END IF;
  v_h := v_match[1]::INTEGER;
  v_m := v_match[2]::INTEGER;
  IF v_h > 23 OR v_m > 59 THEN RETURN NULL; END IF;
  RETURN v_h * 60 + v_m;
END;
$$;

-- Non-negative number, NULL for anything else.
CREATE OR REPLACE FUNCTION public.attendance_to_number(p_value TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF COALESCE(p_value, '') ~ '^\s*\d+(\.\d+)?\s*$' THEN
    RETURN trim(p_value)::NUMERIC;
  END IF;
  RETURN NULL;
END;
$$;

-- The effective schedule for a branch. Each key falls back on its own from
-- the branch's section to the default section to the built-in default
-- (08:00-17:00, 15 minutes grace, 8 hours), exactly like
-- resolveAttendancePolicy() in src/lib/attendance/policy.js.
CREATE OR REPLACE FUNCTION public.attendance_policy_for(p_branch UUID)
RETURNS TABLE (work_start INTEGER, work_end INTEGER, grace NUMERIC, work_hours NUMERIC, schedule_id TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_is_branch BOOLEAN;
  v_minutes INTEGER;
  v_number NUMERIC;
BEGIN
  work_start := 480;
  work_end := 1020;
  grace := 15;
  work_hours := 8;
  schedule_id := 'attendance';

  -- Default section first, the branch's own second, so the branch wins.
  FOR r IN
    SELECT c.section, c.key, c.value
    FROM public.system_config c
    WHERE c.section = 'attendance'
       OR (p_branch IS NOT NULL AND c.section = 'attendance:' || p_branch::TEXT)
    ORDER BY (c.section <> 'attendance')
  LOOP
    v_is_branch := r.section <> 'attendance';
    IF r.key IN ('work_start', 'work_end') THEN
      v_minutes := public.attendance_hhmm_to_minutes(r.value);
      IF v_minutes IS NOT NULL THEN
        IF r.key = 'work_start' THEN work_start := v_minutes; ELSE work_end := v_minutes; END IF;
        IF v_is_branch THEN schedule_id := r.section; END IF;
      END IF;
    ELSIF r.key IN ('grace', 'work_hours') THEN
      v_number := public.attendance_to_number(r.value);
      IF v_number IS NOT NULL THEN
        IF r.key = 'grace' THEN grace := v_number;
        ELSIF v_number > 0 THEN work_hours := v_number;
        END IF;
        IF v_is_branch THEN schedule_id := r.section; END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN NEXT;
END;
$$;

-- Saturday, Sunday or a listed holiday.
CREATE OR REPLACE FUNCTION public.attendance_is_rest_day(p_day DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXTRACT(ISODOW FROM p_day) >= 6
      OR EXISTS (SELECT 1 FROM public.attendance_holidays h WHERE h.holiday_date = p_day);
$$;

-- ─── 4. The status engine ───────────────────────────────────────────────────
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
        -- Never counted as worked or unworked until someone resolves it.
        v_status := 'Incomplete';
        v_early := FALSE;
      ELSE
        v_status := CASE WHEN v_late > 0 THEN 'Late' WHEN v_early THEN 'Early Bird' ELSE 'On Time' END;
      END IF;
    ELSE
      v_worked := ROUND(EXTRACT(EPOCH FROM (NEW.time_out - NEW.time_in)) / 3600.0, 2);
      IF v_worked < 0 THEN v_worked := 0; END IF;
      NEW.total_hours := v_worked;

      -- Undertime only against the same day's end of shift; a time out that
      -- lands on a later date is not undertime.
      IF (NEW.time_out AT TIME ZONE 'Asia/Manila')::DATE = NEW.log_date THEN
        v_out := EXTRACT(HOUR FROM NEW.time_out AT TIME ZONE 'Asia/Manila')::INTEGER * 60
               + EXTRACT(MINUTE FROM NEW.time_out AT TIME ZONE 'Asia/Manila')::INTEGER;
        v_under := GREATEST(0, p.work_end - v_out);
      END IF;

      v_half := v_worked < (p.work_hours / 2.0);

      IF v_half THEN
        -- The half-day deduction covers the day; minutes are not deducted twice.
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

  -- Rest days and holidays: a tap is recorded, but nothing is deducted,
  -- nothing is left Incomplete and no incentive is earned.
  IF v_rest AND NEW.time_in IS NOT NULL THEN
    v_status := 'On Time';
    v_late := 0;
    v_under := 0;
    v_half := FALSE;
    v_early := FALSE;
  END IF;

  IF v_override THEN
    -- The correction workflow chose the status. Keep it and make the facts
    -- agree with it.
    IF NEW.status = 'Absent' THEN
      v_late := 0; v_under := 0; v_half := FALSE; v_early := FALSE;
    ELSIF NEW.status = 'Half Day' THEN
      v_late := 0; v_under := 0; v_half := TRUE; v_early := FALSE;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.status IN ('Pending Correction', 'Corrected') THEN
    -- Only the correction workflow moves a record out of these.
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

-- Named to sort after attendance_logs_stamp_branch: BEFORE triggers fire in
-- name order, and the schedule depends on the branch that one stamps.
DROP TRIGGER IF EXISTS attendance_logs_zz_compute_status ON public.attendance_logs;
CREATE TRIGGER attendance_logs_zz_compute_status
  BEFORE INSERT OR UPDATE ON public.attendance_logs
  FOR EACH ROW EXECUTE FUNCTION public.attendance_logs_compute_status();

-- Recompute every existing row once ("Present" becomes On Time / Early Bird /
-- Undertime / Half Day / Incomplete as its taps dictate).
UPDATE public.attendance_logs SET status_computed_at = NOW();

ALTER TABLE public.attendance_logs ADD CONSTRAINT attendance_logs_status_check CHECK (status IN (
  'On Time', 'Early Bird', 'Late', 'Undertime', 'Half Day', 'Absent',
  'Incomplete', 'Pending Correction', 'Corrected'
));

-- ─── 5. Nightly close: Incomplete and Absent ────────────────────────────────
-- Called by the attendance-nightly Edge Function (supabase/functions/) every
-- night, and by the payroll and attendance screens for the days they show, so
-- the result never depends on the job having run. Idempotent.
--
--   * rows with a time in and no time out are re-evaluated; once their shift
--     has ended the engine flags them Incomplete;
--   * every closed working day (before today, Manila) on which an active
--     employee has no row and no approved leave gets an Absent row, so every
--     absence deduction traces to a specific attendance log.
CREATE OR REPLACE FUNCTION public.attendance_close_days(p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_last_closed DATE := LEAST(p_to, v_today - 1);
  v_reevaluated INTEGER := 0;
  v_absent INTEGER := 0;
BEGIN
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
      AND NOT EXISTS (
        SELECT 1 FROM public.leave_requests lr
        WHERE lower(lr.status) = 'approved'
          AND (lr.employee_id = pr.id::TEXT OR lr.employee_id = pr.employee_id)
          AND d.day BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
      )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_absent = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('reevaluated', v_reevaluated, 'absent_inserted', v_absent);
END;
$$;

-- ─── 6. Corrections ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_corrections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id              UUID NOT NULL REFERENCES public.attendance_logs(id),
  employee_id         UUID NOT NULL,
  employee_name       TEXT,
  branch_id           UUID REFERENCES public.branches(id),
  log_date            DATE NOT NULL,
  original_status     TEXT,
  original_time_in    TIMESTAMPTZ,
  original_time_out   TIMESTAMPTZ,
  -- NULL only when HR / Admin resolved the record as Absent or Half Day.
  corrected_time_out  TIMESTAMPTZ,
  reason              TEXT NOT NULL,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Who filed it: the employee, or HR / Admin resolving an Incomplete record
  -- nobody asked about (attendance_resolve_record).
  requested_by        UUID,
  requested_by_name   TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  -- On rejection: what the record becomes. 'incomplete' keeps it out of
  -- payroll until someone resolves it; 'absent' / 'half_day' force it.
  resolution          TEXT CHECK (resolution IN ('corrected', 'incomplete', 'absent', 'half_day')),
  approved_by         UUID,
  approved_by_name    TEXT,
  approved_at         TIMESTAMPTZ,
  review_note         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS attendance_corrections_status_idx ON public.attendance_corrections (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS attendance_corrections_employee_idx ON public.attendance_corrections (employee_id, log_date);
CREATE INDEX IF NOT EXISTS attendance_corrections_branch_idx ON public.attendance_corrections (branch_id);
-- One open request per record.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_corrections_one_pending
  ON public.attendance_corrections (log_id) WHERE status = 'pending';

ALTER TABLE public.attendance_corrections ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS attendance_corrections_block_hard_delete ON public.attendance_corrections;
CREATE TRIGGER attendance_corrections_block_hard_delete
  BEFORE DELETE ON public.attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

-- Employee asks for a corrected time out. The record becomes
-- Pending Correction until HR / Admin decides.
CREATE OR REPLACE FUNCTION public.attendance_request_correction(
  p_log_id UUID,
  p_employee_id UUID,
  p_corrected_time_out TIMESTAMPTZ,
  p_reason TEXT
)
RETURNS public.attendance_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log public.attendance_logs;
  v_row public.attendance_corrections;
BEGIN
  SELECT * INTO v_log FROM public.attendance_logs WHERE id = p_log_id FOR UPDATE;
  IF NOT FOUND OR v_log.employee_id <> p_employee_id THEN
    RAISE EXCEPTION 'Attendance record not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_log.status NOT IN ('Incomplete', 'Undertime', 'Half Day') THEN
    RAISE EXCEPTION 'Only Incomplete, Undertime or Half Day records can be corrected.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_log.time_in IS NULL THEN
    RAISE EXCEPTION 'This record has no time in to correct.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_corrected_time_out IS NULL OR p_corrected_time_out <= v_log.time_in THEN
    RAISE EXCEPTION 'The corrected time out must be after the time in.' USING ERRCODE = 'check_violation';
  END IF;
  IF (p_corrected_time_out AT TIME ZONE 'Asia/Manila')::DATE <> v_log.log_date THEN
    RAISE EXCEPTION 'The corrected time out must be on the same day as the record.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_corrected_time_out > NOW() THEN
    RAISE EXCEPTION 'The corrected time out cannot be in the future.' USING ERRCODE = 'check_violation';
  END IF;
  IF length(trim(COALESCE(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'Give a reason for the correction.' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.attendance_corrections
    (log_id, employee_id, employee_name, branch_id, log_date, original_status,
     original_time_in, original_time_out, corrected_time_out, reason, requested_by, requested_by_name)
  VALUES
    (v_log.id, v_log.employee_id, v_log.employee_name, v_log.branch_id, v_log.log_date, v_log.status,
     v_log.time_in, v_log.time_out, p_corrected_time_out, trim(p_reason), p_employee_id, v_log.employee_name)
  RETURNING * INTO v_row;

  PERFORM set_config('sacs.attendance_override', 'on', true);
  UPDATE public.attendance_logs SET status = 'Pending Correction' WHERE id = v_log.id;
  PERFORM set_config('sacs.attendance_override', 'off', true);

  RETURN v_row;
END;
$$;

-- HR / Admin decide.
--   approve                  time out replaced, status Corrected
--   reject + 'incomplete'    status recomputed from the original taps (an
--                            original Incomplete stays Incomplete and out of
--                            payroll; a disputed Undertime / Half Day goes
--                            back to what the taps say)
--   reject + 'absent'        forced Absent
--   reject + 'half_day'      forced Half Day
CREATE OR REPLACE FUNCTION public.attendance_review_correction(
  p_correction_id UUID,
  p_decision TEXT,
  p_resolution TEXT,
  p_reviewer UUID,
  p_reviewer_name TEXT,
  p_note TEXT
)
RETURNS public.attendance_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.attendance_corrections;
  v_resolution TEXT;
BEGIN
  SELECT * INTO v_row FROM public.attendance_corrections WHERE id = p_correction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Correction request not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This correction request has already been decided.' USING ERRCODE = 'check_violation';
  END IF;

  IF p_decision = 'approve' THEN
    v_resolution := 'corrected';
    PERFORM set_config('sacs.attendance_override', 'on', true);
    UPDATE public.attendance_logs
    SET time_out = v_row.corrected_time_out, status = 'Corrected'
    WHERE id = v_row.log_id;
    PERFORM set_config('sacs.attendance_override', 'off', true);
  ELSIF p_decision = 'reject' THEN
    v_resolution := COALESCE(NULLIF(p_resolution, ''), 'incomplete');
    IF v_resolution NOT IN ('incomplete', 'absent', 'half_day') THEN
      RAISE EXCEPTION 'Unknown resolution %.', v_resolution USING ERRCODE = 'check_violation';
    END IF;
    PERFORM set_config('sacs.attendance_override', 'on', true);
    IF v_resolution = 'absent' THEN
      UPDATE public.attendance_logs SET status = 'Absent' WHERE id = v_row.log_id;
    ELSIF v_resolution = 'half_day' THEN
      UPDATE public.attendance_logs SET status = 'Half Day' WHERE id = v_row.log_id;
    ELSE
      -- Placeholder the engine replaces once the override is off (below).
      UPDATE public.attendance_logs SET status = 'Incomplete' WHERE id = v_row.log_id;
    END IF;
    PERFORM set_config('sacs.attendance_override', 'off', true);
    IF v_resolution = 'incomplete' THEN
      UPDATE public.attendance_logs SET status_computed_at = NOW() WHERE id = v_row.log_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'Decision must be approve or reject.' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.attendance_corrections
  SET status = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
      resolution = v_resolution,
      approved_by = p_reviewer,
      approved_by_name = p_reviewer_name,
      approved_at = NOW(),
      review_note = NULLIF(trim(COALESCE(p_note, '')), ''),
      updated_at = NOW()
  WHERE id = p_correction_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- HR / Admin resolve an Incomplete record nobody filed a request for, so it
-- does not hold payroll back forever:
--   'time_out'  the given time out is recorded, status Corrected
--   'absent'    forced Absent
--   'half_day'  forced Half Day
-- Written to attendance_corrections as an already-decided request, so the
-- resolution has the same audit trail as an employee's request.
CREATE OR REPLACE FUNCTION public.attendance_resolve_record(
  p_log_id UUID,
  p_resolution TEXT,
  p_time_out TIMESTAMPTZ,
  p_reviewer UUID,
  p_reviewer_name TEXT,
  p_note TEXT
)
RETURNS public.attendance_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log public.attendance_logs;
  v_row public.attendance_corrections;
BEGIN
  SELECT * INTO v_log FROM public.attendance_logs WHERE id = p_log_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attendance record not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_log.status <> 'Incomplete' THEN
    RAISE EXCEPTION 'Only an Incomplete record can be resolved here. A record with a pending request is decided from Correction Requests.' USING ERRCODE = 'check_violation';
  END IF;
  IF length(trim(COALESCE(p_note, ''))) < 5 THEN
    RAISE EXCEPTION 'Give a reason for the resolution.' USING ERRCODE = 'check_violation';
  END IF;

  IF p_resolution = 'time_out' THEN
    IF p_time_out IS NULL OR p_time_out <= v_log.time_in THEN
      RAISE EXCEPTION 'The time out must be after the time in.' USING ERRCODE = 'check_violation';
    END IF;
    IF (p_time_out AT TIME ZONE 'Asia/Manila')::DATE <> v_log.log_date THEN
      RAISE EXCEPTION 'The time out must be on the same day as the record.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_resolution NOT IN ('absent', 'half_day') THEN
    RAISE EXCEPTION 'Resolution must be time_out, absent or half_day.' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.attendance_corrections
    (log_id, employee_id, employee_name, branch_id, log_date, original_status,
     original_time_in, original_time_out, corrected_time_out, reason,
     requested_by, requested_by_name, status, resolution,
     approved_by, approved_by_name, approved_at, review_note)
  VALUES
    (v_log.id, v_log.employee_id, v_log.employee_name, v_log.branch_id, v_log.log_date, v_log.status,
     v_log.time_in, v_log.time_out,
     CASE WHEN p_resolution = 'time_out' THEN p_time_out END,
     trim(p_note), p_reviewer, p_reviewer_name,
     'approved',
     CASE p_resolution WHEN 'time_out' THEN 'corrected' ELSE p_resolution END,
     p_reviewer, p_reviewer_name, NOW(), trim(p_note))
  RETURNING * INTO v_row;

  PERFORM set_config('sacs.attendance_override', 'on', true);
  IF p_resolution = 'time_out' THEN
    UPDATE public.attendance_logs SET time_out = p_time_out, status = 'Corrected' WHERE id = v_log.id;
  ELSIF p_resolution = 'absent' THEN
    UPDATE public.attendance_logs SET status = 'Absent' WHERE id = v_log.id;
  ELSE
    UPDATE public.attendance_logs SET status = 'Half Day' WHERE id = v_log.id;
  END IF;
  PERFORM set_config('sacs.attendance_override', 'off', true);

  RETURN v_row;
END;
$$;

-- Only the server (service role) calls these.
REVOKE ALL ON FUNCTION public.attendance_resolve_record(UUID, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_resolve_record(UUID, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.attendance_close_days(DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_request_correction(UUID, UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_review_correction(UUID, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_close_days(DATE, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_request_correction(UUID, UUID, TIMESTAMPTZ, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_review_correction(UUID, TEXT, TEXT, UUID, TEXT, TEXT) TO service_role;

-- ─── 7. Permissions ─────────────────────────────────────────────────────────
-- Mirrors attendance_corrections in src/lib/rbac/permissions.js: employees
-- (and accountants, who tap in too) request for themselves; HR and Admin
-- approve; Super Admin everything.
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'attendance_corrections', 'all',    true,  true,  true,  true),
  ('admin',       'attendance_corrections', 'branch', false, true,  true,  false),
  ('hr',          'attendance_corrections', 'all',    false, true,  true,  false),
  ('accountant',  'attendance_corrections', 'self',   true,  true,  false, false),
  ('employee',    'attendance_corrections', 'self',   true,  true,  false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope      = EXCLUDED.scope,
  can_create = EXCLUDED.can_create,
  can_read   = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update,
  can_delete = EXCLUDED.can_delete,
  updated_at = NOW();
