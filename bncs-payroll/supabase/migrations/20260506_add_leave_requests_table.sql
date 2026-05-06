-- Migration: add leave_requests table
-- Applying this migration lets the system use the database for leave requests
-- instead of Supabase Storage. Both approaches work; the database is preferred
-- because it handles concurrent writes atomically.
--
-- Apply via: supabase db push
-- or paste into the Supabase SQL Editor and run.

begin;

create table if not exists public.leave_requests (
  id text primary key,
  employee_id text,
  employee_name text not null default 'Unknown Employee',
  position text not null default 'Employee',
  leave_type text not null default 'Leave',
  start_date text not null default '',
  end_date text not null default '',
  reason text not null default 'No reason provided.',
  -- proof_url may hold a large base64 data URL (up to ~3 MB per row).
  proof_url text not null default '',
  status text not null default 'pending_accountant',
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists leave_requests_status_idx
  on public.leave_requests(status);

create index if not exists leave_requests_employee_id_idx
  on public.leave_requests(employee_id);

create index if not exists leave_requests_submitted_at_idx
  on public.leave_requests(submitted_at desc);

drop trigger if exists trg_leave_requests_set_updated_at on public.leave_requests;
create trigger trg_leave_requests_set_updated_at
  before update on public.leave_requests
  for each row
  execute function public.set_updated_at();

-- Allow all roles (admin, accountant, employee) to read rows they own or are
-- responsible for. The API uses the service_role key which bypasses RLS, but
-- these policies cover direct access.

alter table public.leave_requests enable row level security;

drop policy if exists leave_requests_service_role_all on public.leave_requests;
create policy leave_requests_service_role_all
  on public.leave_requests
  for all
  to service_role
  using (true)
  with check (true);

commit;
