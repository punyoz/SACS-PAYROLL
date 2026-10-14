-- ═══════════════════════════════════════════════════════════════════════════
-- Per-employee work schedules, per-cutoff payroll, Early Bird winner
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. Employee level (profiles.employee_level): Pre-school, Grade School,
--    High School, Senior High School, Non-teaching.
--
-- 2. Work schedule profiles (work_schedules) and who follows them
--    (work_schedule_assignments). Super Admin and HR create, change, delete
--    (archive) and assign them (src/app/api/admin/work-schedules/route.js);
--    Admin reads its own branch.
--
--      work_schedules              one row per VERSION of a profile; every
--                                  version of one profile shares schedule_key.
--                                  Editing a profile adds a version from an
--                                  effective date; deleting adds an archived
--                                  version (history is never removed).
--      work_schedule_assignments   an employee's own schedule, or a level's
--                                  schedule, from an effective date
--                                  (schedule_key NULL = back to the fallback).
--
--    Both tables are append-only and refuse an effective date before today
--    (Manila), so attendance already judged and payslips already issued are
--    never recalculated by a schedule change.
--
-- 3. The schedule a day is judged on, attendance_schedule_for(employee,
--    branch, day), in priority order:
--      (1) the employee's own schedule
--      (2) the schedule assigned to the employee's level
--      (3) the branch schedule      (system_config "attendance:<branch>")
--      (4) the default schedule     (system_config "attendance")
--    The status engine and the nightly close use it, so Late, Undertime,
--    Half Day and Absent follow the employee's own start, end, grace period,
--    required hours and working days. Each attendance row keeps the shift it
--    was judged on (shift_start_minutes / shift_end_minutes) and how early or
--    late the time in was against it (arrival_offset_minutes).
--
-- 4. Early Bird: a time in counts as early when it is at least
--    early_bird.threshold_minutes (default 15, Super Admin or HR) before the
--    employee's OWN work start. It replaces the per-day early_bird_bonus rate,
--    retired here (section 8). One winner per pay period is stored in early_bird_winners; the row
--    locks once any payslip of that period is Final.
--
-- 5. payroll_entries.cutoff ('first' 1-15 / 'second' 16-end), and the
--    'early_bird_incentive' payslip line type.
--
-- 6. role_permissions for the two new modules (src/lib/rbac/permissions.js).
--
-- 8. The per-day early_bird_bonus rate is retired (old payslips untouched).
--
-- Existing attendance rows are NOT recomputed: the new columns stay NULL on
-- them until something touches the row, exactly as for any later change.
--
-- Safe to run more than once.

-- ── 1. Employee level ──────────────────────────────────────────────────────

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS employee_level TEXT;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_employee_level_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_employee_level_check CHECK (
  employee_level IS NULL
  OR employee_level IN ('preschool', 'grade_school', 'high_school', 'senior_high', 'non_teaching')
);

-- ── 2. Schedule profiles and assignments ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.work_schedules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_key    UUID NOT NULL,
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  work_start      TIME NOT NULL,
  work_end        TIME NOT NULL,
  grace_minutes   INTEGER NOT NULL DEFAULT 15 CHECK (grace_minutes BETWEEN 0 AND 120),
  work_hours      NUMERIC(4, 2) NOT NULL DEFAULT 8 CHECK (work_hours > 0 AND work_hours <= 24),
  -- ISO weekdays: 1 = Monday ... 7 = Sunday.
  working_days    SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  effective_from  DATE NOT NULL,
  archived        BOOLEAN NOT NULL DEFAULT FALSE,
  note            TEXT,
  created_by      UUID,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT work_schedules_span_chk CHECK (work_end > work_start),
  CONSTRAINT work_schedules_days_chk CHECK (
    cardinality(working_days) BETWEEN 1 AND 7
    AND working_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]
  )
);

CREATE INDEX IF NOT EXISTS work_schedules_key_idx
  ON public.work_schedules (schedule_key, effective_from DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS public.work_schedule_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID REFERENCES public.profiles(id),
  employee_level  TEXT CHECK (
    employee_level IS NULL
    OR employee_level IN ('preschool', 'grade_school', 'high_school', 'senior_high', 'non_teaching')
  ),
  -- NULL: no schedule of its own from this date (falls back to the next level).
  schedule_key    UUID,
  effective_from  DATE NOT NULL,
  note            TEXT,
  created_by      UUID,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT work_schedule_assignments_target_chk CHECK ((employee_id IS NULL) <> (employee_level IS NULL))
);

CREATE INDEX IF NOT EXISTS work_schedule_assignments_employee_idx
  ON public.work_schedule_assignments (employee_id, effective_from DESC, created_at DESC)
  WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_schedule_assignments_level_idx
  ON public.work_schedule_assignments (employee_level, effective_from DESC, created_at DESC)
  WHERE employee_level IS NOT NULL;

-- Append-only, and never from a date already past (Manila).
CREATE OR REPLACE FUNCTION public.work_schedules_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Schedule history is kept as it is: add a new version with an effective date instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.effective_from < (NOW() AT TIME ZONE 'Asia/Manila')::DATE THEN
    RAISE EXCEPTION 'A schedule change cannot take effect before today.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'work_schedule_assignments' AND NEW.schedule_key IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.work_schedules s WHERE s.schedule_key = NEW.schedule_key) THEN
    RAISE EXCEPTION 'Unknown schedule.' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS work_schedules_guard ON public.work_schedules;
CREATE TRIGGER work_schedules_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.work_schedules
  FOR EACH ROW EXECUTE FUNCTION public.work_schedules_guard();

DROP TRIGGER IF EXISTS work_schedule_assignments_guard ON public.work_schedule_assignments;
CREATE TRIGGER work_schedule_assignments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.work_schedule_assignments
  FOR EACH ROW EXECUTE FUNCTION public.work_schedules_guard();

ALTER TABLE public.work_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_schedule_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.work_schedules FROM anon, authenticated;
REVOKE ALL ON public.work_schedule_assignments FROM anon, authenticated;

-- ── 3. The schedule a day is judged on ─────────────────────────────────────

-- The version of a profile in force on a day (NULL row when none yet).
CREATE OR REPLACE FUNCTION public.work_schedule_version_on(p_key UUID, p_day DATE)
RETURNS public.work_schedules
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT s.*
  FROM public.work_schedules s
  WHERE s.schedule_key = p_key AND s.effective_from <= p_day
  ORDER BY s.effective_from DESC, s.created_at DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.attendance_schedule_for(p_employee UUID, p_branch UUID, p_day DATE)
RETURNS TABLE (
  work_start    INTEGER,
  work_end      INTEGER,
  grace         NUMERIC,
  work_hours    NUMERIC,
  schedule_id   TEXT,
  working_days  SMALLINT[],
  source        TEXT,
  schedule_name TEXT,
  schedule_key  UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_key UUID;
  v_level TEXT;
  v_source TEXT;
  s public.work_schedules;
  b RECORD;
BEGIN
  IF p_employee IS NOT NULL THEN
    -- (1) The employee's own schedule.
    SELECT a.schedule_key INTO v_key
    FROM public.work_schedule_assignments a
    WHERE a.employee_id = p_employee AND a.effective_from <= p_day
    ORDER BY a.effective_from DESC, a.created_at DESC
    LIMIT 1;
    v_source := 'employee';

    -- (2) The schedule of the employee's level.
    IF v_key IS NULL THEN
      SELECT pr.employee_level INTO v_level FROM public.profiles pr WHERE pr.id = p_employee;
      IF v_level IS NOT NULL THEN
        SELECT a.schedule_key INTO v_key
        FROM public.work_schedule_assignments a
        WHERE a.employee_level = v_level AND a.effective_from <= p_day
        ORDER BY a.effective_from DESC, a.created_at DESC
        LIMIT 1;
        v_source := 'level';
      END IF;
    END IF;

    IF v_key IS NOT NULL THEN
      s := public.work_schedule_version_on(v_key, p_day);
      IF s.id IS NOT NULL AND NOT s.archived THEN
        work_start := EXTRACT(HOUR FROM s.work_start)::INTEGER * 60 + EXTRACT(MINUTE FROM s.work_start)::INTEGER;
        work_end := EXTRACT(HOUR FROM s.work_end)::INTEGER * 60 + EXTRACT(MINUTE FROM s.work_end)::INTEGER;
        grace := s.grace_minutes;
        work_hours := s.work_hours;
        schedule_id := 'work_schedule:' || s.schedule_key::TEXT;
        working_days := s.working_days;
        source := v_source;
        schedule_name := s.name;
        schedule_key := s.schedule_key;
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;
  END IF;

  -- (3) the branch schedule, (4) the default.
  SELECT * INTO b FROM public.attendance_policy_for(p_branch);
  work_start := b.work_start;
  work_end := b.work_end;
  grace := b.grace;
  work_hours := b.work_hours;
  schedule_id := b.schedule_id;
  working_days := NULL;
  source := CASE WHEN b.schedule_id = 'attendance' THEN 'default' ELSE 'branch' END;
  schedule_name := NULL;
  schedule_key := NULL;
  RETURN NEXT;
END;
$$;

-- One row per day, for timesheets (at most 62 days).
CREATE OR REPLACE FUNCTION public.attendance_schedules_between(p_employee UUID, p_branch UUID, p_from DATE, p_to DATE)
RETURNS TABLE (
  day           DATE,
  work_start    INTEGER,
  work_end      INTEGER,
  grace         NUMERIC,
  work_hours    NUMERIC,
  schedule_id   TEXT,
  working_days  SMALLINT[],
  source        TEXT,
  schedule_name TEXT,
  schedule_key  UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.day::DATE, s.*
  FROM generate_series(p_from, LEAST(p_to, p_from + 61), INTERVAL '1 day') AS d(day)
  CROSS JOIN LATERAL public.attendance_schedule_for(p_employee, p_branch, d.day::DATE) s
  WHERE p_from IS NOT NULL AND p_to IS NOT NULL AND p_from <= p_to;
$$;

-- A day off under a schedule's working days (Mon-Fri when none), or a
-- whole-day holiday / suspension.
CREATE OR REPLACE FUNCTION public.attendance_is_rest_day_on(p_day DATE, p_working_days SMALLINT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN p_working_days IS NULL OR cardinality(p_working_days) = 0 THEN EXTRACT(ISODOW FROM p_day) >= 6
           ELSE NOT (EXTRACT(ISODOW FROM p_day)::SMALLINT = ANY (p_working_days))
         END
      OR EXISTS (
        SELECT 1 FROM public.attendance_holidays h
        WHERE h.holiday_date = p_day AND h.day_part = 'whole'
      );
$$;

CREATE OR REPLACE FUNCTION public.attendance_is_rest_day_for(p_employee UUID, p_branch UUID, p_day DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.attendance_is_rest_day_on(
    p_day,
    (SELECT s.working_days FROM public.attendance_schedule_for(p_employee, p_branch, p_day) s)
  );
$$;

-- The Early Bird threshold in minutes (Super Admin setting, default 15).
CREATE OR REPLACE FUNCTION public.early_bird_threshold_minutes()
RETURNS INTEGER
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT LEAST(GREATEST(public.attendance_to_number(c.value)::INTEGER, 0), 240)
    FROM public.system_config c
    WHERE c.section = 'early_bird' AND c.key = 'threshold_minutes'
      AND public.attendance_to_number(c.value) IS NOT NULL
    LIMIT 1
  ), 15);
$$;

REVOKE ALL ON FUNCTION public.attendance_schedule_for(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_schedules_between(UUID, UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_is_rest_day_for(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.work_schedule_version_on(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.work_schedules_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_schedule_for(UUID, UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_schedules_between(UUID, UUID, DATE, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_is_rest_day_for(UUID, UUID, DATE) TO service_role;

-- ── 4. The status engine on the employee's own schedule ────────────────────

ALTER TABLE public.attendance_logs
  ADD COLUMN IF NOT EXISTS shift_start_minutes    INTEGER,
  ADD COLUMN IF NOT EXISTS shift_end_minutes      INTEGER,
  ADD COLUMN IF NOT EXISTS arrival_offset_minutes INTEGER;

COMMENT ON COLUMN public.attendance_logs.shift_start_minutes IS
  'Work start of the schedule the day was judged on (minutes after midnight, Manila).';
COMMENT ON COLUMN public.attendance_logs.arrival_offset_minutes IS
  'Time in minus that day''s work start, in minutes (negative = early). NULL without a time in or on a rest day.';

-- Unchanged from 20261007010000_holiday_calendar.sql except:
--   * the schedule is attendance_schedule_for(employee, branch, day), not the branch's;
--   * a rest day follows that schedule's working days;
--   * Early Bird = time in at least early_bird_threshold_minutes() before the start;
--   * the shift and the arrival offset are kept on the row.
CREATE OR REPLACE FUNCTION public.attendance_logs_compute_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  p RECORD;
  v_override BOOLEAN := COALESCE(current_setting('sacs.attendance_override', true), '') = 'on';
  v_rest BOOLEAN;
  v_holiday BOOLEAN;
  v_part TEXT;
  v_cutoff INTEGER;
  v_span INTEGER;
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
  v_threshold INTEGER := public.early_bird_threshold_minutes();
BEGIN
  SELECT * INTO p FROM public.attendance_schedule_for(NEW.employee_id, NEW.branch_id, NEW.log_date);
  NEW.schedule_id := p.schedule_id;
  NEW.shift_start_minutes := p.work_start;
  NEW.shift_end_minutes := p.work_end;
  NEW.arrival_offset_minutes := NULL;

  SELECT h.day_part,
         EXTRACT(HOUR FROM h.cutoff)::INTEGER * 60 + EXTRACT(MINUTE FROM h.cutoff)::INTEGER
    INTO v_part, v_cutoff
    FROM public.attendance_holidays h
   WHERE h.holiday_date = NEW.log_date AND h.day_part IN ('am', 'pm') AND h.cutoff IS NOT NULL;
  IF v_part IS NOT NULL AND v_cutoff > p.work_start AND v_cutoff < p.work_end THEN
    v_span := GREATEST(p.work_end - p.work_start, 1);
    IF v_part = 'pm' THEN
      p.work_hours := p.work_hours * (v_cutoff - p.work_start)::NUMERIC / v_span;
      p.work_end := v_cutoff;
    ELSE
      p.work_hours := p.work_hours * (p.work_end - v_cutoff)::NUMERIC / v_span;
      p.work_start := v_cutoff;
    END IF;
  END IF;

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

  v_rest := public.attendance_is_rest_day_on(NEW.log_date, p.working_days);
  v_holiday := EXISTS (
    SELECT 1 FROM public.attendance_holidays h
    WHERE h.holiday_date = NEW.log_date AND h.day_part = 'whole'
  );

  IF NEW.time_in IS NULL THEN
    v_status := CASE WHEN v_holiday THEN 'Holiday' ELSE 'Absent' END;
  ELSE
    v_in := EXTRACT(HOUR FROM NEW.time_in AT TIME ZONE 'Asia/Manila')::INTEGER * 60
          + EXTRACT(MINUTE FROM NEW.time_in AT TIME ZONE 'Asia/Manila')::INTEGER;
    v_tardy := GREATEST(0, v_in - p.work_start);
    v_late := CASE WHEN v_tardy > p.grace THEN v_tardy ELSE 0 END;
    v_early := v_in <= p.work_start - v_threshold;
    IF NOT v_rest THEN
      NEW.arrival_offset_minutes := v_in - p.work_start;
    END IF;

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
$function$;

-- Unchanged (live definition) except that a day off follows the employee's
-- own working days: a Mon-Sat schedule is marked Absent on an untapped
-- Saturday, a Mon-Thu schedule never on a Friday.
CREATE OR REPLACE FUNCTION public.attendance_close_days(p_from date, p_to date)
RETURNS jsonb
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
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_logs l
        WHERE l.employee_id = pr.id AND l.log_date = d.day AND l.archived_duplicate = FALSE
      )
      AND NOT EXISTS (SELECT 1 FROM public.attendance_approved_leave(pr.id, d.day))
      AND NOT public.attendance_is_rest_day_for(pr.id, pr.branch_id, d.day)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_absent = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('reevaluated', v_reevaluated, 'absent_inserted', v_absent);
END;
$function$;

-- ── 5. Early Bird settings and winners ─────────────────────────────────────

-- Defaults (Super Admin or HR). The amount starts at 0: no incentive until
-- one is set.
INSERT INTO public.system_config (section, key, value) VALUES
  ('early_bird', 'threshold_minutes', '15'),
  ('early_bird', 'incentive_amount', '0'),
  ('early_bird', 'exclude_unexcused_absence', 'true')
ON CONFLICT (section, key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.early_bird_winners (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_label           TEXT NOT NULL UNIQUE,          -- "October 1-15, 2026"
  period_start           DATE NOT NULL,
  period_end             DATE NOT NULL,
  window_start           DATE NOT NULL,                 -- attendance counted
  window_end             DATE NOT NULL,
  employee_id            UUID REFERENCES public.profiles(id),  -- NULL: nobody qualified
  employee_name          TEXT,
  branch_id              UUID,
  early_count            INTEGER NOT NULL DEFAULT 0 CHECK (early_count >= 0),
  average_offset_minutes NUMERIC(8, 2),
  late_count             INTEGER NOT NULL DEFAULT 0 CHECK (late_count >= 0),
  absent_count           INTEGER NOT NULL DEFAULT 0 CHECK (absent_count >= 0),
  amount                 NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  threshold_minutes      INTEGER NOT NULL,
  exclude_unexcused      BOOLEAN NOT NULL DEFAULT TRUE,
  source_log_ids         UUID[] NOT NULL DEFAULT '{}',
  ranking                JSONB NOT NULL DEFAULT '[]'::JSONB,
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computed_by            UUID,
  computed_by_name       TEXT,
  finalized_at           TIMESTAMPTZ,
  CONSTRAINT early_bird_winners_winner_chk CHECK (employee_id IS NULL OR early_count > 0)
);

ALTER TABLE public.early_bird_winners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.early_bird_winners FROM anon, authenticated;

-- Once a payslip of the period is Final the winner is fixed: no update, no
-- delete. (Locked by the next Final payslip committed after the winner was
-- stored, payroll_entries_lock_early_bird below; a period with Final
-- payslips from before this feature is not locked by those.)
CREATE OR REPLACE FUNCTION public.early_bird_winners_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF OLD.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'The Early Bird winner for % is final: payroll for the period is already finalized.', OLD.period_label
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS early_bird_winners_guard ON public.early_bird_winners;
CREATE TRIGGER early_bird_winners_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.early_bird_winners
  FOR EACH ROW EXECUTE FUNCTION public.early_bird_winners_guard();

-- The first Final payslip of a period locks its winner.
CREATE OR REPLACE FUNCTION public.early_bird_lock_on_final()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status::TEXT = 'paid' THEN
    UPDATE public.early_bird_winners
       SET finalized_at = NOW()
     WHERE period_label = NEW.pay_period AND finalized_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_entries_lock_early_bird ON public.payroll_entries;
CREATE TRIGGER payroll_entries_lock_early_bird
  AFTER INSERT OR UPDATE OF status ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.early_bird_lock_on_final();

REVOKE ALL ON FUNCTION public.early_bird_winners_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.early_bird_lock_on_final() FROM PUBLIC, anon, authenticated;

-- ── 6. Cutoff on payroll, the Early Bird payslip line ──────────────────────

ALTER TABLE public.payroll_entries ADD COLUMN IF NOT EXISTS cutoff TEXT;
ALTER TABLE public.payroll_entries DROP CONSTRAINT IF EXISTS payroll_entries_cutoff_check;
ALTER TABLE public.payroll_entries ADD CONSTRAINT payroll_entries_cutoff_check
  CHECK (cutoff IS NULL OR cutoff IN ('first', 'second'));

-- "October 1-15, 2026" -> first; "October 16-31, 2026" -> second.
CREATE OR REPLACE FUNCTION public.payroll_entries_stamp_cutoff()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.cutoff := CASE
    WHEN NEW.pay_period ~ '\s1-15,' THEN 'first'
    WHEN NEW.pay_period ~ '\s16-\d{2},' THEN 'second'
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_entries_stamp_cutoff ON public.payroll_entries;
CREATE TRIGGER payroll_entries_stamp_cutoff
  BEFORE INSERT OR UPDATE OF pay_period ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.payroll_entries_stamp_cutoff();

REVOKE ALL ON FUNCTION public.payroll_entries_stamp_cutoff() FROM PUBLIC, anon, authenticated;

UPDATE public.payroll_entries
   SET cutoff = CASE
     WHEN pay_period ~ '\s1-15,' THEN 'first'
     WHEN pay_period ~ '\s16-\d{2},' THEN 'second'
   END
 WHERE cutoff IS NULL;

ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_type_check;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_type_check CHECK (type IN (
  'early_bird', 'perfect_attendance', 'overtime', 'holiday_premium', 'incentive', 'overload',
  'subsidy', 'subsidy_adjustment', 'early_bird_incentive'
));

-- ── 7. Permissions (mirrors src/lib/rbac/permissions.js) ───────────────────

INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'work_schedules',       'all',    true,  true,  true,  true),
  ('admin',       'work_schedules',       'branch', false, true,  false, false),
  ('hr',          'work_schedules',       'all',    true,  true,  true,  true),
  ('accountant',  'work_schedules',       'none',   false, false, false, false),
  ('employee',    'work_schedules',       'none',   false, false, false, false),
  ('super_admin', 'early_bird_incentive', 'all',    true,  true,  true,  true),
  ('admin',       'early_bird_incentive', 'branch', false, true,  false, false),
  ('hr',          'early_bird_incentive', 'all',    false, true,  true,  false),
  ('accountant',  'early_bird_incentive', 'branch', false, true,  false, false),
  ('employee',    'early_bird_incentive', 'none',   false, false, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope      = EXCLUDED.scope,
  can_create = EXCLUDED.can_create,
  can_read   = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update,
  can_delete = EXCLUDED.can_delete,
  updated_at = NOW();

-- ── 8. Retire the per-day Early Bird bonus ─────────────────────────────────
-- The Early Bird incentive (one winner per period, section 5) replaces the
-- early_bird_bonus rate (₱ per Early Bird day). Payroll no longer reads or
-- computes it. Its rate rows, and every payslip / payroll_incentives line
-- ('early_bird') that already paid it, stay exactly as they are; only new
-- versions of the rate are refused, so it cannot be switched back on by
-- accident and paid twice alongside the incentive.
CREATE OR REPLACE FUNCTION public.payroll_rate_configs_refuse_retired()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.rate_type = 'early_bird_bonus' THEN
    RAISE EXCEPTION 'The per-day Early Bird bonus is retired: set the Early Bird incentive instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_rate_configs_refuse_retired ON public.payroll_rate_configs;
CREATE TRIGGER payroll_rate_configs_refuse_retired
  BEFORE INSERT OR UPDATE ON public.payroll_rate_configs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_rate_configs_refuse_retired();

REVOKE ALL ON FUNCTION public.payroll_rate_configs_refuse_retired() FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.attendance_logs.is_early_bird IS
  'Time in at least early_bird_threshold_minutes() before the day''s own work start (the Early Bird status). No longer priced per day; the incentive counts arrival_offset_minutes.';
