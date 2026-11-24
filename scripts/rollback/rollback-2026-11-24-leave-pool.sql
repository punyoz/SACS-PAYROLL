-- Rollback for 20261124230000 (leave credits: one shared pool). From live's definitions before it.
-- Removes the pool rules and any pool overrides; the per-type rules (never changed) apply again.
-- Leave requests and payslips were never touched by the pool, so nothing else to restore.
BEGIN;
DELETE FROM public.leave_credit_overrides WHERE leave_type = 'Leave Credits';
DELETE FROM public.leave_credit_rules WHERE leave_type = 'Leave Credits';
ALTER TABLE public.leave_credit_rules DROP CONSTRAINT IF EXISTS leave_credit_rules_leave_type_check;
ALTER TABLE public.leave_credit_rules ADD CONSTRAINT leave_credit_rules_leave_type_check
  CHECK ((leave_type = ANY (ARRAY['Vacation Leave'::text, 'Sick Leave'::text, 'Emergency Leave'::text])));
ALTER TABLE public.leave_credit_overrides DROP CONSTRAINT IF EXISTS leave_credit_overrides_leave_type_check;
ALTER TABLE public.leave_credit_overrides ADD CONSTRAINT leave_credit_overrides_leave_type_check
  CHECK ((leave_type = ANY (ARRAY['Vacation Leave'::text, 'Sick Leave'::text, 'Emergency Leave'::text])));
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261124230000';
COMMIT;
