-- ═══════════════════════════════════════════════════════════════════════════
-- AWOL: HR decides the separation (2026-11-24 follow-up; replaces the flow of
-- 20261124190000 where noted):
--  * Day 5, all guards pass: confirmed (pay on hold) + 1st notice, automatic (as before).
--  * NEW: no ACTIVE RFID card for the whole period: no case at all (HR's Action
--    needed lists "No active RFID card").
--  * A reply, tap or request at any time stops the automation (as before).
--  * The reply deadline passes with no response: "Ready for HR decision" (no
--    automatic 2nd notice). HR decides: "Separate" sends the notice of
--    separation, effective N days later (hr.awol_separation_days); "Close".
--  * The effective date: separated automatically (as before).
-- ═══════════════════════════════════════════════════════════════════════════

/** The employee had an ACTIVE card for the whole period (registered before it and active since). */
CREATE OR REPLACE FUNCTION public.awol_card_active_through(p_employee UUID, p_from DATE, p_through DATE)
 RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.rfid_cards k
    WHERE k.employee_id = p_employee AND k.status = 'active'
      AND (k.registered_at AT TIME ZONE 'Asia/Manila')::DATE <= p_from
      AND NOT EXISTS (SELECT 1 FROM public.rfid_card_events e WHERE e.card_id = k.id AND e.to_status <> 'active'
                       AND (e.created_at AT TIME ZONE 'Asia/Manila')::DATE BETWEEN p_from AND p_through));
$function$;
REVOKE ALL ON FUNCTION public.awol_card_active_through(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.awol_flag_candidates(p_through DATE DEFAULT (((now() AT TIME ZONE 'Asia/Manila'::TEXT))::DATE - 1))
 RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_days  INTEGER := GREATEST(1, public.hr_setting_int('awol_flag_days', 5));
  v_reply INTEGER := GREATEST(1, public.hr_setting_int('awol_reply_days', 5));
  v_on    DATE := public.awol_auto_from();
  v_today DATE := p_through + 1;
  v_count INTEGER := 0;
  r RECORD;
  v_guards JSONB;
  v_reply_by DATE;
  v_reason TEXT;
  v_case UUID;
BEGIN
  IF v_on IS NULL THEN RETURN 0; END IF;  -- off until enabled
  IF public.automation_off('awol_cases') THEN RETURN 0; END IF;
  IF public.automation_dry_run() THEN RETURN 0; END IF;
  PERFORM public.attendance_detect_data_gaps(p_through - 30, p_through);
  FOR r IN
    WITH working AS (
      SELECT l.employee_id, l.log_date, l.status, l.time_in, l.time_out,
             row_number() OVER (PARTITION BY l.employee_id ORDER BY l.log_date DESC) AS rn
      FROM public.attendance_logs l
      WHERE l.log_date BETWEEN GREATEST(p_through - 45, v_on) AND p_through
        AND l.archived_duplicate = FALSE
        AND l.status NOT IN ('Holiday', 'On Leave')
        AND public.attendance_is_working_day_for(l.employee_id, l.branch_id, l.log_date)
        AND NOT EXISTS (SELECT 1 FROM public.attendance_data_gaps g WHERE g.branch_id = l.branch_id AND g.gap_date = l.log_date)
    )
    SELECT w.employee_id, MIN(w.log_date) AS first_absent
    FROM working w
    WHERE w.rn <= v_days
    GROUP BY w.employee_id
    HAVING COUNT(*) = v_days AND bool_and(w.status = 'Absent' AND w.time_in IS NULL AND w.time_out IS NULL)
  LOOP
    -- One open case per employee; the person must exist and be an employee account at all.
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.employee_awol_cases c WHERE c.employee_id = r.employee_id AND c.stage <> 'closed');
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = r.employee_id AND p.archived = FALSE AND lower(p.role::TEXT) IN ('employee', 'accountant', 'hr'));
    -- No active RFID card for the whole period: no taps prove nothing, so no case (2026-11-24); HR's Action needed lists them.
    CONTINUE WHEN NOT public.awol_card_active_through(r.employee_id, r.first_absent, p_through);
    v_guards := public.awol_case_guards(r.employee_id, r.first_absent, p_through);
    v_reason := (SELECT string_agg(x->>'label' || ': ' || (x->>'detail'), '; ') FROM jsonb_array_elements(v_guards->'checks') x WHERE NOT (x->>'ok')::BOOLEAN);
    INSERT INTO public.employee_awol_cases (employee_id, branch_id, first_absent_on, last_present_on, stage, auto_flagged, notes, guards, automation, automation_reason, automation_changed_at, automation_changed_by_name)
    SELECT r.employee_id, p.branch_id, r.first_absent,
           (SELECT MAX(l.log_date) FROM public.attendance_logs l WHERE l.employee_id = r.employee_id AND l.log_date < r.first_absent AND l.status NOT IN ('Absent', 'Holiday', 'On Leave')),
           'flagged', TRUE,
           format('Opened by System, rule: %s scheduled working days absent with no taps and no request.', v_days),
           v_guards,
           CASE WHEN (v_guards->>'ok')::BOOLEAN THEN 'auto' ELSE 'needs_review' END,
           CASE WHEN (v_guards->>'ok')::BOOLEAN THEN NULL ELSE 'A guard failed: ' || v_reason END,
           NOW(), 'System'
    FROM public.profiles p WHERE p.id = r.employee_id
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_case;
    CONTINUE WHEN v_case IS NULL;
    v_count := v_count + 1;
    IF (v_guards->>'ok')::BOOLEAN THEN
      -- All guards pass: confirmed (pay on hold) and the 1st notice sent, by the system.
      v_reply_by := v_today + v_reply;
      PERFORM public.awol_set_status(r.employee_id, 'AWOL', v_case, v_today,
        format('by System, rule: %s scheduled working days absent with no taps and no request (since %s). Pay on hold.', v_days, to_char(r.first_absent, 'Mon DD, YYYY')));
      UPDATE public.employee_awol_cases
         SET stage = 'first_notice', confirmed_at = NOW(), confirmed_by_name = 'System',
             first_notice_sent_on = v_today, first_notice_reply_by = v_reply_by, updated_at = NOW()
       WHERE id = v_case;
      PERFORM public.awol_send_notice(v_case, 'first', v_today, v_reply_by, NULL);
      PERFORM public.automation_log('awol_cases', format('%s working days absent, all guards passed: confirmed and 1st notice sent', v_days), 'applied',
        format('%s: AWOL confirmed (pay on hold); 1st notice sent, reply by %s', (SELECT full_name FROM public.profiles pr JOIN public.employee_awol_cases c ON c.employee_id = pr.id WHERE c.id = v_case), to_char(v_reply_by, 'Mon DD, YYYY')),
        jsonb_build_object('case_id', v_case, 'first_absent_on', r.first_absent, 'guards', v_guards),
        (SELECT employee_id FROM public.employee_awol_cases WHERE id = v_case), (SELECT branch_id FROM public.employee_awol_cases WHERE id = v_case),
        'awol_case', v_case::TEXT, v_today, NULL);
    ELSE
      PERFORM public.automation_log('awol_cases', 'a guard failed: no automatic action, HR reviews', 'flag',
        format('%s: possible AWOL since %s, needs review (%s)', (SELECT full_name FROM public.profiles pr JOIN public.employee_awol_cases c ON c.employee_id = pr.id WHERE c.id = v_case), to_char(r.first_absent, 'Mon DD, YYYY'), v_reason),
        jsonb_build_object('case_id', v_case, 'guards', v_guards),
        (SELECT employee_id FROM public.employee_awol_cases WHERE id = v_case), (SELECT branch_id FROM public.employee_awol_cases WHERE id = v_case),
        'awol_case', v_case::TEXT, v_today, NULL);
    END IF;
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'awol_case_opened', CASE WHEN (v_guards->>'ok')::BOOLEAN THEN 'AWOL: confirmed and 1st notice sent by the system' ELSE 'AWOL case needs your review' END,
           CASE WHEN (v_guards->>'ok')::BOOLEAN THEN format('%s: absent since %s; pay on hold; reply by %s. Stop the automation on the case if needed.', pr.full_name, to_char(r.first_absent, 'Mon DD, YYYY'), to_char(v_reply_by, 'Mon DD, YYYY'))
                ELSE format('%s: absent since %s. Not automatic: %s', pr.full_name, to_char(r.first_absent, 'Mon DD, YYYY'), v_reason) END,
           'hr-awol'
    FROM public.employee_awol_cases c JOIN public.profiles pr ON pr.id = c.employee_id
    JOIN public.profiles h ON h.role = 'hr' AND h.archived = FALSE AND h.id <> c.employee_id
    WHERE c.id = v_case;
  END LOOP;
  RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.awol_flag_candidates(DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.awol_daily_review(p_today DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila'::TEXT))::DATE)
 RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_changed INTEGER := 0;
  c RECORD;
  v_why TEXT;
BEGIN
  IF public.awol_auto_from() IS NULL THEN RETURN 0; END IF;  -- off until enabled
  IF public.automation_off('awol_cases') THEN RETURN 0; END IF;
  IF public.automation_dry_run() THEN RETURN 0; END IF;

  -- 1. AUTOMATIC STOP: a reply, a tap, or a leave / request at any stage. HR decides; the system never judges a reply.
  FOR c IN
    SELECT a.* FROM public.employee_awol_cases a WHERE a.stage <> 'closed' AND a.automation = 'auto'
  LOOP
    v_why := CASE
      WHEN c.employee_reply IS NOT NULL THEN 'the employee replied'
      WHEN EXISTS (SELECT 1 FROM public.attendance_logs l WHERE l.employee_id = c.employee_id AND l.log_date >= c.first_absent_on
                    AND l.archived_duplicate = FALSE AND (l.time_in IS NOT NULL OR l.time_out IS NOT NULL)) THEN 'the employee tapped in'
      WHEN EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.employee_id::TEXT = c.employee_id::TEXT AND lower(r.status) NOT IN ('rejected', 'cancelled', 'denied')
                    AND (CASE WHEN r.end_date::TEXT ~ '^\d{4}-\d{2}-\d{2}$' THEN r.end_date::TEXT::DATE END) >= c.first_absent_on) THEN 'the employee filed a leave'
      WHEN EXISTS (SELECT 1 FROM public.attendance_corrections x WHERE x.employee_id = c.employee_id AND x.log_date >= c.first_absent_on AND x.status IN ('pending', 'approved')) THEN 'the employee filed an attendance correction'
      WHEN EXISTS (SELECT 1 FROM public.overtime_requests o WHERE o.employee_id = c.employee_id AND o.request_date >= c.first_absent_on AND o.status IN ('pending', 'approved')) THEN 'the employee filed a request'
      ELSE NULL END;
    CONTINUE WHEN v_why IS NULL;
    UPDATE public.employee_awol_cases SET automation = 'response', automation_reason = 'Response received: ' || v_why || '. HR decides.',
           automation_changed_at = NOW(), automation_changed_by_name = 'System', review_reason = COALESCE(review_reason, CASE WHEN v_why LIKE '%tapped%' THEN 'returned' ELSE 'leave_filed' END),
           review_flagged_at = COALESCE(review_flagged_at, NOW()), updated_at = NOW()
     WHERE id = c.id;
    PERFORM public.automation_log('awol_cases', 'a response stops the automation: HR decides', 'flag',
      format('%s: response received (%s); the automation stopped. HR decides: close, continue or separate.', (SELECT full_name FROM public.profiles WHERE id = c.employee_id), v_why),
      jsonb_build_object('case_id', c.id, 'stage', c.stage, 'response', v_why), c.employee_id, c.branch_id, 'awol_case', c.id::TEXT, p_today, NULL);
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'awol_case_review', 'AWOL: response received, HR decides',
           format('%s: %s. The automation stopped; close, continue or separate.', (SELECT full_name FROM public.profiles WHERE id = c.employee_id), v_why), 'hr-awol'
    FROM public.profiles h WHERE h.role = 'hr' AND h.archived = FALSE AND h.id <> c.employee_id;
    v_changed := v_changed + 1;
  END LOOP;

  -- 2. The 1st notice's deadline passed with no response: "Ready for HR decision" (HR decides: Separate sends the
  --    notice of separation, or Close). No 2nd notice by the system (2026-11-24).
  FOR c IN
    SELECT a.* FROM public.employee_awol_cases a
    WHERE a.stage = 'first_notice' AND a.automation = 'auto' AND a.first_notice_reply_by < p_today AND a.employee_reply IS NULL
  LOOP
    UPDATE public.employee_awol_cases SET stage = 'for_decision', updated_at = NOW() WHERE id = c.id;
    PERFORM public.automation_log('awol_cases', 'no reply by the 1st notice deadline: ready for HR decision', 'flag',
      format('%s: no reply by %s; ready for your decision (Separate or Close)', (SELECT full_name FROM public.profiles WHERE id = c.employee_id), to_char(c.first_notice_reply_by, 'Mon DD, YYYY')),
      jsonb_build_object('case_id', c.id, 'reply_by', c.first_notice_reply_by), c.employee_id, c.branch_id, 'awol_case', c.id::TEXT, p_today, NULL);
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'awol_ready_for_decision', 'AWOL: ready for your decision',
           format('%s did not reply by %s. Decide: Separate (sends the notice of separation) or Close.', (SELECT full_name FROM public.profiles WHERE id = c.employee_id), to_char(c.first_notice_reply_by, 'Mon DD, YYYY')), 'hr-awol'
    FROM public.profiles h WHERE h.role = 'hr' AND h.archived = FALSE AND h.id <> c.employee_id;
    v_changed := v_changed + 1;
  END LOOP;

  -- 3. The effective date: separated, RFID card deactivated, final pay started.
  FOR c IN
    SELECT a.* FROM public.employee_awol_cases a
    WHERE a.stage = 'second_notice' AND a.automation = 'auto' AND a.separation_scheduled_on IS NOT NULL AND a.separation_scheduled_on <= p_today AND a.employee_reply IS NULL
  LOOP
    PERFORM public.awol_set_status(c.employee_id, 'Separated', c.id, c.separation_scheduled_on,
      format('by System, rule: AWOL / abandonment (absent since %s; no reply to either notice).', to_char(c.first_absent_on, 'Mon DD, YYYY')),
      jsonb_build_object('separated_on', c.separation_scheduled_on, 'separation_reason', 'AWOL / abandonment'));
    -- The card stops recording attendance (kept in the card history).
    PERFORM set_config('sacs.rfid_flow', 'on', true);
    INSERT INTO public.rfid_card_events (card_id, employee_id, branch_id, action, from_status, to_status, uid_last4, reason, actor_id, actor_name, actor_role)
    SELECT k.id, k.employee_id, k.branch_id, 'deactivated', 'active', 'inactive', k.uid_last4, 'Separated (AWOL): deactivated by System', NULL, 'System', 'system'
    FROM public.rfid_cards k WHERE k.employee_id = c.employee_id AND k.status = 'active';
    UPDATE public.rfid_cards SET status = 'inactive', status_reason = 'Separated (AWOL)', status_changed_by_name = 'System', status_changed_at = NOW()
     WHERE employee_id = c.employee_id AND status = 'active';
    UPDATE public.profiles SET rfid_uid = NULL WHERE id = c.employee_id;
    PERFORM set_config('sacs.rfid_flow', '', true);
    UPDATE public.employee_awol_cases SET stage = 'closed', outcome = 'separated', separation_effective = c.separation_scheduled_on,
           decided_at = NOW(), decided_by = NULL, decided_by_name = 'System',
           recommendation = COALESCE(recommendation, 'Abandonment: no reply to the notice to return and explain, nor to the notice of separation.'),
           updated_at = NOW()
     WHERE id = c.id;
    PERFORM public.automation_log('awol_cases', 'separation date reached with no response: separated; final pay started', 'applied',
      format('%s: separated on %s (AWOL / abandonment); card deactivated; final pay to the Accountant (30 days)', (SELECT full_name FROM public.profiles WHERE id = c.employee_id), to_char(c.separation_scheduled_on, 'Mon DD, YYYY')),
      jsonb_build_object('case_id', c.id, 'separated_on', c.separation_scheduled_on), c.employee_id, c.branch_id, 'awol_case', c.id::TEXT, p_today, NULL);
    -- Final pay: the branch Accountant computes it, HR approves (30 days, as built).
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT x.id, 'final_pay_due', 'Final pay due (separated: AWOL)',
           format('%s was separated on %s. Compute the final pay within 30 days; HR approves it.', (SELECT full_name FROM public.profiles WHERE id = c.employee_id), to_char(c.separation_scheduled_on, 'Mon DD, YYYY')),
           CASE WHEN x.role = 'hr' THEN 'hr-awol' ELSE 'ac-final-pay' END
    FROM public.profiles x
    WHERE x.archived = FALSE AND x.id <> c.employee_id AND (x.role = 'hr' OR (x.role = 'accountant' AND x.branch_id IS NOT DISTINCT FROM c.branch_id));
    v_changed := v_changed + 1;
  END LOOP;

  -- 4. Cases HR runs by hand (stopped, needs review, response): the reminders as before.
  UPDATE public.employee_awol_cases a SET reminded_at = NOW(), updated_at = NOW()
   WHERE a.automation <> 'auto' AND a.stage = 'first_notice' AND a.first_notice_reply_by < p_today AND a.employee_reply IS NULL AND a.reminded_at IS NULL;
  UPDATE public.employee_awol_cases a SET stage = 'for_decision', updated_at = NOW()
   WHERE a.automation <> 'auto' AND a.stage = 'second_notice' AND a.second_notice_reply_by < p_today;
  RETURN v_changed;
END;
$function$;
REVOKE ALL ON FUNCTION public.awol_daily_review(DATE) FROM PUBLIC, anon, authenticated;
