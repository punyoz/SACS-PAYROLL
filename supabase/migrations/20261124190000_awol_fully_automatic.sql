-- ═══════════════════════════════════════════════════════════════════════════
-- AWOL, fully automatic until separation (panel requirement, 2026-11-24),
-- with automatic stops. Nightly (awol-flag-candidates 00:20, awol-daily-review
-- 00:25 Manila), only while the AWOL module is on (Settings > Automation):
--
--  1. Day N (hr.awol_flag_days, default 5 consecutive scheduled working days
--     with zero taps and no approved / pending leave, half day, correction or
--     overtime request): the case opens and the GUARDS run (home branch; on
--     payroll, active, not a demo / test account; zero taps; no request; the
--     branch had normal taps every one of those days, no data gap). All pass:
--     the system confirms AWOL (status AWOL = pay on hold) and sends the 1st
--     notice (reply within hr.awol_reply_days, default 5 calendar days). Any
--     fails: nothing automatic, "Needs review" for HR with the reason.
--  2. The reply deadline passes with no reply, no tap, no request: the 2nd
--     notice (notice of separation, effective hr.awol_separation_days later,
--     default 3) is sent and HR is told "<name> will be separated on <date>
--     unless you stop it".
--  3. On that date: separated (status Separated, reason AWOL / abandonment,
--     RFID card deactivated, self-service only, pay stays on hold) and the
--     final pay process starts (the branch Accountant and HR are told).
--  STOP: a reply, a tap, or a leave / request at any stage stops the case
--  ("Response received: HR decides"). HR can stop and resume any case. The
--  system never judges a reply. Every step: "by System, rule ..." with the
--  evidence (automation_actions + audit), notices kept (awol_notices; the PDF
--  and the e-mail are delivered by the app's daily job, /api/cron/awol-notices).
--
-- Existing cases (the 4 open on live) are NEVER automatic: they are marked
-- "Needs review" here; HR decides them.
-- ═══════════════════════════════════════════════════════════════════════════

-- Settings.
UPDATE public.system_config SET value = '5', updated_by = 'System (2026-11-24: 5 working days)'
 WHERE section = 'hr' AND key = 'awol_flag_days' AND value = '3';
INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'hr', v.key, v.value, 'System'
FROM (VALUES
  ('awol_flag_days', '5'),
  ('awol_separation_days', '3'),
  ('awol_second_notice_template', E'NOTICE OF SEPARATION\n\nDate: {today}\nTo: {employee_name} ({employee_code}), {branch}\n\nYou have not reported for work since {first_absent_on}, and you did not reply to the notice to return to work and explain by {reply_by}.\n\nYou are hereby notified that your employment will end on {separation_on} for abandonment of work, unless you report back or explain your absence in writing before that date.\n\nHuman Resources')
) v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'hr' AND c.key = v.key);

-- The case's automation state.
ALTER TABLE public.employee_awol_cases ADD COLUMN IF NOT EXISTS automation TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE public.employee_awol_cases DROP CONSTRAINT IF EXISTS employee_awol_cases_automation_check;
ALTER TABLE public.employee_awol_cases ADD CONSTRAINT employee_awol_cases_automation_check
  CHECK (automation IN ('auto', 'needs_review', 'response', 'stopped'));
ALTER TABLE public.employee_awol_cases ADD COLUMN IF NOT EXISTS automation_reason TEXT;
ALTER TABLE public.employee_awol_cases ADD COLUMN IF NOT EXISTS automation_changed_at TIMESTAMPTZ;
ALTER TABLE public.employee_awol_cases ADD COLUMN IF NOT EXISTS automation_changed_by_name TEXT;
ALTER TABLE public.employee_awol_cases ADD COLUMN IF NOT EXISTS guards JSONB;
ALTER TABLE public.employee_awol_cases ADD COLUMN IF NOT EXISTS separation_scheduled_on DATE;

-- Every case that exists now is HR's: never processed automatically.
UPDATE public.employee_awol_cases
   SET automation = 'needs_review',
       automation_reason = 'Opened before automatic AWOL (2026-11-24): HR decides.',
       automation_changed_at = NOW(), automation_changed_by_name = 'System'
 WHERE automation = 'auto';

-- A separation decided by the system has no HR account behind it.
ALTER TABLE public.employee_awol_cases DROP CONSTRAINT IF EXISTS employee_awol_cases_separated_chk;
ALTER TABLE public.employee_awol_cases ADD CONSTRAINT employee_awol_cases_separated_chk
  CHECK ((outcome IS DISTINCT FROM 'separated') OR (separation_effective IS NOT NULL AND (decided_by IS NOT NULL OR decided_by_name = 'System')));

-- The notices sent (kept for good), and their delivery.
CREATE TABLE IF NOT EXISTS public.awol_notices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID NOT NULL REFERENCES public.employee_awol_cases(id),
  employee_id   UUID NOT NULL REFERENCES public.profiles(id),
  kind          TEXT NOT NULL CHECK (kind IN ('first', 'second')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  sent_on       DATE NOT NULL,
  reply_by      DATE,
  separation_on DATE,
  sent_by_name  TEXT NOT NULL DEFAULT 'System',
  inapp_at      TIMESTAMPTZ,
  email_to      TEXT,
  emailed_at    TIMESTAMPTZ,
  email_error   TEXT,
  pdf_path      TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS awol_notices_case_idx ON public.awol_notices (case_id, created_at);
CREATE INDEX IF NOT EXISTS awol_notices_pending_idx ON public.awol_notices (created_at) WHERE emailed_at IS NULL;
ALTER TABLE public.awol_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.awol_notices FROM anon, authenticated;

-- The notices' PDFs (private; the app's service key only).
INSERT INTO storage.buckets (id, name, public) VALUES ('awol-notices', 'awol-notices', FALSE) ON CONFLICT (id) DO NOTHING;

-- ── The guards ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.awol_case_guards(p_employee UUID, p_from DATE, p_through DATE)
 RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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
REVOKE ALL ON FUNCTION public.awol_case_guards(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;

-- ── Notices ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.awol_fill_notice(p_case UUID, p_kind TEXT, p_today DATE, p_reply_by DATE, p_separation DATE)
 RETURNS TABLE (title TEXT, body TEXT) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  c RECORD;
  v_text TEXT;
  fmt CONSTANT TEXT := 'FMMonth FMDD, YYYY';
BEGIN
  SELECT a.first_absent_on, a.first_notice_reply_by, pr.full_name, pr.employee_id AS code, b.name AS branch INTO c
  FROM public.employee_awol_cases a JOIN public.profiles pr ON pr.id = a.employee_id LEFT JOIN public.branches b ON b.id = pr.branch_id
  WHERE a.id = p_case;
  SELECT value INTO v_text FROM public.system_config WHERE section = 'hr' AND key = CASE p_kind WHEN 'first' THEN 'awol_first_notice_template' ELSE 'awol_second_notice_template' END;
  v_text := COALESCE(v_text, CASE p_kind WHEN 'first' THEN 'NOTICE TO RETURN TO WORK AND EXPLAIN' ELSE 'NOTICE OF SEPARATION' END);
  v_text := replace(v_text, '{employee_name}', COALESCE(c.full_name, 'Employee'));
  v_text := replace(v_text, '{employee_code}', COALESCE(c.code, ''));
  v_text := replace(v_text, '{branch}', COALESCE(c.branch, ''));
  v_text := replace(v_text, '{first_absent_on}', COALESCE(to_char(c.first_absent_on, fmt), ''));
  v_text := replace(v_text, '{reply_by}', COALESCE(to_char(COALESCE(p_reply_by, c.first_notice_reply_by), fmt), ''));
  v_text := replace(v_text, '{separation_on}', COALESCE(to_char(p_separation, fmt), ''));
  v_text := replace(v_text, '{today}', to_char(p_today, fmt));
  title := btrim(split_part(v_text, E'\n', 1));
  body := v_text;
  RETURN NEXT;
END;
$function$;
REVOKE ALL ON FUNCTION public.awol_fill_notice(UUID, TEXT, DATE, DATE, DATE) FROM PUBLIC, anon, authenticated;

/** The employee's status, as HR's own change writes it (profile, sign-in metadata, history). */
CREATE OR REPLACE FUNCTION public.awol_set_status(p_employee UUID, p_status TEXT, p_case UUID, p_on DATE, p_reason TEXT, p_extra JSONB DEFAULT '{}'::JSONB)
 RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_old TEXT;
BEGIN
  SELECT employee_status INTO v_old FROM public.profiles WHERE id = p_employee;
  UPDATE public.profiles SET employee_status = p_status,
         separated_on = COALESCE((p_extra->>'separated_on')::DATE, separated_on),
         separation_reason = COALESCE(p_extra->>'separation_reason', separation_reason),
         updated_at = NOW()
   WHERE id = p_employee;
  UPDATE auth.users SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::JSONB) || jsonb_build_object('employee_status', p_status, 'rfid_status', p_status)
   WHERE id = p_employee;
  INSERT INTO public.employee_status_changes (employee_id, old_status, new_status, effective_on, reason, awol_case_id, changed_by, changed_by_name)
  VALUES (p_employee, v_old, p_status, p_on, left(p_reason, 500), p_case, NULL, 'System');
END;
$function$;
REVOKE ALL ON FUNCTION public.awol_set_status(UUID, TEXT, UUID, DATE, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

/** Record a notice as sent (in-app now; the PDF and e-mail by the app's daily job). */
CREATE OR REPLACE FUNCTION public.awol_send_notice(p_case UUID, p_kind TEXT, p_today DATE, p_reply_by DATE, p_separation DATE)
 RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_emp UUID;
  v_email TEXT;
  n RECORD;
  v_id UUID;
BEGIN
  SELECT a.employee_id, pr.email INTO v_emp, v_email FROM public.employee_awol_cases a JOIN public.profiles pr ON pr.id = a.employee_id WHERE a.id = p_case;
  SELECT * INTO n FROM public.awol_fill_notice(p_case, p_kind, p_today, p_reply_by, p_separation);
  INSERT INTO public.awol_notices (case_id, employee_id, kind, title, body, sent_on, reply_by, separation_on, inapp_at, email_to)
  VALUES (p_case, v_emp, p_kind, n.title, n.body, p_today, p_reply_by, p_separation, NOW(), v_email)
  RETURNING id INTO v_id;
  INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
  VALUES (v_emp, CASE p_kind WHEN 'first' THEN 'awol_first_notice' ELSE 'awol_second_notice' END,
          CASE p_kind WHEN 'first' THEN 'Notice to return to work' ELSE 'Notice of separation' END,
          CASE p_kind WHEN 'first' THEN format('Report back to work or explain in writing by %s. No decision has been made.', to_char(p_reply_by, 'Mon DD, YYYY'))
               ELSE format('Your employment ends on %s unless you report back or explain in writing before then.', to_char(p_separation, 'Mon DD, YYYY')) END,
          'emp-dash');
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.awol_send_notice(UUID, TEXT, DATE, DATE, DATE) FROM PUBLIC, anon, authenticated;

-- ── Detection (replaces 20261123030000's): opens the case, runs the guards, and confirms + sends the 1st notice ──
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

-- ── The daily review (replaces 20261123030000's) ───────────────────────────
CREATE OR REPLACE FUNCTION public.awol_daily_review(p_today DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila'::TEXT))::DATE)
 RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
REVOKE ALL ON FUNCTION public.awol_daily_review(DATE) FROM PUBLIC, anon, authenticated;
