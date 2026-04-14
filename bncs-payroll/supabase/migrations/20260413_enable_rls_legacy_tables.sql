begin;

-- Security Advisor fix for legacy tables that exist in some deployments.
-- This migration is idempotent and only applies to tables that currently exist.
do $$
declare
  tbl text;
  policy_prefix text;
  legacy_tables text[] := array[
    'employees',
    'attendance',
    'payroll_entries',
    'payroll_periods',
    'approval_logs',
    'payslips'
  ];
begin
  foreach tbl in array legacy_tables loop
    if to_regclass(format('public.%I', tbl)) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', tbl);

    policy_prefix := format('%s_authenticated', tbl);

    execute format('drop policy if exists %I on public.%I', policy_prefix || '_select', tbl);
    execute format('drop policy if exists %I on public.%I', policy_prefix || '_insert', tbl);
    execute format('drop policy if exists %I on public.%I', policy_prefix || '_update', tbl);
    execute format('drop policy if exists %I on public.%I', policy_prefix || '_delete', tbl);

    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      policy_prefix || '_select',
      tbl
    );

    execute format(
      'create policy %I on public.%I for insert to authenticated with check (true)',
      policy_prefix || '_insert',
      tbl
    );

    execute format(
      'create policy %I on public.%I for update to authenticated using (true) with check (true)',
      policy_prefix || '_update',
      tbl
    );

    execute format(
      'create policy %I on public.%I for delete to authenticated using (true)',
      policy_prefix || '_delete',
      tbl
    );
  end loop;
end $$;

commit;
