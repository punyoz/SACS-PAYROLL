-- SCALE DATASET — LOCAL ONLY (run by e2e/scale/seed-scale.mjs inside the
-- local supabase_db_SACS-PAYROLL container). Never run on live.
--
-- 1,200 extra employees in 6 branches (Main Campus 300, five others 180),
-- one Accountant and one Admin per extra branch, and five years of history:
--   attendance  Nov 2021 – Oct 21, 2026, every weekday  (~1.55M rows)
--   payroll     118 semi-monthly periods, Nov 2021 – Sep 2026, every run approved
--               (~708 runs, ~141k payslips, run items and pay records)
--   leave       ~3 requests per employee per year
--   audit log   1,000,000 rows
-- October 2026 is left unprocessed so the payroll-run timing test can run it.
-- Triggers are off while loading (session_replication_role = replica): this
-- is bulk history, not new activity.
\set ON_ERROR_STOP on
set session_replication_role = replica;
set synchronous_commit = off;

-- Branches -------------------------------------------------------------------
insert into branches (name, location, status, updated_at)
select v.name, v.loc, 'Active', now()
from (values ('SACS East Campus', 'East'), ('SACS West Campus', 'West'), ('SACS South Campus', 'South'), ('SACS Hillside Campus', 'Hillside')) v(name, loc)
where not exists (select 1 from branches b where b.name = v.name);

create temp table scale_branches as
select id, name, row_number() over (order by case when name = 'Main Campus' then 0 else 1 end, name) as n
from branches where name in ('Main Campus', 'E2E North Branch', 'SACS East Campus', 'SACS West Campus', 'SACS South Campus', 'SACS Hillside Campus');

-- People -----------------------------------------------------------------------
create temp table first_names(n int, v text);
insert into first_names select row_number() over (), v from unnest(array['Maria','Jose','Juan','Ana','Mark','John','Angelica','Michael','Kristine','Christian','Joy','Paolo','Camille','Carlo','Patricia','Miguel','Andrea','Rafael','Nicole','Gabriel','Bea','Luis','Grace','Daniel','Liza','Ramon','Teresa','Antonio','Rosa','Vincent']) v;
create temp table last_names(n int, v text);
insert into last_names select row_number() over (), v from unnest(array['Santos','Reyes','Cruz','Bautista','Ocampo','Garcia','Mendoza','Torres','Tomas','Andrada','Castillo','Flores','Villanueva','Ramos','Castro','Rivera','Aquino','Navarro','Salazar','Mercado','Dela Cruz','Gonzales','Lopez','Hernandez','Perez','Domingo','Valdez','Soriano','Pascual','Lim']) v;

create temp table scale_people as
select
  gen_random_uuid() as id,
  s.n,
  'scale' || lpad(n::text, 4, '0') || '@scale.test' as email,
  'SC-' || lpad(n::text, 5, '0') as employee_id,
  -- ~30 first x 30 last names: same-name employees exist on purpose (EM-11)
  (select v from first_names f where f.n = 1 + (s.n * 7) % 30) as first_name,
  (select v from last_names l where l.n = 1 + (s.n * 13) % 30) as last_name,
  case when s.n <= 300 then (select id from scale_branches b1 where b1.n = 1) else (select id from scale_branches sb where sb.n = 2 + (s.n - 301) % 5) end as branch_id,
  case when s.n % 5 = 0 then 'Non-Teaching' else 'Teaching' end as employee_type,
  case when s.n % 5 = 0 then 'Registrar Staff' else 'Teacher' end as position,
  (16000 + (s.n * 37) % 24000)::numeric as basic_salary,
  date '2021-06-01' + ((s.n * 11) % 180) as date_hired,
  'employee' as role
from generate_series(1, 1200) s(n);

-- One Accountant and one Admin for each branch other than Main Campus.
insert into scale_people (id, n, email, employee_id, first_name, last_name, branch_id, employee_type, position, basic_salary, date_hired, role)
select gen_random_uuid(), 2000 + b.n, 'scale-acct' || b.n || '@scale.test', 'SC-ACCT-' || b.n, 'Branch', 'Accountant ' || chr((64 + b.n)::int), b.id, 'Non-Teaching', 'Accountant', 26000, date '2021-06-01', 'accountant'
from scale_branches b where b.n > 1;
insert into scale_people (id, n, email, employee_id, first_name, last_name, branch_id, employee_type, position, basic_salary, date_hired, role)
select gen_random_uuid(), 3000 + b.n, 'scale-admin' || b.n || '@scale.test', null, 'Branch', 'Admin ' || chr((64 + b.n)::int), b.id, null, null, null, null, 'admin'
from scale_branches b where b.n > 1;

delete from scale_people p using auth.users u where u.email = p.email;

-- Same password for every scale account (local only): Scale-Employee#2026
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', p.id, 'authenticated', 'authenticated', p.email,
  (select extensions.crypt('Scale-Employee#2026', extensions.gen_salt('bf', 6))), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_strip_nulls(jsonb_build_object('role', p.role, 'full_name', p.first_name || ' ' || p.last_name, 'employee_id', p.employee_id, 'branch_id', p.branch_id,
    'employee_type', p.employee_type, 'position', p.position, 'basic_salary', p.basic_salary, 'date_hired', p.date_hired)),
  now(), now(), '', '', '', '', '', '', '', '', false, false
from scale_people p;

insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
select p.id::text, p.id, jsonb_build_object('sub', p.id::text, 'email', p.email, 'email_verified', true), 'email', now(), now(), null
from scale_people p;

insert into profiles (id, email, full_name, first_name, last_name, role, employee_id, branch_id, employee_type, position, basic_salary, date_hired, employee_status, archived, created_at, updated_at)
select p.id, p.email, p.first_name || ' ' || p.last_name, p.first_name, p.last_name, p.role::user_role, p.employee_id, p.branch_id,
  coalesce(p.employee_type, 'Non-Teaching'), coalesce(p.position, 'Staff'), coalesce(p.basic_salary, 0), p.date_hired, 'Active', false, now(), now()
from scale_people p;

-- Every scale account (also on a re-run, when the inserts above did nothing).
truncate scale_people;
insert into scale_people (id, n, email, employee_id, first_name, last_name, branch_id, employee_type, position, basic_salary, date_hired, role)
select id, row_number() over (order by email), email, employee_id, first_name, last_name, branch_id, employee_type, position, basic_salary, date_hired, role::text
from profiles where email like '%@scale.test';

-- Attendance: every weekday, ~93% on time, 4% late, 3% absent ---------------------
insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out, total_hours, status, late_minutes, undertime_minutes, is_half_day, is_early_bird, created_at, updated_at, archived_duplicate)
select p.id, p.first_name || ' ' || p.last_name, p.employee_type, p.branch_id, d::date,
  case when r < 3 then null when r < 7 then (d::date + time '08:20') at time zone 'Asia/Manila' else (d::date + time '07:05') at time zone 'Asia/Manila' end,
  case when r < 3 then null else (d::date + time '17:00') at time zone 'Asia/Manila' end,
  case when r < 3 then 0 when r < 7 then 7.67 else 8 end,
  case when r < 3 then 'Absent' when r < 7 then 'Late' else 'On Time' end,
  case when r >= 3 and r < 7 then 20 else 0 end, 0, false, false,
  d + interval '9 hours', d + interval '9 hours', false
from (select * from scale_people sp where not exists (select 1 from attendance_logs a where a.employee_id = sp.id)) p
cross join lateral generate_series(greatest(p.date_hired, date '2021-11-01'), date '2026-10-21', interval '1 day') d
cross join lateral (select abs(hashtext(p.id::text || d::text)) % 100 as r) x
where p.role in ('employee', 'accountant') and extract(isodow from d) < 6;

-- Payroll: 118 periods, every branch run approved -----------------------------------
create temp table scale_periods as
select
  (to_char(m, 'FMMonth') || ' ' || case when h = 1 then '1-15' else '16-' || extract(day from (m + interval '1 month - 1 day'))::int end || ', ' || extract(year from m)::int) as label,
  case when h = 1 then m::date else (m + interval '15 days')::date end as period_start,
  case when h = 1 then (m + interval '14 days')::date else (m + interval '1 month - 1 day')::date end as period_end,
  case when h = 1 then 'first' else 'second' end as cutoff,
  to_char(m, 'YYYYMM') || h as seq
from generate_series(date '2021-11-01', date '2026-09-01', interval '1 month') m
cross join (values (1), (2)) hh(h);

\set payslip_tpl `cat /tmp/payslip-template.json`
\set breakdown_tpl `cat /tmp/run-item-breakdown-template.json`
create temp table scale_template as select :'payslip_tpl'::jsonb as payroll, :'breakdown_tpl'::jsonb as breakdown;

create temp table scale_pay as
select p.id as employee_id, p.first_name || ' ' || p.last_name as name, p.employee_id as code, p.employee_type, p.position, p.branch_id, pe.*,
  round(p.basic_salary / 2, 2) as gross,
  round(p.basic_salary * 0.08 / 2, 2) as deductions,
  gen_random_uuid() as entry_id
from scale_people p cross join scale_periods pe
where p.role in ('employee', 'accountant') and pe.period_start >= p.date_hired
  and not exists (select 1 from payroll_entries e where e.employee_id = p.id);

insert into payroll_runs (id, branch_id, period_label, period_start, period_end, cutoff_type, status, submission_no, processed_by_name, submitted_by_name, submitted_at, reviewed_by_name, reviewed_at, remarks, total_employees, total_gross, total_deductions, total_net, created_at, updated_at)
select gen_random_uuid(), sp.branch_id, sp.label, sp.period_start, sp.period_end, sp.cutoff, 'approved', 1, 'Scale Accountant', 'Scale Accountant', sp.period_end + 3, 'Scale HR', sp.period_end + 4, 'Approved (scale history)',
  count(*), sum(sp.gross), sum(sp.deductions), sum(sp.gross - sp.deductions), sp.period_end + 3, sp.period_end + 4
from scale_pay sp
where not exists (select 1 from payroll_runs r where r.branch_id = sp.branch_id and r.period_start = sp.period_start)
group by sp.branch_id, sp.label, sp.period_start, sp.period_end, sp.cutoff;

insert into payroll_entries (id, employee_id, basic_salary, sss, philhealth, pagibig, withholding_tax, absences_deduction, gross_pay, total_deductions, net_pay, status,
  employee_name, employee_code, employee_type, position, pay_period, payroll, submitted_at, payslip_no, branch_id, cutoff, run_id, created_at, updated_at, approved_at)
select sp.entry_id, sp.employee_id, sp.gross * 2, round(sp.gross * 0.045, 2), round(sp.gross * 0.025, 2), 100, 0, 0, sp.gross, sp.deductions, sp.gross - sp.deductions, 'paid',
  sp.name, sp.code, sp.employee_type, sp.position, sp.label,
  jsonb_set(jsonb_set(jsonb_set(t.payroll, '{totals,net_pay}', to_jsonb(sp.gross - sp.deductions)), '{totals,gross_pay}', to_jsonb(sp.gross)), '{basic_salary}', to_jsonb(sp.gross * 2)),
  sp.period_end + 3, 'PS-' || sp.seq || '-' || lpad(row_number() over (partition by sp.seq order by sp.employee_id)::text, 5, '0'),
  sp.branch_id, sp.cutoff, r.id, sp.period_end + 3, sp.period_end + 3, sp.period_end + 4
from scale_pay sp
join payroll_runs r on r.branch_id = sp.branch_id and r.period_start = sp.period_start
cross join scale_template t;

insert into payroll_records (employee_id, employee_name, employee_type, gross_pay, total_deductions, net_pay, period_label, processed_at, created_at, payslip_no, branch_id, updated_at, archived, base_pay, total_incentives, period_start, period_end, processed_by_name)
select e.employee_id, e.employee_name, e.employee_type, e.gross_pay, e.total_deductions, e.net_pay, e.pay_period, e.submitted_at, e.submitted_at, e.payslip_no, e.branch_id, e.submitted_at, false, e.gross_pay, 0,
  sp.period_start, sp.period_end, 'Scale Accountant'
from payroll_entries e join scale_pay sp on sp.entry_id = e.id;

insert into payroll_run_items (run_id, submission_no, entry_id, employee_id, employee_name, employee_code, payslip_no, basic_pay, gross_pay, total_deductions, net_pay, attendance_deduction, absence_deduction, late_deduction,
  undertime_deduction, half_day_deduction, leave_without_pay_deduction, withholding_tax, sss, philhealth, pagibig, loans, other_deductions, early_bird_incentive, total_incentives, days_worked, absent_days, late_days, late_minutes,
  undertime_minutes, half_days, flags, breakdown, created_at)
select e.run_id, 1, e.id, e.employee_id, e.employee_name, e.employee_code, e.payslip_no, e.gross_pay, e.gross_pay, e.total_deductions, e.net_pay, 0, 0, 0, 0, 0, 0, 0, e.sss, e.philhealth, e.pagibig, 0, 0, 0, 0, 11, 0, 0, 0, 0, 0,
  '{}'::text[], t.breakdown, e.submitted_at
from payroll_entries e join scale_people p on p.id = e.employee_id cross join scale_template t
where not exists (select 1 from payroll_run_items i where i.entry_id = e.id);

-- Leave: ~3 per employee per year -------------------------------------------------
insert into leave_requests (id, employee_id, employee_name, position, leave_type, start_date, end_date, reason, status, submitted_at, decided_at, updated_at, pay_status, branch_id, decided_by_name)
select 'scale-' || p.n || '-' || k, p.id, p.first_name || ' ' || p.last_name, p.position,
  (array['Sick Leave','Vacation Leave','Emergency Leave'])[1 + k % 3],
  to_char(date '2021-12-01' + k * 120 + (p.n % 60), 'YYYY-MM-DD'), to_char(date '2021-12-01' + k * 120 + (p.n % 60) + 1, 'YYYY-MM-DD'),
  'Scale history', (array['approved','approved','rejected','approved'])[1 + (p.n + k) % 4],
  date '2021-12-01' + k * 120 - 10, date '2021-12-01' + k * 120 - 8, now(), 'with_pay', p.branch_id, 'Scale HR'
from scale_people p cross join generate_series(0, 14) k
where p.role = 'employee'
on conflict (id) do nothing;

-- Audit log: 1,000,000 rows over 5 years ---------------------------------------------
insert into audit_logs (created_at, module, action, entity_type, entity_id, description, status, source, metadata, branch_id, is_system_event, actor_role, actor_name)
select timestamptz '2021-11-01 08:00+08' + (g * interval '157 seconds'),
  (array['attendance','payroll','leave','user_management','rfid','system_configuration'])[1 + g % 6],
  (array['create','update','approve','reject','tap','login'])[1 + (g / 7) % 6],
  'record', g::text, 'Scale history event ' || g, 'success', 'scale', '{}'::jsonb,
  (select id from scale_branches where n = 1 + g % 6), false,
  (array['hr','accountant','admin','super_admin'])[1 + g % 4], 'Scale Actor ' || (g % 40)
from generate_series(1, 1000000) g
where not exists (select 1 from audit_logs where source = 'scale');

set session_replication_role = origin;
analyze;
select 'people' as what, count(*) from scale_people
union all select 'attendance', count(*) from attendance_logs
union all select 'payslips', count(*) from payroll_entries
union all select 'runs', count(*) from payroll_runs
union all select 'leave', count(*) from leave_requests
union all select 'audit', count(*) from audit_logs;
select pg_size_pretty(pg_database_size('postgres')) as database_size;
