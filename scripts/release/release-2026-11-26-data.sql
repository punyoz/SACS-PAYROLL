-- Release 2026-11-26: data step (after migration 20261126010000). One transaction; before-images of every row it
-- changes are saved first in private.release_20261126_before (the rollback reads them back).
BEGIN;
CREATE TABLE IF NOT EXISTS private.release_20261126_before (tbl text, id text, col text, val text, saved_at timestamptz DEFAULT now());

-- Helper: an ISO date in a sentence becomes "Nov 17, 2026".
CREATE OR REPLACE FUNCTION private.readable_dates(t text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE m text[]; out text := t;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  FOR m IN SELECT regexp_matches(t, '(20\d\d-\d\d-\d\d)', 'g') LOOP
    out := replace(out, m[1], to_char(m[1]::date, 'Mon FMDD, YYYY'));
  END LOOP;
  RETURN out;
END $f$;

-- 1. Demo employee IDs → SACS-101…105 (profiles, auth, payslips, run items, Ramon's notice text).
INSERT INTO private.release_20261126_before (tbl, id, col, val)
  SELECT 'profiles', id::text, 'employee_id', employee_id FROM public.profiles WHERE employee_id ~ '^DEMO-10[1-5]$';
INSERT INTO private.release_20261126_before (tbl, id, col, val)
  SELECT 'payroll_entries', id::text, 'employee_code', employee_code FROM public.payroll_entries WHERE employee_code ~ '^DEMO-10[1-5]$';
INSERT INTO private.release_20261126_before (tbl, id, col, val)
  SELECT 'payroll_run_items', id::text, 'employee_code', employee_code FROM public.payroll_run_items WHERE employee_code ~ '^DEMO-10[1-5]$';
INSERT INTO private.release_20261126_before (tbl, id, col, val)
  SELECT 'awol_notices', id::text, 'body', body FROM public.awol_notices WHERE body ~ 'DEMO-10[1-5]';
ALTER TABLE public.profiles DISABLE TRIGGER profiles_rfid_uid_guard;
UPDATE public.profiles SET employee_id = replace(employee_id, 'DEMO-', 'SACS-'), updated_at = now() WHERE employee_id ~ '^DEMO-10[1-5]$';
ALTER TABLE public.profiles ENABLE TRIGGER profiles_rfid_uid_guard;
UPDATE auth.users u SET raw_user_meta_data = raw_user_meta_data || jsonb_build_object('employee_id', p.employee_id)
  FROM public.profiles p WHERE p.id = u.id AND p.employee_id ~ '^SACS-10[1-5]$';
ALTER TABLE public.payroll_entries DISABLE TRIGGER USER;
UPDATE public.payroll_entries SET employee_code = replace(employee_code, 'DEMO-', 'SACS-') WHERE employee_code ~ '^DEMO-10[1-5]$';
ALTER TABLE public.payroll_entries ENABLE TRIGGER USER;
ALTER TABLE public.payroll_run_items DISABLE TRIGGER USER;
UPDATE public.payroll_run_items SET employee_code = replace(employee_code, 'DEMO-', 'SACS-') WHERE employee_code ~ '^DEMO-10[1-5]$';
ALTER TABLE public.payroll_run_items ENABLE TRIGGER USER;
ALTER TABLE public.awol_notices DISABLE TRIGGER USER;
UPDATE public.awol_notices SET body = regexp_replace(body, 'DEMO-(10[1-5])', 'SACS-\1', 'g'), pdf_path = NULL WHERE body ~ 'DEMO-10[1-5]';
ALTER TABLE public.awol_notices ENABLE TRIGGER USER;

-- 2. Real-looking addresses and emergency contacts for the demo five (no "Demo Street" / "Demo Contact").
INSERT INTO private.release_20261126_before (tbl, id, col, val)
  SELECT 'profiles', id::text, 'contact', json_build_object('address', address, 'ecn', emergency_contact_name, 'eca', emergency_contact_address)::text
  FROM public.profiles WHERE address ~* 'demo street' OR emergency_contact_name ~* '^demo contact$';
UPDATE public.profiles p SET address = v.addr, emergency_contact_address = v.addr, emergency_contact_name = v.ecn, updated_at = now()
FROM (VALUES ('SACS-101', '18 Sumulong St, San Isidro, Antipolo City, Rizal', 'Roberto Aquino'),
             ('SACS-102', '6 Bagong Nayon II, Antipolo City, Rizal', 'Teresita Mendoza'),
             ('SACS-103', '41 Marcos Hwy, Mayamot, Antipolo City, Rizal', 'Danilo Ferrer'),
             ('SACS-104', '9 Dela Paz St, Antipolo City, Rizal', 'Elena Salazar'),
             ('SACS-105', '27 Cupang, Antipolo City, Rizal', 'Rosario Pascual')) v(code, addr, ecn)
WHERE p.employee_id = v.code;
UPDATE public.profiles SET address = '12 Circumferential Rd, Antipolo City, Rizal', updated_at = now() WHERE address ~* 'demo street';

-- 3. Names: the demo Super Admin and removed demo users.
INSERT INTO private.release_20261126_before (tbl, id, col, val) SELECT 'profiles', id::text, 'name', full_name FROM public.profiles WHERE full_name = 'Demo Super Admin One';
UPDATE public.profiles SET first_name = 'Lorna', middle_name = NULL, last_name = 'Villanueva', full_name = 'Lorna Villanueva', updated_at = now() WHERE full_name = 'Demo Super Admin One';
UPDATE auth.users u SET raw_user_meta_data = raw_user_meta_data || '{"full_name": "Lorna Villanueva"}'::jsonb FROM public.profiles p WHERE p.id = u.id AND p.full_name = 'Lorna Villanueva';
CREATE TEMP TABLE name_map (old text, new text) ON COMMIT DROP;
INSERT INTO name_map VALUES ('Demo Super Admin One', 'Lorna Villanueva'), ('Removed demo user', 'Former staff'), ('Demo HR One', 'Maricel Santos'), ('Demo Accountant One Main', 'Rowena Dizon');
DO $n$ DECLARE r record; m record; BEGIN
  -- Names stored on records: the demo names become the real-looking ones.
  FOR r IN SELECT * FROM (VALUES ('branch_announcements','created_by_name'),('branch_announcements','updated_by_name'),('payroll_subsidy_settings','created_by_name'),
      ('branch_admin_requests','created_by_name'),('branch_admin_requests','decided_by_name'),('employee_salary_changes','created_by_name'),('payroll_tax_annualizations','computed_by_name'),
      ('payroll_bir_exports','generated_by_name'),('work_schedules','created_by_name'),('work_schedule_assignments','created_by_name'),('employee_positions','created_by_name'),
      ('rfid_cards','registered_by_name'),('rfid_card_events','actor_name')) t(tbl, col) LOOP
    EXECUTE format('INSERT INTO private.release_20261126_before (tbl, id, col, val) SELECT %L, id::text, %L, %I FROM public.%I WHERE %I IN (SELECT old FROM name_map)', r.tbl, r.col, r.col, r.tbl, r.col);
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', r.tbl);
    EXECUTE format('UPDATE public.%I t SET %I = m.new FROM name_map m WHERE t.%I = m.old', r.tbl, r.col, r.col);
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', r.tbl);
  END LOOP;
  FOR r IN SELECT * FROM (VALUES ('branch_admin_requests','history'),('payroll_tax_annualizations','history')) t(tbl, col) LOOP
    EXECUTE format('INSERT INTO private.release_20261126_before (tbl, id, col, val) SELECT %L, id::text, %L, %I::text FROM public.%I WHERE EXISTS (SELECT 1 FROM name_map m WHERE %I::text LIKE ''%%'' || m.old || ''%%'')', r.tbl, r.col, r.col, r.tbl, r.col);
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', r.tbl);
    FOR m IN SELECT * FROM name_map LOOP
      EXECUTE format('UPDATE public.%I SET %I = replace(%I::text, %L, %L)::jsonb WHERE %I::text LIKE %L', r.tbl, r.col, r.col, m.old, m.new, r.col, '%' || m.old || '%');
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', r.tbl);
  END LOOP;
END $n$;
-- The approver accounts' IDs (not on payroll): DEMO-001 / DEMO-003 become SACS-HR-010 / SACS-ACCT-010.
INSERT INTO private.release_20261126_before (tbl, id, col, val) SELECT 'profiles', id::text, 'employee_id', employee_id FROM public.profiles WHERE employee_id IN ('DEMO-001', 'DEMO-003');
ALTER TABLE public.profiles DISABLE TRIGGER profiles_rfid_uid_guard;
UPDATE public.profiles SET employee_id = CASE employee_id WHEN 'DEMO-001' THEN 'SACS-HR-010' ELSE 'SACS-ACCT-010' END, updated_at = now() WHERE employee_id IN ('DEMO-001', 'DEMO-003');
ALTER TABLE public.profiles ENABLE TRIGGER profiles_rfid_uid_guard;
UPDATE auth.users u SET raw_user_meta_data = raw_user_meta_data || jsonb_build_object('employee_id', p.employee_id) FROM public.profiles p WHERE p.id = u.id AND p.employee_id IN ('SACS-HR-010', 'SACS-ACCT-010');

-- 4. Schedule name and card notes.
INSERT INTO private.release_20261126_before (tbl, id, col, val) SELECT 'work_schedules', id::text, 'name', name FROM public.work_schedules WHERE name = 'Demo: Weekend Event Duty';
ALTER TABLE public.work_schedules DISABLE TRIGGER USER;
UPDATE public.work_schedules SET name = 'Weekend Event Duty' WHERE name = 'Demo: Weekend Event Duty';
ALTER TABLE public.work_schedules ENABLE TRIGGER USER;
INSERT INTO private.release_20261126_before (tbl, id, col, val) SELECT 'rfid_cards', id::text, 'status_reason', status_reason FROM public.rfid_cards WHERE status_reason = 'Removed test lost-card report';
ALTER TABLE public.rfid_cards DISABLE TRIGGER USER;
UPDATE public.rfid_cards SET status_reason = 'Lost-card report withdrawn' WHERE status_reason = 'Removed test lost-card report';
ALTER TABLE public.rfid_cards ENABLE TRIGGER USER;

-- 5. Readable dates in what people read: notifications and automation summaries since Oct 1.
INSERT INTO private.release_20261126_before (tbl, id, col, val)
  SELECT 'notifications', id::text, 'title_body', json_build_object('title', title, 'body', body)::text FROM public.notifications WHERE created_at >= '2026-10-01' AND (title || ' ' || body) ~ '20\d\d-\d\d-\d\d';
UPDATE public.notifications SET title = private.readable_dates(title), body = private.readable_dates(body) WHERE created_at >= '2026-10-01' AND (title || ' ' || body) ~ '20\d\d-\d\d-\d\d';
INSERT INTO private.release_20261126_before (tbl, id, col, val)
  SELECT 'automation_actions', id::text, 'summary_reason', json_build_object('summary', summary, 'reason', reason)::text FROM public.automation_actions WHERE created_at >= '2026-10-01' AND (coalesce(summary,'') || ' ' || coalesce(reason,'')) ~ '20\d\d-\d\d-\d\d';
ALTER TABLE public.automation_actions DISABLE TRIGGER USER;
UPDATE public.automation_actions SET summary = private.readable_dates(summary), reason = private.readable_dates(reason) WHERE created_at >= '2026-10-01' AND (coalesce(summary,'') || ' ' || coalesce(reason,'')) ~ '20\d\d-\d\d-\d\d';
ALTER TABLE public.automation_actions ENABLE TRIGGER USER;

-- 6. Legacy branch-Admin items of the accounts on payroll: archived (kept, hidden everywhere).
UPDATE public.branch_admin_requests SET archived_at = now(), archived_reason = 'Earlier Admin endorsement / test note, archived with the defense data (2026-11-26)'
WHERE archived_at IS NULL AND employee_id IN (SELECT id FROM public.profiles WHERE NOT archived AND on_payroll AND lower(role::text) IN ('employee','accountant','hr'));

-- 7. Settings: leave conversion ON (defaults); the Nov 16-30 recompute on Nov 27.
INSERT INTO private.release_20261126_before (tbl, id, col, val) SELECT 'system_config', section || '.' || key, 'value', value FROM public.system_config WHERE (section = 'payroll' AND key LIKE 'leave_conversion%') OR (section = 'demo' AND key = 'recompute');
INSERT INTO public.system_config (section, key, value, updated_by) VALUES
  ('payroll', 'leave_conversion_enabled', 'true', 'Super Administrator'), ('payroll', 'leave_conversion_tax_free_days', '10', 'Super Administrator'),
  ('payroll', 'leave_conversion_statuses', '[]', 'Super Administrator'),
  ('demo', 'recompute', '{"enabled": true, "period": "November 16-30, 2026", "on": "2026-11-27"}', 'Super Administrator')
ON CONFLICT (section, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by;

-- 8. Sex and civil status of the 8 accounts on payroll that had none (fictional, the owner's instruction):
--    statutory leave reads them (Marisol: maternity; Carlo: paternity). Before-images saved; logged.
CREATE TEMP TABLE sex_civil (full_name text, sex text, civil_status text) ON COMMIT DROP;
INSERT INTO sex_civil VALUES
  ('Marisol Santos Aquino', 'Female', 'Married'), ('Carlo Reyes Mendoza', 'Male', 'Married'),
  ('Liza Gomez Ferrer', 'Female', 'Single'), ('Ramon Cruz Salazar', 'Male', 'Married'), ('Nestor Lim Pascual', 'Male', 'Single'),
  ('Andrea Lopez Villanueva', 'Female', 'Single'), ('Joanna Reyes Marquez', 'Female', 'Single'), ('Teresa Cruz Bautista', 'Female', 'Married');
INSERT INTO private.release_20261126_before (tbl, id, col, val)
  SELECT 'auth_users', u.id::text, 'sex_civil', json_build_object('sex', u.raw_user_meta_data->>'sex', 'civil_status', u.raw_user_meta_data->>'civil_status')::text
  FROM auth.users u JOIN public.profiles p ON p.id = u.id JOIN sex_civil x ON x.full_name = p.full_name
  WHERE NOT p.archived AND p.on_payroll AND (coalesce(u.raw_user_meta_data->>'sex', '') = '' OR coalesce(u.raw_user_meta_data->>'civil_status', '') = '');
UPDATE auth.users u SET raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('sex', x.sex, 'civil_status', x.civil_status)
  FROM public.profiles p JOIN sex_civil x ON x.full_name = p.full_name
  WHERE p.id = u.id AND NOT p.archived AND p.on_payroll AND u.id::text IN (SELECT id FROM private.release_20261126_before WHERE tbl = 'auth_users' AND col = 'sex_civil');
INSERT INTO public.audit_logs (module, action, entity_type, entity_id, description, source, actor_role, actor_name, metadata)
SELECT 'user_management', 'profile_update', 'profile', b.id, 'Sex and civil status filled in for ' || p.full_name || ' (release data step, owner''s instruction).', 'system', 'super_admin', 'Super Administrator (owner''s instruction)', '{"fields": ["sex", "civil_status"]}'::jsonb
FROM private.release_20261126_before b JOIN public.profiles p ON p.id::text = b.id WHERE b.tbl = 'auth_users' AND b.col = 'sex_civil';

INSERT INTO public.audit_logs (module, action, entity_type, entity_id, description, source, actor_role, actor_name, metadata)
VALUES ('config', 'release_data', 'release', '2026-11-26', 'Release 2026-11-26 data step: demo IDs to SACS-101..105, real-looking contacts, names, readable dates, legacy Admin items archived, leave conversion on, Nov 27 recompute scheduled, sex and civil status of 8 accounts filled in.', 'system', 'super_admin', 'Super Administrator (owner''s instruction)', '{}'::jsonb);
COMMIT;
