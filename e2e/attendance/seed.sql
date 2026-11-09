-- Attendance redesign tests: ONE fixed data set, seeded once before the run
-- (e2e/attendance/global-setup.mjs). LOCAL stack only; never run on live.
-- Idempotent: it removes only the rows it adds (dates Oct 22-31, 2026 for
-- Bea and Carlo, "E2E seed" reasons, the "E2E Special Day" holiday).
--
-- Range Oct 22-31, 2026 (Oct 24-25 and Oct 31 are rest days, no rows):
--   Bea   (Main)   Oct 22 On Time · 23 Early Bird · 26 Undertime · 27 Half Day
--                  28 Incomplete + a pending correction · 29 Corrected · 30 On Leave
--   Carlo (North)  Oct 22 Late · 23 Absent · 26 On Time with overtime (19:30 out)
--                  27 Incomplete · 28 Holiday (E2E Special Day, North only)
--   Blocked taps   Oct 22: Bea's inactive card; an unregistered card
-- Statuses are written as given (the status engine is bypassed for these
-- test rows only), so every status is present.
begin;
set local session_replication_role = replica;

delete from attendance_corrections where reason like 'E2E seed%';
delete from attendance_blocked_taps where reason like 'E2E seed%';
delete from attendance_holidays where name = 'E2E Special Day';
delete from attendance_logs
where employee_id in (select id from profiles where email in ('emp2@e2e.test', 'emp3@e2e.test'))
  and log_date between '2026-10-22' and '2026-10-31';

with p as (select id, full_name, employee_type, branch_id, email from profiles where email in ('emp2@e2e.test', 'emp3@e2e.test')),
rows_(email, d, st, tin, tout, hrs, late, under, half, early) as (values
  ('emp2@e2e.test', '2026-10-22', 'On Time',    '07:00', '17:00', 8.00, 0, 0, false, false),
  ('emp2@e2e.test', '2026-10-23', 'Early Bird', '06:40', '17:00', 8.00, 0, 0, false, true),
  ('emp2@e2e.test', '2026-10-26', 'Undertime',  '07:00', '15:30', 6.50, 0, 90, false, false),
  ('emp2@e2e.test', '2026-10-27', 'Half Day',   '07:00', '11:00', 4.00, 0, 0, true, false),
  ('emp2@e2e.test', '2026-10-28', 'Incomplete', '07:00', null,    0.00, 0, 0, false, false),
  ('emp2@e2e.test', '2026-10-29', 'Corrected',  '07:00', '17:00', 8.00, 0, 0, false, false),
  ('emp2@e2e.test', '2026-10-30', 'On Leave',   null,    null,    0.00, 0, 0, false, false),
  ('emp3@e2e.test', '2026-10-22', 'Late',       '08:30', '17:00', 7.50, 90, 0, false, false),
  ('emp3@e2e.test', '2026-10-23', 'Absent',     null,    null,    0.00, 0, 0, false, false),
  ('emp3@e2e.test', '2026-10-26', 'On Time',    '07:00', '19:30', 10.50, 0, 0, false, false),
  ('emp3@e2e.test', '2026-10-27', 'Incomplete', '07:00', null,    0.00, 0, 0, false, false),
  ('emp3@e2e.test', '2026-10-28', 'Holiday',    null,    null,    0.00, 0, 0, false, false)
)
insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out, total_hours, status,
  late_minutes, undertime_minutes, is_half_day, is_early_bird, archived_duplicate)
select p.id, p.full_name, p.employee_type, p.branch_id, r.d::date,
  case when r.tin is null then null else (r.d || ' ' || r.tin)::timestamp at time zone 'Asia/Manila' end,
  case when r.tout is null then null else (r.d || ' ' || r.tout)::timestamp at time zone 'Asia/Manila' end,
  r.hrs, r.st, r.late, r.under, r.half, r.early, false
from rows_ r join p on p.email = r.email;

insert into attendance_corrections (log_id, employee_id, employee_name, branch_id, log_date, original_status, original_time_in, original_time_out,
  corrected_time_out, reason, requested_at, requested_by, requested_by_name, status)
select l.id, l.employee_id, l.employee_name, l.branch_id, l.log_date, l.status, l.time_in, l.time_out,
  ('2026-10-28 17:00')::timestamp at time zone 'Asia/Manila', 'E2E seed: forgot to tap out', now(), l.employee_id, l.employee_name, 'pending'
from attendance_logs l join profiles p on p.id = l.employee_id
where p.email = 'emp2@e2e.test' and l.log_date = '2026-10-28';

insert into attendance_blocked_taps (employee_id, employee_name, branch_id, log_date, attempted_at, reason, rfid_code, source)
select p.id, p.full_name, p.branch_id, date '2026-10-22', ('2026-10-22 07:05')::timestamp at time zone 'Asia/Manila', 'E2E seed: card inactive', '••••••0002', 'rfid_tap'
from profiles p where p.email = 'emp2@e2e.test'
union all
select null, null, (select branch_id from profiles where email = 'emp2@e2e.test'), date '2026-10-22', ('2026-10-22 07:10')::timestamp at time zone 'Asia/Manila',
  'E2E seed: unregistered card', '••••••9999', 'rfid_tap';

insert into attendance_holidays (holiday_date, name, type, day_part, branch_ids, created_by_name)
select date '2026-10-28', 'E2E Special Day', 'special', 'whole', array[(select branch_id from profiles where email = 'emp3@e2e.test')], 'E2E seed';

set local session_replication_role = origin;
commit;
