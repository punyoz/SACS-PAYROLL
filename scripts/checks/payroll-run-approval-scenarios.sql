-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261014010000_payroll_run_approval.sql
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY (docs/local-migration-replay.md), after both
-- 20261013010000 and 20261014010000. One transaction, rolled back.
--
--   npx supabase db reset
--   npx supabase db query < scripts/checks/payroll-run-approval-scenarios.sql
--
-- Ends with NOTICE "all payroll approval scenarios passed".

BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-0000000001a1', 'emp@run.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000001ac', 'acct@run.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000001e1', 'hr@run.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-0000000001f1', 'Run Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id) VALUES
  ('00000000-0000-4000-8000-0000000001a1', 'emp@run.test',  'Eva Employee', 'employee',   '00000000-0000-4000-8000-0000000001f1'),
  ('00000000-0000-4000-8000-0000000001ac', 'acct@run.test', 'Al Accountant', 'accountant', '00000000-0000-4000-8000-0000000001f1'),
  ('00000000-0000-4000-8000-0000000001e1', 'hr@run.test',   'Hana HR',       'hr',         NULL)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, branch_id = EXCLUDED.branch_id;

-- One processed (Final) payslip: gross 26,100, deductions 250, net 25,850.
INSERT INTO public.payroll_entries (id, employee_id, employee_name, pay_period, status, payroll)
VALUES ('00000000-0000-4000-8000-0000000001b1', '00000000-0000-4000-8000-0000000001a1', 'Eva Employee', 'October 1-15, 2026', 'paid',
  '{"basic_salary":26100,"totals":{"gross_pay":26100,"total_incentives":0,"total_deductions":250,"net_pay":25850}}'::JSONB);

DO $$
DECLARE
  v_run public.payroll_runs;
  v_items JSONB := '[{"entry_id":"00000000-0000-4000-8000-0000000001b1","employee_id":"00000000-0000-4000-8000-0000000001a1","employee_name":"Eva Employee","gross_pay":26100,"total_deductions":250,"net_pay":25850,"attendance_deduction":250,"days_worked":10}]';
  v_bad JSONB := '[{"entry_id":"00000000-0000-4000-8000-0000000001b1","employee_id":"00000000-0000-4000-8000-0000000001a1","employee_name":"Eva Employee","gross_pay":26100,"total_deductions":0,"net_pay":26100}]';
  v_ok BOOLEAN;
BEGIN
  -- HR cannot start or submit a run.
  BEGIN
    PERFORM public.ensure_payroll_run('00000000-0000-4000-8000-0000000001f1', 'October 1-15, 2026', '00000000-0000-4000-8000-0000000001e1');
    RAISE EXCEPTION '1: HR must not start a run';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  v_run := public.ensure_payroll_run('00000000-0000-4000-8000-0000000001f1', 'October 1-15, 2026', '00000000-0000-4000-8000-0000000001ac');
  IF v_run.status <> 'draft' OR v_run.cutoff_type <> 'first' OR v_run.period_end <> DATE '2026-10-15' THEN
    RAISE EXCEPTION '1: a new run is Draft, 1st cutoff, ending Oct 15 (got % % %)', v_run.status, v_run.cutoff_type, v_run.period_end;
  END IF;

  -- A snapshot that does not match the payslip is refused.
  BEGIN
    PERFORM public.submit_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000001ac', v_bad);
    RAISE EXCEPTION '2: a mismatching snapshot must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Submit: Pending, totals from the rows, HR notified, history and audit written.
  v_run := public.submit_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000001ac', v_items);
  IF v_run.status <> 'pending' OR v_run.total_net <> 25850 OR v_run.total_employees <> 1 OR v_run.submission_no <> 1 THEN
    RAISE EXCEPTION '3: submit -> Pending with the totals (got % % %)', v_run.status, v_run.total_net, v_run.total_employees;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = '00000000-0000-4000-8000-0000000001e1' AND kind = 'payroll_run_submitted') THEN
    RAISE EXCEPTION '3: HR must be notified';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_id = v_run.id::TEXT AND action = 'payroll_run_submitted' AND actor_role = 'accountant') THEN
    RAISE EXCEPTION '3: the submission must be in the audit log';
  END IF;

  -- Pending: the payslip cannot change (whoever asks), nor the snapshot.
  BEGIN
    UPDATE public.payroll_entries SET payroll = jsonb_set(payroll, '{totals,net_pay}', '1') WHERE id = '00000000-0000-4000-8000-0000000001b1';
    RAISE EXCEPTION '4: a Pending run''s payslip must not change';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.payroll_run_items SET net_pay = 1 WHERE run_id = v_run.id;
    RAISE EXCEPTION '4: the snapshot must not change';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.payroll_runs SET status = 'approved' WHERE id = v_run.id;
    RAISE EXCEPTION '4: the status moves only through the functions';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The Accountant cannot approve; HR cannot reject without a reason.
  BEGIN
    PERFORM public.approve_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000001ac', NULL);
    RAISE EXCEPTION '5: the Accountant must not approve';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.reject_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000001e1', '  ');
    RAISE EXCEPTION '5: a rejection needs a reason';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Reject with a reason: the payslip unlocks, nothing is cleared.
  v_run := public.reject_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000001e1', 'Recheck Oct 5');
  IF v_run.status <> 'rejected' OR NOT EXISTS (SELECT 1 FROM public.payroll_entries WHERE id = '00000000-0000-4000-8000-0000000001b1') THEN
    RAISE EXCEPTION '6: reject -> Rejected, payslip kept';
  END IF;
  UPDATE public.payroll_entries SET payroll = jsonb_set(payroll, '{totals,net_pay}', '25900') WHERE id = '00000000-0000-4000-8000-0000000001b1';
  UPDATE public.payroll_entries SET payroll = jsonb_set(payroll, '{totals,total_deductions}', '200') WHERE id = '00000000-0000-4000-8000-0000000001b1';

  -- Resubmit with the corrected figures: a second snapshot; the first is kept.
  v_items := jsonb_set(jsonb_set(v_items, '{0,net_pay}', '25900'), '{0,total_deductions}', '200');
  v_run := public.submit_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000001ac', v_items);
  IF v_run.status <> 'pending' OR v_run.submission_no <> 2 OR (SELECT count(*) FROM public.payroll_run_items WHERE run_id = v_run.id) <> 2 THEN
    RAISE EXCEPTION '7: resubmit -> Pending, snapshot 2, snapshot 1 kept';
  END IF;

  -- The submitter cannot approve; another HR account can.
  UPDATE public.profiles SET role = 'hr' WHERE id = '00000000-0000-4000-8000-0000000001ac';
  BEGIN
    PERFORM public.approve_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000001ac', NULL);
    RAISE EXCEPTION '8: nobody approves a run they processed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.profiles SET role = 'accountant' WHERE id = '00000000-0000-4000-8000-0000000001ac';

  v_run := public.approve_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000001e1', 'OK');
  IF v_run.status <> 'approved' OR (SELECT approved_by FROM public.payroll_entries WHERE id = '00000000-0000-4000-8000-0000000001b1') IS DISTINCT FROM '00000000-0000-4000-8000-0000000001e1' THEN
    RAISE EXCEPTION '9: approve -> Approved, payslip stamped';
  END IF;

  -- Approved: locked for good; no other move is allowed.
  BEGIN
    DELETE FROM public.payroll_entries WHERE id = '00000000-0000-4000-8000-0000000001b1';
    RAISE EXCEPTION '10: an Approved run''s payslip must not be removed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.reject_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000001e1', 'Too late now');
    RAISE EXCEPTION '10: Approved cannot become Rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The employee's own payslip is visible now (the RLS policy's rule).
  SELECT public.payroll_period_requires_approval('October 1-15, 2026')
     AND EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.id = v_run.id AND r.status = 'approved') INTO v_ok;
  IF NOT v_ok OR public.payroll_period_requires_approval('September 16-30, 2026') THEN
    RAISE EXCEPTION '11: visibility rule';
  END IF;
  IF (SELECT count(*) FROM public.payroll_approval_history WHERE run_id = v_run.id) <> 4 THEN
    RAISE EXCEPTION '12: history has submitted, rejected, resubmitted, approved';
  END IF;

  RAISE NOTICE 'all payroll approval scenarios passed';
END $$;

ROLLBACK;
