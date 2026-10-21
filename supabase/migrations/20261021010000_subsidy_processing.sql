-- Subsidy processing: the Accountant processes, HR approves (decision of 2026-10-21).
--
-- Before this, who did what depended on the kind of subsidy item:
--   * a cash subsidy advance was released by the Accountant alone (no approval);
--   * an excess advance was converted to a loan by the Accountant alone, or
--     sent to HR, who decided AND applied it (a waiver was written by HR);
--   * a missed-month adjustment was requested by the Accountant and approved
--     by HR, and a rejection closed it for good.
--
-- Now every subsidy item is one row of payroll_subsidy_requests and follows
-- one path, each step with one owner:
--
--   pending ──(Accountant processes)──► processed ──(HR)──► approved ──(payroll)──► applied
--                                            │
--                                            └──(HR rejects, reason)──► rejected ──(Accountant fixes, resubmits)──► processed
--
--   pending    an item the system raised and the Accountant has not processed
--              yet (an advance that exceeds the teacher's subsidy)
--   processed  the Accountant processed it (amounts, reason); waits for HR
--   approved   HR approved; its effect is applied by payroll (an adjustment is
--              paid on the next 16–end payslip; an excess "offset", "final pay"
--              or "collect" decision acts later)
--   rejected   HR rejected it with a reason; the Accountant edits and resubmits
--   applied    its effect is in payroll: the adjustment was paid on a payslip,
--              the advance was released, the excess was converted or waived
--
-- Kinds:
--   adjustment         missed-month subsidy adjustment (details: months_missed, months_label)
--   advance            cash subsidy advance (details: date_granted, description)
--   excess_settlement  what happens to an advance above the entitlement
--                      (details: option = convert | offset_next_subsidy | waive | final_pay | collect,
--                       plus number_of_payrolls / amortization / start_period for convert)
--
-- Who may do each step is checked in the database, not only in the app:
--   subsidy_request_process()  the Accountant only (own branch; never their own subsidy)
--   subsidy_request_decide()   HR only; never the person who processed it
--   The money records they write (a subsidy advance, an excess decision or
--   conversion, a waiver, an adjustment's approval) are refused when written
--   any other way (guard triggers below). Admin, Super Admin and Employee
--   have no step.
--
-- RLS: like every payroll table, the browser has no access at all; the app
-- reaches it only through these functions with the server key.
--
-- Additive: no existing row is changed. (Live had no subsidy balances,
-- advances or adjustments when this was written, 2026-10-21.)

-- ── 1. The requests ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_subsidy_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               TEXT NOT NULL CHECK (kind IN ('adjustment', 'advance', 'excess_settlement')),
  employee_id        UUID NOT NULL REFERENCES public.profiles(id),
  branch_id          UUID REFERENCES public.branches(id),
  subsidy_balance_id UUID NOT NULL REFERENCES public.payroll_subsidy_balances(id),
  -- excess_settlement: the subsidy advance being settled; advance: the loan opened on approval.
  loan_id            UUID REFERENCES public.payroll_loans(id),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'processed', 'approved', 'rejected', 'applied')),
  amount             NUMERIC(12, 2) CHECK (amount IS NULL OR amount > 0),
  reason             TEXT,
  details            JSONB NOT NULL DEFAULT '{}'::JSONB,
  submission_no      INTEGER NOT NULL DEFAULT 0,
  requested_by       UUID REFERENCES public.profiles(id),     -- NULL = raised by the system
  requested_by_name  TEXT NOT NULL DEFAULT 'System',
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_by       UUID REFERENCES public.profiles(id),
  processed_by_name  TEXT,
  processed_at       TIMESTAMPTZ,
  decided_by         UUID REFERENCES public.profiles(id),
  decided_by_name    TEXT,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT,
  applied_at         TIMESTAMPTZ,
  applied_note       TEXT,
  adjustment_id      UUID REFERENCES public.payroll_subsidy_adjustments(id),
  converted_loan_id  UUID REFERENCES public.payroll_loans(id),
  -- Every step, oldest first: { action, status, actor_id, actor_name, actor_role, at, note, amount, details }.
  history            JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_subsidy_requests_steps_chk CHECK (
    (status = 'pending' OR (processed_by IS NOT NULL AND processed_at IS NOT NULL AND amount IS NOT NULL))
    AND (status NOT IN ('approved', 'rejected', 'applied') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
    AND (status <> 'rejected' OR length(btrim(COALESCE(decision_note, ''))) >= 5)
    AND (decided_by IS NULL OR decided_by IS DISTINCT FROM processed_by)
  )
);

CREATE INDEX IF NOT EXISTS payroll_subsidy_requests_employee_idx ON public.payroll_subsidy_requests (employee_id, status);
CREATE INDEX IF NOT EXISTS payroll_subsidy_requests_status_idx ON public.payroll_subsidy_requests (status, kind);
CREATE INDEX IF NOT EXISTS payroll_subsidy_requests_branch_idx ON public.payroll_subsidy_requests (branch_id);
CREATE INDEX IF NOT EXISTS payroll_subsidy_requests_balance_idx ON public.payroll_subsidy_requests (subsidy_balance_id);
CREATE INDEX IF NOT EXISTS payroll_subsidy_requests_loan_idx ON public.payroll_subsidy_requests (loan_id);
CREATE INDEX IF NOT EXISTS payroll_subsidy_requests_requested_by_idx ON public.payroll_subsidy_requests (requested_by);
CREATE INDEX IF NOT EXISTS payroll_subsidy_requests_processed_by_idx ON public.payroll_subsidy_requests (processed_by);
CREATE INDEX IF NOT EXISTS payroll_subsidy_requests_decided_by_idx ON public.payroll_subsidy_requests (decided_by);
CREATE INDEX IF NOT EXISTS payroll_subsidy_requests_adjustment_idx ON public.payroll_subsidy_requests (adjustment_id);
CREATE INDEX IF NOT EXISTS payroll_subsidy_requests_converted_idx ON public.payroll_subsidy_requests (converted_loan_id);
-- One open settlement per excess advance.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_subsidy_requests_one_open_excess
  ON public.payroll_subsidy_requests (loan_id)
  WHERE kind = 'excess_settlement' AND status IN ('pending', 'processed', 'rejected');

ALTER TABLE public.payroll_subsidy_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_subsidy_requests FROM anon, authenticated;
DROP POLICY IF EXISTS payroll_subsidy_requests_no_client_access ON public.payroll_subsidy_requests;
CREATE POLICY payroll_subsidy_requests_no_client_access ON public.payroll_subsidy_requests
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- Never deleted: a decided request stays in the history.
DROP TRIGGER IF EXISTS payroll_subsidy_requests_block_hard_delete ON public.payroll_subsidy_requests;
CREATE TRIGGER payroll_subsidy_requests_block_hard_delete BEFORE DELETE ON public.payroll_subsidy_requests
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

-- Written only by the functions below.
CREATE OR REPLACE FUNCTION public.payroll_subsidy_requests_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('sacs.subsidy_flow', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Subsidy requests change only through subsidy processing (the Accountant processes, HR approves).'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payroll_subsidy_requests_guard ON public.payroll_subsidy_requests;
CREATE TRIGGER payroll_subsidy_requests_guard BEFORE INSERT OR UPDATE ON public.payroll_subsidy_requests
  FOR EACH ROW EXECUTE FUNCTION public.payroll_subsidy_requests_guard();

-- ── 2. The money records follow the flow ──────────────────────────────────
-- 'sacs.subsidy_apply' is set (transaction-local) only by subsidy_request_decide().

-- A subsidy advance opens, or an excess advance gets its decision / conversion,
-- only when HR approves the Accountant's request.
CREATE OR REPLACE FUNCTION public.payroll_loans_subsidy_flow_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_flow BOOLEAN := COALESCE(current_setting('sacs.subsidy_apply', true), '') = 'on'
                    OR COALESCE(current_setting('sacs.subsidy_flow', true), '') = 'on';
BEGIN
  IF v_flow THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.loan_type = 'subsidy_advance' THEN
      RAISE EXCEPTION 'A subsidy advance is released only when HR approves it (Accountant processes it in Subsidies).'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.loan_type = 'subsidy_advance'
     AND (NEW.decision, NEW.decision_reason, NEW.decision_recommended_by, NEW.decision_approved_by,
          NEW.decision_approved_at, NEW.converted_to_loan_id, NEW.awaiting_decision, NEW.consent_refused_at)
         IS DISTINCT FROM
         (OLD.decision, OLD.decision_reason, OLD.decision_recommended_by, OLD.decision_approved_by,
          OLD.decision_approved_at, OLD.converted_to_loan_id, OLD.awaiting_decision, OLD.consent_refused_at) THEN
    RAISE EXCEPTION 'An excess subsidy advance is settled only through subsidy processing (Accountant processes, HR approves).'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
-- "aa_": triggers fire in name order, and this one must refuse before the
-- others act (payroll_loans_open books the advance against the balance).
DROP TRIGGER IF EXISTS payroll_loans_aa_subsidy_flow_guard ON public.payroll_loans;
CREATE TRIGGER payroll_loans_aa_subsidy_flow_guard BEFORE INSERT OR UPDATE ON public.payroll_loans
  FOR EACH ROW EXECUTE FUNCTION public.payroll_loans_subsidy_flow_guard();

-- A waiver or a conversion of a subsidy advance is written only on HR's approval.
CREATE OR REPLACE FUNCTION public.payroll_loan_payments_subsidy_flow_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.kind IN ('waiver', 'converted')
     AND COALESCE(current_setting('sacs.subsidy_apply', true), '') <> 'on'
     AND EXISTS (SELECT 1 FROM public.payroll_loans l WHERE l.id = NEW.loan_id AND l.loan_type = 'subsidy_advance') THEN
    RAISE EXCEPTION 'A subsidy advance is waived or converted only when HR approves the Accountant''s settlement.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payroll_loan_payments_aa_subsidy_flow_guard ON public.payroll_loan_payments;
CREATE TRIGGER payroll_loan_payments_aa_subsidy_flow_guard BEFORE INSERT ON public.payroll_loan_payments
  FOR EACH ROW EXECUTE FUNCTION public.payroll_loan_payments_subsidy_flow_guard();

-- An adjustment is created and decided only through the flow; payroll still
-- marks an approved one 'applied' when it pays it (payroll_commit_entries).
CREATE OR REPLACE FUNCTION public.payroll_subsidy_adjustments_flow_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('sacs.subsidy_apply', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR NEW.status IN ('approved', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A missed-month adjustment is created and decided only through subsidy processing (Accountant processes, HR approves).'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payroll_subsidy_adjustments_aa_flow_guard ON public.payroll_subsidy_adjustments;
CREATE TRIGGER payroll_subsidy_adjustments_aa_flow_guard BEFORE INSERT OR UPDATE ON public.payroll_subsidy_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.payroll_subsidy_adjustments_flow_guard();

-- When payroll pays an approved adjustment, its request reads "Applied to payroll".
CREATE OR REPLACE FUNCTION public.payroll_subsidy_adjustments_mark_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied' THEN
    PERFORM set_config('sacs.subsidy_flow', 'on', true);
    UPDATE public.payroll_subsidy_requests r
    SET status = 'applied', applied_at = NOW(),
        applied_note = format('Paid on the %s payslip', to_char(NEW.applied_period_start, 'Mon DD, YYYY')),
        history = r.history || jsonb_build_array(jsonb_build_object(
          'action', 'applied', 'status', 'applied', 'actor_id', NULL, 'actor_name', 'Payroll', 'actor_role', 'system',
          'at', NOW(), 'note', format('Paid on the payslip from %s', to_char(NEW.applied_period_start, 'Mon DD, YYYY'))))
    WHERE r.adjustment_id = NEW.id AND r.status = 'approved';
    PERFORM set_config('sacs.subsidy_flow', '', true);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payroll_subsidy_adjustments_mark_request ON public.payroll_subsidy_adjustments;
CREATE TRIGGER payroll_subsidy_adjustments_mark_request AFTER UPDATE OF status ON public.payroll_subsidy_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.payroll_subsidy_adjustments_mark_request();

-- ── 3. The steps ───────────────────────────────────────────────────────────

-- The system raises a pending settlement for every unsettled subsidy advance
-- whose teacher's advances exceed the entitlement. Idempotent.
CREATE OR REPLACE FUNCTION public.subsidy_requests_raise_excess(p_employee_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  PERFORM set_config('sacs.subsidy_flow', 'on', true);
  INSERT INTO public.payroll_subsidy_requests (kind, employee_id, branch_id, subsidy_balance_id, loan_id, status, amount, history)
  SELECT 'excess_settlement', l.employee_id, l.branch_id, l.subsidy_balance_id, l.id, 'pending',
         LEAST(-b.remaining, l.remaining_balance),
         jsonb_build_array(jsonb_build_object('action', 'raised', 'status', 'pending', 'actor_id', NULL, 'actor_name', 'System',
           'actor_role', 'system', 'at', NOW(), 'amount', LEAST(-b.remaining, l.remaining_balance),
           'note', 'The advances are more than the teacher''s subsidy: the excess needs settling.'))
  FROM public.payroll_loans l
  JOIN public.payroll_subsidy_balances b ON b.id = l.subsidy_balance_id
  WHERE l.loan_type = 'subsidy_advance' AND l.status <> 'paid' AND l.remaining_balance > 0
    AND l.converted_to_loan_id IS NULL AND l.decision_approved_at IS NULL
    AND b.remaining < 0
    AND (p_employee_ids IS NULL OR l.employee_id = ANY (p_employee_ids))
    AND NOT EXISTS (SELECT 1 FROM public.payroll_subsidy_requests r
                    WHERE r.loan_id = l.id AND r.kind = 'excess_settlement' AND r.status IN ('pending', 'processed', 'rejected', 'approved'));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('sacs.subsidy_flow', '', true);
  RETURN v_count;
END;
$$;

-- The Accountant processes a new item (p_request_id NULL) or a pending /
-- rejected one (resubmit). Returns the request.
CREATE OR REPLACE FUNCTION public.subsidy_request_process(
  p_actor UUID, p_request_id UUID, p_kind TEXT, p_employee_id UUID, p_balance_id UUID,
  p_loan_id UUID, p_amount NUMERIC, p_reason TEXT, p_details JSONB)
RETURNS public.payroll_subsidy_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   RECORD;
  v_req     public.payroll_subsidy_requests;
  v_person  public.profiles;
  v_bal     public.payroll_subsidy_balances;
  v_loan    public.payroll_loans;
  v_reason  TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_details JSONB := COALESCE(p_details, '{}'::JSONB);
  v_amount  NUMERIC(12, 2) := round(COALESCE(p_amount, 0), 2);
  v_kind    TEXT := p_kind;
  v_months  INTEGER;
  v_other   INTEGER;
  v_option  TEXT;
  v_hr      UUID[];
BEGIN
  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  IF v_actor.id IS NULL OR v_actor.role <> 'accountant' THEN
    RAISE EXCEPTION 'forbidden: only the Accountant processes a subsidy.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM public.payroll_subsidy_requests WHERE id = p_request_id FOR UPDATE;
    IF v_req.id IS NULL THEN RAISE EXCEPTION 'not_found: no such subsidy request.' USING ERRCODE = 'no_data_found'; END IF;
    IF v_req.status NOT IN ('pending', 'rejected') THEN
      RAISE EXCEPTION 'invalid_transition: this request is % and cannot be processed again.', v_req.status USING ERRCODE = 'check_violation';
    END IF;
    v_kind := v_req.kind;
    p_employee_id := v_req.employee_id;
    p_balance_id := v_req.subsidy_balance_id;
    p_loan_id := CASE WHEN v_req.kind = 'excess_settlement' THEN v_req.loan_id ELSE NULL END;
  END IF;

  IF v_kind NOT IN ('adjustment', 'advance', 'excess_settlement') THEN
    RAISE EXCEPTION 'invalid: unknown subsidy item.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_person FROM public.profiles WHERE id = p_employee_id;
  IF v_person.id IS NULL THEN RAISE EXCEPTION 'not_found: no such employee.' USING ERRCODE = 'no_data_found'; END IF;
  IF v_person.id = v_actor.id THEN
    RAISE EXCEPTION 'forbidden: you cannot process your own subsidy.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.branch_id IS NOT NULL AND v_person.branch_id IS DISTINCT FROM v_actor.branch_id THEN
    RAISE EXCEPTION 'forbidden: that teacher is not in your branch.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_bal FROM public.payroll_subsidy_balances WHERE id = p_balance_id;
  IF v_bal.id IS NULL OR v_bal.employee_id <> v_person.id THEN
    RAISE EXCEPTION 'invalid: the subsidy balance does not belong to this teacher.' USING ERRCODE = 'check_violation';
  END IF;

  IF v_kind = 'adjustment' THEN
    v_months := NULLIF(v_details->>'months_missed', '')::INTEGER;
    IF v_months IS NULL OR v_months NOT BETWEEN 1 AND 12 THEN
      RAISE EXCEPTION 'invalid: months missed must be 1 to 12.' USING ERRCODE = 'check_violation';
    END IF;
    IF length(btrim(COALESCE(v_details->>'months_label', ''))) = 0 THEN
      RAISE EXCEPTION 'invalid: name the months (e.g. May–Jul 2027).' USING ERRCODE = 'check_violation';
    END IF;
    IF v_amount <= 0 OR v_amount > round(v_bal.annual_amount * v_months / 12.0, 2) THEN
      RAISE EXCEPTION 'invalid: the adjustment must be more than ₱0 and at most % month(s) of the % subsidy.', v_months, v_bal.annual_amount
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM((r.details->>'months_missed')::INTEGER), 0) INTO v_other
    FROM public.payroll_subsidy_requests r
    WHERE r.subsidy_balance_id = v_bal.id AND r.kind = 'adjustment' AND r.status IN ('processed', 'approved', 'applied')
      AND r.id IS DISTINCT FROM p_request_id;
    IF v_bal.eligible_months + v_other + v_months > 12 THEN
      RAISE EXCEPTION 'invalid: counted and adjusted months cannot exceed 12 (counted %, already adjusted %).', v_bal.eligible_months, v_other
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_reason IS NULL OR length(v_reason) < 10 THEN
      RAISE EXCEPTION 'invalid: give the reason (at least 10 characters).' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_kind = 'advance' THEN
    IF v_bal.status <> 'open' THEN RAISE EXCEPTION 'invalid: no open subsidy balance for this teacher.' USING ERRCODE = 'check_violation'; END IF;
    IF v_amount <= 0 THEN RAISE EXCEPTION 'invalid: enter the advance amount.' USING ERRCODE = 'check_violation'; END IF;
    IF NULLIF(v_details->>'date_granted', '') IS NULL THEN
      RAISE EXCEPTION 'invalid: enter the date the advance is released.' USING ERRCODE = 'check_violation';
    END IF;
    IF v_amount > v_bal.remaining THEN
      RAISE EXCEPTION 'invalid: the advance % is more than the subsidy balance available (%).', v_amount, GREATEST(v_bal.remaining, 0)
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO v_loan FROM public.payroll_loans WHERE id = p_loan_id FOR UPDATE;
    IF v_loan.id IS NULL OR v_loan.loan_type <> 'subsidy_advance' OR v_loan.employee_id <> v_person.id
       OR v_loan.status = 'paid' OR v_loan.remaining_balance <= 0 OR v_loan.converted_to_loan_id IS NOT NULL
       OR v_loan.decision_approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'invalid: only an unsettled subsidy advance has an excess to settle.' USING ERRCODE = 'check_violation';
    END IF;
    IF v_bal.remaining >= 0 THEN
      RAISE EXCEPTION 'invalid: this advance is still covered by the teacher''s subsidy: nothing to settle.' USING ERRCODE = 'check_violation';
    END IF;
    IF p_request_id IS NULL AND EXISTS (SELECT 1 FROM public.payroll_subsidy_requests r
        WHERE r.loan_id = v_loan.id AND r.kind = 'excess_settlement' AND r.status = 'processed') THEN
      RAISE EXCEPTION 'invalid_transition: this excess is already processed and waiting for HR.' USING ERRCODE = 'check_violation';
    END IF;
    v_amount := LEAST(-v_bal.remaining, v_loan.remaining_balance);
    v_option := v_details->>'option';
    IF v_option NOT IN ('convert', 'offset_next_subsidy', 'waive', 'final_pay', 'collect') THEN
      RAISE EXCEPTION 'invalid: choose how the excess is settled.' USING ERRCODE = 'check_violation';
    END IF;
    IF v_option = 'convert' AND COALESCE((v_details->>'consent_signed')::BOOLEAN, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'invalid: converting to a salary deduction needs the teacher''s signed consent.' USING ERRCODE = 'check_violation';
    END IF;
    IF v_reason IS NULL OR length(v_reason) < 10 THEN
      RAISE EXCEPTION 'invalid: give the reason (at least 10 characters).' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM set_config('sacs.subsidy_flow', 'on', true);

  -- An excess the teacher did not consent to deduct is held while HR decides.
  IF v_kind = 'excess_settlement' AND v_option <> 'convert' AND NOT v_loan.awaiting_decision THEN
    UPDATE public.payroll_loans
    SET status = 'suspended', awaiting_decision = TRUE, consent_refused_at = COALESCE(consent_refused_at, NOW()),
        status_reason = format('Consent refused: %s', v_reason), status_changed_by = v_actor.id,
        status_changed_by_name = v_actor.full_name, status_changed_at = NOW()
    WHERE id = v_loan.id;
  END IF;

  IF v_req.id IS NULL THEN
    -- A settlement the system already raised is processed, not duplicated.
    IF v_kind = 'excess_settlement' THEN
      SELECT * INTO v_req FROM public.payroll_subsidy_requests
      WHERE loan_id = v_loan.id AND kind = 'excess_settlement' AND status IN ('pending', 'rejected') FOR UPDATE;
    END IF;
  END IF;

  IF v_req.id IS NULL THEN
    INSERT INTO public.payroll_subsidy_requests (kind, employee_id, branch_id, subsidy_balance_id, loan_id, status, amount, reason,
      details, submission_no, requested_by, requested_by_name, requested_at, processed_by, processed_by_name, processed_at, history)
    VALUES (v_kind, v_person.id, v_person.branch_id, v_bal.id, CASE WHEN v_kind = 'excess_settlement' THEN v_loan.id END,
      'processed', v_amount, v_reason, v_details, 1, v_actor.id, v_actor.full_name, NOW(), v_actor.id, v_actor.full_name, NOW(),
      jsonb_build_array(jsonb_build_object('action', 'processed', 'status', 'processed', 'actor_id', v_actor.id,
        'actor_name', v_actor.full_name, 'actor_role', 'accountant', 'at', NOW(), 'amount', v_amount, 'note', v_reason, 'details', v_details)))
    RETURNING * INTO v_req;
  ELSE
    UPDATE public.payroll_subsidy_requests r
    SET status = 'processed', amount = v_amount, reason = v_reason, details = v_details, submission_no = r.submission_no + 1,
        processed_by = v_actor.id, processed_by_name = v_actor.full_name, processed_at = NOW(),
        decided_by = NULL, decided_by_name = NULL, decided_at = NULL,
        history = r.history || jsonb_build_array(jsonb_build_object('action', CASE WHEN r.status = 'rejected' THEN 'resubmitted' ELSE 'processed' END,
          'status', 'processed', 'actor_id', v_actor.id, 'actor_name', v_actor.full_name, 'actor_role', 'accountant',
          'at', NOW(), 'amount', v_amount, 'note', v_reason, 'details', v_details))
    WHERE r.id = v_req.id
    RETURNING * INTO v_req;
  END IF;

  PERFORM set_config('sacs.subsidy_flow', '', true);

  -- HR is told a subsidy is waiting.
  SELECT array_agg(id) INTO v_hr FROM public.profiles WHERE role::TEXT = 'hr' AND COALESCE(archived, FALSE) = FALSE;
  PERFORM public.payroll_run_notify(v_hr, 'subsidy_processed',
    format('Subsidy to approve · %s', COALESCE(NULLIF(v_person.full_name, ''), v_person.email)),
    format('%s, ₱%s, processed by %s.',
      CASE v_kind WHEN 'adjustment' THEN 'Missed-month adjustment' WHEN 'advance' THEN 'Subsidy advance' ELSE 'Excess advance settlement' END,
      to_char(v_amount, 'FM999,999,990.00'), v_actor.full_name),
    'hr-subsidy-approvals', NULL);
  RETURN v_req;
END;
$$;

-- HR approves (and the system applies what can be applied now) or rejects.
CREATE OR REPLACE FUNCTION public.subsidy_request_decide(p_actor UUID, p_request_id UUID, p_decision TEXT, p_note TEXT)
RETURNS public.payroll_subsidy_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   RECORD;
  v_req     public.payroll_subsidy_requests;
  v_person  public.profiles;
  v_note    TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_status  TEXT;
  v_option  TEXT;
  v_applied TEXT;
  v_adj     UUID;
  v_loan    UUID;
  v_new     UUID;
  v_payrolls INTEGER;
  v_amort   NUMERIC(12, 2);
  v_label   TEXT;
BEGIN
  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  IF v_actor.id IS NULL OR v_actor.role <> 'hr' THEN
    RAISE EXCEPTION 'forbidden: only HR approves or rejects a subsidy.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_req FROM public.payroll_subsidy_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN RAISE EXCEPTION 'not_found: no such subsidy request.' USING ERRCODE = 'no_data_found'; END IF;
  IF v_req.status <> 'processed' THEN
    RAISE EXCEPTION 'invalid_transition: this request is % (only a processed one is decided).', v_req.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_req.processed_by = v_actor.id THEN
    RAISE EXCEPTION 'forbidden: you processed this subsidy, so someone else must decide it.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'invalid: approve or reject.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'reject' AND (v_note IS NULL OR length(v_note) < 5) THEN
    RAISE EXCEPTION 'remarks_required: write the reason for rejecting (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_person FROM public.profiles WHERE id = v_req.employee_id;
  v_label := COALESCE(NULLIF(v_person.full_name, ''), v_person.email);

  PERFORM set_config('sacs.subsidy_flow', 'on', true);

  IF p_decision = 'reject' THEN
    UPDATE public.payroll_subsidy_requests r
    SET status = 'rejected', decided_by = v_actor.id, decided_by_name = v_actor.full_name, decided_at = NOW(), decision_note = v_note,
        history = r.history || jsonb_build_array(jsonb_build_object('action', 'rejected', 'status', 'rejected', 'actor_id', v_actor.id,
          'actor_name', v_actor.full_name, 'actor_role', 'hr', 'at', NOW(), 'note', v_note))
    WHERE r.id = v_req.id RETURNING * INTO v_req;
    PERFORM set_config('sacs.subsidy_flow', '', true);
    PERFORM public.payroll_run_notify(ARRAY[v_req.processed_by], 'subsidy_rejected',
      format('Subsidy rejected · %s', v_label),
      format('Rejected by %s: %s Fix it and resubmit in Subsidies.', v_actor.full_name, v_note),
      'ac-approvals', NULL);
    RETURN v_req;
  END IF;

  -- Approve, and apply what takes effect now.
  PERFORM set_config('sacs.subsidy_apply', 'on', true);
  v_status := 'approved';
  IF v_req.kind = 'adjustment' THEN
    INSERT INTO public.payroll_subsidy_adjustments (employee_id, subsidy_balance_id, months_missed, months_label, amount, reason,
      status, requested_by, requested_by_name, requested_at)
    VALUES (v_req.employee_id, v_req.subsidy_balance_id, (v_req.details->>'months_missed')::SMALLINT, v_req.details->>'months_label',
      v_req.amount, v_req.reason, 'pending', v_req.processed_by, v_req.processed_by_name, v_req.processed_at)
    RETURNING id INTO v_adj;
    UPDATE public.payroll_subsidy_adjustments
    SET status = 'approved', decided_by = v_actor.id, decided_by_name = v_actor.full_name, decided_by_role = 'hr',
        decided_at = NOW(), decision_note = v_note
    WHERE id = v_adj;
    v_applied := 'Paid on the next 16–end payslip';
  ELSIF v_req.kind = 'advance' THEN
    INSERT INTO public.payroll_loans (employee_id, branch_id, loan_type, description, date_granted, principal, subsidy_balance_id,
      final_pay_authorized, created_by, created_by_name)
    VALUES (v_req.employee_id, v_person.branch_id, 'subsidy_advance',
      COALESCE(NULLIF(btrim(v_req.details->>'description'), ''), format('Subsidy advance (approved by %s)', v_actor.full_name)),
      (v_req.details->>'date_granted')::DATE, v_req.amount, v_req.subsidy_balance_id,
      COALESCE((v_req.details->>'final_pay_authorized')::BOOLEAN, TRUE), v_req.processed_by, v_req.processed_by_name)
    RETURNING id INTO v_loan;
    v_status := 'applied';
    v_applied := 'Advance released; not deducted from salary';
  ELSE
    v_option := v_req.details->>'option';
    IF v_option = 'convert' THEN
      v_payrolls := GREATEST(1, COALESCE(NULLIF(v_req.details->>'number_of_payrolls', '')::INTEGER, 1));
      v_amort := COALESCE(NULLIF(v_req.details->>'amortization', '')::NUMERIC, ceil(v_req.amount * 100 / v_payrolls) / 100);
      INSERT INTO public.payroll_loans (employee_id, branch_id, loan_type, description, date_granted, principal, interest_pct,
        number_of_payrolls, amortization, start_period, final_pay_authorized, created_by, created_by_name)
      VALUES (v_req.employee_id, v_person.branch_id, 'cash_advance', 'Excess subsidy advance (signed consent)', CURRENT_DATE,
        v_req.amount, 0, v_payrolls, LEAST(v_amort, v_req.amount), (v_req.details->>'start_period')::DATE, TRUE,
        v_req.processed_by, v_req.processed_by_name)
      RETURNING id INTO v_new;
      UPDATE public.payroll_loans SET converted_to_loan_id = v_new, awaiting_decision = FALSE WHERE id = v_req.loan_id;
      INSERT INTO public.payroll_loan_payments (loan_id, employee_id, kind, amount, amount_due, note, created_by, created_by_name)
      VALUES (v_req.loan_id, v_req.employee_id, 'converted', v_req.amount, v_req.amount,
        format('Converted to a cash advance with the teacher''s signed consent (approved by %s)', v_actor.full_name),
        v_req.processed_by, v_req.processed_by_name);
      v_status := 'applied';
      v_applied := 'Converted to a cash advance, deducted on 16–end payslips';
    ELSE
      UPDATE public.payroll_loans
      SET decision = v_option, decision_reason = v_req.reason,
          decision_recommended_by = v_req.processed_by, decision_recommended_by_name = v_req.processed_by_name,
          decision_recommended_at = v_req.processed_at,
          decision_approved_by = v_actor.id, decision_approved_by_name = v_actor.full_name, decision_approved_at = NOW(),
          status_reason = format('%s (processed by %s, approved by %s): %s',
            CASE v_option WHEN 'offset_next_subsidy' THEN 'Offset against next year''s subsidy' WHEN 'waive' THEN 'Waived'
              WHEN 'final_pay' THEN 'Recover from final pay' ELSE 'Referred for collection' END,
            v_req.processed_by_name, v_actor.full_name, v_req.reason)
      WHERE id = v_req.loan_id;
      IF v_option = 'waive' THEN
        INSERT INTO public.payroll_loan_payments (loan_id, employee_id, kind, amount, amount_due, note, created_by, created_by_name)
        SELECT l.id, l.employee_id, 'waiver', l.remaining_balance, l.remaining_balance, format('Waived: %s', v_req.reason),
               v_actor.id, v_actor.full_name
        FROM public.payroll_loans l WHERE l.id = v_req.loan_id AND l.remaining_balance > 0;
        v_status := 'applied';
        v_applied := 'Waived (written off)';
      ELSE
        v_applied := CASE v_option WHEN 'offset_next_subsidy' THEN 'Taken from next year''s subsidy payout'
          WHEN 'final_pay' THEN 'Recovered from final pay on separation' ELSE 'Collected outside payroll' END;
      END IF;
    END IF;
  END IF;
  PERFORM set_config('sacs.subsidy_apply', '', true);

  UPDATE public.payroll_subsidy_requests r
  SET status = v_status, decided_by = v_actor.id, decided_by_name = v_actor.full_name, decided_at = NOW(), decision_note = v_note,
      adjustment_id = COALESCE(v_adj, r.adjustment_id),
      loan_id = COALESCE(r.loan_id, v_loan), converted_loan_id = COALESCE(v_new, r.converted_loan_id),
      applied_at = CASE WHEN v_status = 'applied' THEN NOW() END, applied_note = v_applied,
      history = r.history || jsonb_build_array(jsonb_build_object('action', 'approved', 'status', 'approved', 'actor_id', v_actor.id,
        'actor_name', v_actor.full_name, 'actor_role', 'hr', 'at', NOW(), 'note', v_note))
        || CASE WHEN v_status = 'applied' THEN jsonb_build_array(jsonb_build_object('action', 'applied', 'status', 'applied',
             'actor_id', NULL, 'actor_name', 'Payroll', 'actor_role', 'system', 'at', NOW(), 'note', v_applied)) ELSE '[]'::JSONB END
  WHERE r.id = v_req.id RETURNING * INTO v_req;
  PERFORM set_config('sacs.subsidy_flow', '', true);

  PERFORM public.payroll_run_notify(ARRAY[v_req.processed_by], 'subsidy_approved',
    format('Subsidy approved · %s', v_label),
    format('Approved by %s. %s.', v_actor.full_name, v_applied),
    'ac-approvals', NULL);
  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.subsidy_request_process(UUID, UUID, TEXT, UUID, UUID, UUID, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subsidy_request_decide(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subsidy_requests_raise_excess(UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_subsidy_requests_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_loans_subsidy_flow_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_loan_payments_subsidy_flow_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_subsidy_adjustments_flow_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_subsidy_adjustments_mark_request() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.subsidy_request_process(UUID, UUID, TEXT, UUID, UUID, UUID, NUMERIC, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.subsidy_request_decide(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.subsidy_requests_raise_excess(UUID[]) TO service_role;
