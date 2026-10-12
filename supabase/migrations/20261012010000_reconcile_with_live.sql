-- ═══════════════════════════════════════════════════════════════════════════
-- Reconcile: constraints and indexes the live project has but no file created
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The local replay of Oct 12, 2026 (docs/local-migration-replay.md) rebuilt the
-- schema from these files and compared it with the live project. Everything
-- matched except the objects below, which were made in the dashboard (or
-- dropped there) and never written to a migration.
--
-- Copied from the live catalog (pg_get_constraintdef / pg_indexes) on
-- Oct 12, 2026. Every statement is guarded, so on the live project this changes
-- nothing; the migration history repair records it as already applied there.
--
-- Function bodies also differed, but only in comments (the live copies were
-- applied without them), so no function is redefined here.

-- ─── Constraints ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('audit_logs', 'audit_logs_status_check',
       $d$CHECK (status = ANY (ARRAY['success'::text, 'failed'::text]))$d$),
      ('payroll_entries', 'payroll_amounts_nonnegative',
       $d$CHECK (gross_pay >= 0 AND total_deductions >= 0 AND net_pay >= 0)$d$),
      ('payroll_entries', 'payroll_entries_absences_deduction_check', 'CHECK (absences_deduction >= 0)'),
      ('payroll_entries', 'payroll_entries_basic_salary_check', 'CHECK (basic_salary >= 0)'),
      ('payroll_entries', 'payroll_entries_bonus_check', 'CHECK (bonus >= 0)'),
      ('payroll_entries', 'payroll_entries_cash_advance_check', 'CHECK (cash_advance >= 0)'),
      ('payroll_entries', 'payroll_entries_overtime_pay_check', 'CHECK (overtime_pay >= 0)'),
      ('payroll_entries', 'payroll_entries_pagibig_check', 'CHECK (pagibig >= 0)'),
      ('payroll_entries', 'payroll_entries_philhealth_check', 'CHECK (philhealth >= 0)'),
      ('payroll_entries', 'payroll_entries_rice_allowance_check', 'CHECK (rice_allowance >= 0)'),
      ('payroll_entries', 'payroll_entries_sss_check', 'CHECK (sss >= 0)'),
      ('payroll_entries', 'payroll_entries_transport_allowance_check', 'CHECK (transport_allowance >= 0)'),
      ('payroll_entries', 'payroll_entries_withholding_tax_check', 'CHECK (withholding_tax >= 0)'),
      ('payroll_entries', 'payroll_entries_approved_by_fkey',
       'FOREIGN KEY (approved_by) REFERENCES public.profiles(id) ON DELETE SET NULL'),
      ('payroll_entries', 'payroll_entries_submitted_by_fkey',
       'FOREIGN KEY (submitted_by) REFERENCES public.profiles(id) ON DELETE SET NULL'),
      ('payroll_entries', 'payroll_entry_unique_emp_period', 'UNIQUE (employee_id, payroll_period_id)'),
      ('profiles', 'profiles_basic_salary_check', 'CHECK (basic_salary >= 0)'),
      ('profiles', 'profiles_email_key', 'UNIQUE (email)'),
      ('profiles', 'profiles_employee_type_check',
       $d$CHECK (employee_type = ANY (ARRAY['Teaching'::text, 'Non-Teaching'::text]))$d$),
      ('profiles', 'profiles_id_fkey',
       'FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE')
    ) AS v(tbl, name, def)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = c.name
         AND conrelid = format('public.%I', c.tbl)::regclass
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', c.tbl, c.name, c.def);
    END IF;
  END LOOP;
END;
$$;

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_payroll_entries_employee
  ON public.payroll_entries (employee_id);
CREATE INDEX IF NOT EXISTS attendance_logs_employee_id_idx
  ON public.attendance_logs (employee_id);
CREATE INDEX IF NOT EXISTS leave_requests_submitted_at_idx
  ON public.leave_requests (submitted_at DESC);
CREATE INDEX IF NOT EXISTS payroll_records_employee_id_idx
  ON public.payroll_records (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_rfid_uid_unique_idx
  ON public.profiles (rfid_uid) WHERE rfid_uid IS NOT NULL;

-- The live index sorts log_date DESC (made before 20260902010000, whose
-- IF NOT EXISTS then skipped it); the files build it ascending.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'attendance_logs_log_date_idx'
       AND indexdef NOT LIKE '%(log_date DESC)%'
  ) THEN
    DROP INDEX public.attendance_logs_log_date_idx;
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS attendance_logs_log_date_idx
  ON public.attendance_logs (log_date DESC);

-- Created by 20260401010000 and 20260917040000 but no longer on the live
-- project (dropped outside the migration files). Dropped here so a rebuilt
-- database matches it.
DROP INDEX IF EXISTS public.attendance_logs_employee_date_idx;
DROP INDEX IF EXISTS public.payroll_entries_updated_at_idx;
