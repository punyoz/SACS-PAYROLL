-- One live payroll record per employee per pay period. The app already refuses
-- to re-process a paid entry, but runs from before that guard left duplicate
-- records behind; this makes the database refuse them too. Archived rows are
-- excluded so an archived record never blocks a legitimate replacement.
create unique index if not exists payroll_records_employee_period_uniq
  on public.payroll_records (employee_id, period_label)
  where not archived;
