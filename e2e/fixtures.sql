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

-- Subsidy requests in every state (alpha test B4), so the Accountant's
-- processing and HR's approval can be tested: Bea (emp2) with an open 2026
-- subsidy year, and four requests (not Ana: 25-subsidy-flow starts her from nothing):
--   pending   a missed-month adjustment raised by the system (Accountant to process)
--   processed an advance the Accountant processed (HR to approve or reject)
--   approved  an adjustment HR approved (payroll pays it)
--   rejected  an adjustment HR rejected, with the reason (Accountant to fix)
-- Replaced on every seed (these rows only). LOCAL ONLY.
set local session_replication_role = replica;
delete from payroll_subsidy_requests where employee_id in (select id from profiles where email like '%@e2e.test') and reason like 'E2E demo:%';
delete from payroll_subsidy_balances where employee_id in (select id from profiles where email like '%@e2e.test') and proration = 'monthly' and subsidy_year_start = '2026-01-01'
  and not exists (select 1 from payroll_subsidy_requests r where r.subsidy_balance_id = payroll_subsidy_balances.id);
set local session_replication_role = origin;


-- Written directly (the processing functions' guards bypassed) because these
-- are ready-made test states, LOCAL ONLY, like the attendance rows above.
set local session_replication_role = replica;
with ana as (select id, branch_id from profiles where email = 'emp2@e2e.test'),
acct as (select id, full_name from profiles where email = 'acct@e2e.test'),
hr as (select id, full_name from profiles where email = 'hr@e2e.test'),
bal as (
  insert into payroll_subsidy_balances (employee_id, subsidy_year_start, subsidy_year_end, payout_period_start, annual_amount, proration, advance_limit,
    on_resignation, on_dismissal, tax_treatment, eligible_from, eligible_months, entitlement)
  select ana.id, '2026-01-01', '2026-12-31', '2026-12-16', 24000, 'monthly', 'full_year', 'prorate', 'forfeit', 'other_benefit', '2026-01-01', 12, 24000 from ana
  on conflict (employee_id, subsidy_year_start) do update set annual_amount = excluded.annual_amount
  returning id
)
insert into payroll_subsidy_requests (kind, employee_id, branch_id, subsidy_balance_id, status, amount, reason, requested_by_name,
  processed_by, processed_by_name, processed_at, decided_by, decided_by_name, decided_at, decision_note, history)
select x.kind, ana.id, ana.branch_id, bal.id, x.status, x.amount, x.reason, 'System',
  case when x.status <> 'pending' then acct.id end, case when x.status <> 'pending' then acct.full_name end, case when x.status <> 'pending' then now() - interval '2 days' end,
  case when x.status in ('approved', 'rejected') then hr.id end, case when x.status in ('approved', 'rejected') then hr.full_name end,
  case when x.status in ('approved', 'rejected') then now() - interval '1 day' end,
  case when x.status = 'rejected' then 'Wrong month: the license was verified in March, not February.' when x.status = 'approved' then 'Checked against the PRC record.' end,
  '[]'::jsonb
from ana, acct, hr, bal, (values
  ('adjustment', 'pending',   null::numeric, 'E2E demo: missed months Jan-Feb (late license verification)'),
  ('advance',    'processed', 4000,          'E2E demo: advance requested for tuition'),
  ('adjustment', 'approved',  2000,          'E2E demo: missed month March'),
  ('adjustment', 'rejected',  2000,          'E2E demo: missed month February')
) as x(kind, status, amount, reason);
set local session_replication_role = origin;

commit;
