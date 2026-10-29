-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261029040000_payroll_final_override.sql and
-- 20261029050000_payroll_override_employee_notice.sql
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL ONLY: never run against the live project. Everything runs in one
-- transaction and is rolled back. Needs the data the E2E suite leaves behind
-- (approved runs with Final payslips, BIR files, annualizations, a 13th
-- month), so run it after `npm run test:e2e`:
--
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/payroll-override-scenarios.sql
--
-- Ends with NOTICE "all payroll override scenarios passed".

BEGIN;

DO $$
DECLARE
  v_sa       UUID := (SELECT id FROM public.profiles WHERE role = 'super_admin' AND NOT COALESCE(archived, FALSE) LIMIT 1);
  v_acct     UUID := (SELECT id FROM public.profiles WHERE role = 'accountant' AND NOT COALESCE(archived, FALSE) LIMIT 1);
  v_hr       UUID := (SELECT id FROM public.profiles WHERE role = 'hr' AND NOT COALESCE(archived, FALSE) LIMIT 1);
  v_entry    public.payroll_entries;
  v_item     JSONB;
  v_payroll  JSONB;
  v_result   JSONB;
  v_override public.payroll_final_overrides;
  v_kinds    TEXT[];
  v_failed   BOOLEAN;
  v_old_run  TEXT;
BEGIN
  -- A Final payslip of an approved run, whose employee has BIR files, an
  -- annualization and a 13th month for the year (as the E2E suite leaves them).
  SELECT e.* INTO v_entry
    FROM public.payroll_entries e
    JOIN public.payroll_runs r ON r.branch_id = e.branch_id AND r.period_label = e.pay_period AND r.status = 'approved'
   WHERE e.status = 'paid'
     AND EXISTS (SELECT 1 FROM public.payroll_tax_annualizations a WHERE a.employee_id = e.employee_id AND a.tax_year = 2026)
   ORDER BY (EXISTS (SELECT 1 FROM public.payroll_thirteenth_month t WHERE t.employee_id = e.employee_id AND t.year = 2026)) DESC, e.pay_period
   LIMIT 1;
  IF v_entry.id IS NULL OR v_sa IS NULL OR v_acct IS NULL THEN
    RAISE EXCEPTION 'no approved Final payslip with year-end records: run the E2E suite first';
  END IF;

  -- The recomputed payslip: net pay 500 lower, SSS 100 higher, basic earned 400 lower.
  v_payroll := v_entry.payroll;
  v_payroll := jsonb_set(v_payroll, '{totals,net_pay}', to_jsonb(COALESCE(v_entry.net_pay, 0) - 500));
  v_payroll := jsonb_set(v_payroll, '{totals,total_deductions}', to_jsonb(COALESCE(v_entry.total_deductions, 0) + 100));
  v_payroll := jsonb_set(v_payroll, '{deductions,sss}', to_jsonb(COALESCE(v_entry.sss, 0) + 100), true);
  v_payroll := jsonb_set(v_payroll, '{basic_earned}', to_jsonb(COALESCE((v_entry.payroll ->> 'basic_earned')::NUMERIC, v_entry.basic_salary, 0) - 400), true);
  IF jsonb_typeof(v_payroll #> '{final_pay,breakdown,deductions}') = 'array' THEN
    RAISE EXCEPTION 'picked a final-pay payslip; pick another';
  END IF;
  v_item := jsonb_build_object(
    'record', jsonb_build_object('employee_id', v_entry.employee_id, 'employee_name', v_entry.employee_name, 'period_label', v_entry.pay_period,
      'gross_pay', v_entry.gross_pay, 'total_deductions', COALESCE(v_entry.total_deductions, 0) + 100, 'net_pay', COALESCE(v_entry.net_pay, 0) - 500,
      'period_start', public.payroll_period_start(v_entry.pay_period), 'processed_by', v_sa),
    'entry', jsonb_build_object('id', v_entry.id, 'employee_id', v_entry.employee_id, 'employee_name', v_entry.employee_name,
      'pay_period', v_entry.pay_period, 'status', 'paid', 'payroll', v_payroll, 'submitted_at', NOW(), 'created_at', v_entry.created_at),
    'deductions', '[]'::JSONB, 'incentives', '[]'::JSONB, 'loan_payments', '[]'::JSONB);

  -- 1. Only an active Super Admin.
  FOREACH v_old_run IN ARRAY ARRAY[v_acct::TEXT, v_hr::TEXT] LOOP
    v_failed := FALSE;
    BEGIN
      PERFORM public.payroll_override_final(v_old_run::UUID, v_item, 'Corrected a miscalculated loan deduction');
    EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION '1: a non-Super Admin was allowed'; END IF;
  END LOOP;

  -- 2. A reason of at least 10 characters.
  v_failed := FALSE;
  BEGIN
    PERFORM public.payroll_override_final(v_sa, v_item, '  short  ');
  EXCEPTION WHEN check_violation THEN v_failed := SQLERRM LIKE 'override_reason_required:%';
  END;
  IF NOT v_failed THEN RAISE EXCEPTION '2: an override without a proper reason was allowed'; END IF;

  -- 3. Only an approved run: a Final payslip whose run HR has not approved
  -- (here: never submitted) is refused; Pending and Rejected take the same
  -- check (run status is not 'approved').
  INSERT INTO public.payroll_entries (id, employee_id, employee_name, pay_period, status, payroll)
  VALUES (gen_random_uuid(), v_entry.employee_id, v_entry.employee_name, 'November 1-15, 2026', 'paid', v_entry.payroll);
  v_failed := FALSE;
  BEGIN
    PERFORM public.payroll_override_final(v_sa, jsonb_set(v_item, '{entry,pay_period}', '"November 1-15, 2026"'), 'Corrected a miscalculated loan deduction');
  EXCEPTION WHEN check_violation THEN v_failed := SQLERRM LIKE 'override_not_approved:%';
  END;
  IF NOT v_failed THEN RAISE EXCEPTION '3: an override of a payslip not approved by HR was allowed'; END IF;

  -- 4. Without the override, the approved payslip cannot be changed.
  v_failed := FALSE;
  BEGIN
    UPDATE public.payroll_entries SET payroll = v_payroll WHERE id = v_entry.id;
  EXCEPTION WHEN check_violation THEN v_failed := TRUE;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION '4: an approved payslip changed outside the override'; END IF;

  -- 5. The override.
  v_result := public.payroll_override_final(v_sa, v_item, 'Corrected a miscalculated loan deduction after HR dispute');
  SELECT * INTO v_override FROM public.payroll_final_overrides WHERE id = (v_result ->> 'override_id')::UUID;
  IF v_override.id IS NULL THEN RAISE EXCEPTION '5: no override record'; END IF;
  IF v_override.actor_id <> v_sa OR v_override.actor_role <> 'super_admin' OR v_override.employee_id <> v_entry.employee_id
     OR v_override.pay_period <> v_entry.pay_period OR v_override.run_status <> 'approved'
     OR v_override.reason <> 'Corrected a miscalculated loan deduction after HR dispute' OR v_override.created_at IS NULL THEN
    RAISE EXCEPTION '5: override record incomplete: %', to_jsonb(v_override);
  END IF;
  IF (v_override.old_values ->> 'net_pay')::NUMERIC <> COALESCE(v_entry.net_pay, 0)
     OR (v_override.new_values ->> 'net_pay')::NUMERIC <> COALESCE(v_entry.net_pay, 0) - 500
     OR (v_override.new_values ->> 'sss')::NUMERIC <> COALESCE(v_entry.sss, 0) + 100
     OR v_override.old_payslip_no IS DISTINCT FROM v_entry.payslip_no OR v_override.new_payslip_no IS NULL
     OR v_override.new_payslip_no = v_override.old_payslip_no THEN
    RAISE EXCEPTION '5: old / new values wrong: % -> %', v_override.old_values, v_override.new_values;
  END IF;
  IF NOT (v_override.changed_fields @> ARRAY['net_pay', 'sss', 'basic_earned']) THEN
    RAISE EXCEPTION '5: changed fields wrong: %', v_override.changed_fields;
  END IF;
  IF (SELECT net_pay FROM public.payroll_entries WHERE id = v_entry.id) <> COALESCE(v_entry.net_pay, 0) - 500 THEN
    RAISE EXCEPTION '5: payslip not rewritten';
  END IF;
  IF (SELECT count(*) FROM public.payroll_records WHERE employee_id = v_entry.employee_id AND period_label = v_entry.pay_period AND archived) < 1
     OR (SELECT count(*) FROM public.payroll_records WHERE employee_id = v_entry.employee_id AND period_label = v_entry.pay_period AND NOT archived) <> 1 THEN
    RAISE EXCEPTION '5: the old record was not archived / the new one not written';
  END IF;

  -- 6. Downstream records flagged, never changed.
  SELECT array_agg(kind ORDER BY kind) INTO v_kinds FROM public.payroll_review_flags WHERE override_id = v_override.id AND status = 'open';
  IF NOT (v_kinds @> ARRAY['payroll_run', 'remittance', 'tax_annualization']) THEN
    RAISE EXCEPTION '6: flags missing: %', v_kinds;
  END IF;
  IF EXISTS (SELECT 1 FROM public.payroll_bir_exports e WHERE e.tax_year = 2026
               AND (e.employee_id = v_entry.employee_id OR e.rows @> jsonb_build_array(jsonb_build_object('employee_id', v_entry.employee_id::TEXT))))
     AND NOT (v_kinds && ARRAY['bir_2316', 'bir_alphalist']) THEN
    RAISE EXCEPTION '6: a BIR file with this employee was not flagged: %', v_kinds;
  END IF;
  IF EXISTS (SELECT 1 FROM public.payroll_thirteenth_month t WHERE t.employee_id = v_entry.employee_id AND t.year = 2026)
     AND NOT (v_kinds @> ARRAY['thirteenth_month']) THEN
    RAISE EXCEPTION '6: the 13th month was not flagged: %', v_kinds;
  END IF;
  IF jsonb_array_length(v_result -> 'review_flags') <> cardinality(v_kinds) THEN
    RAISE EXCEPTION '6: the result does not list the flags';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.kind = 'payroll_review' AND n.recipient_id = v_acct)
     OR NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.kind = 'payroll_review' AND n.recipient_id = v_hr) THEN
    RAISE EXCEPTION '6: the Accountant and HR were not notified';
  END IF;
  -- The employee is told, with the old and new net pay and the reason (20261029050000).
  IF NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.kind = 'payslip_corrected' AND n.recipient_id = v_entry.employee_id
                  AND n.link_page = 'emp-payslips' AND n.body LIKE '%Corrected a miscalculated loan deduction after HR dispute%'
                  AND n.body LIKE '%' || to_char(COALESCE(v_entry.net_pay, 0) - 500, 'FM999,999,990.00') || '%') THEN
    RAISE EXCEPTION '6: the employee was not notified of the correction';
  END IF;

  -- 7. The override record is never changed or removed.
  v_failed := FALSE;
  BEGIN
    UPDATE public.payroll_final_overrides SET reason = 'rewritten afterwards' WHERE id = v_override.id;
  EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION '7: the override record was changed'; END IF;
  v_failed := FALSE;
  BEGIN
    DELETE FROM public.payroll_final_overrides WHERE id = v_override.id;
  EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION '7: the override record was deleted'; END IF;

  -- 8. A flag only goes from open to reviewed, with a note, and is never removed.
  v_failed := FALSE;
  BEGIN
    UPDATE public.payroll_review_flags SET message = 'changed' WHERE override_id = v_override.id;
  EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION '8: a flag message was changed'; END IF;
  v_failed := FALSE;
  BEGIN
    UPDATE public.payroll_review_flags SET status = 'reviewed', reviewed_at = NOW() WHERE override_id = v_override.id AND kind = 'remittance';
  EXCEPTION WHEN check_violation THEN v_failed := TRUE;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION '8: a flag was reviewed without a note'; END IF;
  UPDATE public.payroll_review_flags SET status = 'reviewed', reviewed_by = v_acct, reviewed_at = NOW(), review_note = 'Re-filed the remittance'
   WHERE override_id = v_override.id AND kind = 'remittance';
  v_failed := FALSE;
  BEGIN
    DELETE FROM public.payroll_review_flags WHERE override_id = v_override.id;
  EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION '8: a flag was deleted'; END IF;

  -- 9. A Draft payslip is not overridden.
  v_failed := FALSE;
  BEGIN
    PERFORM public.payroll_override_final(v_sa, jsonb_set(v_item, '{entry,pay_period}', '"February 1-15, 2020"'), 'Corrected a miscalculated loan deduction');
  EXCEPTION WHEN check_violation THEN v_failed := SQLERRM LIKE 'override_not_final:%';
  END;
  IF NOT v_failed THEN RAISE EXCEPTION '9: an override without a Final payslip was allowed'; END IF;

  -- 10. Clients cannot reach the tables or the function.
  IF has_table_privilege('authenticated', 'public.payroll_final_overrides', 'SELECT')
     OR has_table_privilege('anon', 'public.payroll_review_flags', 'SELECT')
     OR has_function_privilege('authenticated', 'public.payroll_override_final(uuid, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '10: client access to the override tables or function';
  END IF;

  RAISE NOTICE 'all payroll override scenarios passed (flags: %)', v_kinds;
END $$;

ROLLBACK;
