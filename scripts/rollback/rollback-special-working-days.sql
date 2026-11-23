-- Rollback for 20261124130000_special_working_days.sql: attendance_schedule_for as it was
-- (20261013010000, word for word). Special working days stop affecting schedules at once;
-- the table and the line types stay (harmless). Run in one transaction.
BEGIN;
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
DROP FUNCTION IF EXISTS public.attendance_schedule_base_for(UUID, UUID, DATE);
DROP FUNCTION IF EXISTS public.special_working_day_for(UUID, UUID, DATE);
COMMIT;
