-- ═══════════════════════════════════════════════════════════════════════════
-- Baseline: the tables and types that existed before this repository's
-- migrations began (created in the Supabase dashboard)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- profiles, attendance_logs, audit_logs, payroll_records, leave_requests and
-- payroll_entries, with the enum types they use, were created in the
-- dashboard. The later files create them with CREATE TABLE IF NOT EXISTS,
-- which did nothing on the live project but, on an empty database, built a
-- different shape (leave_requests.id uuid instead of text, profiles.role text
-- instead of user_role, payroll_entries missing 19 columns), so a from-scratch
-- replay failed. Found by the local replay of Oct 12, 2026
-- (docs/local-migration-replay.md).
--
-- Copied from the live catalog (format_type / pg_get_expr) on Oct 12, 2026:
-- columns, types, defaults, NOT NULL and primary keys only. Constraints,
-- indexes, triggers, grants and RLS stay in the files that added them. Every
-- statement is guarded, so on the live project this changes nothing; the
-- migration history repair records it as already applied there.
--
-- approval_action, attendance_state and employee_kind are dashboard-era types
-- no code uses; they are kept so a rebuilt database matches the live one.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role' AND typnamespace = 'public'::regnamespace) THEN
    CREATE TYPE public.user_role AS ENUM ('admin', 'accountant', 'employee', 'hr', 'super_admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payroll_state' AND typnamespace = 'public'::regnamespace) THEN
    CREATE TYPE public.payroll_state AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'paid');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'approval_action' AND typnamespace = 'public'::regnamespace) THEN
    CREATE TYPE public.approval_action AS ENUM ('submitted', 'approved', 'rejected', 'withdrawn');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_state' AND typnamespace = 'public'::regnamespace) THEN
    CREATE TYPE public.attendance_state AS ENUM ('present', 'late', 'absent');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'employee_kind' AND typnamespace = 'public'::regnamespace) THEN
    CREATE TYPE public.employee_kind AS ENUM ('teaching', 'non_teaching');
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid NOT NULL,
  email text NOT NULL,
  full_name text NOT NULL,
  role public.user_role NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  employee_id text,
  employee_type text DEFAULT 'Teaching'::text NOT NULL,
  "position" text DEFAULT 'Staff'::text NOT NULL,
  basic_salary numeric(12,2) DEFAULT 0 NOT NULL,
  employee_status text DEFAULT 'Active'::text NOT NULL,
  rfid_uid text,
  archived boolean DEFAULT false NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.attendance_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  employee_id uuid,
  employee_name text NOT NULL,
  employee_type text,
  rfid_code text,
  time_in timestamp with time zone,
  time_out timestamp with time zone,
  total_hours numeric(8,2) DEFAULT 0 NOT NULL,
  status text DEFAULT 'Absent'::text NOT NULL,
  log_date date DEFAULT CURRENT_DATE NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  module text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  description text,
  status text DEFAULT 'success'::text NOT NULL,
  source text DEFAULT 'api'::text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.payroll_records (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  employee_id uuid,
  employee_name text NOT NULL,
  employee_type text,
  gross_pay numeric(12,2) DEFAULT 0 NOT NULL,
  total_deductions numeric(12,2) DEFAULT 0 NOT NULL,
  net_pay numeric(12,2) DEFAULT 0 NOT NULL,
  period_label text,
  processed_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.leave_requests (
  id text NOT NULL,
  employee_id uuid,
  employee_name text DEFAULT 'Unknown Employee'::text NOT NULL,
  "position" text DEFAULT 'Employee'::text NOT NULL,
  leave_type text DEFAULT 'Leave'::text NOT NULL,
  start_date text DEFAULT ''::text NOT NULL,
  end_date text DEFAULT ''::text NOT NULL,
  reason text DEFAULT 'No reason provided.'::text NOT NULL,
  proof_url text DEFAULT ''::text NOT NULL,
  status text DEFAULT 'pending_accountant'::text NOT NULL,
  submitted_at timestamp with time zone DEFAULT now() NOT NULL,
  decided_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.payroll_entries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  employee_id uuid,
  payroll_period_id uuid,
  basic_salary numeric(12,2) DEFAULT 0,
  transport_allowance numeric(12,2) DEFAULT 0,
  rice_allowance numeric(12,2) DEFAULT 0,
  overtime_pay numeric(12,2) DEFAULT 0,
  bonus numeric(12,2) DEFAULT 0,
  sss numeric(12,2) DEFAULT 0,
  philhealth numeric(12,2) DEFAULT 0,
  pagibig numeric(12,2) DEFAULT 0,
  withholding_tax numeric(12,2) DEFAULT 0,
  absences_deduction numeric(12,2) DEFAULT 0,
  cash_advance numeric(12,2) DEFAULT 0,
  gross_pay numeric(12,2) DEFAULT 0,
  total_deductions numeric(12,2) DEFAULT 0,
  net_pay numeric(12,2) DEFAULT 0,
  status public.payroll_state DEFAULT 'draft'::public.payroll_state,
  submitted_by uuid,
  approved_by uuid,
  approved_at timestamp with time zone,
  rejection_reason text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);
