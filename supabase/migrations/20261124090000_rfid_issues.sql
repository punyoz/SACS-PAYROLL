-- ═══════════════════════════════════════════════════════════════════════════
-- Part E step 7 (2026-11-23): RFID issues, found nightly and sent to HR.
--
-- Already safe and automatic, unchanged: a repeat tap within the duplicate
-- window is ignored at the tap; a card HR marks lost (or replaced, inactive)
-- stops recording at once. This adds the nightly check for the day before,
-- each found once, as a flag for HR with a suggested fix (module rfid_issues):
--   unknown_card     an unregistered card was tapped (masked code, per branch)
--   lost_card_used   a lost / inactive / replaced card was tapped
--   inactive_person  an inactive or separated employee's card was tapped
--   wrong_branch     an employee's card was tapped at another branch's terminal
--   terminal_quiet   nobody tapped at a branch by the cutoff time (setting
--                    rfid_offline_cutoff, default 09:00) on a day someone there
--                    was scheduled to start before it (user decision
--                    2026-11-23; the same signal as the AWOL data-gap guard).
-- No automatic fixes here: HR decides. Paused with the module or everything.
-- Additive (new function, settings, one cron job).
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'automation', v.key, v.value, 'System'
FROM (VALUES ('rfid_offline_cutoff', '09:00'), ('paused_rfid_issues', 'false'), ('paused_incident_tracking', 'false')) v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'automation' AND c.key = v.key);

CREATE OR REPLACE FUNCTION public.automation_rfid_issues(p_day DATE DEFAULT (((now() AT TIME ZONE 'Asia/Manila')::DATE) - 1))
 RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_cut_text TEXT := COALESCE((SELECT value FROM public.system_config WHERE section = 'automation' AND key = 'rfid_offline_cutoff'), '09:00');
  v_cut INTEGER;
  v_new INTEGER := 0;
  r RECORD;
  v_key TEXT;
BEGIN
  IF public.automation_off('rfid_issues') THEN RETURN jsonb_build_object('paused', TRUE); END IF;
  v_cut := CASE WHEN v_cut_text ~ '^\d{1,2}:\d{2}$' THEN split_part(v_cut_text, ':', 1)::INTEGER * 60 + split_part(v_cut_text, ':', 2)::INTEGER ELSE 540 END;

  -- 1-4. Refused taps of the day, grouped (Blocked Taps keeps each one).
  FOR r IN
    SELECT CASE WHEN t.reason LIKE 'Unregistered RFID card%' THEN 'unknown_card'
                WHEN t.reason ~ '^Card .* is (lost|inactive|replaced|deactivated)' THEN 'lost_card_used'
                WHEN t.reason LIKE 'Inactive employee%' OR t.reason LIKE 'Separated employee%' THEN 'inactive_person'
                WHEN t.reason LIKE 'Wrong branch:%' THEN 'wrong_branch' END AS code,
           t.branch_id, t.employee_id, COALESCE(t.rfid_code, '') AS card, max(t.employee_name) AS employee_name,
           COUNT(*) AS taps, min(t.attempted_at) AS first_at, max(b.name) AS branch_name
    FROM public.attendance_blocked_taps t
    LEFT JOIN public.branches b ON b.id = t.branch_id
    WHERE t.log_date = p_day AND t.source IN ('rfid_tap', 'offline_sync')
    GROUP BY 1, t.branch_id, t.employee_id, COALESCE(t.rfid_code, '')
  LOOP
    IF r.code IS NULL THEN CONTINUE; END IF;
    v_key := format('%s|%s|%s|%s|%s', r.code, p_day, r.branch_id, r.employee_id, r.card);
    IF EXISTS (SELECT 1 FROM public.automation_actions a WHERE a.module = 'rfid_issues' AND a.entity_type = 'rfid_issue' AND a.entity_id = v_key) THEN CONTINUE; END IF;
    IF public.automation_log('rfid_issues',
         CASE r.code WHEN 'unknown_card' THEN 'an unregistered card was tapped'
                     WHEN 'lost_card_used' THEN 'a lost, replaced or inactive card was tapped'
                     WHEN 'inactive_person' THEN 'an inactive or separated employee''s card was tapped'
                     ELSE 'a card was tapped at another branch''s terminal' END,
         'flag',
         CASE r.code
           WHEN 'unknown_card' THEN format('Unknown card %s tapped %s time(s) at %s on %s. Suggested fix: register it to its owner in RFID Cards, or collect it.',
                                           NULLIF(r.card, ''), r.taps, COALESCE(r.branch_name, 'a branch'), to_char(p_day, 'Mon DD'))
           WHEN 'lost_card_used' THEN format('%s''s card %s (no longer active) was tapped %s time(s) at %s on %s. It stays blocked. Suggested fix: check who has it; give the employee their active card.',
                                             COALESCE(r.employee_name, 'An employee'), NULLIF(r.card, ''), r.taps, COALESCE(r.branch_name, 'a branch'), to_char(p_day, 'Mon DD'))
           WHEN 'inactive_person' THEN format('%s (inactive or separated) tapped %s time(s) at %s on %s. Suggested fix: collect the card and deactivate it in RFID Cards, or update the employee''s status.',
                                              COALESCE(r.employee_name, 'An employee'), r.taps, COALESCE(r.branch_name, 'a branch'), to_char(p_day, 'Mon DD'))
           ELSE format('%s tapped %s time(s) at %s (not their branch) on %s. Suggested fix: if they now work there, file a transfer; otherwise remind them to use their own branch''s terminal.',
                       COALESCE(r.employee_name, 'An employee'), r.taps, COALESCE(r.branch_name, 'a branch'), to_char(p_day, 'Mon DD')) END,
         jsonb_build_object('code', r.code, 'log_date', p_day, 'card', NULLIF(r.card, ''), 'taps', r.taps, 'first_at', r.first_at),
         r.employee_id, r.branch_id, 'rfid_issue', v_key) IS NOT NULL THEN
      v_new := v_new + 1;
    END IF;
  END LOOP;

  -- 5. A quiet terminal: someone at the branch was scheduled to start before the cutoff, and nobody tapped there by then.
  FOR r IN
    WITH due AS (
      SELECT l.branch_id, COUNT(DISTINCT l.employee_id) AS due_before
      FROM public.attendance_logs l JOIN public.profiles p ON p.id = l.employee_id
      WHERE l.log_date = p_day AND l.archived_duplicate = FALSE AND l.branch_id IS NOT NULL
        AND l.status NOT IN ('Holiday', 'On Leave') AND COALESCE(l.shift_start_minutes, 480) < v_cut
        AND p.archived = FALSE AND p.on_payroll AND lower(p.role::TEXT) IN ('employee', 'accountant', 'hr')
        AND public.attendance_is_working_day_for(l.employee_id, l.branch_id, l.log_date)
      GROUP BY l.branch_id
    )
    SELECT d.branch_id, d.due_before, b.name AS branch_name,
           (SELECT min(t.tapped_at) FROM public.attendance_taps t WHERE t.branch_id = d.branch_id AND t.log_date = p_day) AS first_tap
    FROM due d LEFT JOIN public.branches b ON b.id = d.branch_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.attendance_taps t WHERE t.branch_id = d.branch_id AND t.log_date = p_day
        AND (EXTRACT(HOUR FROM t.tapped_at AT TIME ZONE 'Asia/Manila') * 60 + EXTRACT(MINUTE FROM t.tapped_at AT TIME ZONE 'Asia/Manila')) < v_cut)
  LOOP
    v_key := format('terminal_quiet|%s|%s', p_day, r.branch_id);
    IF EXISTS (SELECT 1 FROM public.automation_actions a WHERE a.module = 'rfid_issues' AND a.entity_type = 'rfid_issue' AND a.entity_id = v_key) THEN CONTINUE; END IF;
    IF public.automation_log('rfid_issues', format('no taps by %s although someone was due before then', v_cut_text), 'flag',
         format('No taps at %s by %s on %s although %s scheduled to start before then%s. Suggested fix: check the terminal is on and online (saved offline taps upload when it reconnects), then the day''s records.',
                COALESCE(r.branch_name, 'a branch'), v_cut_text, to_char(p_day, 'Mon DD'),
                CASE WHEN r.due_before = 1 THEN '1 person was' ELSE r.due_before || ' people were' END,
                CASE WHEN r.first_tap IS NULL THEN ', and none all day' ELSE format('; the first tap was at %s', to_char(r.first_tap AT TIME ZONE 'Asia/Manila', 'HH12:MI AM')) END),
         jsonb_build_object('code', 'terminal_quiet', 'log_date', p_day, 'due_before', r.due_before, 'cutoff', v_cut_text, 'first_tap', r.first_tap),
         NULL, r.branch_id, 'rfid_issue', v_key) IS NOT NULL THEN
      v_new := v_new + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('flagged', v_new, 'day', p_day, 'dry_run', public.automation_dry_run());
END;
$function$;
REVOKE ALL ON FUNCTION public.automation_rfid_issues(DATE) FROM PUBLIC, anon, authenticated;

-- Nightly at 00:47 Manila (16:47 UTC): after the attendance flags, before the daily digest.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('automation-rfid-issues', '47 16 * * *', 'SELECT public.automation_rfid_issues();');
  END IF;
END $$;
