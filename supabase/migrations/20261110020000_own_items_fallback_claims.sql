-- ════════════════════════════════════════════════════════════════════════════
-- Nobody approves, processes or edits their own item; the Super Admin is the
-- fallback only when no other HR is active; one shared HR queue with a claim
-- lock (user decisions 2026-11-09, Parts A-D). The server routes check the
-- same, with the audit entry "fallback used" and the notifications.
--
--   * "Active HR": an HR account that is not archived and whose status is not
--     Inactive / Archived / Separated. Any OTHER active HR counts (2, 3 or more).
--   * Leave: HR decides; never the requester; an HR's own leave goes to another
--     active HR, or to the Super Admin when none is left (fallback).
--   * Payroll runs: HR never decides a run holding their own payslip; when no
--     active HR may decide, the Super Admin may (fallback).
--   * Salary changes: never one's own; an HR's salary by another HR, or by the
--     Super Admin when none is left.
--   * The Accountant's own payslip: self-processed only while the branch has
--     exactly ONE active Accountant; with two or more, another Accountant of
--     the branch processes it (switches automatically with the headcount).
--   * hr_queue_claims: claiming locks an item for 30 minutes (or until Release
--     or sign-out); another HR cannot act on it meanwhile, and nobody claims
--     their own item.
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS private;

-- ── 1. Who counts as an active HR ──
CREATE OR REPLACE FUNCTION private.is_active_staff(p_id uuid, p_role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_id AND p.role::text = p_role AND NOT COALESCE(p.archived, false)
      AND COALESCE(p.employee_status, 'Active') NOT IN ('Inactive', 'Archived', 'Separated')
  );
$$;

CREATE OR REPLACE FUNCTION private.other_active_hr_count(p_except uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*)::integer FROM public.profiles p
  WHERE p.role::text = 'hr' AND p.id IS DISTINCT FROM p_except AND NOT COALESCE(p.archived, false)
    AND COALESCE(p.employee_status, 'Active') NOT IN ('Inactive', 'Archived', 'Separated');
$$;

CREATE OR REPLACE FUNCTION private.active_accountant_count(p_branch uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*)::integer FROM public.profiles p
  WHERE p.role::text = 'accountant' AND p.branch_id = p_branch AND NOT COALESCE(p.archived, false)
    AND COALESCE(p.employee_status, 'Active') NOT IN ('Inactive', 'Archived', 'Separated');
$$;

-- True when no active HR may decide this run (each one has a payslip in it or processed it).
CREATE OR REPLACE FUNCTION private.payroll_run_needs_fallback(p_run uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.payroll_runs r, public.profiles h
    WHERE r.id = p_run AND h.role::text = 'hr' AND NOT COALESCE(h.archived, false)
      AND COALESCE(h.employee_status, 'Active') NOT IN ('Inactive', 'Archived', 'Separated')
      AND h.id IS DISTINCT FROM r.processed_by AND h.id IS DISTINCT FROM r.submitted_by
      AND NOT EXISTS (SELECT 1 FROM public.payroll_run_items i
                      WHERE i.run_id = r.id AND i.submission_no = r.submission_no AND (i.employee_id = h.id OR i.processed_by = h.id))
  );
$$;

-- ── 2. The shared HR queue's claim lock ──
CREATE TABLE IF NOT EXISTS public.hr_queue_claims (
  item_type text NOT NULL CHECK (item_type IN ('leave_request', 'payroll_run', 'attendance_correction', 'salary_change')),
  item_id uuid NOT NULL,
  claimed_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  claimed_by_name text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  PRIMARY KEY (item_type, item_id)
);
CREATE INDEX IF NOT EXISTS hr_queue_claims_claimed_by_idx ON public.hr_queue_claims (claimed_by);
ALTER TABLE public.hr_queue_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hr_queue_claims FROM anon, authenticated;
-- No policy: only the server (service role) reads and writes claims.

-- Raise when another HR holds an unexpired claim on the item.
CREATE OR REPLACE FUNCTION private.hr_claim_check(p_type text, p_item uuid, p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_name text;
BEGIN
  SELECT COALESCE(c.claimed_by_name, 'another HR') INTO v_name FROM public.hr_queue_claims c
  WHERE c.item_type = p_type AND c.item_id = p_item AND c.claimed_by IS DISTINCT FROM p_actor AND c.expires_at > now();
  IF FOUND THEN
    RAISE EXCEPTION 'claimed: claimed by %.', v_name USING ERRCODE = 'lock_not_available';
  END IF;
END;
$$;

-- Claim (or renew one's own claim). p_owner: the person the item belongs to.
CREATE OR REPLACE FUNCTION public.hr_claim_item(p_type text, p_item uuid, p_actor uuid, p_owner uuid DEFAULT NULL)
RETURNS public.hr_queue_claims LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row public.hr_queue_claims;
  v_name text;
BEGIN
  IF NOT private.is_active_staff(p_actor, 'hr') THEN
    RAISE EXCEPTION 'forbidden: only an active HR account claims queue items.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_owner IS NOT NULL AND p_owner = p_actor THEN
    RAISE EXCEPTION 'own_item: you cannot claim your own request.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(NULLIF(full_name, ''), email) INTO v_name FROM public.profiles WHERE id = p_actor;
  INSERT INTO public.hr_queue_claims AS c (item_type, item_id, claimed_by, claimed_by_name, claimed_at, expires_at)
  VALUES (p_type, p_item, p_actor, v_name, now(), now() + interval '30 minutes')
  ON CONFLICT (item_type, item_id) DO UPDATE
    SET claimed_by = EXCLUDED.claimed_by, claimed_by_name = EXCLUDED.claimed_by_name, claimed_at = now(), expires_at = now() + interval '30 minutes'
    WHERE c.claimed_by = EXCLUDED.claimed_by OR c.expires_at <= now()
  RETURNING * INTO v_row;
  IF v_row.item_id IS NULL THEN
    SELECT COALESCE(claimed_by_name, 'another HR') INTO v_name FROM public.hr_queue_claims WHERE item_type = p_type AND item_id = p_item;
    RAISE EXCEPTION 'claimed: claimed by %.', v_name USING ERRCODE = 'lock_not_available';
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_release_claims(p_actor uuid, p_type text DEFAULT NULL, p_item uuid DEFAULT NULL)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH gone AS (
    DELETE FROM public.hr_queue_claims
    WHERE claimed_by = p_actor AND (p_type IS NULL OR item_type = p_type) AND (p_item IS NULL OR item_id = p_item)
    RETURNING 1
  ) SELECT count(*)::integer FROM gone;
$$;

REVOKE ALL ON FUNCTION public.hr_claim_item(text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hr_release_claims(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_claim_item(text, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.hr_release_claims(uuid, text, uuid) TO service_role;

-- ── 3. Leave decisions ──
CREATE OR REPLACE FUNCTION public.leave_requests_decision_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_owner_role text;
  v_decider_role text;
BEGIN
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN RETURN NEW; END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status NOT IN ('approved', 'rejected') THEN RETURN NEW; END IF;
  IF NEW.decided_by IS NULL THEN
    RAISE EXCEPTION 'forbidden: a leave decision records who made it.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.decided_by = NEW.employee_id THEN
    RAISE EXCEPTION 'own_item: nobody decides their own leave request.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.role::text INTO v_owner_role FROM public.profiles p WHERE p.id = NEW.employee_id;
  SELECT p.role::text INTO v_decider_role FROM public.profiles p WHERE p.id = NEW.decided_by;
  IF v_decider_role = 'hr' AND private.is_active_staff(NEW.decided_by, 'hr') THEN
    PERFORM private.hr_claim_check('leave_request', NEW.id, NEW.decided_by);
    RETURN NEW;
  END IF;
  IF v_decider_role = 'super_admin' AND v_owner_role = 'hr' AND private.other_active_hr_count(NEW.employee_id) = 0 THEN
    RETURN NEW; -- the fallback: no other active HR
  END IF;
  RAISE EXCEPTION 'forbidden: HR decides leave (the Super Admin only for an HR''s own leave when no other HR is active).'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS leave_requests_decision_guard ON public.leave_requests;
CREATE TRIGGER leave_requests_decision_guard BEFORE UPDATE OF status ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_decision_guard();

-- ── 4. Salary changes: never one's own; the Super Admin for the last HR ──
CREATE OR REPLACE FUNCTION public.employee_salary_changes_writer_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role TEXT;
  v_archived BOOLEAN;
  v_target_role TEXT;
BEGIN
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by IS NOT NULL AND NEW.created_by = NEW.employee_id THEN
    RAISE EXCEPTION 'own_item: nobody changes their own salary.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.role::TEXT, COALESCE(p.archived, false) INTO v_role, v_archived FROM public.profiles p WHERE p.id = NEW.created_by;
  SELECT p.role::TEXT INTO v_target_role FROM public.profiles p WHERE p.id = NEW.employee_id;
  IF v_role = 'super_admin' AND NOT v_archived AND v_target_role = 'hr' AND private.other_active_hr_count(NEW.employee_id) = 0 THEN
    NEW.created_by_role := 'super_admin'; -- the fallback: no other active HR
    RETURN NEW;
  END IF;
  IF NEW.created_by IS NULL OR v_role IS DISTINCT FROM 'hr' OR v_archived THEN
    RAISE EXCEPTION 'forbidden: only HR changes an employee''s salary (by %).', COALESCE(v_role, 'unknown')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_by_role := 'hr';
  RETURN NEW;
END;
$function$;


-- ── 5. The Accountant's own payslip: self-processed only with ONE active Accountant ──
CREATE OR REPLACE FUNCTION public.payroll_entries_self_processing_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text;
BEGIN
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN RETURN NEW; END IF;
  IF NEW.submitted_by IS NULL OR NEW.submitted_by IS DISTINCT FROM NEW.employee_id THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.payroll IS NOT DISTINCT FROM OLD.payroll AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = NEW.employee_id;
  IF v_role IS DISTINCT FROM 'accountant' OR private.active_accountant_count(NEW.branch_id) > 1 THEN
    RAISE EXCEPTION 'self_processing_blocked: another Accountant of the branch processes your payslip (self-processing is only for a branch with one Accountant).'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payroll_entries_zy_self_processing ON public.payroll_entries;
CREATE TRIGGER payroll_entries_zy_self_processing BEFORE INSERT OR UPDATE ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.payroll_entries_self_processing_guard();

-- ── approve_payroll_run: own payslip, Super Admin fallback, claim lock (rest unchanged) ──
CREATE OR REPLACE FUNCTION public.approve_payroll_run(p_run_id uuid, p_actor uuid, p_remarks text DEFAULT NULL::text)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run public.payroll_runs;
  v_actor RECORD;
  v_branch TEXT;
  v_remarks TEXT := NULLIF(btrim(COALESCE(p_remarks, '')), '');
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'not_found: no such payroll run.' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  -- 2026-11-10: HR, or the Super Admin only when no other HR may decide (fallback).
  IF v_actor.id IS NULL OR NOT (v_actor.role = 'hr' OR (v_actor.role = 'super_admin' AND private.payroll_run_needs_fallback(v_run.id))) THEN
    RAISE EXCEPTION 'forbidden: only HR approves payroll (the Super Admin only when no other HR is active).' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Nobody decides a run that holds their own payslip.
  IF EXISTS (SELECT 1 FROM public.payroll_run_items i WHERE i.run_id = v_run.id AND i.submission_no = v_run.submission_no AND i.employee_id = v_actor.id) THEN
    RAISE EXCEPTION 'own_payslip: this run holds your own payslip, so another HR must decide it.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The shared HR queue: an item another HR claimed is theirs until released or expired.
  PERFORM private.hr_claim_check('payroll_run', v_run.id, v_actor.id);
  IF v_run.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_transition: this run is % and cannot be approved.', v_run.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_actor.id IN (v_run.processed_by, v_run.submitted_by) OR EXISTS (
    SELECT 1 FROM public.payroll_run_items i
    WHERE i.run_id = v_run.id AND i.submission_no = v_run.submission_no AND i.processed_by = v_actor.id
  ) THEN
    RAISE EXCEPTION 'self_approval: you processed this payroll, so someone else must approve it.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('sacs.payroll_run_action', 'on', true);
  UPDATE public.payroll_runs SET status = 'approved', reviewed_by = v_actor.id, reviewed_by_name = v_actor.full_name,
         reviewed_at = NOW(), remarks = v_remarks
  WHERE id = v_run.id RETURNING * INTO v_run;

  UPDATE public.payroll_entries SET approved_by = v_actor.id, approved_at = NOW() WHERE run_id = v_run.id;

  -- The Early Bird winner of the period is final from now on.
  IF to_regclass('public.early_bird_winners') IS NOT NULL THEN
    UPDATE public.early_bird_winners SET finalized_at = NOW()
    WHERE period_label = v_run.period_label AND finalized_at IS NULL;
  END IF;

  PERFORM public.payroll_run_record(v_run, 'approved', 'pending', v_actor.id, v_actor.role, v_actor.full_name, v_remarks);
  SELECT name INTO v_branch FROM public.branches WHERE id = v_run.branch_id;
  PERFORM public.payroll_run_notify(ARRAY[v_run.processed_by, v_run.submitted_by], 'payroll_run_approved',
    format('Payroll approved: %s, %s', COALESCE(v_branch, 'branch'), v_run.period_label),
    format('Approved by %s. Payslips are now visible to employees.%s', v_actor.full_name,
      CASE WHEN v_remarks IS NOT NULL THEN ' Note: ' || v_remarks ELSE '' END),
    'ac-process', v_run.id);
  RETURN v_run;
END;
$function$;

-- ── reject_payroll_run: own payslip, Super Admin fallback, claim lock (rest unchanged) ──
CREATE OR REPLACE FUNCTION public.reject_payroll_run(p_run_id uuid, p_actor uuid, p_remarks text)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run public.payroll_runs;
  v_actor RECORD;
  v_branch TEXT;
  v_remarks TEXT := NULLIF(btrim(COALESCE(p_remarks, '')), '');
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'not_found: no such payroll run.' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  -- 2026-11-10: HR, or the Super Admin only when no other HR may decide (fallback).
  IF v_actor.id IS NULL OR NOT (v_actor.role = 'hr' OR (v_actor.role = 'super_admin' AND private.payroll_run_needs_fallback(v_run.id))) THEN
    RAISE EXCEPTION 'forbidden: only HR rejects payroll (the Super Admin only when no other HR is active).' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Nobody decides a run that holds their own payslip.
  IF EXISTS (SELECT 1 FROM public.payroll_run_items i WHERE i.run_id = v_run.id AND i.submission_no = v_run.submission_no AND i.employee_id = v_actor.id) THEN
    RAISE EXCEPTION 'own_payslip: this run holds your own payslip, so another HR must decide it.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The shared HR queue: an item another HR claimed is theirs until released or expired.
  PERFORM private.hr_claim_check('payroll_run', v_run.id, v_actor.id);
  IF v_remarks IS NULL OR length(v_remarks) < 5 THEN
    RAISE EXCEPTION 'remarks_required: write the reason for rejecting (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;
  IF v_run.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_transition: this run is % and cannot be rejected.', v_run.status USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('sacs.payroll_run_action', 'on', true);
  -- Nothing the Accountant did is cleared: the payslips stay, unlocked again.
  UPDATE public.payroll_runs SET status = 'rejected', reviewed_by = v_actor.id, reviewed_by_name = v_actor.full_name,
         reviewed_at = NOW(), remarks = v_remarks
  WHERE id = v_run.id RETURNING * INTO v_run;

  PERFORM public.payroll_run_record(v_run, 'rejected', 'pending', v_actor.id, v_actor.role, v_actor.full_name, v_remarks);
  SELECT name INTO v_branch FROM public.branches WHERE id = v_run.branch_id;
  PERFORM public.payroll_run_notify(ARRAY[v_run.processed_by, v_run.submitted_by], 'payroll_run_rejected',
    format('Payroll rejected: %s, %s', COALESCE(v_branch, 'branch'), v_run.period_label),
    format('Rejected by %s: %s', v_actor.full_name, v_remarks),
    'ac-process', v_run.id);
  RETURN v_run;
END;
$function$;
