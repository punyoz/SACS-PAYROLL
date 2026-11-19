-- ═══════════════════════════════════════════════════════════════════════════
-- Final pay needs HR approval (2026-11-20)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Before: the Accountant's final pay was written as a Final payslip at once,
-- with its loan repayments, the pro-rated 13th month, the subsidy settlement
-- and the AWOL stamp. Now:
--
--   1. public.payroll_final_pay_submissions   one row per submission:
--        status  pending   "Pending HR Approval": the full computed payslip
--                          (item = what payroll_commit_entries writes) and its
--                          side effects (effects), locked. Nothing is written
--                          to payroll yet; what it will use is HELD (3.)
--                approved  "Paid/Released": written by payroll_final_pay_decide
--                rejected  "Rejected by HR" (reason): nothing was written, so
--                          nothing needs undoing; the Accountant resubmits
--                          (a new row; the rejected one stays as history)
--        legacy  TRUE      the final payslips saved before this change, labeled
--                          "Released before HR approval was required" (their
--                          payslips, repayments, 13th month and subsidy are
--                          not touched)
--        corrects_entry_id a correction of an approved final pay (same approval)
--   2. public.payroll_final_pay_decide(actor, id, 'approve' | 'reject', reason)
--        HR of the employee's branch at separation (an HR without a home
--        branch reaches every branch, as elsewhere); the Super Admin only when
--        no such HR is active (same stand-in rule as payroll runs); never the
--        submitter or the employee. Approve writes everything in ONE
--        transaction (payroll_commit_entries + 13th month + subsidy + loans
--        for collection + AWOL stamp) or nothing.
--   3. Holds while a submission is pending (refused unless the decide function
--      is writing, sacs.final_pay_release = on):
--        payroll_loan_payments  INSERT on a held loan (regular payroll, manual)
--        payroll_loans          UPDATE of a held loan (suspend, waive, edit)
--        payroll_thirteenth_month INSERT / UPDATE for the employee (13th-month run)
--        payroll_subsidy_balances UPDATE of the held balance
--        payroll_entries        a Final ('paid') payslip for the employee
--
-- Rollback: scripts/checks/final-pay-hr-approval-2026-11-20-rollback.sql
-- (drops the triggers, functions and the table; no existing row is changed
-- by this migration, so nothing else needs restoring).
--
-- Safe to run more than once.

-- ── 1. Submissions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_final_pay_submissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id        UUID NOT NULL REFERENCES public.profiles(id),
  employee_name      TEXT,
  branch_id          UUID REFERENCES public.branches(id),     -- the branch at separation
  separated_on       DATE NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  legacy             BOOLEAN NOT NULL DEFAULT FALSE,
  release_on         DATE NOT NULL,
  net_pay            NUMERIC(12, 2) NOT NULL DEFAULT 0,
  item               JSONB NOT NULL DEFAULT '{}'::JSONB,       -- the payslip, as computed
  effects            JSONB NOT NULL DEFAULT '{}'::JSONB,       -- 13th month, subsidy, loans held
  corrects_entry_id  UUID REFERENCES public.payroll_entries(id),
  submitted_by       UUID REFERENCES public.profiles(id),
  submitted_by_name  TEXT,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by         UUID REFERENCES public.profiles(id),
  decided_by_name    TEXT,
  decided_by_role    TEXT,
  decided_at         TIMESTAMPTZ,
  reject_reason      TEXT,
  entry_id           UUID REFERENCES public.payroll_entries(id),
  payslip_no         TEXT,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_final_pay_submissions_rejected_chk CHECK (status <> 'rejected' OR length(btrim(COALESCE(reject_reason, ''))) >= 5),
  CONSTRAINT payroll_final_pay_submissions_approved_chk CHECK (status <> 'approved' OR entry_id IS NOT NULL)
);

-- One waiting submission per employee.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_final_pay_submissions_one_pending
  ON public.payroll_final_pay_submissions (employee_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS payroll_final_pay_submissions_branch_idx
  ON public.payroll_final_pay_submissions (branch_id, status);
CREATE INDEX IF NOT EXISTS payroll_final_pay_submissions_employee_idx
  ON public.payroll_final_pay_submissions (employee_id, submitted_at DESC);

ALTER TABLE public.payroll_final_pay_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_final_pay_submissions_no_client_access ON public.payroll_final_pay_submissions;
CREATE POLICY payroll_final_pay_submissions_no_client_access ON public.payroll_final_pay_submissions
  TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.payroll_final_pay_submissions FROM anon, authenticated;

-- Locked: the computed payslip never changes; only pending → approved | rejected.
CREATE OR REPLACE FUNCTION public.payroll_final_pay_submissions_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.item IS DISTINCT FROM OLD.item OR NEW.effects IS DISTINCT FROM OLD.effects
     OR NEW.release_on IS DISTINCT FROM OLD.release_on OR NEW.net_pay IS DISTINCT FROM OLD.net_pay
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.corrects_entry_id IS DISTINCT FROM OLD.corrects_entry_id OR NEW.legacy IS DISTINCT FROM OLD.legacy THEN
    RAISE EXCEPTION 'final_pay_locked: a submitted final pay cannot be changed; reject it and submit again.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_transition: this final pay is % already.', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_final_pay_submissions_lock ON public.payroll_final_pay_submissions;
CREATE TRIGGER payroll_final_pay_submissions_lock
  BEFORE UPDATE ON public.payroll_final_pay_submissions
  FOR EACH ROW EXECUTE FUNCTION public.payroll_final_pay_submissions_lock();

DROP TRIGGER IF EXISTS payroll_final_pay_submissions_block_hard_delete ON public.payroll_final_pay_submissions;
CREATE TRIGGER payroll_final_pay_submissions_block_hard_delete
  BEFORE DELETE ON public.payroll_final_pay_submissions
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

-- The final payslips saved before this change: labeled, nothing else. (One
-- HR approved -- re-applied after a rollback -- carries payroll.final_pay.approval
-- and is recorded as approved by that person, not as legacy.)
INSERT INTO public.payroll_final_pay_submissions (
  employee_id, employee_name, branch_id, separated_on, status, legacy, release_on, net_pay,
  submitted_by_name, submitted_at, decided_by_name, decided_by_role, decided_at, entry_id, payslip_no, note
)
SELECT e.employee_id, e.employee_name, e.branch_id,
       COALESCE(NULLIF(e.payroll->'final_pay'->>'separated_on', '')::DATE, (e.created_at AT TIME ZONE 'Asia/Manila')::DATE),
       'approved', e.payroll->'final_pay'->'approval' IS NULL,
       COALESCE(NULLIF(e.payroll->'final_pay'->>'release_on', '')::DATE, (e.created_at AT TIME ZONE 'Asia/Manila')::DATE),
       COALESCE(NULLIF(e.payroll->'totals'->>'net_pay', '')::NUMERIC, 0),
       e.payroll->'final_pay'->>'computed_by_name', e.created_at,
       e.payroll->'final_pay'->'approval'->>'approved_by_name', e.payroll->'final_pay'->'approval'->>'approved_by_role',
       COALESCE(NULLIF(e.payroll->'final_pay'->'approval'->>'approved_at', '')::TIMESTAMPTZ, e.created_at), e.id, e.payslip_no,
       CASE WHEN e.payroll->'final_pay'->'approval' IS NULL THEN 'Released before HR approval was required' END
  FROM public.payroll_entries e
 WHERE e.pay_period LIKE 'Final pay%' AND e.status = 'paid'
   AND NOT EXISTS (SELECT 1 FROM public.payroll_final_pay_submissions s WHERE s.entry_id = e.id);

-- ── 2. Holds while pending ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION private.final_pay_releasing()
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT COALESCE(current_setting('sacs.final_pay_release', true), '') = 'on';
$$;

CREATE OR REPLACE FUNCTION public.payroll_final_pay_hold()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_held BOOLEAN;
BEGIN
  IF private.final_pay_releasing() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_TABLE_NAME = 'payroll_loan_payments' THEN
    v_held := EXISTS (SELECT 1 FROM public.payroll_final_pay_submissions s
                      WHERE s.status = 'pending' AND s.effects->'loan_ids' ? NEW.loan_id::TEXT);
  ELSIF TG_TABLE_NAME = 'payroll_loans' THEN
    v_held := EXISTS (SELECT 1 FROM public.payroll_final_pay_submissions s
                      WHERE s.status = 'pending' AND s.effects->'loan_ids' ? OLD.id::TEXT);
  ELSIF TG_TABLE_NAME = 'payroll_subsidy_balances' THEN
    v_held := EXISTS (SELECT 1 FROM public.payroll_final_pay_submissions s
                      WHERE s.status = 'pending' AND s.effects->'subsidy'->>'balance_id' = OLD.id::TEXT);
  ELSIF TG_TABLE_NAME = 'payroll_entries' THEN
    v_held := NEW.status = 'paid'::public.payroll_state AND EXISTS (
      SELECT 1 FROM public.payroll_final_pay_submissions s WHERE s.status = 'pending' AND s.employee_id = NEW.employee_id);
  ELSE  -- payroll_thirteenth_month
    v_held := EXISTS (SELECT 1 FROM public.payroll_final_pay_submissions s
                      WHERE s.status = 'pending' AND s.employee_id = NEW.employee_id);
  END IF;
  IF v_held THEN
    RAISE EXCEPTION 'final_pay_reserved: held for a final pay waiting for HR approval (%).', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.payroll_final_pay_hold() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payroll_loan_payments_a0_final_pay_hold ON public.payroll_loan_payments;
CREATE TRIGGER payroll_loan_payments_a0_final_pay_hold
  BEFORE INSERT ON public.payroll_loan_payments
  FOR EACH ROW EXECUTE FUNCTION public.payroll_final_pay_hold();

DROP TRIGGER IF EXISTS payroll_loans_a0_final_pay_hold ON public.payroll_loans;
CREATE TRIGGER payroll_loans_a0_final_pay_hold
  BEFORE UPDATE ON public.payroll_loans
  FOR EACH ROW EXECUTE FUNCTION public.payroll_final_pay_hold();

DROP TRIGGER IF EXISTS payroll_subsidy_balances_a0_final_pay_hold ON public.payroll_subsidy_balances;
CREATE TRIGGER payroll_subsidy_balances_a0_final_pay_hold
  BEFORE UPDATE ON public.payroll_subsidy_balances
  FOR EACH ROW EXECUTE FUNCTION public.payroll_final_pay_hold();

DROP TRIGGER IF EXISTS payroll_thirteenth_month_a0_final_pay_hold ON public.payroll_thirteenth_month;
CREATE TRIGGER payroll_thirteenth_month_a0_final_pay_hold
  BEFORE INSERT OR UPDATE ON public.payroll_thirteenth_month
  FOR EACH ROW EXECUTE FUNCTION public.payroll_final_pay_hold();

DROP TRIGGER IF EXISTS payroll_entries_a0_final_pay_hold ON public.payroll_entries;
CREATE TRIGGER payroll_entries_a0_final_pay_hold
  BEFORE INSERT OR UPDATE ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.payroll_final_pay_hold();

-- ── 3. HR's decision ──────────────────────────────────────────────────────

-- True when no active HR may decide this submission: the Super Admin stands in.
CREATE OR REPLACE FUNCTION private.final_pay_needs_fallback(p_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.payroll_final_pay_submissions s, public.profiles h
    WHERE s.id = p_id AND h.role::TEXT = 'hr' AND NOT COALESCE(h.archived, FALSE)
      AND COALESCE(h.employee_status, 'Active') NOT IN ('Inactive', 'Archived', 'Separated')
      AND (h.branch_id IS NULL OR h.branch_id = s.branch_id)
      AND h.id IS DISTINCT FROM s.submitted_by AND h.id IS DISTINCT FROM s.employee_id
  );
$$;

CREATE OR REPLACE FUNCTION public.payroll_final_pay_decide(p_actor UUID, p_id UUID, p_action TEXT, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.profiles;
  v_row public.payroll_final_pay_submissions;
  v_fx JSONB;
  v_item JSONB;
  v_res JSONB;
  v_entry UUID;
  v_now TIMESTAMPTZ := NOW();
  v_pay RECORD;
  v_left JSONB;
  v_label TEXT;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id = p_actor;
  SELECT * INTO v_row FROM public.payroll_final_pay_submissions WHERE id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'not_found: no such final pay.' USING ERRCODE = 'no_data_found'; END IF;
  IF v_actor.id IS NULL OR COALESCE(v_actor.archived, FALSE) OR NOT (
       (v_actor.role::TEXT = 'hr' AND (v_actor.branch_id IS NULL OR v_actor.branch_id = v_row.branch_id))
    OR (v_actor.role::TEXT = 'super_admin' AND private.final_pay_needs_fallback(v_row.id))) THEN
    RAISE EXCEPTION 'forbidden: only HR of the employee''s branch approves final pay (the Super Admin only when no such HR is active).'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.id = v_row.submitted_by OR v_actor.id = v_row.employee_id THEN
    RAISE EXCEPTION 'forbidden: you cannot decide this final pay.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_transition: this final pay is % already.', v_row.status USING ERRCODE = 'check_violation';
  END IF;

  IF p_action = 'reject' THEN
    IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN
      RAISE EXCEPTION 'reason_required: give the reason for rejecting (at least 5 characters).' USING ERRCODE = 'check_violation';
    END IF;
    -- Nothing was written while pending: ending the hold releases everything.
    UPDATE public.payroll_final_pay_submissions
       SET status = 'rejected', reject_reason = btrim(p_reason), decided_by = v_actor.id, decided_by_name = v_actor.full_name,
           decided_by_role = v_actor.role::TEXT, decided_at = v_now
     WHERE id = p_id RETURNING * INTO v_row;
    RETURN jsonb_build_object('ok', TRUE, 'status', 'rejected', 'id', v_row.id);
  END IF;
  IF p_action IS DISTINCT FROM 'approve' THEN
    RAISE EXCEPTION 'invalid: approve or reject.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('sacs.final_pay_release', 'on', true);
  v_fx := v_row.effects;
  v_label := v_row.item->'entry'->>'pay_period';

  -- A correction: the approved final pay's repayments are reversed and its
  -- payroll record archived first (the payslip itself is rewritten below).
  IF v_row.corrects_entry_id IS NOT NULL THEN
    FOR v_pay IN SELECT p.id, p.loan_id FROM public.payroll_loan_payments p
                  WHERE p.payroll_entry_id = v_row.corrects_entry_id AND p.kind IN ('final_pay', 'subsidy_offset') AND NOT p.reversed LOOP
      INSERT INTO public.payroll_loan_payments (loan_id, employee_id, kind, amount, reverses_payment_id, payroll_entry_id, pay_period, note, created_by, created_by_name)
      VALUES (v_pay.loan_id, v_row.employee_id, 'reversal', 0, v_pay.id, v_row.corrects_entry_id, v_label,
              'Final pay corrected: repayment replaced', v_actor.id, v_actor.full_name);
    END LOOP;
    UPDATE public.payroll_records SET archived = TRUE
     WHERE employee_id = v_row.employee_id AND period_label = v_label AND NOT archived;
  END IF;

  v_item := jsonb_set(v_row.item, '{record,processed_at}', to_jsonb(v_now));
  v_item := jsonb_set(v_item, '{entry,payroll,final_pay,approval}', jsonb_build_object(
    'status', 'released', 'release_on', v_row.release_on,
    'submitted_by_name', v_row.submitted_by_name, 'submitted_at', v_row.submitted_at,
    'approved_by_name', v_actor.full_name, 'approved_by_role', v_actor.role::TEXT, 'approved_at', v_now,
    'corrects_entry_id', v_row.corrects_entry_id));
  v_res := public.payroll_commit_entries(jsonb_build_array(v_item))->0;
  IF NOT COALESCE((v_res->>'ok')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'commit_failed: %', COALESCE(v_res->>'error', 'the payslip was not written') USING ERRCODE = 'check_violation';
  END IF;
  v_entry := (v_res->>'entry_id')::UUID;
  UPDATE public.payroll_entries SET approved_by = v_actor.id, approved_at = v_now WHERE id = v_entry;

  -- The pro-rated 13th month (a correction rewrites the one its final pay paid).
  IF COALESCE(NULLIF(v_fx->'thirteenth'->>'amount', '')::NUMERIC, 0) > 0 THEN
    INSERT INTO public.payroll_thirteenth_month (employee_id, employee_name, year, basic_earned, amount, breakdown, processed_by, processed_by_name)
    VALUES (v_row.employee_id, v_row.employee_name, (v_fx->'thirteenth'->>'year')::INTEGER, (v_fx->'thirteenth'->>'basic_earned')::NUMERIC,
            (v_fx->'thirteenth'->>'amount')::NUMERIC, jsonb_build_object('final_pay', true, 'entry_id', v_entry),
            v_row.submitted_by, v_row.submitted_by_name)
    ON CONFLICT (employee_id, year) DO UPDATE
       SET basic_earned = EXCLUDED.basic_earned, amount = EXCLUDED.amount, breakdown = EXCLUDED.breakdown,
           processed_by = EXCLUDED.processed_by, processed_by_name = EXCLUDED.processed_by_name, processed_at = NOW()
     WHERE public.payroll_thirteenth_month.breakdown->>'final_pay' = 'true';
  END IF;

  -- The subsidy year settled.
  IF NULLIF(v_fx->'subsidy'->>'balance_id', '') IS NOT NULL THEN
    UPDATE public.payroll_subsidy_balances
       SET paid_out = (v_fx->'subsidy'->>'payout')::NUMERIC, paid_out_on = v_row.release_on,
           forfeited = (v_fx->'subsidy'->>'forfeited')::NUMERIC, status = 'settled_in_final_pay',
           payout_entry_id = v_entry, status_reason = 'Final pay ' || v_label, updated_at = NOW()
     WHERE id = (v_fx->'subsidy'->>'balance_id')::UUID;
  END IF;

  -- Loans the final pay could not cover: for collection.
  FOR v_left IN SELECT value FROM jsonb_array_elements(COALESCE(v_fx->'uncovered', '[]'::JSONB)) LOOP
    UPDATE public.payroll_loans
       SET status = 'suspended', status_reason = 'Separated – for collection (' || COALESCE(v_left->>'reason', '') || ')',
           status_changed_by = v_actor.id, status_changed_by_name = v_actor.full_name, status_changed_at = NOW()
     WHERE id = (v_left->>'loan_id')::UUID AND status <> 'paid';
  END LOOP;

  UPDATE public.employee_awol_cases
     SET final_pay_computed_at = v_row.submitted_at, final_pay_released_on = v_row.release_on, updated_at = NOW()
   WHERE employee_id = v_row.employee_id AND outcome = 'separated';

  UPDATE public.payroll_final_pay_submissions
     SET status = 'approved', decided_by = v_actor.id, decided_by_name = v_actor.full_name, decided_by_role = v_actor.role::TEXT,
         decided_at = v_now, entry_id = v_entry, payslip_no = v_res->>'payslip_no'
   WHERE id = p_id RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', TRUE, 'status', 'approved', 'id', v_row.id, 'entry_id', v_entry, 'payslip_no', v_row.payslip_no);
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_final_pay_decide(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_final_pay_decide(UUID, UUID, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION private.final_pay_needs_fallback(UUID) FROM PUBLIC, anon, authenticated;
