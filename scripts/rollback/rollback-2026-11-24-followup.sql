-- Rollback for the follow-up release 2026-11-24 (migrations 20261124200000, 210000, 220000).
-- Built from live's definitions before the release (backup backups/2026-11-24_1209).
-- Restores the AWOL guard / candidate / nightly functions; removes the card check
-- function and the "Maintenance" position (only when no one holds it).
-- KEPT on purpose: the awol_replies table and the awol-replies bucket (employees'
-- replies are records; the old code simply does not read them).
-- The leave-credits pool (20261124230000) has its own rollback.
BEGIN;
CREATE OR REPLACE FUNCTION public.awol_case_guards(p_employee uuid, p_from date, p_through date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p RECORD;
  v_checks JSONB := '[]'::JSONB;
  v_ok BOOLEAN := TRUE;
  v_bad TEXT;
  v_taps INTEGER;
  v_req TEXT;
BEGIN
  SELECT id, branch_id, on_payroll, archived, is_demo, employee_status, lower(role::TEXT) AS role INTO p FROM public.profiles WHERE id = p_employee;
  IF p.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'checks', jsonb_build_array(jsonb_build_object('key', 'person', 'label', 'Employee record', 'ok', FALSE, 'detail', 'Not found')));
  END IF;
  -- 1. A home branch.
  v_checks := v_checks || jsonb_build_object('key', 'home_branch', 'label', 'Has a home branch', 'ok', p.branch_id IS NOT NULL,
    'detail', CASE WHEN p.branch_id IS NULL THEN 'No branch on the record' ELSE 'Yes' END);
  v_ok := v_ok AND p.branch_id IS NOT NULL;
  -- 2. On payroll, active, a real employee account (never a demo / test or an Admin / Super Admin account).
  v_bad := CASE WHEN NOT COALESCE(p.on_payroll, FALSE) THEN 'Not on payroll'
                WHEN p.archived THEN 'Archived'
                WHEN COALESCE(p.is_demo, FALSE) THEN 'A demo / test account'
                WHEN p.role NOT IN ('employee', 'accountant', 'hr') THEN 'Not an employee account'
                WHEN COALESCE(p.employee_status, 'Active') <> 'Active' THEN 'Status ' || p.employee_status
                ELSE NULL END;
  v_checks := v_checks || jsonb_build_object('key', 'on_payroll', 'label', 'On payroll, active, real account', 'ok', v_bad IS NULL, 'detail', COALESCE(v_bad, 'Yes'));
  v_ok := v_ok AND v_bad IS NULL;
  -- 3. Zero taps in the period.
  SELECT COUNT(*) INTO v_taps FROM public.attendance_logs l
   WHERE l.employee_id = p_employee AND l.log_date BETWEEN p_from AND p_through AND l.archived_duplicate = FALSE
     AND (l.time_in IS NOT NULL OR l.time_out IS NOT NULL);
  v_checks := v_checks || jsonb_build_object('key', 'zero_taps', 'label', 'Zero taps', 'ok', v_taps = 0, 'detail', CASE WHEN v_taps = 0 THEN 'No tap since ' || to_char(p_from, 'Mon DD') ELSE v_taps || CASE WHEN v_taps = 1 THEN ' day with taps' ELSE ' days with taps' END END);
  v_ok := v_ok AND v_taps = 0;
  -- 4. No request covering the period (leave or half day not rejected / cancelled, a correction, an overtime request).
  v_req := NULL;
  IF EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.employee_id::TEXT = p_employee::TEXT AND lower(r.status) NOT IN ('rejected', 'cancelled', 'denied')
             AND (CASE WHEN r.start_date::TEXT ~ '^\d{4}-\d{2}-\d{2}$' THEN r.start_date::TEXT::DATE END) <= p_through
             AND (CASE WHEN r.end_date::TEXT ~ '^\d{4}-\d{2}-\d{2}$' THEN r.end_date::TEXT::DATE END) >= p_from) THEN v_req := 'A leave request covers these days';
  ELSIF EXISTS (SELECT 1 FROM public.attendance_corrections c WHERE c.employee_id = p_employee AND c.status = 'pending' AND c.log_date BETWEEN p_from AND p_through) THEN v_req := 'An attendance correction is pending';
  ELSIF EXISTS (SELECT 1 FROM public.overtime_requests o WHERE o.employee_id = p_employee AND o.status IN ('pending', 'approved') AND o.request_date BETWEEN p_from AND p_through) THEN v_req := 'An overtime request covers these days';
  END IF;
  v_checks := v_checks || jsonb_build_object('key', 'no_request', 'label', 'No leave or other request', 'ok', v_req IS NULL, 'detail', COALESCE(v_req, 'None'));
  v_ok := v_ok AND v_req IS NULL;
  -- 5. The branch had normal taps every one of those days (no device / data problem).
  v_bad := NULL;
  IF p.branch_id IS NOT NULL THEN
    SELECT string_agg(to_char(d::DATE, 'Mon DD'), ', ' ORDER BY d) INTO v_bad
    FROM generate_series(p_from, p_through, INTERVAL '1 day') d
    WHERE public.attendance_is_working_day_for(p_employee, p.branch_id, d::DATE)
      AND (EXISTS (SELECT 1 FROM public.attendance_data_gaps g WHERE g.branch_id = p.branch_id AND g.gap_date = d::DATE)
        OR NOT EXISTS (SELECT 1 FROM public.attendance_logs l WHERE l.branch_id = p.branch_id AND l.log_date = d::DATE AND l.employee_id <> p_employee
                        AND l.archived_duplicate = FALSE AND l.time_in IS NOT NULL));
  ELSE
    v_bad := 'no branch';
  END IF;
  v_checks := v_checks || jsonb_build_object('key', 'branch_normal', 'label', 'Branch had normal taps', 'ok', v_bad IS NULL,
    'detail', CASE WHEN v_bad IS NULL THEN 'Yes, every day' ELSE 'No normal taps / data gap: ' || v_bad END);
  v_ok := v_ok AND v_bad IS NULL;
  RETURN jsonb_build_object('ok', v_ok, 'checks', v_checks, 'from', p_from, 'through', p_through, 'checked_at', NOW());
END;
$function$;

CREATE OR REPLACE FUNCTION public.awol_daily_review(p_today date DEFAULT ((now() AT TIME ZONE 'Asia/Manila'::text))::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed INTEGER := 0;
  v_sep_days INTEGER := GREATEST(1, public.hr_setting_int('awol_separation_days', 3));
  c RECORD;
  v_why TEXT;
  v_sep DATE;
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

  -- 2. The 1st notice's deadline passed with no response: the 2nd notice (notice of separation) is sent.
  FOR c IN
    SELECT a.* FROM public.employee_awol_cases a
    WHERE a.stage = 'first_notice' AND a.automation = 'auto' AND a.first_notice_reply_by < p_today AND a.employee_reply IS NULL
  LOOP
    v_sep := p_today + v_sep_days;
    UPDATE public.employee_awol_cases SET stage = 'second_notice', second_notice_sent_on = p_today, second_notice_reply_by = v_sep,
           separation_scheduled_on = v_sep, updated_at = NOW()
     WHERE id = c.id;
    PERFORM public.awol_send_notice(c.id, 'second', p_today, c.first_notice_reply_by, v_sep);
    PERFORM public.automation_log('awol_cases', 'no reply by the 1st notice deadline: 2nd notice (separation) sent', 'applied',
      format('%s: 2nd notice sent; separated on %s unless HR stops it or the employee responds', (SELECT full_name FROM public.profiles WHERE id = c.employee_id), to_char(v_sep, 'Mon DD, YYYY')),
      jsonb_build_object('case_id', c.id, 'reply_by', c.first_notice_reply_by, 'separation_on', v_sep), c.employee_id, c.branch_id, 'awol_case', c.id::TEXT, p_today, NULL);
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'awol_separation_scheduled', 'AWOL: separation scheduled',
           format('%s will be separated on %s unless you stop it.', (SELECT full_name FROM public.profiles WHERE id = c.employee_id), to_char(v_sep, 'Mon DD, YYYY')), 'hr-awol'
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

CREATE OR REPLACE FUNCTION public.awol_flag_candidates(p_through date DEFAULT (((now() AT TIME ZONE 'Asia/Manila'::text))::date - 1))
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
REVOKE ALL ON FUNCTION public.awol_case_guards(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.awol_flag_candidates(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.awol_daily_review(DATE) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.awol_card_active_through(UUID, DATE, DATE);
DELETE FROM public.employee_positions e WHERE e.name = 'Maintenance'
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.position = 'Maintenance');
DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('20261124200000', '20261124210000', '20261124220000');
COMMIT;
