-- Basic salary changes, effective-dated (decisions of 2026-10-26).
--
-- HR records a raise (or any change) with the month it starts (always the
-- 1st), a reason and an optional note; payroll uses the salary in force on
-- each pay period's first day, so a period before the change keeps the old
-- salary and processed payslips never move. Who, when, old → new, effective
-- date and reason are kept here for good, and written to the audit log.
--
--   * Only an active HR account adds a change: the API checks the session
--     (/api/hr/salary-changes) and this database refuses any other author
--     (employee_salary_changes_writer_guard). Not the Super Admin (decision:
--     HR only), not the Accountant, not the Employee.
--   * Rows are never deleted or rewritten; the only later write is applied_at
--     (the day the salary on record became the new one).
--   * Browsers never reach the table (no grants; no-client-access policy).
--
-- Additive. Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.employee_salary_changes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      UUID NOT NULL REFERENCES public.profiles(id),
  old_salary       NUMERIC(12, 2) NOT NULL CHECK (old_salary >= 0),
  new_salary       NUMERIC(12, 2) NOT NULL CHECK (new_salary > 0 AND new_salary <= 9999999.99),
  effective_date   DATE NOT NULL CHECK (EXTRACT(DAY FROM effective_date) = 1),
  reason           TEXT NOT NULL CHECK (reason IN ('Performance review', 'Contract renewal', 'Promotion', 'Salary adjustment', 'Correction', 'Other')),
  note             TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_by       UUID REFERENCES public.profiles(id),
  created_by_name  TEXT,
  created_by_role  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS employee_salary_changes_employee_idx
  ON public.employee_salary_changes (employee_id, effective_date, created_at);
CREATE INDEX IF NOT EXISTS employee_salary_changes_due_idx
  ON public.employee_salary_changes (effective_date) WHERE applied_at IS NULL;
CREATE INDEX IF NOT EXISTS employee_salary_changes_created_by_idx
  ON public.employee_salary_changes (created_by);

-- Only an active HR account adds a change (the API server, as service_role,
-- passes its session's user as created_by). Migrations run as the owner.
CREATE OR REPLACE FUNCTION public.employee_salary_changes_writer_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_archived BOOLEAN;
BEGIN
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  SELECT p.role::TEXT, COALESCE(p.archived, false) INTO v_role, v_archived FROM public.profiles p WHERE p.id = NEW.created_by;
  IF NEW.created_by IS NULL OR v_role IS DISTINCT FROM 'hr' OR v_archived THEN
    RAISE EXCEPTION 'forbidden: only HR changes an employee''s salary (by %).', COALESCE(v_role, 'unknown')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_by_role := 'hr';
  RETURN NEW;
END;
$$;

-- Never deleted; an update may only fill in applied_at.
CREATE OR REPLACE FUNCTION public.employee_salary_changes_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'append_only: salary changes are kept for good.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.applied_at IS NOT NULL
     OR (NEW.employee_id, NEW.old_salary, NEW.new_salary, NEW.effective_date, NEW.reason, NEW.note, NEW.created_by, NEW.created_by_name, NEW.created_by_role, NEW.created_at)
        IS DISTINCT FROM
        (OLD.employee_id, OLD.old_salary, OLD.new_salary, OLD.effective_date, OLD.reason, OLD.note, OLD.created_by, OLD.created_by_name, OLD.created_by_role, OLD.created_at) THEN
    RAISE EXCEPTION 'append_only: a salary change is never rewritten; record a new one.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'employee_salary_changes_writer_guard'
                 AND tgrelid = 'public.employee_salary_changes'::regclass) THEN
    CREATE TRIGGER employee_salary_changes_writer_guard
      BEFORE INSERT ON public.employee_salary_changes
      FOR EACH ROW EXECUTE FUNCTION public.employee_salary_changes_writer_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'employee_salary_changes_append_only'
                 AND tgrelid = 'public.employee_salary_changes'::regclass) THEN
    CREATE TRIGGER employee_salary_changes_append_only
      BEFORE UPDATE OR DELETE ON public.employee_salary_changes
      FOR EACH ROW EXECUTE FUNCTION public.employee_salary_changes_append_only();
  END IF;
END $$;

ALTER TABLE public.employee_salary_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.employee_salary_changes FROM anon, authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'employee_salary_changes'
                 AND policyname = 'employee_salary_changes_no_client_access') THEN
    CREATE POLICY employee_salary_changes_no_client_access ON public.employee_salary_changes
      FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.employee_salary_changes_writer_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_salary_changes_append_only() FROM PUBLIC, anon, authenticated;
