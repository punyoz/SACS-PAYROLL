-- Holiday calendar: yearly generation, class suspensions, and the Holiday status.
--
-- 1. attendance_seed_holidays(year) adds a year's holidays that are fixed by
--    law or can be computed: New Year's Day, Holy Week (Maundy Thursday,
--    Good Friday, Black Saturday, from the date of Easter), Araw ng
--    Kagitingan, Labor Day, Independence Day, Ninoy Aquino Day, National
--    Heroes Day (last Monday of August), All Saints' Day, Bonifacio Day,
--    Immaculate Conception, Christmas Day, Rizal Day and the Last Day of the
--    Year. A pg_cron job runs it every December 1 for the next year. The days
--    proclaimed each year (Eid'l Fitr, Eid'l Adha, Chinese New Year, All
--    Souls' Day, Christmas Eve, declared days) are still added by hand in
--    Super Admin -> System Configuration -> Holidays.
--
-- 2. Class suspensions (type "suspension"): a typhoon or LGU-declared day.
--    A whole-day suspension is a day off like a holiday, with no premium for
--    working it. A morning or afternoon suspension (day_part "am" / "pm",
--    with the cutoff time) stays a working day, on a shorter schedule: "pm"
--    means work ends at the cutoff, "am" that it starts at the cutoff, so
--    leaving at a 12:00 suspension is not undertime.
--
-- 3. The Holiday status: a day with no tap on a holiday or whole-day
--    suspension reads "Holiday", not "Absent". attendance_apply_holiday(day)
--    recomputes a day's records when a holiday or suspension is added or
--    removed after the nightly close already judged it.
--
-- Also corrects 2027's Maundy Thursday and Good Friday, seeded as April 1-2:
-- Easter 2027 is March 28, so they are March 25-26.
--
-- Safe to run more than once.

-- ── 1. Columns ─────────────────────────────────────────────────────────────

ALTER TABLE public.attendance_holidays DROP CONSTRAINT IF EXISTS attendance_holidays_type_check;
ALTER TABLE public.attendance_holidays ADD CONSTRAINT attendance_holidays_type_check
  CHECK (type IN ('holiday', 'special', 'suspension'));

ALTER TABLE public.attendance_holidays ADD COLUMN IF NOT EXISTS day_part TEXT NOT NULL DEFAULT 'whole';
ALTER TABLE public.attendance_holidays ADD COLUMN IF NOT EXISTS cutoff TIME;

ALTER TABLE public.attendance_holidays DROP CONSTRAINT IF EXISTS attendance_holidays_day_part_check;
ALTER TABLE public.attendance_holidays ADD CONSTRAINT attendance_holidays_day_part_check CHECK (
  day_part IN ('whole', 'am', 'pm')
  AND (day_part = 'whole' OR (type = 'suspension' AND cutoff IS NOT NULL))
);

ALTER TABLE public.attendance_logs DROP CONSTRAINT IF EXISTS attendance_logs_status_check;
ALTER TABLE public.attendance_logs ADD CONSTRAINT attendance_logs_status_check CHECK (status IN (
  'On Time', 'Early Bird', 'Late', 'Undertime', 'Half Day', 'Absent', 'Incomplete',
  'Pending Correction', 'Corrected', 'On Leave', 'Holiday'
));

-- ── 2. Rest days: only a whole-day holiday or suspension is one ────────────

CREATE OR REPLACE FUNCTION public.attendance_is_rest_day(p_day DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXTRACT(ISODOW FROM p_day) >= 6
      OR EXISTS (
        SELECT 1 FROM public.attendance_holidays h
        WHERE h.holiday_date = p_day AND h.day_part = 'whole'
      );
$$;

-- ── 3. Status engine: partial suspensions and the Holiday status ───────────

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
BEGIN
  SELECT * INTO p FROM public.attendance_policy_for(NEW.branch_id);
  NEW.schedule_id := p.schedule_id;

  -- A morning / afternoon suspension: the day's schedule ends (pm) or starts
  -- (am) at the cutoff, and the required hours shrink in proportion.
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

  v_rest := public.attendance_is_rest_day(NEW.log_date);
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
$function$;

-- ── 4. Re-mark a day's records after a holiday is added or removed ─────────

CREATE OR REPLACE FUNCTION public.attendance_apply_holiday(p_day DATE, p_actor UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  PERFORM set_config('app.change_source', 'holiday', true);
  PERFORM set_config('app.actor_id', COALESCE(p_actor::TEXT, ''), true);
  -- Every record of the day is recomputed by the status engine, as the
  -- nightly close does: an untapped day becomes Holiday (or Absent again),
  -- and a tapped one is judged on the day's new schedule (a partial
  -- suspension). A corrected or pending day keeps its status.
  UPDATE public.attendance_logs
     SET status_computed_at = NOW()
   WHERE log_date = p_day
     AND archived_duplicate = FALSE;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── 5. A year's holidays fixed by law or computed ─────────────────────────

CREATE OR REPLACE FUNCTION public.attendance_seed_holidays(
  p_year INTEGER,
  p_created_by_name TEXT DEFAULT 'System (yearly calendar)'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  y_a INTEGER; y_b INTEGER; y_c INTEGER; y_d INTEGER; y_e INTEGER; y_f INTEGER;
  y_g INTEGER; y_h INTEGER; y_i INTEGER; y_k INTEGER; y_l INTEGER; y_m INTEGER;
  v_easter DATE;
  v_heroes DATE;
  v_aug31 DATE;
  v_count INTEGER := 0;
BEGIN
  IF p_year IS NULL OR p_year < 2000 OR p_year > 2100 THEN
    RAISE EXCEPTION 'Year must be between 2000 and 2100.';
  END IF;

  -- Easter Sunday (anonymous Gregorian algorithm).
  y_a := p_year % 19;
  y_b := p_year / 100;
  y_c := p_year % 100;
  y_d := y_b / 4;
  y_e := y_b % 4;
  y_f := (y_b + 8) / 25;
  y_g := (y_b - y_f + 1) / 3;
  y_h := (19 * y_a + y_b - y_d - y_g + 15) % 30;
  y_i := y_c / 4;
  y_k := y_c % 4;
  y_l := (32 + 2 * y_e + 2 * y_i - y_h - y_k) % 7;
  y_m := (y_a + 11 * y_h + 22 * y_l) / 451;
  v_easter := make_date(p_year, (y_h + y_l - 7 * y_m + 114) / 31, ((y_h + y_l - 7 * y_m + 114) % 31) + 1);

  -- National Heroes Day: the last Monday of August.
  v_aug31 := make_date(p_year, 8, 31);
  v_heroes := v_aug31 - (EXTRACT(ISODOW FROM v_aug31)::INTEGER - 1);

  INSERT INTO public.attendance_holidays (holiday_date, name, type, created_by_name)
  SELECT d.holiday_date, d.holiday_name, d.holiday_type, p_created_by_name
  FROM (VALUES
    (make_date(p_year, 1, 1),   'New Year''s Day',                    'holiday'),
    (v_easter - 3,              'Maundy Thursday',                    'holiday'),
    (v_easter - 2,              'Good Friday',                        'holiday'),
    (v_easter - 1,              'Black Saturday',                     'special'),
    (make_date(p_year, 4, 9),   'Araw ng Kagitingan',                 'holiday'),
    (make_date(p_year, 5, 1),   'Labor Day',                          'holiday'),
    (make_date(p_year, 6, 12),  'Independence Day',                   'holiday'),
    (make_date(p_year, 8, 21),  'Ninoy Aquino Day',                   'special'),
    (v_heroes,                  'National Heroes Day',                'holiday'),
    (make_date(p_year, 11, 1),  'All Saints'' Day',                   'special'),
    (make_date(p_year, 11, 30), 'Bonifacio Day',                      'holiday'),
    (make_date(p_year, 12, 8),  'Feast of the Immaculate Conception', 'special'),
    (make_date(p_year, 12, 25), 'Christmas Day',                      'holiday'),
    (make_date(p_year, 12, 30), 'Rizal Day',                          'holiday'),
    (make_date(p_year, 12, 31), 'Last Day of the Year',               'special')
  ) AS d(holiday_date, holiday_name, holiday_type)
  ON CONFLICT (holiday_date) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_apply_holiday(DATE, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_seed_holidays(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_apply_holiday(DATE, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_seed_holidays(INTEGER, TEXT) TO service_role;

-- ── 6. Corrections and next year's calendar ───────────────────────────────

-- Easter 2027 is March 28: Holy Week was seeded a week late.
UPDATE public.attendance_holidays SET holiday_date = DATE '2027-03-25'
 WHERE holiday_date = DATE '2027-04-01' AND name = 'Maundy Thursday'
   AND NOT EXISTS (SELECT 1 FROM public.attendance_holidays WHERE holiday_date = DATE '2027-03-25');
UPDATE public.attendance_holidays SET holiday_date = DATE '2027-03-26'
 WHERE holiday_date = DATE '2027-04-02' AND name = 'Good Friday'
   AND NOT EXISTS (SELECT 1 FROM public.attendance_holidays WHERE holiday_date = DATE '2027-03-26');

SELECT public.attendance_seed_holidays(2027);

-- Every December 1, 00:10 Asia/Manila (November 30, 16:10 UTC), next year.
SELECT cron.schedule(
  'holiday-calendar-next-year',
  '10 16 30 11 *',
  $$SELECT public.attendance_seed_holidays(EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Asia/Manila')::INTEGER + 1);$$
);
