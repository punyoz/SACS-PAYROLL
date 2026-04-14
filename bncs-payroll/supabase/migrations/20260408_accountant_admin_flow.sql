-- BNCS Payroll accountant/admin integration tables
-- Apply this migration in your Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.salary_approvals (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid,
  employee_name text not null,
  employee_code text,
  employee_type text,
  position text,
  current_salary numeric(12,2) not null default 0,
  proposed_salary numeric(12,2) not null default 0,
  reason text,
  submitted_by text,
  submitted_at timestamptz not null default now(),
  status text not null default 'pending',
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint salary_approvals_status_check
    check (status in ('pending', 'approved', 'rejected'))
);

create index if not exists salary_approvals_status_idx
  on public.salary_approvals (status);
create index if not exists salary_approvals_submitted_at_idx
  on public.salary_approvals (submitted_at desc);
create index if not exists salary_approvals_employee_id_idx
  on public.salary_approvals (employee_id);

create table if not exists public.payroll_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid,
  employee_name text not null,
  employee_type text,
  gross_pay numeric(12,2) not null default 0,
  total_deductions numeric(12,2) not null default 0,
  net_pay numeric(12,2) not null default 0,
  period_label text,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists payroll_records_processed_at_idx
  on public.payroll_records (processed_at desc);
create index if not exists payroll_records_employee_id_idx
  on public.payroll_records (employee_id);

create table if not exists public.attendance_logs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid,
  employee_name text not null,
  employee_type text,
  rfid_code text,
  time_in timestamptz,
  time_out timestamptz,
  total_hours numeric(8,2) not null default 0,
  status text not null default 'Absent',
  log_date date not null default current_date,
  created_at timestamptz not null default now(),
  constraint attendance_logs_status_check
    check (status in ('Present', 'Late', 'Absent'))
);

create index if not exists attendance_logs_log_date_idx
  on public.attendance_logs (log_date desc);
create index if not exists attendance_logs_employee_id_idx
  on public.attendance_logs (employee_id);
create index if not exists attendance_logs_created_at_idx
  on public.attendance_logs (created_at desc);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  module text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  description text,
  status text not null default 'success',
  source text not null default 'api',
  metadata jsonb not null default '{}'::jsonb,
  constraint audit_logs_status_check
    check (status in ('success', 'failed'))
);

create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);
create index if not exists audit_logs_module_idx
  on public.audit_logs (module);
create index if not exists audit_logs_action_idx
  on public.audit_logs (action);

-- Optional uniqueness guard to prevent duplicate open approvals for same employee/time window.
create unique index if not exists salary_approvals_employee_pending_idx
  on public.salary_approvals (employee_id)
  where status = 'pending';
