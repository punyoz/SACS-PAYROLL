-- Payroll corrections after approval (scenarios AC-06 / AC-08, decision
-- 2026-10-22). An approved run stays locked for good; a payslip found wrong
-- afterwards is corrected on a LATER payslip, never by changing it:
--
--   1. The Accountant files a correction against an approved payslip: an
--      underpayment (paid too little, e.g. a retroactive raise) or an
--      overpayment (paid too much), the amount and the reason.
--   2. HR (never the person who filed it) approves or rejects it; a rejected
--      one goes back to the Accountant to fix and resubmit, and stays on record.
--   3. Approval applies it through what payroll already pays:
--        underpayment -> an incentive item ("Correction — <period>: <reason>"),
--                        paid on the employee's next monthly payroll;
--        overpayment  -> a recovery deduction (payroll_loans, type 'other'),
--                        deducted from the next 2nd-half payslip(s).
--      The correction keeps the id of what it created.
--
-- Additive: one table, three functions. Nothing existing is changed.

CREATE TABLE IF NOT EXISTS public.payroll_corrections (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id        UUID NOT NULL REFERENCES public.profiles(id),
  branch_id          UUID REFERENCES public.branches(id),
  entry_id           UUID NOT NULL REFERENCES public.payroll_entries(id),
  period_label       TEXT NOT NULL,
  payslip_no         TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('underpayment', 'overpayment')),
  amount             NUMERIC(12, 2) NOT NULL CHECK (amount > 0 AND amount <= 9999999.99),
  -- Overpayment only: how many 2nd-half payslips the recovery is spread over.
  payrolls           INTEGER NOT NULL DEFAULT 1 CHECK (payrolls BETWEEN 1 AND 24),
  reason             TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by       UUID REFERENCES public.profiles(id),
  requested_by_name  TEXT,
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by         UUID REFERENCES public.profiles(id),
  decided_by_name    TEXT,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT,
  applied_incentive_id UUID REFERENCES public.payroll_monthly_incentives(id),
  applied_loan_id    UUID REFERENCES public.payroll_loans(id),
  -- Every step: { at, action, by, by_name, role, note, amount, kind }.
  history            JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_corrections_applied_chk CHECK (
    status <> 'approved' OR (applied_incentive_id IS NOT NULL) <> (applied_loan_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS payroll_corrections_status_idx ON public.payroll_corrections (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS payroll_corrections_employee_idx ON public.payroll_corrections (employee_id);
CREATE INDEX IF NOT EXISTS payroll_corrections_branch_idx ON public.payroll_corrections (branch_id);
CREATE INDEX IF NOT EXISTS payroll_corrections_entry_idx ON public.payroll_corrections (entry_id);
CREATE INDEX IF NOT EXISTS payroll_corrections_requested_by_idx ON public.payroll_corrections (requested_by);
CREATE INDEX IF NOT EXISTS payroll_corrections_decided_by_idx ON public.payroll_corrections (decided_by);
CREATE INDEX IF NOT EXISTS payroll_corrections_incentive_idx ON public.payroll_corrections (applied_incentive_id);
CREATE INDEX IF NOT EXISTS payroll_corrections_loan_idx ON public.payroll_corrections (applied_loan_id);

-- Server only (the API uses the service role after its own permission check).
ALTER TABLE public.payroll_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_corrections FROM anon, authenticated;
DROP POLICY IF EXISTS payroll_corrections_no_client_access ON public.payroll_corrections;
CREATE POLICY payroll_corrections_no_client_access ON public.payroll_corrections
  FOR ALL TO anon, authenticated USING (FALSE) WITH CHECK (FALSE);

-- Kept for good: a correction is cancelled or rejected, never deleted.
DROP TRIGGER IF EXISTS payroll_corrections_block_hard_delete ON public.payroll_corrections;
CREATE TRIGGER payroll_corrections_block_hard_delete BEFORE DELETE ON public.payroll_corrections
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

-- One history step.
CREATE OR REPLACE FUNCTION public.payroll_correction_step(p_action TEXT, p_actor public.profiles, p_note TEXT, p_kind TEXT, p_amount NUMERIC)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_array(jsonb_build_object(
    'at', NOW(), 'action', p_action, 'by', p_actor.id, 'by_name', p_actor.full_name, 'role', p_actor.role::TEXT,
    'note', p_note, 'kind', p_kind, 'amount', p_amount));
$$;

/*
 * The Accountant files a correction against an APPROVED payslip of its own
 * branch, never its own payslip. One open correction per payslip at a time.
 */
CREATE OR REPLACE FUNCTION public.payroll_correction_file(
  p_actor UUID, p_entry UUID, p_kind TEXT, p_amount NUMERIC, p_payrolls INTEGER, p_reason TEXT
) RETURNS public.payroll_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.profiles;
  v_entry public.payroll_entries;
  v_run_status TEXT;
  v_row public.payroll_corrections;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id = p_actor;
  IF v_actor.id IS NULL OR v_actor.role::TEXT <> 'accountant' OR COALESCE(v_actor.archived, FALSE) THEN
    RAISE EXCEPTION 'forbidden: only the Accountant files a payroll correction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_entry FROM public.payroll_entries WHERE id = p_entry;
  IF v_entry.id IS NULL THEN RAISE EXCEPTION 'not_found: no such payslip.' USING ERRCODE = 'no_data_found'; END IF;
  IF v_entry.employee_id = v_actor.id THEN
    RAISE EXCEPTION 'forbidden: you cannot file a correction to your own payslip.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.branch_id IS NULL OR v_entry.branch_id IS DISTINCT FROM v_actor.branch_id THEN
    RAISE EXCEPTION 'forbidden: that payslip is not your branch''s.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO v_run_status FROM public.payroll_runs WHERE id = v_entry.run_id;
  IF v_entry.status::TEXT <> 'paid' OR COALESCE(v_run_status, '') <> 'approved' THEN
    RAISE EXCEPTION 'invalid: only a payslip HR approved is corrected this way; a payslip not yet approved is reprocessed instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind NOT IN ('underpayment', 'overpayment') THEN
    RAISE EXCEPTION 'invalid: choose underpayment or overpayment.' USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(p_amount, 0) <= 0 THEN RAISE EXCEPTION 'invalid: enter the amount.' USING ERRCODE = 'check_violation'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'reason_required: give the reason (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payroll_corrections c WHERE c.entry_id = p_entry AND c.status IN ('pending', 'rejected')) THEN
    RAISE EXCEPTION 'duplicate: this payslip already has a correction waiting; fix or wait for that one.' USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.payroll_corrections (employee_id, branch_id, entry_id, period_label, payslip_no, kind, amount, payrolls, reason,
    requested_by, requested_by_name, history)
  VALUES (v_entry.employee_id, v_entry.branch_id, v_entry.id, v_entry.pay_period, v_entry.payslip_no, p_kind, ROUND(p_amount, 2),
    CASE WHEN p_kind = 'overpayment' THEN GREATEST(1, LEAST(24, COALESCE(p_payrolls, 1))) ELSE 1 END, btrim(p_reason),
    v_actor.id, v_actor.full_name, public.payroll_correction_step('filed', v_actor, btrim(p_reason), p_kind, ROUND(p_amount, 2)))
  RETURNING * INTO v_row;

  PERFORM public.payroll_run_notify(ARRAY(SELECT id FROM public.profiles WHERE role::TEXT = 'hr' AND NOT COALESCE(archived, FALSE)),
    'payroll_correction', 'Payroll correction to approve',
    format('%s: %s of %s for %s (%s).', v_actor.full_name, p_kind, to_char(v_row.amount, 'FM999,999,990.00'), v_entry.employee_name, v_entry.pay_period),
    'hr-payroll-approval', v_entry.run_id);
  RETURN v_row;
END;
$$;

/* The Accountant fixes a REJECTED correction and sends it to HR again. */
CREATE OR REPLACE FUNCTION public.payroll_correction_resubmit(
  p_actor UUID, p_id UUID, p_kind TEXT, p_amount NUMERIC, p_payrolls INTEGER, p_reason TEXT
) RETURNS public.payroll_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.profiles;
  v_row public.payroll_corrections;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id = p_actor;
  IF v_actor.id IS NULL OR v_actor.role::TEXT <> 'accountant' OR COALESCE(v_actor.archived, FALSE) THEN
    RAISE EXCEPTION 'forbidden: only the Accountant resubmits a payroll correction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_row FROM public.payroll_corrections WHERE id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'not_found: no such correction.' USING ERRCODE = 'no_data_found'; END IF;
  IF v_row.branch_id IS DISTINCT FROM v_actor.branch_id OR v_row.employee_id = v_actor.id THEN
    RAISE EXCEPTION 'forbidden: that correction is not yours to resubmit.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_row.status <> 'rejected' THEN
    RAISE EXCEPTION 'invalid_transition: only a rejected correction is resubmitted (this one is %).', v_row.status USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind NOT IN ('underpayment', 'overpayment') OR COALESCE(p_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'invalid: choose the kind and enter the amount.' USING ERRCODE = 'check_violation';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'reason_required: give the reason (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.payroll_corrections
     SET kind = p_kind, amount = ROUND(p_amount, 2),
         payrolls = CASE WHEN p_kind = 'overpayment' THEN GREATEST(1, LEAST(24, COALESCE(p_payrolls, 1))) ELSE 1 END,
         reason = btrim(p_reason), status = 'pending', requested_by = v_actor.id, requested_by_name = v_actor.full_name,
         requested_at = NOW(), decided_by = NULL, decided_by_name = NULL, decided_at = NULL, decision_note = NULL,
         history = history || public.payroll_correction_step('resubmitted', v_actor, btrim(p_reason), p_kind, ROUND(p_amount, 2)),
         updated_at = NOW()
   WHERE id = p_id
  RETURNING * INTO v_row;

  PERFORM public.payroll_run_notify(ARRAY(SELECT id FROM public.profiles WHERE role::TEXT = 'hr' AND NOT COALESCE(archived, FALSE)),
    'payroll_correction', 'Payroll correction resubmitted',
    format('%s resubmitted the correction for %s (%s).', v_actor.full_name, (SELECT full_name FROM public.profiles WHERE id = v_row.employee_id), v_row.period_label),
    'hr-payroll-approval', NULL);
  RETURN v_row;
END;
$$;

/*
 * HR approves or rejects a pending correction (never one it filed). Approval
 * creates what pays or recovers it, in the same transaction.
 */
CREATE OR REPLACE FUNCTION public.payroll_correction_decide(p_actor UUID, p_id UUID, p_action TEXT, p_note TEXT)
RETURNS public.payroll_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.profiles;
  v_row public.payroll_corrections;
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_start DATE;
  v_text TEXT;
  v_incentive UUID;
  v_loan UUID;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id = p_actor;
  IF v_actor.id IS NULL OR v_actor.role::TEXT <> 'hr' OR COALESCE(v_actor.archived, FALSE) THEN
    RAISE EXCEPTION 'forbidden: only HR approves or rejects a payroll correction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_row FROM public.payroll_corrections WHERE id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'not_found: no such correction.' USING ERRCODE = 'no_data_found'; END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_transition: this correction is % already.', v_row.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.requested_by = v_actor.id OR v_row.employee_id = v_actor.id THEN
    RAISE EXCEPTION 'forbidden: you cannot decide this correction.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_action = 'reject' THEN
    IF length(btrim(COALESCE(p_note, ''))) < 5 THEN
      RAISE EXCEPTION 'reason_required: give the reason for rejecting (at least 5 characters).' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.payroll_corrections
       SET status = 'rejected', decided_by = v_actor.id, decided_by_name = v_actor.full_name, decided_at = NOW(),
           decision_note = btrim(p_note), history = history || public.payroll_correction_step('rejected', v_actor, btrim(p_note), kind, amount),
           updated_at = NOW()
     WHERE id = p_id RETURNING * INTO v_row;
    PERFORM public.payroll_run_notify(ARRAY[v_row.requested_by], 'payroll_correction', 'Payroll correction rejected',
      format('HR rejected the correction for %s (%s): %s', (SELECT full_name FROM public.profiles WHERE id = v_row.employee_id), v_row.period_label, btrim(p_note)),
      'ac-records', NULL);
    RETURN v_row;
  END IF;
  IF p_action <> 'approve' THEN
    RAISE EXCEPTION 'invalid: approve or reject.' USING ERRCODE = 'check_violation';
  END IF;

  v_text := format('Correction — %s: %s', v_row.period_label, v_row.reason);
  IF v_row.kind = 'underpayment' THEN
    INSERT INTO public.payroll_monthly_incentives (employee_id, branch_id, item_date, kind, description, amount, created_by, created_by_name)
    VALUES (v_row.employee_id, v_row.branch_id, v_today, 'incentive', left(v_text, 200), v_row.amount, v_actor.id, v_actor.full_name)
    RETURNING id INTO v_incentive;
  ELSE
    -- The next 2nd half (payroll deductions are taken on the 16-end payslip).
    v_start := CASE WHEN extract(day FROM v_today) <= 16 THEN date_trunc('month', v_today)::DATE + 15
                    ELSE (date_trunc('month', v_today) + INTERVAL '1 month')::DATE + 15 END;
    INSERT INTO public.payroll_loans (employee_id, branch_id, loan_type, description, date_granted, principal, interest_pct,
      number_of_payrolls, amortization, start_period, remaining_balance, status, created_by, created_by_name)
    VALUES (v_row.employee_id, v_row.branch_id, 'other', left('Overpayment recovery — ' || v_row.period_label || ': ' || v_row.reason, 200),
      v_today, v_row.amount, 0, v_row.payrolls, ROUND(v_row.amount / v_row.payrolls, 2), v_start, v_row.amount,
      'active', v_actor.id, v_actor.full_name)
    RETURNING id INTO v_loan;
  END IF;

  UPDATE public.payroll_corrections
     SET status = 'approved', decided_by = v_actor.id, decided_by_name = v_actor.full_name, decided_at = NOW(),
         decision_note = NULLIF(btrim(COALESCE(p_note, '')), ''), applied_incentive_id = v_incentive, applied_loan_id = v_loan,
         history = history || public.payroll_correction_step('approved', v_actor, NULLIF(btrim(COALESCE(p_note, '')), ''), kind, amount),
         updated_at = NOW()
   WHERE id = p_id RETURNING * INTO v_row;
  PERFORM public.payroll_run_notify(ARRAY[v_row.requested_by, v_row.employee_id], 'payroll_correction', 'Payroll correction approved',
    format('A correction to the %s payslip (%s of %s) will be on the next payslip.', v_row.period_label, v_row.kind, to_char(v_row.amount, 'FM999,999,990.00')),
    NULL, NULL);
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_correction_step(TEXT, public.profiles, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_correction_file(UUID, UUID, TEXT, NUMERIC, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_correction_resubmit(UUID, UUID, TEXT, NUMERIC, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_correction_decide(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_correction_file(UUID, UUID, TEXT, NUMERIC, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_correction_resubmit(UUID, UUID, TEXT, NUMERIC, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_correction_decide(UUID, UUID, TEXT, TEXT) TO service_role;
