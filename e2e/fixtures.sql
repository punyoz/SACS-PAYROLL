-- LOCAL E2E fixtures only (run by e2e/seed-e2e.mjs inside supabase_db_SACS-PAYROLL).
-- Never run on live. Idempotent: clears the e2e accounts' own rows first.
begin;

-- Re-seeding replaces the test accounts' attendance; the hard-delete guard is
-- bypassed for this local fixture only.
set local session_replication_role = replica;
delete from attendance_logs where employee_id in (select id from profiles where email like '%@e2e.test');
set local session_replication_role = origin;

-- Attendance Oct 1-21, 2026 (weekdays). 07:00-17:00 Manila = on time.
--   Ana  (emp1): absent Oct 6, late Oct 8 (08:30)
--   Bea  (emp2): absent Oct 7, late Oct 15
--   Carlo(emp3, North): every day on time
with days as (
  select d::date as day from generate_series('2026-10-01'::date, '2026-10-21'::date, '1 day') d
  where extract(isodow from d) < 6
), emp as (
  select id, full_name, branch_id, employee_type, email from profiles
  where email in ('emp1@e2e.test', 'emp2@e2e.test', 'emp3@e2e.test', 'acct@e2e.test', 'hr@e2e.test')
), plan as (
  select e.*, d.day,
    case
      when e.email = 'emp1@e2e.test' and d.day = '2026-10-06' then 'absent'
      when e.email = 'emp1@e2e.test' and d.day = '2026-10-08' then 'late'
      when e.email = 'emp2@e2e.test' and d.day = '2026-10-07' then 'absent'
      when e.email = 'emp2@e2e.test' and d.day = '2026-10-15' then 'late'
      else 'ok' end as kind
  from emp e cross join days d
)
insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out, status)
select id, full_name, employee_type, branch_id, day,
  case kind when 'absent' then null when 'late' then (day + time '08:30') at time zone 'Asia/Manila' else (day + time '07:00') at time zone 'Asia/Manila' end,
  case kind when 'absent' then null else (day + time '17:00') at time zone 'Asia/Manila' end,
  'Absent'
from plan;

commit;
