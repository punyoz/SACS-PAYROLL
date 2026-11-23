-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK for 20261124070000_transfer_automation.sql (Part E step 5).
-- Restores the transfer approval function word for word (from
-- 20260910010000_transfer_requests_and_employee_contact.sql) and removes the
-- daily job and the new functions. Keeps the two new columns (the old code
-- ignores them). Run the first SELECT before rolling back: approved transfers
-- with a later date not applied yet must be applied by HR by hand afterwards.
-- ═══════════════════════════════════════════════════════════════════════════

-- 0. Approved, future-dated, not applied yet (HR re-applies these after the rollback):
SELECT id, employee_id, from_branch_id, to_branch_id, effective_date
FROM public.transfer_requests WHERE status = 'approved' AND applied_at IS NULL AND effective_date IS NOT NULL;

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_transfer_request_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.reviewed_at := NOW();

    UPDATE public.profiles
    SET branch_id = NEW.to_branch_id, updated_at = NOW()
    WHERE id = NEW.employee_id;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_transfer_request_approval() FROM PUBLIC, anon, authenticated;

-- The release dry run without the transfer job (as 20261124030000 defined it).
CREATE OR REPLACE FUNCTION public.automation_dry_run_all(p_today DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::DATE))
 RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('automation.dry_run', 'on', true);
  RETURN jsonb_build_object(
    'attendance_flags', public.automation_attendance_flags(p_today - 1),
    'schedule_requests', public.automation_schedule_checks(p_today),
    'daily', public.automation_daily(p_today));
END;
$function$;
REVOKE ALL ON FUNCTION public.automation_dry_run_all(DATE) FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule('transfer-apply-due') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'transfer-apply-due');
DROP FUNCTION IF EXISTS public.transfer_apply_due(DATE);
DROP FUNCTION IF EXISTS public.transfer_apply_followups(public.transfer_requests, BOOLEAN);

-- Optional (loses the effective dates entered): 
-- ALTER TABLE public.transfer_requests DROP COLUMN IF EXISTS applied_at, DROP COLUMN IF EXISTS effective_date;

COMMIT;
