-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261123040000_tenure_auto_grant.sql (Part G)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY. One transaction, rolled back.
--
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/tenure-auto-grant-scenarios.sql
--
-- Ends with NOTICE "all tenure auto-grant scenarios passed".

BEGIN;

-- One clean school-wide policy (2 years, active) for the test.
UPDATE public.tenure_protection_policies SET is_active = TRUE, min_tenure_years = 2 WHERE branch_id IS NULL;
INSERT INTO public.tenure_protection_policies (branch_id, use_global, min_tenure_years, is_active)
SELECT NULL, FALSE, 2, TRUE WHERE NOT EXISTS (SELECT 1 FROM public.tenure_protection_policies WHERE branch_id IS NULL);

INSERT INTO auth.users (id, email, aud, role, instance_id)
SELECT ('00000000-0000-4000-8000-0000000007a' || n)::UUID, 't' || n || '@tenure.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
FROM generate_series(1, 9) n ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-0000000007f1', 'Tenure Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status, employment_status, date_hired) VALUES
  ('00000000-0000-4000-8000-0000000007a1', 't1@tenure.test', 'Tina Today',     'employee', '00000000-0000-4000-8000-0000000007f1', FALSE, TRUE, 'Active', 'Regular',      '2025-03-20'),
  ('00000000-0000-4000-8000-0000000007a2', 't2@tenure.test', 'Tom Tomorrow',   'employee', '00000000-0000-4000-8000-0000000007f1', FALSE, TRUE, 'Active', 'Regular',      '2025-03-21'),
  ('00000000-0000-4000-8000-0000000007a3', 't3@tenure.test', 'Pia Probation',  'employee', '00000000-0000-4000-8000-0000000007f1', FALSE, TRUE, 'Active', 'Probationary', '2020-01-10'),
  ('00000000-0000-4000-8000-0000000007a4', 't4@tenure.test', 'Rex Revoked',    'employee', '00000000-0000-4000-8000-0000000007f1', FALSE, TRUE, 'Active', 'Regular',      '2019-06-01'),
  ('00000000-0000-4000-8000-0000000007a5', 't5@tenure.test', 'Rita Rehired',   'employee', '00000000-0000-4000-8000-0000000007f1', FALSE, TRUE, 'Active', 'Regular',      '2018-01-08'),
  ('00000000-0000-4000-8000-0000000007a6', 't6@tenure.test', 'Mia Manual',     'employee', '00000000-0000-4000-8000-0000000007f1', FALSE, TRUE, 'Active', 'Regular',      '2017-02-01'),
  -- Olga: long past 2 years when the job first runs. Dina: no date hired yet (filled in later).
  ('00000000-0000-4000-8000-0000000007a7', 't7@tenure.test', 'Olga Oldtimer',  'employee', '00000000-0000-4000-8000-0000000007f1', FALSE, TRUE, 'Active', 'Regular',      '2015-01-05'),
  ('00000000-0000-4000-8000-0000000007a8', 't8@tenure.test', 'Dina Undated',   'employee', '00000000-0000-4000-8000-0000000007f1', FALSE, TRUE, 'Active', 'Regular',      NULL),
  -- Adam: an Admin wrongly flagged on payroll, with an old date hired: never counted (2026-11-22).
  ('00000000-0000-4000-8000-0000000007a9', 't9@tenure.test', 'Adam Admin',     'admin',    '00000000-0000-4000-8000-0000000007f1', FALSE, TRUE, 'Active', 'Regular',      '2014-06-02')
ON CONFLICT (id) DO UPDATE SET date_hired = EXCLUDED.date_hired, employment_status = EXCLUDED.employment_status, archived = FALSE, on_payroll = TRUE, employee_status = 'Active', branch_id = EXCLUDED.branch_id;

-- Rex: granted once and revoked by HR. Mia: an existing manual grant. Rita: separated, back on 2026-02-02.
SET LOCAL session_replication_role = replica;
INSERT INTO public.tenure_protection_grants (employee_id, effective_from, notes, granted_by_name, granted_by_role, granted_at, revoked_on, revoked_by_name, revoked_by_role, revoke_notes)
VALUES ('00000000-0000-4000-8000-0000000007a4', '2024-01-01', 'manual', 'Hana HR', 'hr', '2024-01-01', '2026-06-01', 'Hana HR', 'hr', 'Granted in error');
INSERT INTO public.tenure_protection_grants (employee_id, effective_from, notes, granted_by_name, granted_by_role, granted_at)
VALUES ('00000000-0000-4000-8000-0000000007a6', '2019-02-01', 'manual grant', 'Hana HR', 'hr', '2019-02-01');
INSERT INTO public.employee_status_changes (employee_id, old_status, new_status, effective_on, reason)
VALUES ('00000000-0000-4000-8000-0000000007a5', 'Active', 'Separated', '2025-12-31', 'resigned'),
       ('00000000-0000-4000-8000-0000000007a5', 'Separated', 'Active', '2026-02-02', 'rehired');
SET LOCAL session_replication_role = origin;

CREATE TEMP TABLE payslips_before AS SELECT id, md5(payroll::TEXT || net_pay::TEXT) AS h FROM public.payroll_entries;

DO $$
DECLARE
  tina CONSTANT UUID := '00000000-0000-4000-8000-0000000007a1';
  tom  CONSTANT UUID := '00000000-0000-4000-8000-0000000007a2';
  pia  CONSTANT UUID := '00000000-0000-4000-8000-0000000007a3';
  rex  CONSTANT UUID := '00000000-0000-4000-8000-0000000007a4';
  rita CONSTANT UUID := '00000000-0000-4000-8000-0000000007a5';
  mia  CONSTANT UUID := '00000000-0000-4000-8000-0000000007a6';
  olga CONSTANT UUID := '00000000-0000-4000-8000-0000000007a7';
  dina CONSTANT UUID := '00000000-0000-4000-8000-0000000007a8';
  v_list UUID[];
  v_n INTEGER;
BEGIN
  -- 1. The first-run list on 2027-03-20: Olga (long past) and Tina (exactly 2 years today) — not Tom (tomorrow),
  --    not Pia (Probationary), not Rex (revoked by HR), not Rita (service restarted 2026-02-02), not Mia (already
  --    protected), not Dina (no date hired).
  SELECT array_agg(employee_id ORDER BY full_name) INTO v_list FROM public.tenure_auto_grant_candidates('2027-03-20') WHERE branch_id = '00000000-0000-4000-8000-0000000007f1';
  ASSERT v_list = ARRAY[olga, tina], format('1: first-run list %s', v_list);
  -- A NEW anniversary: from the cutoff containing it (Mar 16-31, in progress).
  ASSERT (SELECT effective_from FROM public.tenure_auto_grant_candidates('2027-03-20') WHERE employee_id = tina) = '2027-03-16', '1b: the cutoff containing the anniversary (Mar 16-31)';
  -- Already past at the first run: from the cutoff in progress, NEVER the old anniversary (2017-01-01).
  ASSERT (SELECT effective_from FROM public.tenure_auto_grant_candidates('2027-03-20') WHERE employee_id = olga) = '2027-03-16', '1c: Olga from the current cutoff, not backwards';

  -- 2. The job grants exactly the list, logged and notified.
  v_n := public.tenure_auto_grant('2027-03-20');
  ASSERT (SELECT COUNT(*) FROM public.tenure_protection_grants WHERE employee_id = tina AND granted_by_role = 'system' AND effective_from = '2027-03-16'
          AND notes LIKE 'by System, rule: 2 years of service%') = 1, '2: Tina granted by System from Mar 16';
  ASSERT NOT EXISTS (SELECT 1 FROM public.tenure_protection_grants WHERE employee_id IN (tom, pia, rita) ), '2b: nobody else';
  ASSERT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = tina AND kind = 'tenure_granted'), '2c: Tina told';
  ASSERT EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'tenure_auto_grant' AND entity_id = tina::TEXT), '2d: logged';

  -- 3. Tom reaches it the next day, but the Mar 16-31 run is already approved: from the NEXT cutoff
  --    (no retroactive adjustment to a processed payslip); nobody twice.
  INSERT INTO public.payroll_runs (branch_id, period_label, period_start, period_end, cutoff_type, status)
  VALUES ('00000000-0000-4000-8000-0000000007f1', 'March 16-31, 2027', '2027-03-16', '2027-03-31', 'second', 'approved');
  PERFORM public.tenure_auto_grant('2027-03-21');
  ASSERT (SELECT COUNT(*) FROM public.tenure_protection_grants WHERE employee_id = tom) = 1, '3: Tom on his anniversary';
  ASSERT (SELECT effective_from FROM public.tenure_protection_grants WHERE employee_id = tom) = '2027-04-01', '3c: processed cutoff → the next one';
  ASSERT (SELECT COUNT(*) FROM public.tenure_protection_grants WHERE employee_id = tina) = 1, '3b: Tina once';

  -- 4. Revoked stays revoked: Rex is never re-granted automatically; HR re-grants by hand and that stands.
  PERFORM public.tenure_auto_grant('2027-04-01');
  ASSERT (SELECT COUNT(*) FROM public.tenure_protection_grants WHERE employee_id = rex) = 1, '4: Rex not re-granted';
  INSERT INTO public.tenure_protection_grants (employee_id, effective_from, notes, granted_by_name, granted_by_role, granted_at)
  VALUES (rex, '2027-04-01', 'HR re-grant', 'Hana HR', 'hr', NOW());
  ASSERT (SELECT COUNT(*) FROM public.tenure_protection_grants WHERE employee_id = rex AND revoked_on IS NULL) = 1, '4b: HR re-grant stands';

  -- 5. Rita: the break restarts the count — eligible two years after her return (2028-02-02).
  ASSERT NOT EXISTS (SELECT 1 FROM public.tenure_auto_grant_candidates('2028-02-01') WHERE employee_id = rita), '5: not before 2 years from the return';
  ASSERT EXISTS (SELECT 1 FROM public.tenure_auto_grant_candidates('2028-02-02') WHERE employee_id = rita), '5b: eligible 2 years from the return';

  -- 5c. Dina's date hired is filled in later (anniversary 2026-01-10, long past): from the cutoff in progress.
  UPDATE public.profiles SET date_hired = '2024-01-10' WHERE id = dina;
  PERFORM public.tenure_auto_grant('2027-04-02');
  ASSERT (SELECT effective_from FROM public.tenure_protection_grants WHERE employee_id = dina) = '2027-04-01', '5c: date hired filled later → current cutoff, not backwards';

  -- 5d. Admin / Super Admin: never, whatever the on-payroll flag says.
  ASSERT NOT EXISTS (SELECT 1 FROM public.tenure_auto_grant_candidates('2027-04-02') WHERE employee_id = '00000000-0000-4000-8000-0000000007a9'), '5d: Admin never a candidate';
  ASSERT NOT EXISTS (SELECT 1 FROM public.tenure_protection_grants WHERE employee_id = '00000000-0000-4000-8000-0000000007a9'), '5e: Admin never granted';

  -- 6. Mia's manual grant is untouched.
  ASSERT (SELECT COUNT(*) FROM public.tenure_protection_grants WHERE employee_id = mia) = 1, '6: manual grant stays';

  -- 7. Processed payslips are never changed.
  ASSERT NOT EXISTS (SELECT 1 FROM public.payroll_entries e JOIN payslips_before b ON b.id = e.id WHERE md5(e.payroll::TEXT || e.net_pay::TEXT) <> b.h), '7: payslips unchanged';

  RAISE NOTICE 'all tenure auto-grant scenarios passed';
END $$;

ROLLBACK;
