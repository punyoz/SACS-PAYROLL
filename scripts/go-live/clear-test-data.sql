-- ═══════════════════════════════════════════════════════════════════════════
-- Go-live: clear the test data, keep the settings.            (NOT A MIGRATION)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Deletes every employee-related record (attendance, taps, leave, transfers,
-- payslips and their lines, loans, subsidy balances, AWOL cases, licence
-- records, audit trail, sign-in throttles and codes) and every account
-- except the ones listed in step 1.
--
-- Keeps: branches, role_permissions, system_config, payroll_rate_configs,
-- payroll_tax_brackets, payroll_schedule_settings, payroll_subsidy_settings,
-- the settings rows of payroll_setting_changes, and attendance_holidays.
--
-- HOW TO RUN (docs/go-live.md, "Clear the test data"):
--   0. Take a backup first. There is no undo.
--   1. Create the real Super Admin (real email, strong password) and sign
--      in with it once, so you know it works.
--   2. Put that email in step 1 below.
--   3. Run the whole file in the Supabase SQL Editor. DRY RUN is on (step
--      1), so it stops at the end with an error that lists the "before" and
--      "after" counts, and nothing is saved.
--   4. When the counts are right, set dry_run to FALSE in step 1 and run it
--      again. It then commits and shows the final counts.
--
-- The delete-blocking triggers (block_hard_delete, the append-only guards)
-- are switched off for these tables inside this one transaction only, and
-- switched back on before it ends. If anything fails, Postgres rolls back
-- everything, including the trigger switches.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Dry run, and the accounts to KEEP (edit this) ──────────────────────
CREATE TEMP TABLE go_live_mode (dry_run BOOLEAN NOT NULL) ON COMMIT DROP;
INSERT INTO go_live_mode VALUES (TRUE);   -- TRUE: change nothing. FALSE: really delete.

CREATE TEMP TABLE go_live_keep (email TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO go_live_keep (email) VALUES
  ('REPLACE-WITH-THE-REAL-SUPER-ADMIN-EMAIL');
  -- , ('second.superadmin@your-school-domain')

-- ── 2. Safety checks: stop before touching anything ───────────────────────
DO $$
DECLARE
  v_missing INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM go_live_keep
              WHERE email ILIKE '%REPLACE%' OR email ILIKE '%@example.com'
                 OR email ILIKE '%@maxxspace.com') THEN
    RAISE EXCEPTION 'Step 1 still lists a placeholder or test address. Put the real Super Admin email there.';
  END IF;

  SELECT count(*) INTO v_missing
    FROM go_live_keep k
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(k.email));
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% address(es) in step 1 have no account. Create the real Super Admin first.', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM auth.users u
      JOIN go_live_keep k ON lower(k.email) = lower(u.email)
      JOIN public.profiles p ON p.id = u.id
     WHERE p.role::TEXT = 'super_admin' AND COALESCE(p.archived, FALSE) = FALSE
  ) THEN
    RAISE EXCEPTION 'Step 1 has no active Super Admin. Refusing: nobody could sign in afterwards.';
  END IF;
END;
$$;

CREATE TEMP TABLE go_live_drop ON COMMIT DROP AS
  SELECT u.id
    FROM auth.users u
   WHERE lower(u.email) NOT IN (SELECT lower(email) FROM go_live_keep)
      OR u.email IS NULL;

-- ── 3. Before ──────────────────────────────────────────────────────────────
CREATE TEMP TABLE go_live_counts (seq SERIAL, stage TEXT, name TEXT, n BIGINT) ON COMMIT DROP;
INSERT INTO go_live_counts (stage, name, n)
SELECT 'before', t.name, t.n FROM (VALUES
  ('accounts kept',              (SELECT count(*) FROM auth.users WHERE id NOT IN (SELECT id FROM go_live_drop))),
  ('accounts deleted',           (SELECT count(*) FROM go_live_drop)),
  ('attendance_logs',            (SELECT count(*) FROM public.attendance_logs)),
  ('attendance_taps',            (SELECT count(*) FROM public.attendance_taps)),
  ('leave_requests',             (SELECT count(*) FROM public.leave_requests)),
  ('payroll_entries',            (SELECT count(*) FROM public.payroll_entries)),
  ('payroll_records',            (SELECT count(*) FROM public.payroll_records)),
  ('payroll_loans',              (SELECT count(*) FROM public.payroll_loans)),
  ('payroll_subsidy_balances',   (SELECT count(*) FROM public.payroll_subsidy_balances)),
  ('employee_awol_cases',        (SELECT count(*) FROM public.employee_awol_cases)),
  ('audit_logs',                 (SELECT count(*) FROM public.audit_logs)),
  ('KEEP branches',              (SELECT count(*) FROM public.branches)),
  ('KEEP role_permissions',      (SELECT count(*) FROM public.role_permissions)),
  ('KEEP system_config',         (SELECT count(*) FROM public.system_config)),
  ('KEEP payroll_rate_configs',  (SELECT count(*) FROM public.payroll_rate_configs)),
  ('KEEP payroll_tax_brackets',  (SELECT count(*) FROM public.payroll_tax_brackets)),
  ('KEEP attendance_holidays',   (SELECT count(*) FROM public.attendance_holidays))
) AS t(name, n);

-- ── 4. Switch the delete guards off (this transaction only) ───────────────
ALTER TABLE public.attendance_blocked_taps      DISABLE TRIGGER USER;
ALTER TABLE public.attendance_corrections       DISABLE TRIGGER USER;
ALTER TABLE public.attendance_logs              DISABLE TRIGGER USER;
ALTER TABLE public.attendance_logs_history      DISABLE TRIGGER USER;
ALTER TABLE public.attendance_overtime_approvals DISABLE TRIGGER USER;
ALTER TABLE public.attendance_taps              DISABLE TRIGGER USER;
ALTER TABLE public.audit_logs                   DISABLE TRIGGER USER;
ALTER TABLE public.employee_awol_cases          DISABLE TRIGGER USER;
ALTER TABLE public.employee_license_alerts      DISABLE TRIGGER USER;
ALTER TABLE public.employee_license_changes     DISABLE TRIGGER USER;
ALTER TABLE public.employee_license_documents   DISABLE TRIGGER USER;
ALTER TABLE public.employee_status_changes      DISABLE TRIGGER USER;
ALTER TABLE public.payroll_cash_advances        DISABLE TRIGGER USER;
ALTER TABLE public.payroll_deductions           DISABLE TRIGGER USER;
ALTER TABLE public.payroll_incentives           DISABLE TRIGGER USER;
ALTER TABLE public.payroll_loan_payments        DISABLE TRIGGER USER;
ALTER TABLE public.payroll_loans                DISABLE TRIGGER USER;
ALTER TABLE public.payroll_monthly_incentives   DISABLE TRIGGER USER;
ALTER TABLE public.payroll_records              DISABLE TRIGGER USER;
ALTER TABLE public.payroll_schedule_settings    DISABLE TRIGGER USER;
ALTER TABLE public.payroll_setting_changes      DISABLE TRIGGER USER;
ALTER TABLE public.payroll_subsidy_adjustments  DISABLE TRIGGER USER;
ALTER TABLE public.payroll_subsidy_balances     DISABLE TRIGGER USER;
ALTER TABLE public.payroll_subsidy_settings     DISABLE TRIGGER USER;
ALTER TABLE public.payroll_thirteenth_month     DISABLE TRIGGER USER;
ALTER TABLE public.profiles                     DISABLE TRIGGER USER;

-- ── 5. Settings stay; their "created by" link to a test account is cleared ─
UPDATE public.payroll_schedule_settings SET created_by = NULL WHERE created_by IN (SELECT id FROM go_live_drop);
UPDATE public.payroll_subsidy_settings  SET created_by = NULL WHERE created_by IN (SELECT id FROM go_live_drop);
UPDATE public.payroll_tax_brackets      SET created_by = NULL WHERE created_by IN (SELECT id FROM go_live_drop);
-- payroll_rate_configs.created_by is not a foreign key: left as the record of who set each rate.
UPDATE public.attendance_holidays       SET created_by = NULL WHERE created_by IN (SELECT id FROM go_live_drop);

-- ── 6. Delete the test data, children first ───────────────────────────────
-- Payroll
DELETE FROM public.payroll_loan_payments;
DELETE FROM public.payroll_subsidy_adjustments;
DELETE FROM public.payroll_loans;
DELETE FROM public.payroll_subsidy_balances;
DELETE FROM public.payroll_deductions;
DELETE FROM public.payroll_incentives;
DELETE FROM public.payroll_records;
DELETE FROM public.payroll_entries;
DELETE FROM public.payroll_monthly_incentives;
DELETE FROM public.payroll_thirteenth_month;
DELETE FROM public.payroll_cash_advances;
DELETE FROM public.payroll_contribution_amounts;
DELETE FROM public.payroll_setting_changes WHERE setting_type = 'teacher_license' OR employee_id IS NOT NULL;

-- Attendance
DELETE FROM public.attendance_corrections;
DELETE FROM public.attendance_logs_history;
DELETE FROM public.attendance_overtime_approvals;
DELETE FROM public.attendance_taps;
DELETE FROM public.attendance_blocked_taps;
DELETE FROM public.attendance_logs;

-- HR records
DELETE FROM public.employee_status_changes;
DELETE FROM public.employee_awol_cases;
DELETE FROM public.employee_license_alerts;
DELETE FROM public.employee_license_changes;
UPDATE public.profiles SET prc_id_document_id = NULL, license_verified_by = NULL
 WHERE prc_id_document_id IS NOT NULL OR license_verified_by IS NOT NULL;
DELETE FROM public.employee_license_documents;
DELETE FROM public.leave_requests;
DELETE FROM public.transfer_requests;

-- Audit trail and sign-in state (test activity)
DELETE FROM public.audit_logs;
DELETE FROM public.auth_email_otps;
DELETE FROM public.auth_throttle;

-- Accounts (profiles first; auth.users removes their identities and sessions)
DELETE FROM public.employee_branch_assignments WHERE user_id IN (SELECT id FROM go_live_drop);
UPDATE public.profiles SET archived_by = NULL WHERE archived_by IN (SELECT id FROM go_live_drop);
DELETE FROM public.profiles WHERE id IN (SELECT id FROM go_live_drop);
DELETE FROM auth.users       WHERE id IN (SELECT id FROM go_live_drop);

-- ── 7. Switch the guards back on ──────────────────────────────────────────
ALTER TABLE public.attendance_blocked_taps      ENABLE TRIGGER USER;
ALTER TABLE public.attendance_corrections       ENABLE TRIGGER USER;
ALTER TABLE public.attendance_logs              ENABLE TRIGGER USER;
ALTER TABLE public.attendance_logs_history      ENABLE TRIGGER USER;
ALTER TABLE public.attendance_overtime_approvals ENABLE TRIGGER USER;
ALTER TABLE public.attendance_taps              ENABLE TRIGGER USER;
ALTER TABLE public.audit_logs                   ENABLE TRIGGER USER;
ALTER TABLE public.employee_awol_cases          ENABLE TRIGGER USER;
ALTER TABLE public.employee_license_alerts      ENABLE TRIGGER USER;
ALTER TABLE public.employee_license_changes     ENABLE TRIGGER USER;
ALTER TABLE public.employee_license_documents   ENABLE TRIGGER USER;
ALTER TABLE public.employee_status_changes      ENABLE TRIGGER USER;
ALTER TABLE public.payroll_cash_advances        ENABLE TRIGGER USER;
ALTER TABLE public.payroll_deductions           ENABLE TRIGGER USER;
ALTER TABLE public.payroll_incentives           ENABLE TRIGGER USER;
ALTER TABLE public.payroll_loan_payments        ENABLE TRIGGER USER;
ALTER TABLE public.payroll_loans                ENABLE TRIGGER USER;
ALTER TABLE public.payroll_monthly_incentives   ENABLE TRIGGER USER;
ALTER TABLE public.payroll_records              ENABLE TRIGGER USER;
ALTER TABLE public.payroll_schedule_settings    ENABLE TRIGGER USER;
ALTER TABLE public.payroll_setting_changes      ENABLE TRIGGER USER;
ALTER TABLE public.payroll_subsidy_adjustments  ENABLE TRIGGER USER;
ALTER TABLE public.payroll_subsidy_balances     ENABLE TRIGGER USER;
ALTER TABLE public.payroll_subsidy_settings     ENABLE TRIGGER USER;
ALTER TABLE public.payroll_thirteenth_month     ENABLE TRIGGER USER;
ALTER TABLE public.profiles                     ENABLE TRIGGER USER;

-- ── 8. After ───────────────────────────────────────────────────────────────
INSERT INTO go_live_counts (stage, name, n)
SELECT 'after', t.name, t.n FROM (VALUES
  ('accounts',                   (SELECT count(*) FROM auth.users)),
  ('profiles',                   (SELECT count(*) FROM public.profiles)),
  ('attendance_logs',            (SELECT count(*) FROM public.attendance_logs)),
  ('leave_requests',             (SELECT count(*) FROM public.leave_requests)),
  ('payroll_entries',            (SELECT count(*) FROM public.payroll_entries)),
  ('payroll_loans',              (SELECT count(*) FROM public.payroll_loans)),
  ('audit_logs',                 (SELECT count(*) FROM public.audit_logs)),
  ('KEEP branches',              (SELECT count(*) FROM public.branches)),
  ('KEEP role_permissions',      (SELECT count(*) FROM public.role_permissions)),
  ('KEEP system_config',         (SELECT count(*) FROM public.system_config)),
  ('KEEP payroll_rate_configs',  (SELECT count(*) FROM public.payroll_rate_configs)),
  ('KEEP payroll_tax_brackets',  (SELECT count(*) FROM public.payroll_tax_brackets)),
  ('KEEP attendance_holidays',   (SELECT count(*) FROM public.attendance_holidays)),
  ('guards still OFF (must be 0)', (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                                     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'D'))
) AS t(name, n);

-- ── 9. Dry run stops here and rolls everything back ────────────────────────
DO $$
DECLARE
  v_summary TEXT;
BEGIN
  IF (SELECT dry_run FROM go_live_mode) THEN
    SELECT string_agg(format('%s %s = %s', stage, name, n), E'\n' ORDER BY seq)
      INTO v_summary FROM go_live_counts;
    RAISE EXCEPTION E'DRY RUN: nothing was saved. Counts:\n%', v_summary;
  END IF;
  IF (SELECT n FROM go_live_counts WHERE name LIKE 'guards still OFF%') <> 0 THEN
    RAISE EXCEPTION 'A delete guard is still switched off; rolling back.';
  END IF;
END;
$$;

COMMIT;

-- Final counts (shown in the SQL Editor after a real run).
SELECT 'accounts' AS name, count(*) AS n FROM auth.users
UNION ALL SELECT 'attendance_logs', count(*) FROM public.attendance_logs
UNION ALL SELECT 'payroll_entries', count(*) FROM public.payroll_entries
UNION ALL SELECT 'payroll_loans', count(*) FROM public.payroll_loans
UNION ALL SELECT 'branches (kept)', count(*) FROM public.branches
UNION ALL SELECT 'payroll_rate_configs (kept)', count(*) FROM public.payroll_rate_configs
UNION ALL SELECT 'attendance_holidays (kept)', count(*) FROM public.attendance_holidays;
