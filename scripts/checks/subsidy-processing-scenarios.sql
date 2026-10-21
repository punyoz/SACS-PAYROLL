-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261021010000_subsidy_processing.sql
-- (the Accountant processes a subsidy, HR approves it)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY (docs/local-migration-replay.md): never run against the
-- live project. Everything runs in one transaction and is rolled back, so
-- the local database is left as it was.
--
--   npx supabase db reset
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/subsidy-processing-scenarios.sql
--
-- Each check RAISEs an exception with what was expected when it fails; the
-- script ends with NOTICE "all subsidy processing scenarios passed".

BEGIN;

-- ── Setup: a branch, one person per role, one licensed teacher ─────────────
INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-00000000a001', 'acct@sub.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a002', 'hr@sub.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a003', 'admin@sub.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a004', 'sa@sub.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a005', 'teacher@sub.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000a006', 'acct2@sub.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name, status) VALUES
  ('00000000-0000-4000-8000-00000000b001', 'Subsidy Branch', 'Active'),
  ('00000000-0000-4000-8000-00000000b002', 'Other Branch', 'Active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, employee_type, position, basic_salary, employee_status, date_hired) VALUES
  ('00000000-0000-4000-8000-00000000a001', 'acct@sub.test', 'Ana Accountant', 'accountant', '00000000-0000-4000-8000-00000000b001', 'Non-Teaching', 'Accountant', 30000, 'Active', '2024-01-15'),
  ('00000000-0000-4000-8000-00000000a002', 'hr@sub.test', 'Hana HR', 'hr', '00000000-0000-4000-8000-00000000b001', 'Non-Teaching', 'HR', 30000, 'Active', '2024-01-15'),
  ('00000000-0000-4000-8000-00000000a003', 'admin@sub.test', 'Ada Admin', 'admin', '00000000-0000-4000-8000-00000000b001', 'Non-Teaching', 'Admin', 0, 'Active', '2024-01-15'),
  ('00000000-0000-4000-8000-00000000a004', 'sa@sub.test', 'Sam Super', 'super_admin', NULL, 'Non-Teaching', 'SA', 0, 'Active', '2024-01-15'),
  ('00000000-0000-4000-8000-00000000a005', 'teacher@sub.test', 'Tess Teacher', 'employee', '00000000-0000-4000-8000-00000000b001', 'Teaching', 'Teacher I', 28000, 'Active', '2024-01-15'),
  ('00000000-0000-4000-8000-00000000a006', 'acct2@sub.test', 'Otto Other', 'accountant', '00000000-0000-4000-8000-00000000b002', 'Non-Teaching', 'Accountant', 30000, 'Active', '2024-01-15')
ON CONFLICT (id) DO NOTHING;

-- HR turns the license on and verifies it: the subsidy balance opens.
-- (Distinct change times: in one transaction NOW() is the same for both.)
INSERT INTO public.employee_license_changes (employee_id, action, prc_license_no, license_expires_on, reason, changed_by, changed_by_name, changed_by_role, effective_on, changed_at)
VALUES ('00000000-0000-4000-8000-00000000a005', 'turn_on', '1234567', (CURRENT_DATE + 400), 'License submitted', '00000000-0000-4000-8000-00000000a002', 'Hana HR', 'hr', (NOW() AT TIME ZONE 'Asia/Manila')::DATE, NOW() - INTERVAL '1 minute');
INSERT INTO public.employee_license_changes (employee_id, action, reason, changed_by, changed_by_name, changed_by_role, effective_on, changed_at)
VALUES ('00000000-0000-4000-8000-00000000a005', 'verify', 'Checked with PRC', '00000000-0000-4000-8000-00000000a002', 'Hana HR', 'hr', (NOW() AT TIME ZONE 'Asia/Manila')::DATE, NOW());

DO $$
DECLARE
  acct CONSTANT UUID := '00000000-0000-4000-8000-00000000a001';
  hr   CONSTANT UUID := '00000000-0000-4000-8000-00000000a002';
  adm  CONSTANT UUID := '00000000-0000-4000-8000-00000000a003';
  sa   CONSTANT UUID := '00000000-0000-4000-8000-00000000a004';
  tess CONSTANT UUID := '00000000-0000-4000-8000-00000000a005';
  acct2 CONSTANT UUID := '00000000-0000-4000-8000-00000000a006';
  v_bal public.payroll_subsidy_balances;
  v_req public.payroll_subsidy_requests;
  v_adv public.payroll_subsidy_requests;
  v_exc public.payroll_subsidy_requests;
  v_loan public.payroll_loans;
  v_n INTEGER;
  v_failed BOOLEAN;
  who UUID;
BEGIN
  SELECT * INTO v_bal FROM public.payroll_subsidy_balances WHERE employee_id = tess AND status = 'open';
  IF v_bal.id IS NULL THEN RAISE EXCEPTION 'setup: verifying the license should open a subsidy balance'; END IF;
  -- Room for an adjustment: count fewer months than 12.
  UPDATE public.payroll_subsidy_balances SET eligible_months = 6, entitlement = round(annual_amount * 6 / 12.0, 2) WHERE id = v_bal.id;
  SELECT * INTO v_bal FROM public.payroll_subsidy_balances WHERE id = v_bal.id;

  -- 1. Only the Accountant processes.
  FOREACH who IN ARRAY ARRAY[hr, adm, sa, tess] LOOP
    v_failed := FALSE;
    BEGIN
      PERFORM public.subsidy_request_process(who, NULL, 'adjustment', tess, v_bal.id, NULL, 1000, 'Verified late; license valid since May', '{"months_missed":1,"months_label":"May 2026"}');
    EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
    IF NOT v_failed THEN RAISE EXCEPTION '1: % must not be able to process a subsidy', who; END IF;
  END LOOP;
  -- ...and only for its own branch.
  v_failed := FALSE;
  BEGIN
    PERFORM public.subsidy_request_process(acct2, NULL, 'adjustment', tess, v_bal.id, NULL, 1000, 'Verified late; license valid since May', '{"months_missed":1,"months_label":"May 2026"}');
  EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '1: an Accountant of another branch must be refused'; END IF;

  -- 2. The Accountant processes an adjustment: Processed, HR is told.
  v_req := public.subsidy_request_process(acct, NULL, 'adjustment', tess, v_bal.id, NULL, 1000, 'Verified late; license valid since May', '{"months_missed":1,"months_label":"May 2026"}');
  IF v_req.status <> 'processed' OR v_req.processed_by <> acct OR v_req.requested_by <> acct THEN
    RAISE EXCEPTION '2: expected processed by the Accountant, got % / %', v_req.status, v_req.processed_by;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = hr AND kind = 'subsidy_processed') THEN
    RAISE EXCEPTION '2: HR should be notified';
  END IF;
  -- An amount above the months' worth is refused.
  v_failed := FALSE;
  BEGIN
    PERFORM public.subsidy_request_process(acct, NULL, 'adjustment', tess, v_bal.id, NULL, 999999, 'Verified late; license valid since May', '{"months_missed":1,"months_label":"Jun 2026"}');
  EXCEPTION WHEN check_violation THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '2: an adjustment above the cap must be refused'; END IF;

  -- 3. Only HR decides; a rejection needs a reason and goes back to the Accountant.
  FOREACH who IN ARRAY ARRAY[acct, adm, sa, tess] LOOP
    v_failed := FALSE;
    BEGIN
      PERFORM public.subsidy_request_decide(who, v_req.id, 'approve', NULL);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
    IF NOT v_failed THEN RAISE EXCEPTION '3: % must not be able to decide a subsidy', who; END IF;
  END LOOP;
  v_failed := FALSE;
  BEGIN
    PERFORM public.subsidy_request_decide(hr, v_req.id, 'reject', 'no');
  EXCEPTION WHEN check_violation THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '3: a rejection without a reason must be refused'; END IF;
  v_req := public.subsidy_request_decide(hr, v_req.id, 'reject', 'Attach the PRC receipt date in the reason.');
  IF v_req.status <> 'rejected' OR v_req.decided_by <> hr THEN RAISE EXCEPTION '3: expected rejected by HR'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = acct AND kind = 'subsidy_rejected' AND body LIKE '%PRC receipt%') THEN
    RAISE EXCEPTION '3: the Accountant should be told the reason';
  END IF;
  -- A rejected request cannot be approved until it is resubmitted.
  v_failed := FALSE;
  BEGIN
    PERFORM public.subsidy_request_decide(hr, v_req.id, 'approve', NULL);
  EXCEPTION WHEN check_violation THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '3: a rejected request must not be approved directly'; END IF;
  v_req := public.subsidy_request_process(acct, v_req.id, NULL, NULL, NULL, NULL, 1000, 'Verified late; PRC receipt dated May 2, 2026', '{"months_missed":1,"months_label":"May 2026"}');
  IF v_req.status <> 'processed' OR v_req.submission_no <> 2 OR v_req.decided_by IS NOT NULL THEN
    RAISE EXCEPTION '3: resubmitted should be processed again (submission 2), got % / %', v_req.status, v_req.submission_no;
  END IF;
  IF jsonb_array_length(v_req.history) <> 3 THEN RAISE EXCEPTION '3: history should keep processed, rejected, resubmitted (has %)', jsonb_array_length(v_req.history); END IF;

  -- 4. HR approves: the adjustment is approved by HR and waits for payroll;
  --    when payroll pays it, the request reads Applied to payroll.
  v_req := public.subsidy_request_decide(hr, v_req.id, 'approve', 'OK');
  IF v_req.status <> 'approved' OR v_req.adjustment_id IS NULL THEN RAISE EXCEPTION '4: expected approved with an adjustment'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payroll_subsidy_adjustments WHERE id = v_req.adjustment_id AND status = 'approved'
                 AND decided_by = hr AND decided_by_role = 'hr' AND requested_by = acct) THEN
    RAISE EXCEPTION '4: the adjustment should be approved by HR, requested by the Accountant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = acct AND kind = 'subsidy_approved') THEN
    RAISE EXCEPTION '4: the Accountant should be told it was approved';
  END IF;
  UPDATE public.payroll_subsidy_adjustments
  SET status = 'applied', applied_period_start = date_trunc('month', CURRENT_DATE)::DATE + 15,
      payroll_entry_id = gen_random_uuid(), applied_at = NOW()
  WHERE id = v_req.adjustment_id;
  SELECT * INTO v_req FROM public.payroll_subsidy_requests WHERE id = v_req.id;
  IF v_req.status <> 'applied' OR v_req.applied_at IS NULL THEN RAISE EXCEPTION '4: paid adjustment should read applied, got %', v_req.status; END IF;

  -- 5. Nothing skips the flow.
  v_failed := FALSE;
  BEGIN
    INSERT INTO public.payroll_subsidy_adjustments (employee_id, subsidy_balance_id, months_missed, months_label, amount, reason, requested_by)
    VALUES (tess, v_bal.id, 1, 'Jun 2026', 100, 'Direct insert', acct);
  EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '5: a direct adjustment must be refused'; END IF;
  v_failed := FALSE;
  BEGIN
    INSERT INTO public.payroll_loans (employee_id, branch_id, loan_type, date_granted, principal, subsidy_balance_id)
    VALUES (tess, '00000000-0000-4000-8000-00000000b001', 'subsidy_advance', (NOW() AT TIME ZONE 'Asia/Manila')::DATE, 100, v_bal.id);
  EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '5: a direct subsidy advance must be refused'; END IF;
  v_failed := FALSE;
  BEGIN
    UPDATE public.payroll_subsidy_requests SET status = 'approved' WHERE id = v_req.id;
  EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '5: a direct request change must be refused'; END IF;
  v_failed := FALSE;
  BEGIN
    DELETE FROM public.payroll_subsidy_requests WHERE id = v_req.id;
  EXCEPTION WHEN OTHERS THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '5: a request must never be deleted'; END IF;

  -- 6. Advance: processed, released only on HR's approval.
  v_adv := public.subsidy_request_process(acct, NULL, 'advance', tess, v_bal.id, NULL, 2000, NULL,
    jsonb_build_object('date_granted', (NOW() AT TIME ZONE 'Asia/Manila')::DATE, 'description', 'Advance for tuition'));
  IF EXISTS (SELECT 1 FROM public.payroll_loans WHERE employee_id = tess AND loan_type = 'subsidy_advance') THEN
    RAISE EXCEPTION '6: no advance may be released before HR approves';
  END IF;
  v_adv := public.subsidy_request_decide(hr, v_adv.id, 'approve', NULL);
  SELECT * INTO v_loan FROM public.payroll_loans WHERE id = v_adv.loan_id;
  IF v_adv.status <> 'applied' OR v_loan.id IS NULL OR v_loan.principal <> 2000 OR v_loan.created_by <> acct THEN
    RAISE EXCEPTION '6: approved advance should be released (loan by the Accountant), got % / %', v_adv.status, v_loan.principal;
  END IF;

  -- 7. Excess: the system raises it, the Accountant processes a waiver, HR approves, it is written off.
  UPDATE public.payroll_subsidy_balances SET entitlement = 500 WHERE id = v_bal.id;   -- the license lapsed: advances now exceed it
  v_n := public.subsidy_requests_raise_excess(ARRAY[tess]);
  SELECT * INTO v_exc FROM public.payroll_subsidy_requests WHERE kind = 'excess_settlement' AND loan_id = v_loan.id;
  IF v_n <> 1 OR v_exc.status <> 'pending' OR v_exc.requested_by IS NOT NULL OR v_exc.amount <> 1500 THEN
    RAISE EXCEPTION '7: expected one pending excess of 1500 raised by the system, got % / % / %', v_n, v_exc.status, v_exc.amount;
  END IF;
  IF public.subsidy_requests_raise_excess(ARRAY[tess]) <> 0 THEN RAISE EXCEPTION '7: raising again must not duplicate'; END IF;
  v_failed := FALSE;
  BEGIN
    UPDATE public.payroll_loans SET decision = 'waive' WHERE id = v_loan.id;
  EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '7: a direct excess decision must be refused'; END IF;
  v_exc := public.subsidy_request_process(acct, v_exc.id, NULL, NULL, NULL, NULL, NULL, 'Teacher refused to sign; hardship case',
    '{"option":"waive"}');
  IF v_exc.status <> 'processed' OR v_exc.requested_by IS NOT NULL OR v_exc.processed_by <> acct THEN
    RAISE EXCEPTION '7: expected processed by the Accountant (requested by the system)';
  END IF;
  IF NOT (SELECT awaiting_decision FROM public.payroll_loans WHERE id = v_loan.id) THEN
    RAISE EXCEPTION '7: the advance should be held while HR decides';
  END IF;
  v_exc := public.subsidy_request_decide(hr, v_exc.id, 'approve', NULL);
  SELECT * INTO v_loan FROM public.payroll_loans WHERE id = v_loan.id;
  IF v_exc.status <> 'applied' OR v_loan.decision <> 'waive' OR v_loan.decision_recommended_by <> acct
     OR v_loan.decision_approved_by <> hr OR v_loan.remaining_balance <> 0 THEN
    RAISE EXCEPTION '7: expected waived (processed by the Accountant, approved by HR, balance 0), got % / % / %',
      v_exc.status, v_loan.decision, v_loan.remaining_balance;
  END IF;

  -- 8. Everything stays: 3 requests, all kept with their history.
  SELECT count(*) INTO v_n FROM public.payroll_subsidy_requests WHERE employee_id = tess;
  IF v_n <> 3 THEN RAISE EXCEPTION '8: expected 3 requests kept, got %', v_n; END IF;

  RAISE NOTICE 'all subsidy processing scenarios passed';
END $$;

ROLLBACK;
