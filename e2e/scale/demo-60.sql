-- DEMO DATASET, 64 employees — LOCAL ONLY (loaded by
-- e2e/specs/99-sa-backup-ui-rates.spec.mjs into the local
-- supabase_db_SACS-PAYROLL container). Never run on live.
--
-- 64 demo employees (@demo60.test) split over Main Campus and E2E North
-- Branch, a year of weekday attendance (Nov 2025 – Oct 2026, ~16,700 rows),
-- and one paid October 1-15, 2026 payslip each, so the Super Admin's backup
-- and payroll export have something real-sized to carry for both branches.
-- One transaction; safe to run again (adds only what is missing).
\set ON_ERROR_STOP on
begin;
set local session_replication_role = replica;

create temp table demo_people on commit drop as
select s.n,
  'demo' || lpad(s.n::text, 3, '0') || '@demo60.test' as email,
  'DM-' || lpad(s.n::text, 4, '0') as employee_id,
  (array['Ana','Ben','Carla','Dante','Ella','Felix','Gina','Hugo'])[1 + s.n % 8] as first_name,
  (array['Abad','Bravo','Cortez','Diaz','Esteban','Fajardo','Gomez','Herrera'])[1 + (s.n / 8) % 8] as last_name,
  case when s.n % 2 = 0 then (select id from branches where name = 'Main Campus') else (select id from branches where name = 'E2E North Branch') end as branch_id,
  case when s.n % 4 = 0 then 'Non-Teaching' else 'Teaching' end as employee_type,
  (18000 + (s.n * 397) % 20000)::numeric as basic_salary
from generate_series(1, 64) s(n);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', p.email,
  (select extensions.crypt('Demo-Employee#2026', extensions.gen_salt('bf', 6))), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('role', 'employee', 'full_name', p.first_name || ' ' || p.last_name, 'employee_id', p.employee_id, 'branch_id', p.branch_id),
  now(), now(), '', '', '', '', '', '', '', '', false, false
from demo_people p
where not exists (select 1 from auth.users u where u.email = p.email);

-- is_demo (20261108040000): set ONLY here, by the demo seed.
insert into profiles (id, email, full_name, first_name, last_name, role, employee_id, branch_id, employee_type, position, basic_salary, date_hired, employee_status, archived, is_demo, created_at, updated_at)
select u.id, p.email, p.first_name || ' ' || p.last_name, p.first_name, p.last_name, 'employee'::user_role, p.employee_id, p.branch_id,
  p.employee_type, case when p.employee_type = 'Teaching' then 'Teacher' else 'Registrar Staff' end, p.basic_salary, date '2025-06-01', 'Active', false, true, now(), now()
from demo_people p
join auth.users u on u.email = p.email
where not exists (select 1 from profiles x where x.id = u.id);
update profiles set is_demo = true where email like '%@demo60.test' and not is_demo;

insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out, total_hours, status, late_minutes, undertime_minutes, is_half_day, is_early_bird, created_at, updated_at, archived_duplicate)
select pr.id, pr.full_name, pr.employee_type, pr.branch_id, d::date,
  (d::date + time '07:05') at time zone 'Asia/Manila', (d::date + time '17:00') at time zone 'Asia/Manila', 8, 'On Time', 0, 0, false, false,
  d + interval '9 hours', d + interval '9 hours', false
from profiles pr
cross join lateral generate_series(date '2025-11-01', date '2026-10-31', interval '1 day') d
where pr.email like '%@demo60.test'
  and extract(isodow from d) < 6
  and not exists (select 1 from attendance_logs a where a.employee_id = pr.id);

insert into payroll_entries (employee_id, employee_name, employee_code, employee_type, position, pay_period, cutoff, status, basic_salary, gross_pay,
  sss, philhealth, pagibig, withholding_tax, total_deductions, net_pay, branch_id, payslip_no, payroll, created_at, updated_at, approved_at)
select pr.id, pr.full_name, pr.employee_id, pr.employee_type, pr.position, 'October 1-15, 2026', 'first', 'paid',
  round(pr.basic_salary / 2, 2), round(pr.basic_salary / 2, 2), 0, 0, 0, 0, 0, round(pr.basic_salary / 2, 2), pr.branch_id,
  'DEMO-' || pr.employee_id, '{"demo": true}'::jsonb, now(), now(), now()
from profiles pr
where pr.email like '%@demo60.test'
  and not exists (select 1 from payroll_entries e where e.employee_id = pr.id);

commit;
select 'demo employees' as what, count(*) from profiles where email like '%@demo60.test'
union all select 'demo attendance', count(*) from attendance_logs a join profiles p on p.id = a.employee_id where p.email like '%@demo60.test'
union all select 'demo payslips', count(*) from payroll_entries e join profiles p on p.id = e.employee_id where p.email like '%@demo60.test';
