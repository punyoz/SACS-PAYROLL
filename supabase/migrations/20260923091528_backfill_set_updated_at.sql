-- ═══════════════════════════════════════════════════════════════════════════
-- Backfill: public.set_updated_at() and its six triggers
-- ═══════════════════════════════════════════════════════════════════════════
--
-- These existed on the live project before migrations were kept in this
-- repository (created from the dashboard), so no file created them and a
-- from-scratch replay stopped at 20260923091529_drop_dead_db_objects.sql
-- ("function public.set_updated_at() does not exist"). Found by the local
-- replay of Oct 12, 2026 (docs/local-migration-replay.md).
--
-- Copied from the live definitions (pg_get_functiondef / pg_get_triggerdef).
-- On the live project this changes nothing: the function body is the same
-- and each trigger is dropped and recreated identically. The migration
-- history repair records it as already applied there.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
begin new.updated_at = now(); return new; end; $function$;

DROP TRIGGER IF EXISTS trg_attendance_logs_set_updated_at ON public.attendance_logs;
CREATE TRIGGER trg_attendance_logs_set_updated_at BEFORE UPDATE ON public.attendance_logs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_audit_logs_set_updated_at ON public.audit_logs;
CREATE TRIGGER trg_audit_logs_set_updated_at BEFORE UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_leave_requests_set_updated_at ON public.leave_requests;
CREATE TRIGGER trg_leave_requests_set_updated_at BEFORE UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_payroll_entries_updated_at ON public.payroll_entries;
CREATE TRIGGER trg_payroll_entries_updated_at BEFORE UPDATE ON public.payroll_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_payroll_records_set_updated_at ON public.payroll_records;
CREATE TRIGGER trg_payroll_records_set_updated_at BEFORE UPDATE ON public.payroll_records FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_profiles_set_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_set_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
