-- Part B, step 2 (2026-11-22): a half-day leave is a one-day leave request
-- with the half it covers (AM or PM). It counts as 0.5 day of leave
-- (src/lib/leave-requests/split.js requestDays); "with pay" uses 0.5 credit,
-- "without pay" is deducted at the half-day rate.
ALTER TABLE public.leave_requests ADD COLUMN IF NOT EXISTS half_day TEXT;
ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_half_day_check;
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_half_day_check
  CHECK (half_day IS NULL OR (half_day IN ('AM', 'PM') AND start_date = end_date));

-- "Absent (short day)": taps, but worked below the minimum (see the engine below).
ALTER TABLE public.attendance_logs DROP CONSTRAINT IF EXISTS attendance_logs_status_check;
ALTER TABLE public.attendance_logs ADD CONSTRAINT attendance_logs_status_check CHECK (status = ANY (ARRAY[
  'On Time', 'Early Bird', 'Late', 'Undertime', 'Half Day', 'Absent', 'Absent (short day)', 'Incomplete',
  'Pending Correction', 'Corrected', 'On Leave', 'Holiday']));

-- The minimum worked share of a day (% of its hours) below which a day with
-- taps is an Absent; pending the school's policy manual.
INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'requests', 'absent_below_pct', '50', 'System'
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'requests' AND c.key = 'absent_below_pct');

CREATE OR REPLACE FUNCTION public.attendance_absent_below_pct()
 RETURNS NUMERIC
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT CASE WHEN value ~ '^\d+(\.\d+)?$' AND value::NUMERIC BETWEEN 0 AND 100 THEN value::NUMERIC END
                     FROM public.system_config WHERE section = 'requests' AND key = 'absent_below_pct' LIMIT 1), 50);
$function$;
REVOKE ALL ON FUNCTION public.attendance_absent_below_pct() FROM PUBLIC, anon, authenticated;

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
  v_leave_half TEXT;
  v_mid INTEGER;
  v_min_pct NUMERIC := public.attendance_absent_below_pct();
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

  -- An approved half-day leave (2026-11-22): the day's work is the other half
  -- (AM leave: work starts at mid-shift; PM leave: it ends there).
  IF v_part IS NULL THEN
    SELECT lr.half_day INTO v_leave_half
      FROM public.leave_requests lr
     WHERE lr.employee_id::TEXT = NEW.employee_id::TEXT
       AND lower(COALESCE(lr.status, '')) = 'approved'
       AND lr.half_day IN ('AM', 'PM')
       AND public.attendance_leave_date(lr.start_date) = NEW.log_date
     LIMIT 1;
    IF v_leave_half IS NOT NULL AND p.work_end > p.work_start THEN
      v_mid := p.work_start + (p.work_end - p.work_start) / 2;
      p.work_hours := p.work_hours / 2.0;
      IF v_leave_half = 'AM' THEN p.work_start := v_mid; ELSE p.work_end := v_mid; END IF;
      NEW.shift_start_minutes := p.work_start;
      NEW.shift_end_minutes := p.work_end;
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

      -- No "Half Day" without a half-day leave request (2026-11-22): worked
      -- below the minimum (setting requests.absent_below_pct, % of the day's
      -- hours) is "Absent (short day)" for HR follow-up. Pay is deducted only
      -- for the time NOT worked: undertime_minutes holds the day's hours less
      -- the hours worked (never a full day for a day with taps).
      IF v_worked < p.work_hours * v_min_pct / 100.0 THEN
        v_status := 'Absent (short day)';
        v_late := 0;
        v_under := GREATEST(0, ROUND((p.work_hours - v_worked) * 60))::INTEGER;
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

CREATE OR REPLACE FUNCTION public.attendance_sync_leave(p_leave_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- A half-day leave (2026-11-22) writes no On Leave day: the day keeps its
  -- own record (taps, or the nightly Absent), recomputed against the half
  -- shift (attendance_logs_compute_status) whenever the request changes.
  IF r.half_day IS NOT NULL THEN
    UPDATE public.attendance_logs l
    SET status_computed_at = NOW()
    WHERE l.employee_id::TEXT = r.employee_id::TEXT
      AND l.archived_duplicate = FALSE
      AND l.log_date = public.attendance_leave_date(r.start_date);
    RETURN jsonb_build_object('leave_id', r.id, 'marked', 0, 'removed', 0, 'conflicts', '[]'::JSONB, 'half_day', r.half_day);
  END IF;

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
$function$;

CREATE OR REPLACE FUNCTION public.attendance_approved_leave(p_employee_id uuid, p_day date)
 RETURNS TABLE(id text, leave_type text, pay_status text, start_date text, end_date text, decided_by_name text, decided_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT lr.id, lr.leave_type, lr.pay_status, lr.start_date,
         COALESCE(NULLIF(lr.end_date, ''), lr.start_date), lr.decided_by_name, lr.decided_at
  FROM public.leave_requests lr
  WHERE lr.employee_id = p_employee_id
    AND lower(lr.status) = 'approved'
    AND lr.half_day IS NULL -- a half day keeps its taps (2026-11-22)
    AND p_day BETWEEN public.attendance_leave_date(lr.start_date)
                  AND public.attendance_leave_date(COALESCE(NULLIF(lr.end_date, ''), lr.start_date))
  ORDER BY lr.decided_at DESC NULLS LAST
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.awol_flag_candidates(p_through date DEFAULT (((now() AT TIME ZONE 'Asia/Manila'::text))::date - 1))
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_days  INTEGER := GREATEST(1, COALESCE((
            SELECT NULLIF(value, '')::INTEGER FROM public.system_config
            WHERE section = 'hr' AND key = 'awol_flag_days'), 3));
  v_count INTEGER;
BEGIN
  WITH working AS (
    SELECT l.employee_id, l.log_date, l.status, l.time_in,
           row_number() OVER (PARTITION BY l.employee_id ORDER BY l.log_date DESC) AS rn
    FROM public.attendance_logs l
    WHERE l.log_date BETWEEN p_through - 30 AND p_through
      AND NOT public.attendance_is_rest_day(l.log_date)
  ), streaks AS (
    SELECT w.employee_id, MIN(w.log_date) AS first_absent
    FROM working w
    WHERE w.rn <= v_days
    GROUP BY w.employee_id
    HAVING COUNT(*) = v_days AND bool_and(w.status = 'Absent' AND w.time_in IS NULL) -- a short day with taps is not a no-show
  ), opened AS (
    INSERT INTO public.employee_awol_cases (employee_id, branch_id, first_absent_on, last_present_on)
    SELECT s.employee_id, p.branch_id, s.first_absent,
           (SELECT MAX(l.log_date) FROM public.attendance_logs l
            WHERE l.employee_id = s.employee_id AND l.log_date < s.first_absent
              AND l.status NOT IN ('Absent', 'Holiday', 'On Leave'))
    FROM streaks s
    JOIN public.profiles p ON p.id = s.employee_id
    WHERE p.archived = FALSE
      AND p.on_payroll
      AND COALESCE(p.employee_status, 'Active') = 'Active'
      -- leave_requests.employee_id is UUID and its dates are TEXT on live:
      -- compare as text / cast only well-formed dates, never fail the job.
      AND NOT EXISTS (
        SELECT 1 FROM public.leave_requests r
        WHERE r.employee_id::TEXT = s.employee_id::TEXT
          AND lower(r.status) NOT IN ('rejected', 'cancelled', 'denied')
          AND (CASE WHEN r.start_date::TEXT ~ '^\d{4}-\d{2}-\d{2}$' THEN r.start_date::TEXT::DATE END) <= p_through
          AND (CASE WHEN r.end_date::TEXT ~ '^\d{4}-\d{2}-\d{2}$' THEN r.end_date::TEXT::DATE END) >= s.first_absent)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM opened;
  RETURN v_count;
END;
$function$;

-- The sync also runs when the half changes.
DROP TRIGGER IF EXISTS leave_requests_sync_attendance ON public.leave_requests;
CREATE TRIGGER leave_requests_sync_attendance AFTER INSERT OR UPDATE OF status, start_date, end_date, employee_id, half_day
  ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION public.leave_requests_sync_attendance();
