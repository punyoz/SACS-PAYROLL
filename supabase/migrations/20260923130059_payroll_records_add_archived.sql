-- Hard delete is blocked on payroll_records (block_hard_delete trigger), so
-- records that should no longer surface are archived instead.
alter table public.payroll_records add column if not exists archived boolean not null default false;
