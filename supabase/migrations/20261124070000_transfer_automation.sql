-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 3, Part E step 5 (2026-11-23): transfer endorsements and the
-- effective date. User decisions 2026-11-23:
--   * a transfer gets an effective date (default today). Approved for today:
--     applied at once, as before; for a later date: the system applies it that
--     morning (transfer_apply_due, daily);
--   * applying moves the branch (profile and sign-in account; the session ends
--     so the next sign-in carries the new branch), the ACTIVE RFID card's
--     branch, and the payroll branch with it (payroll follows the profile);
--   * the employee's OWN work schedule is kept and flagged to HR to check;
--   * everything logged "by System"; nothing while the module is paused.
-- The system's endorsement (rules checked, filled for the leaving branch's
-- Admin) is in src/lib/automation/transfer-recommendations.js.
--
-- NON-ADDITIVE (raised in the release plan): apply_transfer_request_approval()
-- is replaced so a future-dated approval waits for its date.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.transfer_requests ADD COLUMN IF NOT EXISTS effective_date DATE;
ALTER TABLE public.transfer_requests ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;

/** What applying a transfer changes besides the profile (card, flags, log). The caller moves the profile. */
CREATE OR REPLACE FUNCTION public.transfer_apply_followups(p_request public.transfer_requests, p_with_account BOOLEAN)
 RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Asia/Manila')::DATE;
  v_cards INTEGER;
  v_name TEXT;
  v_own BOOLEAN;
BEGIN
  SELECT full_name INTO v_name FROM public.profiles WHERE id = p_request.employee_id;
  IF p_with_account THEN
    -- The sign-in account carries the branch too; the session ends so the next sign-in picks it up.
    UPDATE auth.users
    SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::JSONB) || jsonb_build_object('branch_id', p_request.to_branch_id),
        raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::JSONB) || jsonb_build_object('session_id', 'revoked:' || to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    WHERE id = p_request.employee_id;
  END IF;
  -- The active card follows (lost / replaced / inactive cards are left as they are).
  UPDATE public.rfid_cards SET branch_id = p_request.to_branch_id WHERE employee_id = p_request.employee_id AND status = 'active';
  GET DIAGNOSTICS v_cards = ROW_COUNT;
  PERFORM public.automation_log('transfer_endorsements', 'an approved transfer applied on its effective date', 'applied',
    format('%s moved to %s (effective %s)', COALESCE(v_name, 'An employee'), COALESCE((SELECT name FROM public.branches WHERE id = p_request.to_branch_id), 'the new branch'), COALESCE(p_request.effective_date, v_today)),
    jsonb_build_object('transfer_id', p_request.id, 'from_branch_id', p_request.from_branch_id, 'to_branch_id', p_request.to_branch_id,
                       'effective_date', COALESCE(p_request.effective_date, v_today), 'cards_moved', v_cards),
    p_request.employee_id, p_request.to_branch_id, 'transfer_request_applied', p_request.id::TEXT, COALESCE(p_request.effective_date, v_today));
  -- Their own schedule stays: HR checks it fits the new branch.
  SELECT EXISTS (SELECT 1 FROM public.work_schedule_assignments a WHERE a.employee_id = p_request.employee_id AND a.schedule_key IS NOT NULL
                 AND a.effective_from <= COALESCE(p_request.effective_date, v_today)) INTO v_own;
  IF v_own THEN
    PERFORM public.automation_log('transfer_endorsements', 'a transferred employee with their own schedule: HR checks it fits the new branch', 'flag',
      format('%s has their own work schedule: check it fits %s', COALESCE(v_name, 'An employee'), COALESCE((SELECT name FROM public.branches WHERE id = p_request.to_branch_id), 'the new branch')),
      jsonb_build_object('transfer_id', p_request.id), p_request.employee_id, p_request.to_branch_id, 'transfer_schedule_check', p_request.id::TEXT);
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.transfer_apply_followups(public.transfer_requests, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- The approval effect: today (or no date) -> at once, as before; a later date -> it waits (transfer_apply_due).
CREATE OR REPLACE FUNCTION public.apply_transfer_request_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.reviewed_at := NOW();
    IF COALESCE(NEW.effective_date, (NOW() AT TIME ZONE 'Asia/Manila')::DATE) <= (NOW() AT TIME ZONE 'Asia/Manila')::DATE THEN
      UPDATE public.profiles
      SET branch_id = NEW.to_branch_id, updated_at = NOW()
      WHERE id = NEW.employee_id;
      NEW.applied_at := NOW();
      -- The card, the log and the schedule flag (the app updates the sign-in account at once).
      PERFORM public.transfer_apply_followups(NEW, FALSE);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_transfer_request_approval() FROM PUBLIC, anon, authenticated;

/** Daily: approved transfers whose effective date has come. Nothing while the module is paused. */
CREATE OR REPLACE FUNCTION public.transfer_apply_due(p_today DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::DATE))
 RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  r public.transfer_requests;
  v_applied INTEGER := 0;
  v_stuck INTEGER := 0;
  v_moved INTEGER;
BEGIN
  IF public.automation_off('transfer_endorsements') THEN RETURN jsonb_build_object('paused', TRUE); END IF;
  IF public.automation_dry_run() THEN
    RETURN jsonb_build_object('would_apply', (SELECT COUNT(*) FROM public.transfer_requests WHERE status = 'approved' AND applied_at IS NULL
      AND effective_date IS NOT NULL AND effective_date <= p_today), 'dry_run', TRUE);
  END IF;
  FOR r IN SELECT * FROM public.transfer_requests WHERE status = 'approved' AND applied_at IS NULL AND effective_date IS NOT NULL AND effective_date <= p_today ORDER BY effective_date, created_at LOOP
    UPDATE public.profiles SET branch_id = r.to_branch_id, updated_at = NOW()
    WHERE id = r.employee_id AND branch_id IS NOT DISTINCT FROM r.from_branch_id;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    IF v_moved = 0 THEN
      -- The employee is no longer in the branch it was raised for: HR decides (never moved twice).
      IF NOT EXISTS (SELECT 1 FROM public.automation_actions WHERE module = 'transfer_endorsements' AND entity_type = 'transfer_request_stuck' AND entity_id = r.id::TEXT) THEN
        PERFORM public.automation_log('transfer_endorsements', 'an approved transfer whose employee is no longer in the branch it was raised for', 'flag',
          'An approved transfer could not be applied: the employee is no longer in the branch it was raised for',
          jsonb_build_object('transfer_id', r.id), r.employee_id, r.from_branch_id, 'transfer_request_stuck', r.id::TEXT, r.effective_date,
          'the employee moved after the transfer was approved');
      END IF;
      v_stuck := v_stuck + 1;
      CONTINUE;
    END IF;
    UPDATE public.transfer_requests SET applied_at = NOW() WHERE id = r.id;
    PERFORM public.transfer_apply_followups(r, TRUE);
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    VALUES (r.employee_id, 'transfer_applied', 'Your transfer took effect',
            format('From today you are at %s. Sign in again to see your new branch.', COALESCE((SELECT name FROM public.branches WHERE id = r.to_branch_id), 'the new branch')), NULL);
    v_applied := v_applied + 1;
  END LOOP;
  RETURN jsonb_build_object('applied', v_applied, 'stuck', v_stuck);
END;
$function$;
REVOKE ALL ON FUNCTION public.transfer_apply_due(DATE) FROM PUBLIC, anon, authenticated;

-- 00:35 Manila (16:35 UTC), before the attendance flags: the day's taps count at the new branch.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('transfer-apply-due', '35 16 * * *', 'SELECT public.transfer_apply_due();');
  END IF;
END $$;

/** The release check: every module's first run as a dry run (adds transfers). */
CREATE OR REPLACE FUNCTION public.automation_dry_run_all(p_today DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::DATE))
 RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('automation.dry_run', 'on', true);
  RETURN jsonb_build_object(
    'attendance_flags', public.automation_attendance_flags(p_today - 1),
    'schedule_requests', public.automation_schedule_checks(p_today),
    'transfers', public.transfer_apply_due(p_today),
    'daily', public.automation_daily(p_today));
END;
$function$;
REVOKE ALL ON FUNCTION public.automation_dry_run_all(DATE) FROM PUBLIC, anon, authenticated;
