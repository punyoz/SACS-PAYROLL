-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261115010000_approval_flow_fixes.sql
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY. One transaction, rolled back. Each snapshot row carries
-- every NOT NULL figure of payroll_run_items, as the app sends it.
--
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/approval-flow-2026-11-15-scenarios.sql
--
-- Ends with NOTICE "all approval flow scenarios passed".

BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-0000000002a1', 'eva@flow.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000002a2', 'dan@flow.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000002a3', 'lou@flow.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000002ac', 'acct@flow.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000002e1', 'hr@flow.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES
  ('00000000-0000-4000-8000-0000000002f1', 'Flow Branch'),
  ('00000000-0000-4000-8000-0000000002f2', 'Flow Annex')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived) VALUES
  ('00000000-0000-4000-8000-0000000002a1', 'eva@flow.test',  'Eva Final',     'employee',   '00000000-0000-4000-8000-0000000002f1', FALSE),
  ('00000000-0000-4000-8000-0000000002a2', 'dan@flow.test',  'Dan Draft',     'employee',   '00000000-0000-4000-8000-0000000002f1', FALSE),
  ('00000000-0000-4000-8000-0000000002a3', 'lou@flow.test',  'Lou Leaver',    'employee',   '00000000-0000-4000-8000-0000000002f1', TRUE),
  ('00000000-0000-4000-8000-0000000002ac', 'acct@flow.test', 'Ari Accountant', 'accountant', '00000000-0000-4000-8000-0000000002f1', FALSE),
  ('00000000-0000-4000-8000-0000000002e1', 'hr@flow.test',   'Hilda HR',      'hr',         NULL, FALSE)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, branch_id = EXCLUDED.branch_id, archived = EXCLUDED.archived;

-- Eva: Final, net 25,850. Dan: a Draft. Lou (archived): Final, net 1,000.
INSERT INTO public.payroll_entries (id, employee_id, employee_name, pay_period, status, payroll) VALUES
  ('00000000-0000-4000-8000-0000000002b1', '00000000-0000-4000-8000-0000000002a1', 'Eva Final', 'October 1-15, 2026', 'paid',
   '{"basic_salary":26100,"totals":{"gross_pay":26100,"total_incentives":0,"total_deductions":250,"net_pay":25850}}'::JSONB),
  ('00000000-0000-4000-8000-0000000002b2', '00000000-0000-4000-8000-0000000002a2', 'Dan Draft', 'October 1-15, 2026', 'draft',
   '{"basic_salary":26100,"totals":{"gross_pay":26100,"total_incentives":0,"total_deductions":0,"net_pay":26100}}'::JSONB),
  ('00000000-0000-4000-8000-0000000002b3', '00000000-0000-4000-8000-0000000002a3', 'Lou Leaver', 'October 1-15, 2026', 'paid',
   '{"basic_salary":1000,"totals":{"gross_pay":1000,"total_incentives":0,"total_deductions":0,"net_pay":1000}}'::JSONB);

DO $$
DECLARE
  v_run public.payroll_runs;
  v_eva JSONB := '[{"basic_pay":0,"attendance_deduction":0,"absence_deduction":0,"late_deduction":0,"undertime_deduction":0,"half_day_deduction":0,"leave_without_pay_deduction":0,"withholding_tax":0,"sss":0,"philhealth":0,"pagibig":0,"loans":0,"other_deductions":0,"early_bird_incentive":0,"total_incentives":0,"days_worked":10,"absent_days":0,"late_days":0,"late_minutes":0,"undertime_minutes":0,"half_days":0,"entry_id":"00000000-0000-4000-8000-0000000002b1","employee_id":"00000000-0000-4000-8000-0000000002a1","employee_name":"Eva Final","gross_pay":26100,"total_deductions":250,"net_pay":25850}]';
  v_both JSONB := '[{"basic_pay":0,"attendance_deduction":0,"absence_deduction":0,"late_deduction":0,"undertime_deduction":0,"half_day_deduction":0,"leave_without_pay_deduction":0,"withholding_tax":0,"sss":0,"philhealth":0,"pagibig":0,"loans":0,"other_deductions":0,"early_bird_incentive":0,"total_incentives":0,"days_worked":10,"absent_days":0,"late_days":0,"late_minutes":0,"undertime_minutes":0,"half_days":0,"entry_id":"00000000-0000-4000-8000-0000000002b1","employee_id":"00000000-0000-4000-8000-0000000002a1","employee_name":"Eva Final","gross_pay":26100,"total_deductions":250,"net_pay":25850},
                    {"basic_pay":0,"attendance_deduction":0,"absence_deduction":0,"late_deduction":0,"undertime_deduction":0,"half_day_deduction":0,"leave_without_pay_deduction":0,"withholding_tax":0,"sss":0,"philhealth":0,"pagibig":0,"loans":0,"other_deductions":0,"early_bird_incentive":0,"total_incentives":0,"days_worked":10,"absent_days":0,"late_days":0,"late_minutes":0,"undertime_minutes":0,"half_days":0,"entry_id":"00000000-0000-4000-8000-0000000002b3","employee_id":"00000000-0000-4000-8000-0000000002a3","employee_name":"Lou Leaver","gross_pay":1000,"total_deductions":0,"net_pay":1000}]';
  v_draft JSONB := '[{"basic_pay":0,"attendance_deduction":0,"absence_deduction":0,"late_deduction":0,"undertime_deduction":0,"half_day_deduction":0,"leave_without_pay_deduction":0,"withholding_tax":0,"sss":0,"philhealth":0,"pagibig":0,"loans":0,"other_deductions":0,"early_bird_incentive":0,"total_incentives":0,"days_worked":10,"absent_days":0,"late_days":0,"late_minutes":0,"undertime_minutes":0,"half_days":0,"entry_id":"00000000-0000-4000-8000-0000000002b2","employee_id":"00000000-0000-4000-8000-0000000002a2","employee_name":"Dan Draft","gross_pay":26100,"total_deductions":0,"net_pay":26100}]';
  v_left JSONB := '[{"employee_id":"00000000-0000-4000-8000-0000000002a2","employee_name":"Dan Draft","left_out_as":"draft","reason":"Not finalized"},
                    {"employee_id":"00000000-0000-4000-8000-0000000002a3","employee_name":"Lou Leaver","left_out_as":"outside_list"}]';
  v_body TEXT;
BEGIN
  v_run := public.ensure_payroll_run('00000000-0000-4000-8000-0000000002f1', 'October 1-15, 2026', '00000000-0000-4000-8000-0000000002ac');

  -- 1. A Final payslip left out without being listed as left out: refused.
  BEGIN
    PERFORM public.submit_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000002ac', v_eva, '[{"employee_id":"00000000-0000-4000-8000-0000000002a2","employee_name":"Dan Draft"}]'::JSONB);
    RAISE EXCEPTION '1: Lou''s Final payslip must not be dropped silently';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'snapshot_mismatch: Lou Leaver has a Final payslip%' THEN RAISE; END IF;
  END;
  -- 2. A Draft is never one of the run's payslips.
  BEGIN
    PERFORM public.submit_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000002ac', v_draft, v_left);
    RAISE EXCEPTION '2: a Draft must not go in a run';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. Drafts do not block: submitted with Dan (Draft) and Lou (outside the list) left out.
  v_run := public.submit_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000002ac', v_eva, v_left);
  IF v_run.status <> 'pending' OR v_run.total_employees <> 1 OR v_run.total_net <> 25850 THEN
    RAISE EXCEPTION '3: Pending with Eva only (got % % %)', v_run.status, v_run.total_employees, v_run.total_net;
  END IF;
  IF (SELECT run_id FROM public.payroll_entries WHERE id = '00000000-0000-4000-8000-0000000002b2') IS NOT NULL
     OR (SELECT run_id FROM public.payroll_entries WHERE id = '00000000-0000-4000-8000-0000000002b3') IS NOT NULL THEN
    RAISE EXCEPTION '3: Dan''s Draft and Lou''s payslip stay out of the run';
  END IF;
  IF (SELECT string_agg(left_out_as, ',' ORDER BY employee_name) FROM public.payroll_run_exclusions WHERE run_id = v_run.id AND submission_no = 1) <> 'draft,outside_list' THEN
    RAISE EXCEPTION '3: why each was left out is kept';
  END IF;

  -- 4. HR's notice: the real net and who was left out.
  SELECT body INTO v_body FROM public.notifications WHERE recipient_id = '00000000-0000-4000-8000-0000000002e1' AND kind = 'payroll_run_submitted' AND run_id = v_run.id;
  IF v_body NOT LIKE '%net ₱25,850.00%' OR v_body NOT LIKE '%2 left out: Dan Draft, Lou Leaver%' OR v_body LIKE '%an amount%' THEN
    RAISE EXCEPTION '4: HR notice body was: %', v_body;
  END IF;

  -- 5. A payslip in a run keeps its branch: refused directly, not moved by the commit path.
  UPDATE public.profiles SET branch_id = '00000000-0000-4000-8000-0000000002f2' WHERE id = '00000000-0000-4000-8000-0000000002a1';
  BEGIN
    UPDATE public.payroll_entries SET branch_id = '00000000-0000-4000-8000-0000000002f2' WHERE id = '00000000-0000-4000-8000-0000000002b1';
    RAISE EXCEPTION '5: a payslip in a run must not change branch';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'payslip_in_run:%' AND SQLERRM NOT LIKE 'payroll_run_locked:%' THEN RAISE; END IF;
  END;
  PERFORM set_config('sacs.payroll_run_action', 'on', true);
  BEGIN
    UPDATE public.payroll_entries SET branch_id = '00000000-0000-4000-8000-0000000002f2' WHERE id = '00000000-0000-4000-8000-0000000002b1';
    RAISE EXCEPTION '5: not even inside a run action';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'payslip_in_run:%' THEN RAISE; END IF;
  END;
  PERFORM set_config('sacs.payroll_run_action', 'off', true);

  -- 6. Rejected, then reprocessed (commit path) after the move: the payslip stays in its branch and run.
  v_run := public.reject_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000002e1', 'Please recheck Eva first');
  PERFORM set_config('sacs.payroll_commit', 'on', true);
  UPDATE public.payroll_entries SET payroll = jsonb_set(payroll, '{basic_salary}', '26100') WHERE id = '00000000-0000-4000-8000-0000000002b1';
  PERFORM set_config('sacs.payroll_commit', 'off', true);
  IF (SELECT branch_id FROM public.payroll_entries WHERE id = '00000000-0000-4000-8000-0000000002b1') <> '00000000-0000-4000-8000-0000000002f1' THEN
    RAISE EXCEPTION '6: the payslip must stay with the branch it was processed in';
  END IF;
  UPDATE public.profiles SET branch_id = '00000000-0000-4000-8000-0000000002f1' WHERE id = '00000000-0000-4000-8000-0000000002a1';

  -- 7. Resubmitted with Lou ticked in, then approved: each employee of the snapshot is told.
  v_run := public.submit_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000002ac', v_both, '[{"employee_id":"00000000-0000-4000-8000-0000000002a2","employee_name":"Dan Draft","left_out_as":"draft"}]'::JSONB);
  IF v_run.total_employees <> 2 OR (SELECT run_id FROM public.payroll_entries WHERE id = '00000000-0000-4000-8000-0000000002b3') IS DISTINCT FROM v_run.id THEN
    RAISE EXCEPTION '7: Lou is in the resubmitted run';
  END IF;
  SELECT body INTO v_body FROM public.notifications WHERE kind = 'payroll_run_submitted' AND run_id = v_run.id AND body LIKE '%resubmitted%';
  IF v_body NOT LIKE '%2 employees · net ₱26,850.00%' OR v_body NOT LIKE '%1 left out: Dan Draft%' THEN
    RAISE EXCEPTION '7: resubmitted notice body was: %', v_body;
  END IF;
  -- A resubmission without Lou releases Lou's payslip from the run.
  v_run := public.reject_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000002e1', 'Lou should not be in it');
  v_run := public.submit_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000002ac', v_eva, v_left);
  IF (SELECT run_id FROM public.payroll_entries WHERE id = '00000000-0000-4000-8000-0000000002b3') IS NOT NULL THEN
    RAISE EXCEPTION '7: a payslip dropped on resubmission leaves the run';
  END IF;

  v_run := public.approve_payroll_run(v_run.id, '00000000-0000-4000-8000-0000000002e1', NULL);
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = '00000000-0000-4000-8000-0000000002a1' AND kind = 'payslip_released' AND run_id = v_run.id) THEN
    RAISE EXCEPTION '8: Eva must be told her payslip is ready';
  END IF;
  IF EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id IN ('00000000-0000-4000-8000-0000000002a2', '00000000-0000-4000-8000-0000000002a3') AND kind = 'payslip_released') THEN
    RAISE EXCEPTION '8: only the snapshot''s employees are told';
  END IF;
  -- Other notices still carry no amounts.
  IF EXISTS (SELECT 1 FROM public.notifications WHERE run_id = v_run.id AND kind <> 'payroll_run_submitted' AND (title || body) ~ '[0-9]{1,3},[0-9]{3}\.[0-9]{2}') THEN
    RAISE EXCEPTION '8: amounts stay out of every other notification';
  END IF;

  RAISE NOTICE 'all approval flow scenarios passed';
END $$;

ROLLBACK;
