-- ════════════════════════════════════════════════════════════════════════════
-- "Not on payroll" accounts (decision 2026-11-20): system users who sign in and
-- work in the app but are not paid, not scheduled and not counted.
--
-- profiles.on_payroll (default TRUE). FALSE means:
--   * the nightly close writes no Absent records for them
--     (attendance_missing_days, also the "Absent / Not tapped yet" counts);
--   * the AWOL job opens no case for them (awol_flag_candidates);
--   * the app leaves them out of the payroll roster and the employee lists
--     (it reads user_metadata.on_payroll, set here together with the column).
--
-- Set on the three accounts kept after the demo removal: Demo Super Admin One,
-- Demo HR One and Demo Accountant One Main. Their interim "On Leave" status
-- (20:05 Manila, 2026-11-20) goes back to Active, and the automatic Absent
-- records the nightly close wrote for them meanwhile are removed.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS on_payroll BOOLEAN NOT NULL DEFAULT TRUE;
COMMENT ON COLUMN public.profiles.on_payroll IS
  'FALSE = system account: no attendance, no payroll, not in employee lists (20261120020000).';

CREATE OR REPLACE FUNCTION public.attendance_missing_days(p_from DATE, p_to DATE)
RETURNS TABLE (employee_id UUID, full_name TEXT, employee_type TEXT, branch_id UUID, day DATE)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH missing AS MATERIALIZED (
    SELECT pr.id, pr.full_name, pr.employee_type, pr.branch_id, d.day
    FROM public.profiles pr
    CROSS JOIN LATERAL (
      SELECT gs::DATE AS day FROM generate_series(p_from, p_to, INTERVAL '1 day') gs
    ) d
    WHERE lower(pr.role::TEXT) IN ('employee', 'accountant', 'hr')
      AND pr.on_payroll
      AND COALESCE(pr.archived, FALSE) = FALSE
      AND lower(COALESCE(pr.employee_status, 'active')) <> 'inactive'
      AND d.day >= COALESCE(pr.date_hired, pr.created_at::DATE)
      AND NOT (lower(COALESCE(pr.employee_status, '')) = 'separated' AND pr.separated_on IS NOT NULL AND d.day > pr.separated_on)
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_logs l
        WHERE l.employee_id = pr.id AND l.log_date = d.day AND l.archived_duplicate = FALSE
      )
  )
  SELECT m.id, m.full_name, m.employee_type, m.branch_id, m.day
  FROM missing m
  WHERE NOT EXISTS (SELECT 1 FROM public.attendance_approved_leave(m.id, m.day))
    AND NOT public.attendance_is_rest_day_for(m.id, m.branch_id, m.day);
$function$;

REVOKE ALL ON FUNCTION public.attendance_missing_days(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_missing_days(DATE, DATE) TO service_role;

CREATE OR REPLACE FUNCTION public.awol_flag_candidates(
  p_through DATE DEFAULT ((NOW() AT TIME ZONE 'Asia/Manila')::DATE - 1)
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days  INTEGER := GREATEST(1, COALESCE((
            SELECT NULLIF(value, '')::INTEGER FROM public.system_config
            WHERE section = 'hr' AND key = 'awol_flag_days'), 3));
  v_count INTEGER;
BEGIN
  WITH working AS (
    SELECT l.employee_id, l.log_date, l.status,
           row_number() OVER (PARTITION BY l.employee_id ORDER BY l.log_date DESC) AS rn
    FROM public.attendance_logs l
    WHERE l.log_date BETWEEN p_through - 30 AND p_through
      AND NOT public.attendance_is_rest_day(l.log_date)
  ), streaks AS (
    SELECT w.employee_id, MIN(w.log_date) AS first_absent
    FROM working w
    WHERE w.rn <= v_days
    GROUP BY w.employee_id
    HAVING COUNT(*) = v_days AND bool_and(w.status = 'Absent')
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
$$;

REVOKE EXECUTE ON FUNCTION public.awol_flag_candidates(DATE) FROM PUBLIC, anon, authenticated;

-- ── the three kept system accounts ───────────────────────────────────────────
DO $$
DECLARE
  v_ids UUID[] := ARRAY(SELECT id FROM public.profiles WHERE email IN (
    'ehdrefuerzo8+sa1@gmail.com', 'ehdrefuerzo8+hr1@gmail.com', 'ehdrefuerzo8+acc-b1-1@gmail.com'));
BEGIN
  IF cardinality(v_ids) = 0 THEN RETURN; END IF;  -- a database without them (e.g. a fresh local stack)

  UPDATE public.profiles SET on_payroll = FALSE, updated_at = NOW() WHERE id = ANY (v_ids);
  UPDATE auth.users SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || '{"on_payroll": false}'::jsonb
  WHERE id = ANY (v_ids);

  -- interim "On Leave" (2026-11-20) back to Active, logged like the app does
  INSERT INTO public.employee_status_changes (employee_id, old_status, new_status, effective_on, reason, changed_by, changed_by_name)
  SELECT id, employee_status, 'Active', (NOW() AT TIME ZONE 'Asia/Manila')::DATE,
         'Not on payroll now (20261120020000): interim On Leave ended', NULL, 'System'
  FROM public.profiles WHERE id = ANY (v_ids) AND employee_status = 'On Leave';
  UPDATE public.profiles SET employee_status = 'Active', updated_at = NOW() WHERE id = ANY (v_ids) AND employee_status = 'On Leave';
  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || '{"employee_status": "Active"}'::jsonb
  WHERE id = ANY (v_ids) AND raw_user_meta_data->>'employee_status' = 'On Leave';

  -- automatic Absent records the nightly close wrote for them (no tap, never edited, no leave)
  ALTER TABLE public.attendance_logs DISABLE TRIGGER attendance_logs_block_hard_delete;
  DELETE FROM public.attendance_logs
  WHERE employee_id = ANY (v_ids) AND time_in IS NULL AND time_out IS NULL
    AND status = 'Absent' AND changed_by IS NULL AND leave_request_id IS NULL;
  ALTER TABLE public.attendance_logs ENABLE TRIGGER attendance_logs_block_hard_delete;
END $$;
