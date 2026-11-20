-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261121010000_employee_classification.sql (Part A)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL ONLY. One transaction, rolled back.
--
--   npx supabase db query < scripts/checks/employee-classification-scenarios.sql
--
-- Ends with NOTICE "all employee classification scenarios passed".

BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-0000000003a1', 'prob@cls.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000003a2', 'contract@cls.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000003a3', 'later@cls.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000003e1', 'hr@cls.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-0000000003f1', 'Classification Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, date_hired, employee_type, employment_status, employment_type, contract_end_date) VALUES
  -- Probationary, hired 5 months and 10 days ago: 6 months is within 30 days.
  ('00000000-0000-4000-8000-0000000003a1', 'prob@cls.test', 'Pia Probationary', 'employee', '00000000-0000-4000-8000-0000000003f1',
    (NOW() AT TIME ZONE 'Asia/Manila')::DATE - INTERVAL '5 months' - INTERVAL '10 days', 'Teaching', 'Probationary', 'Full-time', NULL),
  -- Contract ending in 20 days.
  ('00000000-0000-4000-8000-0000000003a2', 'contract@cls.test', 'Carlo Contract', 'employee', '00000000-0000-4000-8000-0000000003f1',
    '2025-06-01', 'Non-Teaching', 'Contractual', 'Full-time', (NOW() AT TIME ZONE 'Asia/Manila')::DATE + 20),
  -- Regular, nothing due.
  ('00000000-0000-4000-8000-0000000003a3', 'later@cls.test', 'Lea Later', 'employee', '00000000-0000-4000-8000-0000000003f1',
    '2024-01-01', 'Teaching', 'Regular', 'Full-time', NULL),
  ('00000000-0000-4000-8000-0000000003e1', 'hr@cls.test', 'Hana HR', 'hr', NULL, '2024-01-01', 'Non-Teaching', 'Regular', 'Full-time', NULL)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, date_hired = EXCLUDED.date_hired, employee_type = EXCLUDED.employee_type,
  employment_status = EXCLUDED.employment_status, employment_type = EXCLUDED.employment_type, contract_end_date = EXCLUDED.contract_end_date;

DO $$
DECLARE
  c_prob UUID := '00000000-0000-4000-8000-0000000003a1';
  c_contract UUID := '00000000-0000-4000-8000-0000000003a2';
  c_later UUID := '00000000-0000-4000-8000-0000000003a3';
  c_hr UUID := '00000000-0000-4000-8000-0000000003e1';
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_ok BOOLEAN;
  v_n INTEGER;
BEGIN
  -- 1. "Substitute" is not a status.
  v_ok := FALSE;
  BEGIN
    UPDATE public.profiles SET employment_status = 'Substitute' WHERE id = c_later;
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '1: Substitute was accepted as a status'; END IF;

  -- 2. A dated change waits for its date, then applies (profile + account metadata).
  INSERT INTO public.employee_classification_changes (employee_id, field, old_value, new_value, effective_on, reason, changed_by_name)
  VALUES (c_later, 'employment_type', 'Full-time', 'Part-time', v_today + 10, 'Reduced load next term', 'Hana HR');
  PERFORM public.employee_classification_apply(v_today);
  IF (SELECT employment_type FROM public.profiles WHERE id = c_later) <> 'Full-time' THEN RAISE EXCEPTION '2: applied before its date'; END IF;
  PERFORM public.employee_classification_apply(v_today + 10);
  IF (SELECT employment_type FROM public.profiles WHERE id = c_later) <> 'Part-time' THEN RAISE EXCEPTION '2b: not applied on its date'; END IF;
  IF (SELECT raw_user_meta_data->>'employment_type' FROM auth.users WHERE id = c_later) <> 'Part-time' THEN RAISE EXCEPTION '2c: account metadata not updated'; END IF;
  IF EXISTS (SELECT 1 FROM public.employee_classification_changes WHERE employee_id = c_later AND applied_at IS NULL) THEN RAISE EXCEPTION '2d: not marked applied'; END IF;

  -- 3. A change needs a reason and a valid value.
  v_ok := FALSE;
  BEGIN
    INSERT INTO public.employee_classification_changes (employee_id, field, new_value, effective_on, reason) VALUES (c_later, 'employment_status', 'Regular', v_today, '');
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '3: a change without a reason was accepted'; END IF;
  v_ok := FALSE;
  BEGIN
    INSERT INTO public.employee_classification_changes (employee_id, field, new_value, effective_on, reason) VALUES (c_later, 'employment_status', 'Substitute', v_today, 'test');
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '3b: Substitute accepted in the history'; END IF;

  -- 4. Off payroll on a date: the nightly close skips the account from then.
  INSERT INTO public.employee_classification_changes (employee_id, field, old_value, new_value, effective_on, reason)
  VALUES (c_later, 'on_payroll', 'true', 'false', v_today, 'System account');
  PERFORM public.employee_classification_apply(v_today);
  IF (SELECT on_payroll FROM public.profiles WHERE id = c_later) THEN RAISE EXCEPTION '4: on_payroll not switched off'; END IF;
  IF EXISTS (SELECT 1 FROM public.attendance_missing_days(v_today - 3, v_today - 1) m WHERE m.employee_id = c_later) THEN
    RAISE EXCEPTION '4b: an off-payroll account still gets Absent days';
  END IF;

  -- 5. Probation ends 6 months after the hire date (or the latest change to Probationary).
  IF public.employee_probation_end(c_prob) <> ((v_today - INTERVAL '5 months' - INTERVAL '10 days') + INTERVAL '6 months')::DATE THEN
    RAISE EXCEPTION '5: probation end from the hire date';
  END IF;
  IF public.employee_probation_end(c_later) IS NOT NULL THEN RAISE EXCEPTION '5b: a non-probationary account has a probation end'; END IF;

  -- 6. Reminders: probation and contract within 30 days → one reminder each, sent to every HR; no repeats.
  DELETE FROM public.notifications WHERE recipient_id = c_hr;
  v_n := public.employee_hr_reminders_run(v_today);
  IF NOT EXISTS (SELECT 1 FROM public.employee_hr_reminders WHERE employee_id = c_prob AND kind = 'probation_end') THEN RAISE EXCEPTION '6: no probation reminder'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employee_hr_reminders WHERE employee_id = c_contract AND kind = 'contract_end') THEN RAISE EXCEPTION '6b: no contract reminder'; END IF;
  IF EXISTS (SELECT 1 FROM public.employee_hr_reminders WHERE employee_id = c_later) THEN RAISE EXCEPTION '6c: a reminder with nothing due'; END IF;
  SELECT COUNT(*) INTO v_n FROM public.notifications WHERE recipient_id = c_hr AND kind = 'hr_reminder' AND body LIKE '%Pia Probationary completes the probation%';
  IF v_n <> 1 THEN RAISE EXCEPTION '6d: HR got % probation notifications', v_n; END IF;
  PERFORM public.employee_hr_reminders_run(v_today);
  SELECT COUNT(*) INTO v_n FROM public.notifications WHERE recipient_id = c_hr AND kind = 'hr_reminder';
  IF v_n <> 2 THEN RAISE EXCEPTION '6e: reminders repeated (% notifications)', v_n; END IF;

  -- 7. Leave credit rules and pay rules: every combination has a default, pending the policy manual.
  IF (SELECT COUNT(*) FROM public.leave_credit_rules WHERE note LIKE '%pending policy manual%') <> 60 THEN RAISE EXCEPTION '7: leave credit defaults'; END IF;
  IF (SELECT COUNT(*) FROM public.employee_pay_rules WHERE note LIKE '%pending policy manual%') <> 12 THEN RAISE EXCEPTION '7b: pay rule defaults'; END IF;
  v_ok := FALSE;
  BEGIN
    INSERT INTO public.employee_pay_rules (employee_type, employment_status, employment_type, pay_basis, effective_from)
    VALUES ('Teaching', 'Regular', 'Full-time', 'hourly', v_today);
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '7c: a full-timer paid by the hour was accepted'; END IF;

  RAISE NOTICE 'all employee classification scenarios passed';
END $$;

ROLLBACK;
