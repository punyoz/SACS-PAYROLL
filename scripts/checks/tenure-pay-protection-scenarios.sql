-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261015010000_tenure_pay_protection.sql
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY (docs/local-migration-replay.md), after 20261015010000.
-- One transaction, rolled back.
--
--   npx supabase db reset
--   npx supabase db query < scripts/checks/tenure-pay-protection-scenarios.sql
--
-- Ends with NOTICE "all tenure pay protection scenarios passed".

BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-0000000002a1', 'old@tenure.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000002a2', 'new@tenure.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000002ac', 'acct@tenure.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000002e1', 'hr@tenure.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-0000000002f1', 'Tenure Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, date_hired) VALUES
  -- Hired 3 years ago / 1 year ago (relative, so the checks never go stale).
  ('00000000-0000-4000-8000-0000000002a1', 'old@tenure.test',  'Olga Old',      'employee',   '00000000-0000-4000-8000-0000000002f1', (NOW() AT TIME ZONE 'Asia/Manila')::DATE - INTERVAL '3 years'),
  ('00000000-0000-4000-8000-0000000002a2', 'new@tenure.test',  'Nina New',      'employee',   '00000000-0000-4000-8000-0000000002f1', (NOW() AT TIME ZONE 'Asia/Manila')::DATE - INTERVAL '1 year'),
  ('00000000-0000-4000-8000-0000000002ac', 'acct@tenure.test', 'Al Accountant', 'accountant', '00000000-0000-4000-8000-0000000002f1', NULL),
  ('00000000-0000-4000-8000-0000000002e1', 'hr@tenure.test',   'Hana HR',       'hr',         NULL, NULL)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, branch_id = EXCLUDED.branch_id, date_hired = EXCLUDED.date_hired;

DO $$
DECLARE
  c_old CONSTANT UUID := '00000000-0000-4000-8000-0000000002a1';
  c_new CONSTANT UUID := '00000000-0000-4000-8000-0000000002a2';
  c_acct CONSTANT UUID := '00000000-0000-4000-8000-0000000002ac';
  c_hr CONSTANT UUID := '00000000-0000-4000-8000-0000000002e1';
  c_entry CONSTANT UUID := '00000000-0000-4000-8000-0000000002b1';
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_grant UUID;
  v_ok BOOLEAN;
  v_count INTEGER;
  v_role TEXT;
BEGIN
  -- 1. The system-wide default exists: 2 years, everything covered, active.
  IF NOT EXISTS (SELECT 1 FROM public.tenure_protection_policies WHERE branch_id IS NULL AND min_tenure_years = 2 AND is_active
                 AND cover_absence AND cover_late AND cover_holiday AND cover_suspension AND cover_summer_break AND cover_christmas_break) THEN
    RAISE EXCEPTION '1: system-wide default policy';
  END IF;

  -- 2. Tenure: 3 years meets 2; 1 year does not; raising the threshold to 4 changes that.
  IF NOT public.tenure_meets_threshold(c_old) OR public.tenure_meets_threshold(c_new) THEN
    RAISE EXCEPTION '2: tenure threshold';
  END IF;
  UPDATE public.tenure_protection_policies SET min_tenure_years = 4, updated_by = c_hr WHERE branch_id IS NULL;
  IF public.tenure_meets_threshold(c_old) THEN RAISE EXCEPTION '2b: threshold change'; END IF;
  UPDATE public.tenure_protection_policies SET min_tenure_years = 2, updated_by = c_hr WHERE branch_id IS NULL;
  IF (SELECT updated_by_role FROM public.tenure_protection_policies WHERE branch_id IS NULL) <> 'hr' THEN
    RAISE EXCEPTION '2c: updated_by_role stamped from the profile';
  END IF;

  -- 3. Only HR / Admin / Super Admin may change the settings.
  v_ok := FALSE;
  BEGIN
    UPDATE public.tenure_protection_policies SET min_tenure_years = 0, updated_by = c_acct WHERE branch_id IS NULL;
  EXCEPTION WHEN insufficient_privilege THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '3: an accountant changed the policy'; END IF;
  v_ok := FALSE;
  BEGIN
    DELETE FROM public.tenure_protection_policies WHERE branch_id IS NULL;
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '3b: policy deleted'; END IF;

  -- 4. Only HR / Admin / Super Admin may grant; never to HR; never backdated.
  v_ok := FALSE;
  BEGIN
    INSERT INTO public.tenure_protection_grants (employee_id, effective_from, granted_by, granted_by_role)
    VALUES (c_old, v_today, c_acct, 'hr');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '4: an accountant granted protection'; END IF;
  v_ok := FALSE;
  BEGIN
    INSERT INTO public.tenure_protection_grants (employee_id, effective_from, granted_by, granted_by_role)
    VALUES (c_hr, v_today, c_hr, 'hr');
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '4b: granted to an HR account'; END IF;
  v_ok := FALSE;
  BEGIN
    INSERT INTO public.tenure_protection_grants (employee_id, effective_from, granted_by, granted_by_role)
    VALUES (c_old, v_today - 1, c_hr, 'hr');
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '4c: backdated grant'; END IF;

  -- The claimed role is ignored: the profile's role is recorded.
  INSERT INTO public.tenure_protection_grants (employee_id, effective_from, notes, granted_by, granted_by_name, granted_by_role)
  VALUES (c_old, v_today, 'Contract 2023-014', c_hr, 'Hana HR', 'super_admin')
  RETURNING id, granted_by_role INTO v_grant, v_role;
  IF v_role <> 'hr' THEN RAISE EXCEPTION '4d: granted_by_role %', v_role; END IF;

  -- 5. One open grant per employee; a grant is never edited or deleted.
  v_ok := FALSE;
  BEGIN
    INSERT INTO public.tenure_protection_grants (employee_id, effective_from, granted_by, granted_by_role) VALUES (c_old, v_today, c_hr, 'hr');
  EXCEPTION WHEN unique_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '5: two open grants'; END IF;
  v_ok := FALSE;
  BEGIN
    UPDATE public.tenure_protection_grants SET notes = 'changed' WHERE id = v_grant;
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '5b: grant edited'; END IF;
  v_ok := FALSE;
  BEGIN
    DELETE FROM public.tenure_protection_grants WHERE id = v_grant;
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '5c: grant deleted'; END IF;

  -- 6. Granted + tenure: covered; the employee under 2 years has no grant -> NULL.
  IF public.tenure_protection_grant_for(c_old, 'absence', v_today + 1) IS DISTINCT FROM v_grant THEN
    RAISE EXCEPTION '6: absence protected';
  END IF;
  IF public.tenure_protection_grant_for(c_new, 'absence', v_today + 1) IS NOT NULL THEN
    RAISE EXCEPTION '6b: no grant, no protection';
  END IF;
  IF public.tenure_protection_grant_for(c_old, 'absence', v_today - 1) IS NOT NULL THEN
    RAISE EXCEPTION '6c: before the grant';
  END IF;

  -- 7. Breaks: only inside the break, only while the category is checked; an
  --    ordinary absence inside a break is judged by the break.
  INSERT INTO public.school_break_periods (school_year, kind, start_date, end_date, updated_by, created_by)
  VALUES ('2099-2100', 'summer', v_today + 10, v_today + 12, c_hr, c_hr);
  IF public.school_break_kind_on(v_today + 11) <> 'summer' OR public.school_break_kind_on(v_today + 13) IS NOT NULL THEN
    RAISE EXCEPTION '7: break lookup';
  END IF;
  IF public.tenure_protection_grant_for(c_old, 'summer_break', v_today + 11) IS DISTINCT FROM v_grant
     OR public.tenure_protection_grant_for(c_old, 'summer_break', v_today + 13) IS NOT NULL THEN
    RAISE EXCEPTION '7b: summer break protection';
  END IF;
  UPDATE public.tenure_protection_policies SET cover_summer_break = FALSE, updated_by = c_hr WHERE branch_id IS NULL;
  IF public.tenure_protection_grant_for(c_old, 'summer_break', v_today + 11) IS NOT NULL
     OR public.tenure_protection_grant_for(c_old, 'absence', v_today + 11) IS NOT NULL THEN
    RAISE EXCEPTION '7c: summer unchecked stays unpaid';
  END IF;
  UPDATE public.tenure_protection_policies SET cover_summer_break = TRUE, updated_by = c_hr WHERE branch_id IS NULL;
  -- Moving the dates moves the protection.
  UPDATE public.school_break_periods SET start_date = v_today + 20, end_date = v_today + 22, updated_by = c_hr WHERE school_year = '2099-2100';
  IF public.tenure_protection_grant_for(c_old, 'summer_break', v_today + 11) IS NOT NULL
     OR public.tenure_protection_grant_for(c_old, 'summer_break', v_today + 21) IS DISTINCT FROM v_grant THEN
    RAISE EXCEPTION '7d: changed break dates';
  END IF;

  -- 8. A branch's own policy wins until it follows the system-wide one again.
  INSERT INTO public.tenure_protection_policies (branch_id, cover_absence, updated_by)
  VALUES ('00000000-0000-4000-8000-0000000002f1', FALSE, c_hr);
  IF public.tenure_protection_grant_for(c_old, 'absence', v_today + 1) IS NOT NULL THEN
    RAISE EXCEPTION '8: branch policy';
  END IF;
  UPDATE public.tenure_protection_policies SET use_global = TRUE, updated_by = c_hr WHERE branch_id = '00000000-0000-4000-8000-0000000002f1';
  IF public.tenure_protection_grant_for(c_old, 'absence', v_today + 1) IS DISTINCT FROM v_grant THEN
    RAISE EXCEPTION '8b: back to system-wide';
  END IF;

  -- 9. The payslip's waived deductions are recorded, replaced on regeneration,
  --    and a bad line never stops the payslip.
  INSERT INTO public.payroll_entries (id, employee_id, employee_name, pay_period, status, payroll)
  VALUES (c_entry, c_old, 'Olga Old', 'October 1-15, 2026', 'paid', jsonb_build_object('audit', jsonb_build_object('attendance', jsonb_build_object(
    'tenure_protection', jsonb_build_array(
      jsonb_build_object('type', 'absent', 'category', 'absence', 'grant_id', v_grant, 'log_date', '2026-10-01', 'quantity', 1, 'unit', 'day', 'amount', 2400),
      jsonb_build_object('type', 'late', 'category', 'late', 'grant_id', v_grant, 'log_date', '2026-10-02', 'quantity', 20, 'unit', 'minute', 'amount', 100),
      jsonb_build_object('type', 'absent', 'category', 'absence', 'grant_id', gen_random_uuid(), 'amount', 999)
    )))));
  SELECT count(*) INTO v_count FROM public.tenure_protection_applications WHERE entry_id = c_entry AND grant_id = v_grant;
  IF v_count <> 2 OR (SELECT sum(amount) FROM public.tenure_protection_applications WHERE entry_id = c_entry) <> 2500 THEN
    RAISE EXCEPTION '9: applications recorded (% rows)', v_count;
  END IF;
  UPDATE public.payroll_entries SET payroll = jsonb_build_object('audit', jsonb_build_object('attendance', jsonb_build_object(
    'tenure_protection', jsonb_build_array(
      jsonb_build_object('type', 'absent', 'category', 'summer_break', 'grant_id', v_grant, 'log_date', 'not a date', 'quantity', 'x', 'amount', 2400)
    )))) WHERE id = c_entry;
  IF (SELECT count(*) FROM public.tenure_protection_applications WHERE entry_id = c_entry) <> 1
     OR (SELECT category FROM public.tenure_protection_applications WHERE entry_id = c_entry) <> 'summer_break' THEN
    RAISE EXCEPTION '9b: regenerated payslip replaces its rows';
  END IF;
  UPDATE public.payroll_entries SET payroll = '{"audit":{"attendance":{}}}'::JSONB WHERE id = c_entry;
  IF EXISTS (SELECT 1 FROM public.tenure_protection_applications WHERE entry_id = c_entry) THEN
    RAISE EXCEPTION '9c: no protection, no rows';
  END IF;

  -- 10. Revoking: today or later only, once; days before stay protected.
  v_ok := FALSE;
  BEGIN
    UPDATE public.tenure_protection_grants SET revoked_on = v_today - 1, revoked_by = c_hr, revoked_at = NOW() WHERE id = v_grant;
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '10: retroactive revocation'; END IF;
  v_ok := FALSE;
  BEGIN
    UPDATE public.tenure_protection_grants SET revoked_on = v_today + 5, revoked_by = c_acct, revoked_at = NOW() WHERE id = v_grant;
  EXCEPTION WHEN insufficient_privilege THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '10b: an accountant revoked'; END IF;
  UPDATE public.tenure_protection_grants SET revoked_on = v_today + 5, revoked_by = c_hr, revoked_by_name = 'Hana HR', revoked_at = NOW() WHERE id = v_grant;
  IF public.tenure_protection_grant_for(c_old, 'absence', v_today + 4) IS DISTINCT FROM v_grant
     OR public.tenure_protection_grant_for(c_old, 'absence', v_today + 5) IS NOT NULL THEN
    RAISE EXCEPTION '10c: protection ends on revoked_on';
  END IF;
  v_ok := FALSE;
  BEGIN
    UPDATE public.tenure_protection_grants SET revoked_on = v_today + 9 WHERE id = v_grant;
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '10d: revoked twice'; END IF;
  -- A new grant after the revocation is allowed.
  INSERT INTO public.tenure_protection_grants (employee_id, effective_from, granted_by, granted_by_role) VALUES (c_old, v_today + 30, c_hr, 'hr');

  -- 11. Client roles cannot read or write the tables.
  IF has_table_privilege('authenticated', 'public.tenure_protection_grants', 'SELECT')
     OR has_table_privilege('anon', 'public.tenure_protection_policies', 'SELECT')
     OR has_table_privilege('authenticated', 'public.school_break_periods', 'INSERT')
     OR has_function_privilege('authenticated', 'public.tenure_protection_grant_for(uuid, text, date)', 'EXECUTE') THEN
    RAISE EXCEPTION '11: client roles have access';
  END IF;

  RAISE NOTICE 'all tenure pay protection scenarios passed';
END $$;

ROLLBACK;
