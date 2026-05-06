-- Complete fix for salary approvals: schema, trigger, RLS, and Storage bucket.
-- Safe to run multiple times. Supersedes 20260506_fix_salary_approvals_updated_at.sql.

begin;

-- 1. Ensure set_updated_at function exists (idempotent)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 2. Add missing columns to salary_approvals (safe if they already exist)
alter table public.salary_approvals
  add column if not exists updated_at  timestamptz not null default now(),
  add column if not exists decided_at  timestamptz,
  add column if not exists role        text;

-- 3. Recreate the update trigger so it is always in the correct state
drop trigger if exists trg_salary_approvals_set_updated_at on public.salary_approvals;
create trigger trg_salary_approvals_set_updated_at
  before update on public.salary_approvals
  for each row
  execute function public.set_updated_at();

-- 4. Enable RLS (no-op if already enabled)
alter table public.salary_approvals enable row level security;

-- 5. Service-role bypass policy (lets API routes using the service key act freely)
drop policy if exists salary_approvals_service_role_all on public.salary_approvals;
create policy salary_approvals_service_role_all
  on public.salary_approvals
  for all
  to service_role
  using (true)
  with check (true);

-- 6. Create the Supabase Storage bucket used for approval overrides persistence.
--    ON CONFLICT DO NOTHING makes this safe to run on repeat.
insert into storage.buckets (id, name, public, file_size_limit)
values ('bncs-payroll-store', 'bncs-payroll-store', false, 104857600)
on conflict (id) do nothing;

-- 7. Allow service_role to read/write objects in that bucket
drop policy if exists bncs_payroll_store_service_role_all on storage.objects;
create policy bncs_payroll_store_service_role_all
  on storage.objects
  for all
  to service_role
  using  (bucket_id = 'bncs-payroll-store')
  with check (bucket_id = 'bncs-payroll-store');

commit;
