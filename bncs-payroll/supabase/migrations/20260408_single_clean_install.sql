begin;

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Profiles base table and compatibility columns
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade
);

alter table public.profiles
  add column if not exists email text,
  add column if not exists full_name text default '',
  add column if not exists role text default 'employee',
  add column if not exists employee_id text,
  add column if not exists employee_type text default 'Teaching',
  add column if not exists position text default 'Staff',
  add column if not exists basic_salary numeric(12,2) default 0,
  add column if not exists employee_status text default 'Active',
  add column if not exists rfid_uid text,
  add column if not exists archived boolean default false,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

-- Enum-safe data normalization for pre-existing schemas
update public.profiles
set
  full_name = coalesce(nullif(full_name::text, ''), ''),
  role = coalesce(role, 'employee'),
  employee_type = coalesce(employee_type, 'Teaching'),
  position = coalesce(nullif(position::text, ''), 'Staff'),
  basic_salary = coalesce(basic_salary, 0),
  employee_status = coalesce(employee_status, 'Active'),
  archived = coalesce(archived, false),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, now());

-- Only add role check when role is a text-like column.
do $$
declare
  role_data_type text;
begin
  select data_type
  into role_data_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'profiles'
    and column_name = 'role';

  if role_data_type in ('text', 'character varying', 'character') then
    alter table public.profiles drop constraint if exists profiles_role_check;
    alter table public.profiles
      add constraint profiles_role_check
      check (role in ('admin','accountant','employee'));
  end if;
end $$;

alter table public.profiles drop constraint if exists profiles_employee_type_check;
alter table public.profiles drop constraint if exists profiles_employee_status_check;
alter table public.profiles drop constraint if exists profiles_basic_salary_check;

alter table public.profiles
  add constraint profiles_employee_type_check
  check (employee_type in ('Teaching','Non-Teaching'));

alter table public.profiles
  add constraint profiles_employee_status_check
  check (employee_status in ('Active','Pending','Archived'));

alter table public.profiles
  add constraint profiles_basic_salary_check
  check (basic_salary >= 0);

create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists profiles_employee_id_idx on public.profiles(employee_id);
create index if not exists profiles_archived_idx on public.profiles(archived);

create unique index if not exists profiles_email_unique_idx
  on public.profiles(email)
  where email is not null;

create unique index if not exists profiles_employee_id_unique_idx
  on public.profiles(employee_id)
  where employee_id is not null;

create unique index if not exists profiles_rfid_uid_unique_idx
  on public.profiles(rfid_uid)
  where rfid_uid is not null;

drop trigger if exists trg_profiles_set_updated_at on public.profiles;
create trigger trg_profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create or replace function public.is_admin_user()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role::text = 'admin'
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  );
$$;

create table if not exists public.salary_approvals (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.profiles(id) on delete set null,
  employee_name text not null,
  employee_code text,
  employee_type text,
  position text,
  current_salary numeric(12,2) not null default 0,
  proposed_salary numeric(12,2) not null default 0,
  reason text,
  submitted_by text not null default 'Accountant',
  submitted_at timestamptz not null default now(),
  status text not null default 'pending',
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint salary_approvals_status_check
    check (status in ('pending','approved','rejected')),
  constraint salary_approvals_current_salary_check
    check (current_salary >= 0),
  constraint salary_approvals_proposed_salary_check
    check (proposed_salary >= 0)
);

create index if not exists salary_approvals_status_idx
  on public.salary_approvals(status);
create index if not exists salary_approvals_submitted_at_idx
  on public.salary_approvals(submitted_at desc);
create index if not exists salary_approvals_employee_id_idx
  on public.salary_approvals(employee_id);
create unique index if not exists salary_approvals_employee_pending_idx
  on public.salary_approvals(employee_id)
  where status = 'pending';

drop trigger if exists trg_salary_approvals_set_updated_at on public.salary_approvals;
create trigger trg_salary_approvals_set_updated_at
before update on public.salary_approvals
for each row
execute function public.set_updated_at();

create table if not exists public.payroll_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.profiles(id) on delete set null,
  employee_name text not null,
  employee_type text,
  gross_pay numeric(12,2) not null default 0,
  total_deductions numeric(12,2) not null default 0,
  net_pay numeric(12,2) not null default 0,
  period_label text not null,
  status text not null default 'paid',
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_records_status_check
    check (status in ('paid','pending_approval','on_hold','draft')),
  constraint payroll_records_gross_pay_check
    check (gross_pay >= 0),
  constraint payroll_records_total_deductions_check
    check (total_deductions >= 0)
);

create index if not exists payroll_records_employee_id_idx
  on public.payroll_records(employee_id);
create index if not exists payroll_records_processed_at_idx
  on public.payroll_records(processed_at desc);
create index if not exists payroll_records_period_label_idx
  on public.payroll_records(period_label);

drop trigger if exists trg_payroll_records_set_updated_at on public.payroll_records;
create trigger trg_payroll_records_set_updated_at
before update on public.payroll_records
for each row
execute function public.set_updated_at();

create table if not exists public.attendance_logs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.profiles(id) on delete set null,
  employee_name text not null,
  employee_type text,
  rfid_code text,
  time_in timestamptz,
  time_out timestamptz,
  total_hours numeric(8,2) not null default 0,
  status text not null default 'Absent',
  log_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_logs_status_check
    check (status in ('Present','Late','Absent')),
  constraint attendance_logs_total_hours_check
    check (total_hours >= 0)
);

create index if not exists attendance_logs_employee_id_idx
  on public.attendance_logs(employee_id);
create index if not exists attendance_logs_log_date_idx
  on public.attendance_logs(log_date desc);
create index if not exists attendance_logs_created_at_idx
  on public.attendance_logs(created_at desc);

drop trigger if exists trg_attendance_logs_set_updated_at on public.attendance_logs;
create trigger trg_attendance_logs_set_updated_at
before update on public.attendance_logs
for each row
execute function public.set_updated_at();

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  module text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  description text,
  status text not null default 'success',
  source text not null default 'api',
  metadata jsonb not null default '{}'::jsonb,
  constraint audit_logs_status_check
    check (status in ('success','failed'))
);

create index if not exists audit_logs_created_at_idx
  on public.audit_logs(created_at desc);
create index if not exists audit_logs_module_idx
  on public.audit_logs(module);
create index if not exists audit_logs_action_idx
  on public.audit_logs(action);

drop trigger if exists trg_audit_logs_set_updated_at on public.audit_logs;
create trigger trg_audit_logs_set_updated_at
before update on public.audit_logs
for each row
execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.salary_approvals enable row level security;
alter table public.payroll_records enable row level security;
alter table public.attendance_logs enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.is_admin_user());

drop policy if exists profiles_update_self_or_admin on public.profiles;
create policy profiles_update_self_or_admin
on public.profiles
for update
to authenticated
using (id = auth.uid() or public.is_admin_user())
with check (id = auth.uid() or public.is_admin_user());

drop policy if exists profiles_insert_admin_only on public.profiles;
create policy profiles_insert_admin_only
on public.profiles
for insert
to authenticated
with check (public.is_admin_user());

drop policy if exists profiles_delete_admin_only on public.profiles;
create policy profiles_delete_admin_only
on public.profiles
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists salary_approvals_select_admin_accountant on public.salary_approvals;
create policy salary_approvals_select_admin_accountant
on public.salary_approvals
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text in ('admin','accountant')
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  )
);

drop policy if exists salary_approvals_insert_admin_accountant on public.salary_approvals;
create policy salary_approvals_insert_admin_accountant
on public.salary_approvals
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text in ('admin','accountant')
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  )
);

drop policy if exists salary_approvals_update_admin_accountant on public.salary_approvals;
create policy salary_approvals_update_admin_accountant
on public.salary_approvals
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text in ('admin','accountant')
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text in ('admin','accountant')
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  )
);

drop policy if exists salary_approvals_delete_admin_accountant on public.salary_approvals;
create policy salary_approvals_delete_admin_accountant
on public.salary_approvals
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text in ('admin','accountant')
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  )
);

drop policy if exists payroll_records_select_admin_accountant on public.payroll_records;
create policy payroll_records_select_admin_accountant
on public.payroll_records
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text in ('admin','accountant')
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  )
);

drop policy if exists payroll_records_write_admin_accountant on public.payroll_records;
create policy payroll_records_write_admin_accountant
on public.payroll_records
for all
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text in ('admin','accountant')
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text in ('admin','accountant')
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  )
);

drop policy if exists attendance_logs_select_admin_accountant on public.attendance_logs;
create policy attendance_logs_select_admin_accountant
on public.attendance_logs
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text in ('admin','accountant')
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  )
);

drop policy if exists attendance_logs_write_admin_only on public.attendance_logs;
create policy attendance_logs_write_admin_only
on public.attendance_logs
for all
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists audit_logs_select_admin_only on public.audit_logs;
create policy audit_logs_select_admin_only
on public.audit_logs
for select
to authenticated
using (public.is_admin_user());

drop policy if exists audit_logs_insert_admin_accountant on public.audit_logs;
create policy audit_logs_insert_admin_accountant
on public.audit_logs
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text in ('admin','accountant')
      and coalesce((to_jsonb(p) ->> 'archived')::boolean, false) = false
  )
);

commit;
