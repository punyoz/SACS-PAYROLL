-- Rollback for the 2026-11-26 release: the data step (from its before-images) and migration 20261126010000.
-- Code: redeploy the previous production deployment (named in the release report).
BEGIN;
ALTER TABLE public.profiles DISABLE TRIGGER profiles_rfid_uid_guard;
UPDATE public.profiles p SET employee_id = b.val FROM private.release_20261126_before b WHERE b.tbl = 'profiles' AND b.col = 'employee_id' AND p.id::text = b.id;
ALTER TABLE public.profiles ENABLE TRIGGER profiles_rfid_uid_guard;
UPDATE auth.users u SET raw_user_meta_data = raw_user_meta_data || jsonb_build_object('employee_id', b.val) FROM private.release_20261126_before b WHERE b.tbl = 'profiles' AND b.col = 'employee_id' AND u.id::text = b.id;
UPDATE public.profiles p SET address = (b.val::json->>'address'), emergency_contact_name = (b.val::json->>'ecn'), emergency_contact_address = (b.val::json->>'eca')
  FROM private.release_20261126_before b WHERE b.tbl = 'profiles' AND b.col = 'contact' AND p.id::text = b.id;
UPDATE public.profiles p SET first_name = 'Demo', last_name = 'Super Admin One', full_name = b.val FROM private.release_20261126_before b WHERE b.tbl = 'profiles' AND b.col = 'name' AND p.id::text = b.id;
UPDATE auth.users u SET raw_user_meta_data = raw_user_meta_data || jsonb_build_object('full_name', b.val) FROM private.release_20261126_before b WHERE b.tbl = 'profiles' AND b.col = 'name' AND u.id::text = b.id;

DO $r$ DECLARE r record; BEGIN
  FOR r IN SELECT DISTINCT tbl, col FROM private.release_20261126_before
    WHERE tbl IN ('payroll_entries','payroll_run_items','branch_announcements','payroll_subsidy_settings','branch_admin_requests','employee_salary_changes',
                  'payroll_tax_annualizations','payroll_bir_exports','work_schedules','rfid_cards','work_schedule_assignments','employee_positions','rfid_card_events') LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', r.tbl);
    IF r.col = 'history' THEN
      EXECUTE format('UPDATE public.%I t SET %I = b.val::jsonb FROM private.release_20261126_before b WHERE b.tbl = %L AND b.col = %L AND t.id::text = b.id', r.tbl, r.col, r.tbl, r.col);
    ELSE
      EXECUTE format('UPDATE public.%I t SET %I = b.val FROM private.release_20261126_before b WHERE b.tbl = %L AND b.col = %L AND t.id::text = b.id', r.tbl, r.col, r.tbl, r.col);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', r.tbl);
  END LOOP;
END $r$;

ALTER TABLE public.awol_notices DISABLE TRIGGER USER;
UPDATE public.awol_notices n SET body = b.val FROM private.release_20261126_before b WHERE b.tbl = 'awol_notices' AND n.id::text = b.id;
ALTER TABLE public.awol_notices ENABLE TRIGGER USER;
UPDATE public.notifications n SET title = (b.val::json->>'title'), body = (b.val::json->>'body') FROM private.release_20261126_before b WHERE b.tbl = 'notifications' AND n.id::text = b.id;
ALTER TABLE public.automation_actions DISABLE TRIGGER USER;
UPDATE public.automation_actions a SET summary = (b.val::json->>'summary'), reason = (b.val::json->>'reason') FROM private.release_20261126_before b WHERE b.tbl = 'automation_actions' AND a.id::text = b.id;
ALTER TABLE public.automation_actions ENABLE TRIGGER USER;

DELETE FROM public.system_config WHERE (section = 'payroll' AND key IN ('leave_conversion_tax_free_days', 'leave_conversion_statuses')) OR (section = 'demo' AND key = 'recompute');
UPDATE public.system_config c SET value = b.val FROM private.release_20261126_before b WHERE b.tbl = 'system_config' AND c.section || '.' || c.key = b.id;
UPDATE public.system_config SET value = 'false' WHERE section = 'payroll' AND key = 'leave_conversion_enabled'
  AND NOT EXISTS (SELECT 1 FROM private.release_20261126_before b WHERE b.tbl = 'system_config' AND b.id = 'payroll.leave_conversion_enabled');

-- Migration 20261126010000 (the archive columns; archived rows become visible again).
DROP INDEX IF EXISTS public.branch_admin_requests_live_idx;
ALTER TABLE public.branch_admin_requests DROP COLUMN IF EXISTS archived_reason;
ALTER TABLE public.branch_admin_requests DROP COLUMN IF EXISTS archived_at;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261126010000';
DROP FUNCTION IF EXISTS private.readable_dates(text);
COMMIT;
