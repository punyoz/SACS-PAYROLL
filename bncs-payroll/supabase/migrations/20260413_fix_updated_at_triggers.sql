begin;

-- Fix legacy schemas where update triggers exist but updated_at column is missing.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  tbl text;
  trg text;
  targets text[] := array[
    'profiles',
    'salary_approvals',
    'payroll_records',
    'attendance_logs',
    'audit_logs'
  ];
begin
  foreach tbl in array targets loop
    if to_regclass(format('public.%I', tbl)) is null then
      continue;
    end if;

    execute format(
      'alter table public.%I add column if not exists updated_at timestamptz default now()',
      tbl
    );

    trg := format('trg_%s_set_updated_at', tbl);
    execute format('drop trigger if exists %I on public.%I', trg, tbl);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      trg,
      tbl
    );
  end loop;
end $$;

commit;
