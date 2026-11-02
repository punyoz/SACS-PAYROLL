-- Holidays and holiday duty (2026-11-02).
--
-- School rule (decided): on a holiday the school is CLOSED. Nobody is
-- expected to work, and the day is never an absence, late or undertime. HR
-- may require specific staff to report (guards, maintenance, registrar,
-- event duty); they earn the holiday premium when they work.
--
-- 1. attendance_holidays gains:
--    * type 'special_working': a special WORKING day (e.g. EDSA People Power
--      Anniversary, Feb 25). It is shown on calendars and timesheets but is
--      an ordinary working day: never a day off, never a premium.
--    * branch_ids: NULL (or empty) = every branch; otherwise only the listed
--      branches (a local holiday, or a closure of one or two branches).
--    * source: where the day comes from ("Proclamation No. 1006, s. 2025").
--    Every reader of the table in the database now goes through
--    attendance_day_off_on(day, branch), which applies both rules.
--
-- 2. The 2026 days proclaimed each year, checked against the official texts:
--    Proclamation No. 1006, s. 2025 (2026 regular holidays and special
--    days), No. 1189, s. 2026 (Eid'l Fitr, March 20) and No. 1264, s. 2026
--    (Eid'l Adha, May 27). Only missing dates are added; nothing existing is
--    changed but its `source`. Attendance is recomputed only for days from
--    today on: a past day's records (and any payroll already approved on
--    them) are left exactly as they are.
--
-- 3. holiday_duty_assignments: who HR required to report on a holiday, with
--    the shift and an optional note; holiday_duty_history: every assign,
--    change and removal, with who did it.
--
-- 4. holiday_work_reviews: HR's decision on a holiday worked WITHOUT an
--    assignment (approved = paid the holiday premium; rejected = not).
--
-- The three new tables are server-only (the API routes, service role).
--
-- Safe to run more than once.

-- ── 1. attendance_holidays: special working days, branches, source ─────────

ALTER TABLE public.attendance_holidays DROP CONSTRAINT IF EXISTS attendance_holidays_type_check;
ALTER TABLE public.attendance_holidays ADD CONSTRAINT attendance_holidays_type_check
  CHECK (type IN ('holiday', 'special', 'special_working', 'suspension'));

ALTER TABLE public.attendance_holidays ADD COLUMN IF NOT EXISTS branch_ids UUID[];
ALTER TABLE public.attendance_holidays ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE public.attendance_holidays DROP CONSTRAINT IF EXISTS attendance_holidays_source_length;
ALTER TABLE public.attendance_holidays ADD CONSTRAINT attendance_holidays_source_length
  CHECK (source IS NULL OR char_length(source) <= 200);

-- A special working day is a whole working day; it has no morning/afternoon part.
ALTER TABLE public.attendance_holidays DROP CONSTRAINT IF EXISTS attendance_holidays_working_whole;
ALTER TABLE public.attendance_holidays ADD CONSTRAINT attendance_holidays_working_whole
  CHECK (type <> 'special_working' OR day_part = 'whole');

COMMENT ON COLUMN public.attendance_holidays.branch_ids IS
  'NULL or empty: every branch. Otherwise the day applies only to these branches (local holiday, branch closure).';
COMMENT ON COLUMN public.attendance_holidays.source IS
  'Where the day comes from, e.g. "Proclamation No. 1006, s. 2025".';

/** True when a holiday row applies to an employee of p_branch. */
CREATE OR REPLACE FUNCTION public.attendance_holiday_applies(p_branch_ids UUID[], p_branch UUID)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_branch_ids IS NULL OR cardinality(p_branch_ids) = 0 OR p_branch = ANY (p_branch_ids);
$$;

/** True when p_day is a whole day off for p_branch (a holiday, special day or suspension; not a special working day). */
CREATE OR REPLACE FUNCTION public.attendance_day_off_on(p_day DATE, p_branch UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.attendance_holidays h
    WHERE h.holiday_date = p_day
      AND h.day_part = 'whole'
      AND h.type <> 'special_working'
      AND public.attendance_holiday_applies(h.branch_ids, p_branch)
  );
$$;

-- Without a branch only the nationwide days count (the older callers).
CREATE OR REPLACE FUNCTION public.attendance_is_rest_day(p_day DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXTRACT(ISODOW FROM p_day) >= 6 OR public.attendance_day_off_on(p_day, NULL);
$$;

CREATE OR REPLACE FUNCTION public.attendance_is_rest_day_on(p_day DATE, p_working_days SMALLINT[], p_branch UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN p_working_days IS NULL OR cardinality(p_working_days) = 0 THEN EXTRACT(ISODOW FROM p_day) >= 6
           ELSE NOT (EXTRACT(ISODOW FROM p_day)::SMALLINT = ANY (p_working_days))
         END
      OR public.attendance_day_off_on(p_day, p_branch);
$$;

CREATE OR REPLACE FUNCTION public.attendance_is_rest_day_on(p_day DATE, p_working_days SMALLINT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.attendance_is_rest_day_on(p_day, p_working_days, NULL::UUID);
$$;

CREATE OR REPLACE FUNCTION public.attendance_is_rest_day_for(p_employee UUID, p_branch UUID, p_day DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.attendance_is_rest_day_on(
    p_day,
    (SELECT s.working_days FROM public.attendance_schedule_for(p_employee, p_branch, p_day) s),
    p_branch
  );
$$;

-- The status engine: unchanged except that the holiday and partial-suspension
-- lookups now honour the branch and skip special working days.
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
   WHERE h.holiday_date = NEW.log_date AND h.day_part IN ('am', 'pm') AND h.cutoff IS NOT NULL
     AND public.attendance_holiday_applies(h.branch_ids, NEW.branch_id);
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

  v_rest := public.attendance_is_rest_day_on(NEW.log_date, p.working_days, NEW.branch_id);
  v_holiday := public.attendance_day_off_on(NEW.log_date, NEW.branch_id);

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

-- Tenure Pay Protection: the day's category now follows the branch, and a
-- special working day is an ordinary day (absence / late categories).
CREATE OR REPLACE FUNCTION public.tenure_protection_grant_for(p_employee UUID, p_category TEXT, p_day DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila'::text))::date)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_policy public.tenure_protection_policies;
  v_branch UUID;
  v_grant UUID;
  v_covered BOOLEAN;
  v_type TEXT;
BEGIN
  SELECT branch_id INTO v_branch FROM public.profiles WHERE id = p_employee;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_policy := public.tenure_protection_policy_for(v_branch);
  IF v_policy.id IS NULL OR NOT v_policy.is_active THEN RETURN NULL; END IF;

  SELECT h.type INTO v_type
    FROM public.attendance_holidays h
   WHERE h.holiday_date = p_day
     AND h.type <> 'special_working'
     AND public.attendance_holiday_applies(h.branch_ids, v_branch);

  -- A break / holiday / suspension day is judged only by that day's category
  -- (an absence in summer is protected only when summer break is covered).
  v_covered := CASE p_category
    WHEN 'absence' THEN v_policy.cover_absence AND public.school_break_kind_on(p_day) IS NULL AND v_type IS NULL
    WHEN 'late' THEN v_policy.cover_late AND public.school_break_kind_on(p_day) IS NULL AND v_type IS NULL
    WHEN 'holiday' THEN v_policy.cover_holiday AND public.school_break_kind_on(p_day) IS NULL AND v_type IN ('holiday', 'special')
    WHEN 'suspension' THEN v_policy.cover_suspension AND public.school_break_kind_on(p_day) IS NULL AND v_type = 'suspension'
    WHEN 'summer_break' THEN v_policy.cover_summer_break AND public.school_break_kind_on(p_day) = 'summer'
    WHEN 'christmas_break' THEN v_policy.cover_christmas_break AND public.school_break_kind_on(p_day) = 'christmas'
    ELSE FALSE
  END;
  IF NOT COALESCE(v_covered, FALSE) THEN RETURN NULL; END IF;
  IF NOT public.tenure_meets_threshold(p_employee, p_day) THEN RETURN NULL; END IF;

  SELECT g.id INTO v_grant
  FROM public.tenure_protection_grants g
  WHERE g.employee_id = p_employee
    AND g.effective_from <= p_day
    AND (g.revoked_on IS NULL OR p_day < g.revoked_on)
  ORDER BY g.effective_from DESC
  LIMIT 1;
  RETURN v_grant;
END;
$function$;

-- ── 2. The 2026 proclaimed days ────────────────────────────────────────────

INSERT INTO public.attendance_holidays (holiday_date, name, type, created_by_name, source) VALUES
  ('2026-02-17', 'Chinese New Year', 'special', 'System (2026 proclamations)', 'Proclamation No. 1006, s. 2025'),
  ('2026-02-25', 'EDSA People Power Revolution Anniversary', 'special_working', 'System (2026 proclamations)', 'Proclamation No. 1006, s. 2025'),
  ('2026-03-20', 'Eid''l Fitr', 'holiday', 'System (2026 proclamations)', 'Proclamation No. 1189, s. 2026'),
  ('2026-04-04', 'Black Saturday', 'special', 'System (2026 proclamations)', 'Proclamation No. 1006, s. 2025'),
  ('2026-05-27', 'Eid''l Adha', 'holiday', 'System (2026 proclamations)', 'Proclamation No. 1264, s. 2026'),
  ('2026-11-02', 'All Souls'' Day', 'special', 'System (2026 proclamations)', 'Proclamation No. 1006, s. 2025'),
  ('2026-12-24', 'Christmas Eve', 'special', 'System (2026 proclamations)', 'Proclamation No. 1006, s. 2025')
ON CONFLICT (holiday_date) DO NOTHING;

-- The rest of 2026 is in Proclamation No. 1006 as well: record it.
UPDATE public.attendance_holidays
   SET source = 'Proclamation No. 1006, s. 2025'
 WHERE source IS NULL
   AND type IN ('holiday', 'special')
   AND holiday_date IN ('2026-01-01', '2026-04-02', '2026-04-03', '2026-04-09', '2026-05-01', '2026-06-12',
                        '2026-08-21', '2026-08-31', '2026-11-01', '2026-11-30', '2026-12-08', '2026-12-25',
                        '2026-12-30', '2026-12-31');

-- Recompute attendance for the added days that have not passed yet (an
-- untapped day becomes Holiday instead of Absent). Past days are left as they
-- are: their payroll may already be approved.
DO $$
DECLARE
  v_day DATE;
BEGIN
  FOREACH v_day IN ARRAY ARRAY['2026-11-02', '2026-12-24']::DATE[] LOOP
    IF v_day >= (NOW() AT TIME ZONE 'Asia/Manila')::DATE THEN
      PERFORM public.attendance_apply_holiday(v_day, NULL);
    END IF;
  END LOOP;
END;
$$;

-- ── 3. Holiday duty ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.holiday_duty_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date DATE NOT NULL REFERENCES public.attendance_holidays(holiday_date) ON UPDATE CASCADE ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- The employee's branch when assigned (for lists; attendance uses the log's branch).
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  shift_start TIME NOT NULL,
  shift_end TIME NOT NULL,
  required_hours NUMERIC(4, 2) NOT NULL,
  note TEXT,
  -- How the assignment was made: one employee, a whole branch or a position group.
  assigned_via TEXT NOT NULL DEFAULT 'employee',
  assigned_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by_name TEXT,
  CONSTRAINT holiday_duty_one_per_day UNIQUE (holiday_date, employee_id),
  CONSTRAINT holiday_duty_shift_order CHECK (shift_end > shift_start),
  CONSTRAINT holiday_duty_hours CHECK (required_hours > 0 AND required_hours <= 12),
  CONSTRAINT holiday_duty_note_length CHECK (note IS NULL OR char_length(note) <= 200),
  CONSTRAINT holiday_duty_via CHECK (assigned_via IN ('employee', 'branch', 'position'))
);

CREATE INDEX IF NOT EXISTS holiday_duty_assignments_employee_idx ON public.holiday_duty_assignments (employee_id, holiday_date);
CREATE INDEX IF NOT EXISTS holiday_duty_assignments_branch_idx ON public.holiday_duty_assignments (branch_id);
CREATE INDEX IF NOT EXISTS holiday_duty_assignments_assigned_by_idx ON public.holiday_duty_assignments (assigned_by);
CREATE INDEX IF NOT EXISTS holiday_duty_assignments_updated_by_idx ON public.holiday_duty_assignments (updated_by);

CREATE TABLE IF NOT EXISTS public.holiday_duty_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID,
  holiday_date DATE NOT NULL,
  employee_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  employee_name TEXT,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT holiday_duty_history_action CHECK (action IN ('assigned', 'changed', 'removed', 'work_approved', 'work_rejected'))
);

CREATE INDEX IF NOT EXISTS holiday_duty_history_day_idx ON public.holiday_duty_history (holiday_date, created_at);
CREATE INDEX IF NOT EXISTS holiday_duty_history_employee_idx ON public.holiday_duty_history (employee_id);
CREATE INDEX IF NOT EXISTS holiday_duty_history_actor_idx ON public.holiday_duty_history (actor_id);

-- ── 4. Holiday worked without an assignment: HR's decision ─────────────────

CREATE TABLE IF NOT EXISTS public.holiday_work_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date DATE NOT NULL,
  employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  log_id UUID,
  decision TEXT NOT NULL,
  note TEXT,
  decided_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_by_name TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT holiday_work_reviews_one_per_day UNIQUE (holiday_date, employee_id),
  CONSTRAINT holiday_work_reviews_decision CHECK (decision IN ('approved', 'rejected')),
  CONSTRAINT holiday_work_reviews_note_length CHECK (note IS NULL OR char_length(note) <= 200)
);

CREATE INDEX IF NOT EXISTS holiday_work_reviews_employee_idx ON public.holiday_work_reviews (employee_id);
CREATE INDEX IF NOT EXISTS holiday_work_reviews_decided_by_idx ON public.holiday_work_reviews (decided_by);

-- ── 5. Server-only, like the other attendance tables ───────────────────────

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['holiday_duty_assignments', 'holiday_duty_history', 'holiday_work_reviews'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', v_table);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table AND policyname = 'no_client_access') THEN
      EXECUTE format('CREATE POLICY no_client_access ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)', v_table);
    END IF;
  END LOOP;
END;
$$;
