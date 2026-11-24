-- ═══════════════════════════════════════════════════════════════════════════
-- Daily digests (2026-11-24 release): HR gets the automation summary (pointing
-- at Action needed / Settings > Automation, not the removed dashboard card);
-- the branch Admin gets HR's decisions for their branch since yesterday (the
-- Admin no longer checks anything). Each digest can be switched off in
-- Settings > Automation (system_config automation.digest_hr / digest_admin).
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'automation', v.key, 'true', 'System'
FROM (VALUES ('digest_hr'), ('digest_admin')) v(key)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'automation' AND c.key = v.key);

CREATE OR REPLACE FUNCTION public.automation_setting_on(p_key TEXT)
 RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT value FROM public.system_config WHERE section = 'automation' AND key = p_key LIMIT 1), 'true') <> 'false';
$function$;
REVOKE ALL ON FUNCTION public.automation_setting_on(TEXT) FROM PUBLIC, anon, authenticated;

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

  -- 3. The digests (2026-11-24; each can be switched off in Settings > Automation).
  --    HR: what the system did since yesterday, what waits for HR, what it could not decide.
  IF public.automation_setting_on('digest_hr') THEN
    WITH counts AS (
      SELECT r.id AS recipient,
             COUNT(*) FILTER (WHERE a.status = 'done' AND a.created_at >= (p_today - 1)::TIMESTAMP AT TIME ZONE 'Asia/Manila') AS done,
             COUNT(*) FILTER (WHERE a.status IN ('with_hr', 'open')) AS waiting,
             COUNT(*) FILTER (WHERE a.status = 'couldnt_decide') AS undecided
      FROM public.profiles r
      JOIN public.automation_actions a ON TRUE
      WHERE r.archived = FALSE AND r.role = 'hr'
      GROUP BY r.id
    ), sent AS (
      INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
      SELECT c.recipient, 'automation_digest', 'Automation: daily summary',
             format('%s done since yesterday · %s waiting for HR · %s the system could not decide (Action needed on the dashboard; details in Settings > Automation).', c.done, c.waiting, c.undecided),
             'hr-automation'
      FROM counts c WHERE c.done + c.waiting + c.undecided > 0
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_digests FROM sent;
  END IF;
  --    The branch Admin: HR's decisions for their branch since yesterday (the Admin views and monitors).
  IF public.automation_setting_on('digest_admin') THEN
    WITH decided AS (
      SELECT branch_id, status::text FROM public.leave_requests
       WHERE decided_at >= (p_today - 1)::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND decided_at < p_today::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND status::text IN ('approved', 'rejected')
      UNION ALL SELECT branch_id, status::text FROM public.overtime_requests
       WHERE decided_at >= (p_today - 1)::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND decided_at < p_today::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND status::text IN ('approved', 'rejected')
      UNION ALL SELECT branch_id, status::text FROM public.attendance_corrections
       WHERE approved_at >= (p_today - 1)::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND approved_at < p_today::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND status::text IN ('approved', 'rejected')
      UNION ALL SELECT branch_id, status::text FROM public.substitutions
       WHERE decided_at >= (p_today - 1)::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND decided_at < p_today::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND status::text IN ('approved', 'rejected')
      UNION ALL SELECT branch_id, CASE WHEN status::text IN ('approved', 'resolved') THEN 'approved' ELSE status::text END FROM public.branch_admin_requests
       WHERE decided_at >= (p_today - 1)::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND decided_at < p_today::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND status::text IN ('approved', 'rejected', 'resolved')
      UNION ALL SELECT from_branch_id, status::text FROM public.transfer_requests
       WHERE reviewed_at >= (p_today - 1)::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND reviewed_at < p_today::TIMESTAMP AT TIME ZONE 'Asia/Manila' AND status::text IN ('approved', 'rejected')
    ), per_branch AS (
      SELECT branch_id, COUNT(*) FILTER (WHERE status = 'approved') AS approved, COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
      FROM decided WHERE branch_id IS NOT NULL GROUP BY branch_id
    ), sent AS (
      INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
      SELECT r.id, 'hr_decisions_digest', 'HR decisions for your branch',
             format('Yesterday HR approved %s and rejected %s item(s) for your branch. See Branch Review.', b.approved, b.rejected),
             'adm-leaves'
      FROM per_branch b JOIN public.profiles r ON r.archived = FALSE AND r.role = 'admin' AND r.branch_id = b.branch_id
      WHERE b.approved + b.rejected > 0
      RETURNING 1
    )
    SELECT v_digests + COUNT(*) INTO v_digests FROM sent;
  END IF;

  RETURN jsonb_build_object('forwarded', v_forwarded, 'escalated', v_escalated, 'digests', v_digests);
END;
$function$;
REVOKE ALL ON FUNCTION public.automation_daily(DATE) FROM PUBLIC, anon, authenticated;
