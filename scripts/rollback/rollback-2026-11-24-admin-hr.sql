-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK for the 2026-11-24 release (migrations 20261124150000-190000).
-- Written from LIVE's own definitions (read-only) before the release. The code
-- rollback is promoting the previous Vercel deploy. Run only if the release
-- must be undone.
--  1. The 4 functions the release replaces, as live had them.
--  2. The 3 constraints the release widened, as live had them.
--  3. Substitutions: the system's unpicked proposals removed (never paid); the substitute required again.
--  4. hr.awol_flag_days back to 3; the AWOL automation paused.
-- Kept (additive, harmless to the old code): new tables (branch_item_messages,
-- awol_notices), columns, functions, presets, the bucket and history rows.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

-- 1. Functions
-- automation_log
CREATE OR REPLACE FUNCTION public.automation_log(p_module text, p_rule text, p_kind text, p_summary text, p_data jsonb DEFAULT '{}'::jsonb, p_employee uuid DEFAULT NULL::uuid, p_branch uuid DEFAULT NULL::uuid, p_entity_type text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text, p_effective_on date DEFAULT NULL::date, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Asia/Manila')::DATE;
  v_id UUID;
  v_status TEXT;
BEGIN
  IF public.automation_off(p_module) THEN RETURN NULL; END IF;
  -- A dry run counts the action and writes nothing.
  IF public.automation_dry_run() THEN RETURN gen_random_uuid(); END IF;
  v_status := CASE
    WHEN p_reason IS NOT NULL AND p_kind <> 'applied' THEN 'couldnt_decide'
    WHEN p_kind = 'applied' THEN 'done'
    WHEN p_kind = 'proposal' THEN 'admin_check'
    ELSE 'open' END;
  INSERT INTO public.automation_actions (module, rule, kind, status, summary, data, reason, entity_type, entity_id, employee_id, branch_id, effective_on, admin_due_on)
  VALUES (p_module, p_rule, p_kind, v_status, p_summary, COALESCE(p_data, '{}'::JSONB), p_reason, p_entity_type, p_entity_id, p_employee, p_branch, p_effective_on,
          CASE WHEN v_status = 'admin_check' THEN public.automation_add_working_days(v_today, public.automation_setting_int('admin_check_days', 1), p_branch) END)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (module, action, entity_type, entity_id, description, status, source, metadata, is_system_event, actor_name, actor_role)
  VALUES (p_module, 'automation_' || p_kind, COALESCE(p_entity_type, 'automation_action'), COALESCE(p_entity_id, v_id::TEXT),
          format('by System, rule: %s. %s', p_rule, p_summary), 'success', 'system',
          jsonb_build_object('automation_action_id', v_id, 'rule', p_rule, 'data', COALESCE(p_data, '{}'::JSONB), 'reason', p_reason), TRUE, 'System', 'system');
  RETURN v_id;
END;
$function$;

-- automation_daily
CREATE OR REPLACE FUNCTION public.automation_daily(p_today date DEFAULT ((now() AT TIME ZONE 'Asia/Manila'::text))::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_forwarded INTEGER := 0;
  v_escalated INTEGER := 0;
  v_digests INTEGER := 0;
  v_stale INTEGER := public.automation_setting_int('stale_days', 3);
BEGIN
  IF public.automation_paused() THEN RETURN jsonb_build_object('paused', TRUE); END IF;
  IF public.automation_dry_run() THEN
    RETURN jsonb_build_object(
      'would_forward', (SELECT COUNT(*) FROM public.automation_actions WHERE status = 'admin_check' AND admin_due_on <= p_today),
      'would_escalate', (SELECT COUNT(*) FROM public.automation_actions a WHERE a.status IN ('admin_check', 'with_hr', 'open', 'couldnt_decide') AND a.escalated_at IS NULL
        AND (public.automation_add_working_days((a.created_at AT TIME ZONE 'Asia/Manila')::DATE, v_stale, a.branch_id) <= p_today
             OR (a.effective_on IS NOT NULL AND a.effective_on < p_today))),
      'dry_run', TRUE);
  END IF;

  -- 1. No objection within the Admin's check time: to HR, by the system.
  WITH f AS (
    UPDATE public.automation_actions
    SET status = 'with_hr', forwarded_at = NOW(), forwarded_by = 'System', updated_at = NOW()
    WHERE status = 'admin_check' AND admin_due_on <= p_today
    RETURNING id, module, summary
  ), told AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'automation_forwarded', 'Prepared by the system, for your decision',
           format('%s (no objection from the branch Admin in time).', f.summary), 'hr-dashboard'
    FROM f JOIN public.profiles h ON h.role = 'hr' AND h.archived = FALSE
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_forwarded FROM f;

  -- 2. Stale: waiting more than the stale days (working days), or past its effective date. Once.
  WITH s AS (
    UPDATE public.automation_actions a
    SET escalated_at = NOW(), updated_at = NOW()
    WHERE a.status IN ('admin_check', 'with_hr', 'open', 'couldnt_decide') AND a.escalated_at IS NULL
      AND (public.automation_add_working_days((a.created_at AT TIME ZONE 'Asia/Manila')::DATE, v_stale, a.branch_id) <= p_today
           OR (a.effective_on IS NOT NULL AND a.effective_on < p_today))
    RETURNING a.id, a.summary, a.branch_id, a.effective_on
  ), told AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT r.id, 'automation_escalated', 'Waiting too long',
           format('%s%s', s.summary, CASE WHEN s.effective_on IS NOT NULL AND s.effective_on < p_today THEN format(' (effective %s has passed)', s.effective_on) ELSE '' END),
           CASE WHEN r.role = 'hr' THEN 'hr-dashboard' ELSE 'adm-dashboard' END
    FROM s JOIN public.profiles r ON r.archived = FALSE
      AND (r.role = 'hr' OR (r.role = 'admin' AND r.branch_id IS NOT DISTINCT FROM s.branch_id))
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_escalated FROM s;

  -- 3. The digest: done (since yesterday), waiting, couldn't decide. HR sees every branch; an Admin, their own.
  WITH counts AS (
    SELECT r.id AS recipient, r.role,
           COUNT(*) FILTER (WHERE a.status = 'done' AND a.created_at >= (p_today - 1)::TIMESTAMP AT TIME ZONE 'Asia/Manila') AS done,
           COUNT(*) FILTER (WHERE (r.role = 'admin' AND a.status = 'admin_check') OR (r.role = 'hr' AND a.status IN ('with_hr', 'open'))) AS waiting,
           COUNT(*) FILTER (WHERE a.status = 'couldnt_decide') AS undecided
    FROM public.profiles r
    JOIN public.automation_actions a ON (r.role = 'hr' OR a.branch_id IS NOT DISTINCT FROM r.branch_id)
    WHERE r.archived = FALSE AND r.role IN ('hr', 'admin')
    GROUP BY r.id, r.role
  ), sent AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT c.recipient, 'automation_digest', 'Automation: daily summary',
           format('%s done since yesterday · %s waiting for you · %s the system could not decide (see why on the Automation card).', c.done, c.waiting, c.undecided),
           CASE WHEN c.role = 'hr' THEN 'hr-dashboard' ELSE 'adm-dashboard' END
    FROM counts c WHERE c.done + c.waiting + c.undecided > 0
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_digests FROM sent;

  RETURN jsonb_build_object('forwarded', v_forwarded, 'escalated', v_escalated, 'digests', v_digests);
END;
$function$;

-- awol_flag_candidates
CREATE OR REPLACE FUNCTION public.awol_flag_candidates(p_through date DEFAULT (((now() AT TIME ZONE 'Asia/Manila'::text))::date - 1))
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

-- awol_daily_review
CREATE OR REPLACE FUNCTION public.awol_daily_review(p_today date DEFAULT ((now() AT TIME ZONE 'Asia/Manila'::text))::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

-- 2. Constraints
UPDATE public.remark_presets SET active = FALSE WHERE decision = 'file';
ALTER TABLE public.remark_presets DROP CONSTRAINT IF EXISTS remark_presets_decision_check;
DELETE FROM public.remark_presets WHERE decision = 'file' AND code LIKE 'file.%';
ALTER TABLE remark_presets ADD CONSTRAINT remark_presets_decision_check CHECK ((decision = ANY (ARRAY['approve'::text, 'reject'::text, 'resolve'::text, 'endorse'::text, 'object'::text, 'override'::text, 'revoke'::text])));
ALTER TABLE employee_awol_cases DROP CONSTRAINT IF EXISTS employee_awol_cases_separated_chk;
ALTER TABLE employee_awol_cases ADD CONSTRAINT employee_awol_cases_separated_chk CHECK (((outcome IS DISTINCT FROM 'separated'::text) OR ((separation_effective IS NOT NULL) AND (decided_by IS NOT NULL))));
DO $$ BEGIN PERFORM set_config('sacs.rfid_flow', 'on', true); ALTER TABLE public.rfid_card_events DISABLE TRIGGER USER; DELETE FROM public.rfid_card_events WHERE action = 'lost_report_removed'; ALTER TABLE public.rfid_card_events ENABLE TRIGGER USER; END $$;
-- (the history guard: allowed inside the RFID flow)
ALTER TABLE rfid_card_events DROP CONSTRAINT IF EXISTS rfid_card_events_action_check;
ALTER TABLE rfid_card_events ADD CONSTRAINT rfid_card_events_action_check CHECK ((action = ANY (ARRAY['registered'::text, 'replaced'::text, 'deactivated'::text, 'reactivated'::text, 'marked_lost'::text, 'imported'::text])));

-- 3. Substitutions: the system's proposals with no teacher picked were never paid; the old code cannot show them.
--    (An approved substitution always names its substitute.)
ALTER TABLE public.substitutions DISABLE TRIGGER USER;
DELETE FROM public.substitutions WHERE substitute_id IS NULL AND status <> 'approved';
ALTER TABLE public.substitutions ENABLE TRIGGER USER;
ALTER TABLE public.substitutions DROP CONSTRAINT IF EXISTS substitutions_approved_has_substitute;
DROP INDEX IF EXISTS public.substitutions_one_per_leave_day;
ALTER TABLE public.substitutions ALTER COLUMN substitute_id SET NOT NULL;

-- 4. AWOL
UPDATE public.system_config SET value = '3', updated_by = 'Rollback 2026-11-24' WHERE section = 'hr' AND key = 'awol_flag_days';
UPDATE public.system_config SET value = 'true', updated_by = 'Rollback 2026-11-24' WHERE section = 'automation' AND key = 'paused_awol_cases';

COMMIT;
