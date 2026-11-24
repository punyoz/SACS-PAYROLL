-- Checks on the defense data (2026-11-24): every query returns the PROBLEMS it finds (0 rows = pass).
-- Scope: the accounts on payroll, Oct 1 to today. Run on the local build before export, and read-only on live after.
\set ON_ERROR_STOP 1
create temporary view s as select id from profiles where not archived and on_payroll and lower(role::text) in ('employee','accountant','hr');
create temporary view pe as select e.*, (e.payroll->'totals'->>'gross_pay')::numeric g, (e.payroll->'totals'->>'total_deductions')::numeric d, (e.payroll->'totals'->>'net_pay')::numeric n
  from payroll_entries e where e.employee_id in (select id from s) and e.pay_period ~ '^(October|November) .*2026$';

\echo '1. every payslip adds up to the centavo (gross + additional pay - deductions = net)'
select employee_name, pay_period, g, d, n from pe where abs(g + coalesce((payroll->'totals'->>'total_incentives')::numeric, 0) - d - n) >= 0.005;

\echo '2. every month reconciles (1st half + 2nd half = the monthly net on the 2nd half)'
select a.employee_name, a.pay_period, a.n first_net, b.n second_net, (b.payroll->'monthly'->>'monthly_net')::numeric monthly_net
from pe a join pe b on b.employee_id = a.employee_id and b.pay_period = replace(replace(a.pay_period, '1-15', '16-31'), 'November 16-31', 'November 16-30')
where a.pay_period like '%1-15%' and b.pay_period not like '%1-15%' and abs(a.n + b.n - (b.payroll->'monthly'->>'monthly_net')::numeric) >= 0.005;

\echo '3. no time out before its time in; one record per person and day; no tap over 3 hours before the shift'
select employee_name, log_date, 'out before in' why from attendance_logs where employee_id in (select id from s) and log_date >= '2026-10-01' and time_out is not null and time_in is not null and time_out <= time_in
union all select max(employee_name), log_date, 'duplicate day' from attendance_logs where employee_id in (select id from s) and log_date >= '2026-10-01' and not archived_duplicate group by employee_id, log_date having count(*) > 1
union all select employee_name, log_date, 'tap over 3 h early' from attendance_logs where employee_id in (select id from s) and log_date >= '2026-10-01' and time_in is not null and shift_start_minutes is not null
  and (extract(hour from time_in at time zone 'Asia/Manila') * 60 + extract(minute from time_in at time zone 'Asia/Manila')) < shift_start_minutes - 180;

\echo '4. late minutes = time in - shift start (whole minutes) on every Late day'
select employee_name, log_date, late_minutes, (extract(hour from time_in at time zone 'Asia/Manila') * 60 + extract(minute from time_in at time zone 'Asia/Manila'))::int - shift_start_minutes expected
from attendance_logs where employee_id in (select id from s) and log_date >= '2026-10-01' and status = 'Late'
  and late_minutes <> (extract(hour from time_in at time zone 'Asia/Manila') * 60 + extract(minute from time_in at time zone 'Asia/Manila'))::int - shift_start_minutes;

\echo '5. approved whole-day leave: On Leave, no taps; no taps on a rest day / holiday (except the special working day)'
select l.employee_name, a.log_date, a.status from leave_requests l join attendance_logs a on a.employee_id = l.employee_id and a.log_date between l.start_date::date and l.end_date::date
where l.employee_id in (select id from s) and l.status = 'approved' and l.half_day is null and (a.status <> 'On Leave' or a.time_in is not null)
union all select a.employee_name, a.log_date, 'tap on a non-working day' from attendance_logs a where a.employee_id in (select id from s) and a.log_date >= '2026-10-01' and a.time_in is not null
  and not public.attendance_is_working_day_for(a.employee_id, a.branch_id, a.log_date);

\echo '6. payslip late / undertime minutes = the attendance records it counted'
select e.employee_name, e.pay_period, (e.payroll->'audit'->'attendance'->'counts'->>'late_minutes')::int on_payslip, sum(coalesce(a.late_minutes, 0)) on_records
from pe e join attendance_logs a on a.id::text in (select jsonb_array_elements_text(e.payroll->'audit'->'attendance'->'source_log_ids'))
where a.status = 'Late' group by e.id, e.employee_name, e.pay_period, e.payroll
having (e.payroll->'audit'->'attendance'->'counts'->>'late_minutes')::int <> sum(coalesce(a.late_minutes, 0));

\echo '7. payroll totals equal across the run, its items, the payslips and the payroll records, per branch and period'
select r.period_label, b.name, r.status, (select sum(net_pay) from payroll_run_items i where i.run_id = r.id) items,
  (select sum((e.payroll->'totals'->>'net_pay')::numeric) from payroll_entries e where e.run_id = r.id) entries,
  (select sum(c.net_pay) from payroll_records c join payroll_entries e on e.employee_id = c.employee_id and e.pay_period = c.period_label where e.run_id = r.id and not c.archived) records
from payroll_runs r join branches b on b.id = r.branch_id where r.period_start >= '2026-10-01'
  and not ((select sum(net_pay) from payroll_run_items i where i.run_id = r.id) = (select sum((e.payroll->'totals'->>'net_pay')::numeric) from payroll_entries e where e.run_id = r.id)
       and (select sum((e.payroll->'totals'->>'net_pay')::numeric) from payroll_entries e where e.run_id = r.id)
         = (select sum(c.net_pay) from payroll_records c join payroll_entries e on e.employee_id = c.employee_id and e.pay_period = c.period_label where e.run_id = r.id and not c.archived));

\echo '8. no test text and no ISO dates in what people read (names, reasons, notes, notifications)'
select 'name' what, full_name txt from profiles where id in (select id from s) and full_name ~* '\m(demo|test|default|e2e|sample|lorem)\M'
union all select 'notification', title || ' / ' || body from notifications where created_at >= '2026-10-01' and recipient_id in (select id from s) and (title || ' ' || body) ~ '\d{4}-\d{2}-\d{2}|\m(test|lorem|e2e|asdf)\M'
union all select 'leave reason', reason from leave_requests where employee_id in (select id from s) and end_date::date >= '2026-10-01' and reason ~* '\d{4}-\d{2}-\d{2}|\m(test|lorem|e2e|asdf)\M'
union all select 'overtime reason', reason from overtime_requests where employee_id in (select id from s) and request_date >= '2026-10-01' and reason ~* '\d{4}-\d{2}-\d{2}|\m(test|lorem|e2e|asdf)\M'
union all select 'payslip label', pay_period from payroll_entries where employee_id in (select id from s) and created_at >= '2026-10-01' and pay_period ~ '\d{4}-\d{2}-\d{2}';

\echo '9. statuses and counts (for the report)'
select status, count(*) from attendance_logs where employee_id in (select id from s) and log_date >= '2026-10-01' group by 1 order by 2 desc;
