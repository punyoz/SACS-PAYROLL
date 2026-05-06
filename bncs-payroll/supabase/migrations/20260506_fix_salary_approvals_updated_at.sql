-- Fix: ensure updated_at column exists on salary_approvals so the
-- set_updated_at trigger does not fail on approve/reject actions.
-- Safe to run multiple times (uses IF NOT EXISTS / CREATE OR REPLACE).

begin;

-- Add updated_at if the table was created by an older migration that omitted it.
alter table public.salary_approvals
  add column if not exists updated_at timestamptz not null default now();

-- Also ensure decided_at exists (some older schemas omit it).
alter table public.salary_approvals
  add column if not exists decided_at timestamptz;

-- Recreate the trigger so it is always in the correct state.
drop trigger if exists trg_salary_approvals_set_updated_at on public.salary_approvals;
create trigger trg_salary_approvals_set_updated_at
  before update on public.salary_approvals
  for each row
  execute function public.set_updated_at();

-- Service-role bypass policy (allows API routes using the service key to
-- read/write without needing an authenticated JWT).
drop policy if exists salary_approvals_service_role_all on public.salary_approvals;
create policy salary_approvals_service_role_all
  on public.salary_approvals
  for all
  to service_role
  using (true)
  with check (true);

commit;
