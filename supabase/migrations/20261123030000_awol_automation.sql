-- ═══════════════════════════════════════════════════════════════════════════
-- Part D (2026-11-22): AWOL automation. Additive (a new table, new columns,
-- new settings; awol_flag_candidates replaced; one new daily job).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Daily, after attendance closes:
--   1. Data-gap guard (attendance_detect_data_gaps): a day on which a share of
--      a branch's scheduled people (setting hr.awol_gap_pct, default 50%) has
--      no taps is a possible device / data problem: recorded once, HR told,
--      and that branch-day never counts toward AWOL.
--   2. Detection (awol_flag_candidates): N consecutive scheduled working days
--      absent with no tap (hr.awol_flag_days, default 3), on each employee's
--      OWN schedule (rest days, holidays, On Leave and gap days left out), no
--      approved or pending leave (half days too). The case opens "flagged"
--      with the 1st notice PREPARED (a PDF from the editable template
--      hr.awol_first_notice_template); HR is told, reviews it and sends it
--      with one click (user decision 2026-11-22). The deadlines start when HR
--      sends it (reply by + hr.awol_reply_days, default 5).
--   3. Review (awol_daily_review): a return (a tap) or a leave filed marks the
--      case for HR review; after the 1st notice's deadline HR is reminded to
--      send the 2nd; after the 2nd notice's deadline the case is "Ready for HR
--      decision" (for_decision). Separation is NEVER automatic.

-- OFF until enabled (user decision 2026-11-23): hr.awol_auto_from is empty, so
-- detection, the device check and the daily review do nothing, and both jobs
-- (the existing awol-flag-candidates and the new awol-daily-review) are
-- INACTIVE. public.awol_automation_enable() sets the date (today) and turns the
-- jobs on; only absences ON or AFTER that date ever count.

ALTER TABLE public.employee_awol_cases ADD COLUMN IF NOT EXISTS auto_flagged BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.employee_awol_cases ADD COLUMN IF NOT EXISTS review_reason TEXT;
ALTER TABLE public.employee_awol_cases ADD COLUMN IF NOT EXISTS review_flagged_at TIMESTAMPTZ;
ALTER TABLE public.employee_awol_cases ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.attendance_data_gaps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   UUID NOT NULL REFERENCES public.branches(id),
  gap_date    DATE NOT NULL,
  scheduled   INTEGER NOT NULL,
  no_taps     INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_id, gap_date)
);
ALTER TABLE public.attendance_data_gaps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_data_gaps FROM anon, authenticated;

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'hr', v.key, v.value, 'System'
FROM (VALUES
  ('awol_auto_from', ''),
  ('awol_gap_pct', '50'),
  ('awol_reply_days', '5'),
  ('awol_first_notice_template', E'NOTICE TO RETURN TO WORK AND EXPLAIN\n\nDate: {today}\nTo: {employee_name} ({employee_code}), {branch}\n\nOur records show that you have not reported for work since {first_absent_on}, without an approved or pending leave.\n\nPlease report back to work, or explain your absence in writing, on or before {reply_by}.\n\nThis notice is part of due process. No decision has been made; the school will consider your reply.\n\nHuman Resources')
) v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'hr' AND c.key = v.key);

CREATE OR REPLACE FUNCTION public.hr_setting_int(p_key TEXT, p_default INTEGER)
 RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT CASE WHEN value ~ '^\d{1,4}$' THEN value::INTEGER END FROM public.system_config WHERE section = 'hr' AND key = p_key LIMIT 1), p_default);
$function$;
REVOKE ALL ON FUNCTION public.hr_setting_int(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

/** The date AWOL automation counts from (hr.awol_auto_from), or NULL while it is off. */
CREATE OR REPLACE FUNCTION public.awol_auto_from()
 RETURNS DATE LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN value ~ '^\d{4}-\d{2}-\d{2}$' THEN value::DATE END
  FROM public.system_config WHERE section = 'hr' AND key = 'awol_auto_from' LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.awol_auto_from() FROM PUBLIC, anon, authenticated;

/** A scheduled working day for this employee (own schedule; not a holiday or day off). */
CREATE OR REPLACE FUNCTION public.attendance_is_working_day_for(p_employee UUID, p_branch UUID, p_day DATE)
 RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT NOT public.attendance_is_rest_day_on(p_day, s.working_days, p_branch) AND NOT public.attendance_day_off_on(p_day, p_branch)
  FROM public.attendance_schedule_for(p_employee, p_branch, p_day) s;
$function$;
REVOKE ALL ON FUNCTION public.attendance_is_working_day_for(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.attendance_detect_data_gaps(p_from DATE, p_to DATE)
 RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_pct INTEGER := public.hr_setting_int('awol_gap_pct', 50);
  v_new INTEGER;
  v_on  DATE := public.awol_auto_from();
BEGIN
  IF v_on IS NULL THEN RETURN 0; END IF;  -- off
  p_from := GREATEST(p_from, v_on);       -- never days before it was enabled
  WITH day_rows AS (
    SELECT l.branch_id, l.log_date, l.employee_id, (l.time_in IS NULL AND l.time_out IS NULL) AS no_tap
    FROM public.attendance_logs l
    JOIN public.profiles p ON p.id = l.employee_id
    WHERE l.log_date BETWEEN p_from AND p_to AND l.archived_duplicate = FALSE AND l.branch_id IS NOT NULL
      AND l.status NOT IN ('Holiday', 'On Leave')
      AND p.archived = FALSE AND p.on_payroll
      -- Admin / Super Admin are never on payroll here, whatever the flag says (user decision 2026-11-22)
      AND lower(p.role::TEXT) IN ('employee', 'accountant', 'hr')
      AND public.attendance_is_working_day_for(l.employee_id, l.branch_id, l.log_date)
  ), per_day AS (
    SELECT branch_id, log_date, COUNT(DISTINCT employee_id) AS scheduled, COUNT(DISTINCT employee_id) FILTER (WHERE no_tap) AS no_taps
    FROM day_rows GROUP BY branch_id, log_date
  ), inserted AS (
    INSERT INTO public.attendance_data_gaps (branch_id, gap_date, scheduled, no_taps)
    SELECT branch_id, log_date, scheduled, no_taps FROM per_day
    WHERE scheduled >= 2 AND no_taps * 100 >= v_pct * scheduled
    ON CONFLICT (branch_id, gap_date) DO NOTHING
    RETURNING branch_id, gap_date, scheduled, no_taps
  ), told AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'attendance_data_gap', 'Possible device or data problem',
           format('%s of %s scheduled people in %s have no taps on %s. No AWOL case counts that day; check the RFID terminal and the records.',
                  i.no_taps, i.scheduled, COALESCE(b.name, 'a branch'), to_char(i.gap_date, 'Mon DD, YYYY')),
           'hr-attendance'
    FROM inserted i
    LEFT JOIN public.branches b ON b.id = i.branch_id
    JOIN public.profiles h ON h.role = 'hr' AND h.archived = FALSE
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_new FROM inserted;
  RETURN v_new;
END;
$function$;
REVOKE ALL ON FUNCTION public.attendance_detect_data_gaps(DATE, DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.awol_flag_candidates(p_through DATE DEFAULT (((now() AT TIME ZONE 'Asia/Manila'::text))::date - 1))
 RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_days  INTEGER := GREATEST(1, public.hr_setting_int('awol_flag_days', 3));
  v_count INTEGER;
  v_on    DATE := public.awol_auto_from();
BEGIN
  IF v_on IS NULL THEN RETURN 0; END IF;  -- off until enabled
  PERFORM public.attendance_detect_data_gaps(p_through - 30, p_through);
  WITH working AS (
    SELECT l.employee_id, l.branch_id, l.log_date, l.status, l.time_in, l.time_out,
           row_number() OVER (PARTITION BY l.employee_id ORDER BY l.log_date DESC) AS rn
    FROM public.attendance_logs l
    WHERE l.log_date BETWEEN GREATEST(p_through - 30, v_on) AND p_through  -- only absences on or after the enable date
      AND l.archived_duplicate = FALSE
      AND l.status NOT IN ('Holiday', 'On Leave')
      -- the employee's own schedule: rest days and days off never count
      AND public.attendance_is_working_day_for(l.employee_id, l.branch_id, l.log_date)
      -- a branch-day with a possible device / data problem never counts
      AND NOT EXISTS (SELECT 1 FROM public.attendance_data_gaps g WHERE g.branch_id = l.branch_id AND g.gap_date = l.log_date)
  ), streaks AS (
    SELECT w.employee_id, MIN(w.log_date) AS first_absent
    FROM working w
    WHERE w.rn <= v_days
    GROUP BY w.employee_id
    HAVING COUNT(*) = v_days AND bool_and(w.status = 'Absent' AND w.time_in IS NULL AND w.time_out IS NULL)
  ), opened AS (
    INSERT INTO public.employee_awol_cases (employee_id, branch_id, first_absent_on, last_present_on, stage, auto_flagged, notes)
    SELECT s.employee_id, p.branch_id, s.first_absent,
           (SELECT MAX(l.log_date) FROM public.attendance_logs l
            WHERE l.employee_id = s.employee_id AND l.log_date < s.first_absent
              AND l.status NOT IN ('Absent', 'Holiday', 'On Leave')),
           'flagged', TRUE,
           format('Opened by System, rule: %s scheduled working days absent with no taps and no leave. 1st notice prepared for HR to review and send.', v_days)
    FROM streaks s
    JOIN public.profiles p ON p.id = s.employee_id
    WHERE p.archived = FALSE
      AND p.on_payroll
      -- Admin / Super Admin: never an AWOL case, whatever the flag says (user decision 2026-11-22)
      AND lower(p.role::TEXT) IN ('employee', 'accountant', 'hr')
      -- No branch (e.g. HR with no home branch): skipped until one is set; the device check
      -- cannot see their days (user decision 2026-11-23). HR's Action needed lists them.
      AND p.branch_id IS NOT NULL
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
    RETURNING id, employee_id, first_absent_on
  ), told AS (
    -- HR only: the employee hears when HR sends the notice.
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'awol_case_opened', 'AWOL case opened by the system',
           format('%s: absent since %s. The 1st notice is prepared: review it and send it.', COALESCE(p.full_name, 'An employee'), to_char(o.first_absent_on, 'Mon DD, YYYY')),
           'hr-awol'
    FROM opened o
    JOIN public.profiles p ON p.id = o.employee_id
    JOIN public.profiles h ON h.role = 'hr' AND h.archived = FALSE
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM opened;
  RETURN v_count;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.awol_flag_candidates(DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.awol_daily_review(p_today DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::DATE))
 RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_changed INTEGER := 0;
  v_n INTEGER;
BEGIN
  IF public.awol_auto_from() IS NULL THEN RETURN 0; END IF;  -- off until enabled
  -- A return (any tap after the first absent day) or a leave filed: marked for HR review, once.
  WITH marked AS (
    UPDATE public.employee_awol_cases c
    SET review_reason = CASE
          WHEN EXISTS (SELECT 1 FROM public.attendance_logs l WHERE l.employee_id = c.employee_id AND l.log_date > c.first_absent_on
                        AND l.archived_duplicate = FALSE AND (l.time_in IS NOT NULL OR l.time_out IS NOT NULL)) THEN 'returned'
          ELSE 'leave_filed' END,
        review_flagged_at = NOW(), updated_at = NOW()
    WHERE c.stage <> 'closed' AND c.review_reason IS NULL
      AND (EXISTS (SELECT 1 FROM public.attendance_logs l WHERE l.employee_id = c.employee_id AND l.log_date > c.first_absent_on
                    AND l.archived_duplicate = FALSE AND (l.time_in IS NOT NULL OR l.time_out IS NOT NULL))
        OR EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.employee_id::TEXT = c.employee_id::TEXT
                    AND lower(r.status) NOT IN ('rejected', 'cancelled', 'denied')
                    AND (CASE WHEN r.end_date::TEXT ~ '^\d{4}-\d{2}-\d{2}$' THEN r.end_date::TEXT::DATE END) >= c.first_absent_on))
    RETURNING c.id, c.employee_id, c.review_reason
  ), told AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'awol_case_review', 'AWOL case needs your review',
           format('%s %s. Close the case or continue it.', COALESCE(p.full_name, 'An employee'), CASE m.review_reason WHEN 'returned' THEN 'has tapped in again' ELSE 'filed a leave covering the absence' END),
           'hr-awol'
    FROM marked m JOIN public.profiles p ON p.id = m.employee_id
    JOIN public.profiles h ON h.role = 'hr' AND h.archived = FALSE
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM marked;
  v_changed := v_changed + v_n;

  -- 1st notice's deadline passed with no reply: HR is reminded (once) to send the 2nd notice.
  WITH due AS (
    UPDATE public.employee_awol_cases c SET reminded_at = NOW(), updated_at = NOW()
    WHERE c.stage = 'first_notice' AND c.first_notice_reply_by < p_today AND c.employee_reply IS NULL AND c.reminded_at IS NULL AND c.review_reason IS NULL
    RETURNING c.id, c.employee_id
  ), told AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'awol_reply_overdue', 'AWOL: reply deadline passed',
           format('%s has not replied to the 1st notice. Send the 2nd notice (two-notice rule) or close the case.', COALESCE(p.full_name, 'An employee')), 'hr-awol'
    FROM due d JOIN public.profiles p ON p.id = d.employee_id
    JOIN public.profiles h ON h.role = 'hr' AND h.archived = FALSE
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM due;
  v_changed := v_changed + v_n;

  -- 2nd notice's deadline passed: "Ready for HR decision" (HR decides; never automatic).
  WITH ready AS (
    UPDATE public.employee_awol_cases c SET stage = 'for_decision', updated_at = NOW()
    WHERE c.stage = 'second_notice' AND c.second_notice_reply_by < p_today AND c.review_reason IS NULL
    RETURNING c.id, c.employee_id
  ), told AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'awol_ready_for_decision', 'AWOL case ready for your decision',
           format('%s: both notices served and the reply period is over. Review the timeline and decide.', COALESCE(p.full_name, 'An employee')), 'hr-awol'
    FROM ready r JOIN public.profiles p ON p.id = r.employee_id
    JOIN public.profiles h ON h.role = 'hr' AND h.archived = FALSE
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM ready;
  RETURN v_changed + v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public.awol_daily_review(DATE) FROM PUBLIC, anon, authenticated;

-- Daily, after the detection (awol-flag-candidates runs at 16:20 UTC = 00:20 Manila).
-- Both jobs INACTIVE until public.awol_automation_enable() (user decision 2026-11-23).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('awol-daily-review', '25 16 * * *', 'SELECT public.awol_daily_review();');
    PERFORM cron.alter_job(j.jobid, active := FALSE) FROM cron.job j WHERE j.jobname IN ('awol-daily-review', 'awol-flag-candidates');
  END IF;
END $$;

/**
 * Turn AWOL automation on (the user runs it, after the dry run): absences count
 * from p_from (default today, Manila) onward, never earlier; both jobs active.
 */
CREATE OR REPLACE FUNCTION public.awol_automation_enable(p_from DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::DATE))
 RETURNS DATE LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF p_from < (now() AT TIME ZONE 'Asia/Manila')::DATE THEN
    RAISE EXCEPTION 'AWOL automation never counts days before it is enabled: % is in the past.', p_from;
  END IF;
  UPDATE public.system_config SET value = p_from::TEXT, updated_by = 'System' WHERE section = 'hr' AND key = 'awol_auto_from';
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.alter_job(j.jobid, active := TRUE) FROM cron.job j WHERE j.jobname IN ('awol-daily-review', 'awol-flag-candidates');
  END IF;
  INSERT INTO public.audit_logs (module, action, entity_type, entity_id, description, status, source, metadata, is_system_event, actor_name, actor_role)
  VALUES ('hr', 'awol_automation_enable', 'system_config', 'hr.awol_auto_from',
          format('AWOL automation enabled: absences count from %s.', p_from), 'success', 'system', jsonb_build_object('from', p_from), TRUE, 'System', 'system');
  RETURN p_from;
END;
$function$;
REVOKE ALL ON FUNCTION public.awol_automation_enable(DATE) FROM PUBLIC, anon, authenticated;

-- The backup lists the new table.
CREATE OR REPLACE FUNCTION public.backup_export_tables()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    -- users, employees, branches, roles
    'profiles', 'branches', 'role_permissions', 'employee_branch_assignments', 'branch_admin_requests',
    'employee_salary_changes', 'employee_status_changes', 'employee_awol_cases',
    'employee_license_changes', 'employee_license_alerts', 'employee_license_documents',
    'tenure_protection_policies', 'tenure_protection_grants', 'tenure_protection_applications',
    'rfid_cards', 'rfid_card_events', 'rfid_terminals', 'transfer_requests',
    -- the positions list (20261109050000), added to the backup 2026-11-15
    'employee_positions',
    -- Part A (20261121010000): classification history, HR reminders, leave and pay rules
    'employee_classification_changes', 'employee_hr_reminders', 'leave_credit_rules', 'leave_credit_overrides',
    'statutory_leave_types', 'employee_pay_rules',
    'work_schedules', 'work_schedule_assignments',
    -- attendance
    'attendance_logs', 'attendance_logs_history', 'attendance_corrections', 'attendance_overtime_approvals',
    'attendance_blocked_taps', 'attendance_taps', 'attendance_holidays', 'school_break_periods',
    'holiday_duty_assignments', 'holiday_duty_history', 'holiday_work_reviews', 'early_bird_winners',
    -- possible device / data problem days (Part D, 20261123030000)
    'attendance_data_gaps',
    -- leave
    'leave_requests',
    -- overtime requests (Part B, 20261122010000)
    'overtime_requests',
    -- substitute teaching (Part C, 20261123020000)
    'substitutions',
    -- payroll
    'payroll_entries', 'payroll_records', 'payroll_runs', 'payroll_run_items', 'payroll_run_exclusions',
    'payroll_approval_history', 'payroll_corrections', 'payroll_final_overrides', 'payroll_review_flags',
    'payroll_tax_annualizations', 'payroll_bir_exports',
    -- final pay waiting for HR (20261120010000), added to the backup 2026-11-21
    'payroll_final_pay_submissions',
    -- loans, advances, incentives, subsidy, 13th month
    'payroll_loans', 'payroll_loan_payments', 'payroll_cash_advances', 'payroll_incentives',
    'payroll_monthly_incentives', 'payroll_deductions', 'payroll_contribution_amounts',
    'payroll_subsidy_requests', 'payroll_subsidy_adjustments', 'payroll_subsidy_balances',
    'payroll_subsidy_settings', 'payroll_thirteenth_month',
    -- preset remarks for decisions (Part H, 20261122030000)
    'remark_presets',
    -- rates and settings
    'payroll_rate_configs', 'payroll_tax_brackets', 'payroll_sss_msc_brackets', 'payroll_schedule_settings',
    'payroll_setting_changes', 'payroll_window_enforcement', 'payroll_window_enforcement_changes', 'system_config',
    -- announcements, audit
    'branch_announcements', 'audit_logs'
  ]::text[];
$function$;
