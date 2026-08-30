-- Backfills the schema for tables that were created out-of-band (directly in
-- the Supabase dashboard) at some point before this repo's migration history
-- began tracking them. Every later migration that ALTERs one of these tables
-- (20260509_add_payslip_no.sql, 20260513_add_payroll_breakdown_to_salary_approvals.sql,
-- 20260520_add_hr_role_enum.sql, 20260522_add_super_admin_role_enum.sql) depends
-- on it existing first, which is why this file is dated earlier than all of them.
--
-- Entirely idempotent (CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN IF
-- NOT EXISTS per column, matching the style already used in
-- 20260522_create_branches.sql) — safe to run whether these tables already
-- exist live with a compatible schema, or don't exist at all yet.

-- ─── user_role enum ─────────────────────────────────────────────────────────
-- Postgres has no `CREATE TYPE IF NOT EXISTS`, so this needs a guard. The two
-- later ADD VALUE migrations ('hr', 'super_admin') layer on top of this base set.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE public.user_role AS ENUM ('admin', 'accountant', 'employee', 'it');
  END IF;
END;
$$;

-- ─── profiles ────────────────────────────────────────────────────────────────
-- Column set matched to what's live today (confirmed via direct query this session).
CREATE TABLE IF NOT EXISTS public.profiles (
  id                  UUID PRIMARY KEY,
  email               TEXT,
  full_name           TEXT,
  role                TEXT,
  employee_id         TEXT,
  employee_type       TEXT,
  position            TEXT,
  basic_salary        NUMERIC NOT NULL DEFAULT 0,
  employee_status     TEXT NOT NULL DEFAULT 'Active',
  rfid_uid            TEXT,
  archived            BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email           TEXT,
  ADD COLUMN IF NOT EXISTS full_name       TEXT,
  ADD COLUMN IF NOT EXISTS role            TEXT,
  ADD COLUMN IF NOT EXISTS employee_id     TEXT,
  ADD COLUMN IF NOT EXISTS employee_type   TEXT,
  ADD COLUMN IF NOT EXISTS position        TEXT,
  ADD COLUMN IF NOT EXISTS basic_salary    NUMERIC,
  ADD COLUMN IF NOT EXISTS employee_status TEXT,
  ADD COLUMN IF NOT EXISTS rfid_uid        TEXT,
  ADD COLUMN IF NOT EXISTS archived        BOOLEAN,
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ;

-- ─── attendance_logs ─────────────────────────────────────────────────────────
-- Column set matched to src/app/api/admin/attendance/route.js's insert/select shape.
CREATE TABLE IF NOT EXISTS public.attendance_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL,
  employee_name   TEXT,
  employee_type   TEXT,
  rfid_code       TEXT,
  time_in         TIMESTAMPTZ,
  time_out        TIMESTAMPTZ,
  total_hours     NUMERIC NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'Present',
  log_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.attendance_logs
  ADD COLUMN IF NOT EXISTS employee_id   UUID,
  ADD COLUMN IF NOT EXISTS employee_name TEXT,
  ADD COLUMN IF NOT EXISTS employee_type TEXT,
  ADD COLUMN IF NOT EXISTS rfid_code     TEXT,
  ADD COLUMN IF NOT EXISTS time_in       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS time_out      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_hours   NUMERIC,
  ADD COLUMN IF NOT EXISTS status        TEXT,
  ADD COLUMN IF NOT EXISTS log_date      DATE,
  ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS attendance_logs_employee_date_idx
  ON public.attendance_logs (employee_id, log_date);

-- ─── audit_logs ──────────────────────────────────────────────────────────────
-- Column set matched to src/lib/audit/store.js's insert shape.
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  module        TEXT NOT NULL DEFAULT 'system',
  action        TEXT NOT NULL DEFAULT 'event',
  entity_type   TEXT NOT NULL DEFAULT 'resource',
  entity_id     TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'success',
  source        TEXT NOT NULL DEFAULT 'api',
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS module      TEXT,
  ADD COLUMN IF NOT EXISTS action      TEXT,
  ADD COLUMN IF NOT EXISTS entity_type TEXT,
  ADD COLUMN IF NOT EXISTS entity_id   TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS status      TEXT,
  ADD COLUMN IF NOT EXISTS source      TEXT,
  ADD COLUMN IF NOT EXISTS metadata    JSONB;

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON public.audit_logs (created_at DESC);

-- ─── salary_approvals ────────────────────────────────────────────────────────
-- Column set matched to src/lib/salary-approvals/store.js's FULL_SELECT. The
-- payroll_breakdown column is added afterward by the existing
-- 20260513_add_payroll_breakdown_to_salary_approvals.sql migration.
CREATE TABLE IF NOT EXISTS public.salary_approvals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       TEXT,
  employee_name     TEXT,
  employee_code     TEXT,
  employee_type     TEXT,
  position          TEXT,
  current_salary    NUMERIC NOT NULL DEFAULT 0,
  proposed_salary   NUMERIC NOT NULL DEFAULT 0,
  reason            TEXT,
  submitted_by      TEXT,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status            TEXT NOT NULL DEFAULT 'pending',
  decided_at        TIMESTAMPTZ
);

ALTER TABLE public.salary_approvals
  ADD COLUMN IF NOT EXISTS employee_id     TEXT,
  ADD COLUMN IF NOT EXISTS employee_name   TEXT,
  ADD COLUMN IF NOT EXISTS employee_code   TEXT,
  ADD COLUMN IF NOT EXISTS employee_type   TEXT,
  ADD COLUMN IF NOT EXISTS position        TEXT,
  ADD COLUMN IF NOT EXISTS current_salary  NUMERIC,
  ADD COLUMN IF NOT EXISTS proposed_salary NUMERIC,
  ADD COLUMN IF NOT EXISTS reason          TEXT,
  ADD COLUMN IF NOT EXISTS submitted_by    TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status          TEXT,
  ADD COLUMN IF NOT EXISTS decided_at      TIMESTAMPTZ;

-- ─── payroll_records ─────────────────────────────────────────────────────────
-- Column set matched to appendPayrollRecord()/fetchPayrollRecords() in
-- src/app/api/accountant/payroll/route.js. The payslip_no column + unique
-- constraint are added afterward by the existing 20260509_add_payslip_no.sql
-- migration.
CREATE TABLE IF NOT EXISTS public.payroll_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       UUID,
  employee_name     TEXT,
  employee_type     TEXT,
  gross_pay         NUMERIC NOT NULL DEFAULT 0,
  total_deductions  NUMERIC NOT NULL DEFAULT 0,
  net_pay           NUMERIC NOT NULL DEFAULT 0,
  period_label      TEXT,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.payroll_records
  ADD COLUMN IF NOT EXISTS employee_id      UUID,
  ADD COLUMN IF NOT EXISTS employee_name    TEXT,
  ADD COLUMN IF NOT EXISTS employee_type    TEXT,
  ADD COLUMN IF NOT EXISTS gross_pay        NUMERIC,
  ADD COLUMN IF NOT EXISTS total_deductions NUMERIC,
  ADD COLUMN IF NOT EXISTS net_pay          NUMERIC,
  ADD COLUMN IF NOT EXISTS period_label     TEXT,
  ADD COLUMN IF NOT EXISTS processed_at     TIMESTAMPTZ;
