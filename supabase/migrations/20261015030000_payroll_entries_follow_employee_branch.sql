-- A reprocessed payslip belongs to the employee's current branch.
--
-- payroll_entries.branch_id is stamped only on INSERT (payroll_entries_stamp_branch,
-- 20260903010000_rbac_branch_scoping.sql). payroll_commit_entries updates an
-- existing (employee_id, pay_period) row in place, so a payslip first made
-- while the employee was in one branch stayed there after a transfer: the
-- October 1-15, 2026 payslip of an employee moved from Spring Valley to Main
-- Branch kept Spring Valley, and Main Branch's HR approval panel listed them
-- as "No Final payslip yet" however often it was reprocessed.
--
-- This trigger moves the row to profiles.branch_id, but only inside
-- payroll_commit_entries (sacs.payroll_commit = 'on', i.e. a real
-- (re)process) and never out of a run that is Pending or Approved: then the
-- row keeps its branch and payroll_entries_zz_run_lock refuses the change,
-- as before. Named to sort before payroll_entries_zz_run_lock, so the run
-- lock judges the branch the row ends up in.

CREATE OR REPLACE FUNCTION public.payroll_entries_follow_employee_branch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_branch UUID;
BEGIN
  IF COALESCE(current_setting('sacs.payroll_commit', true), '') <> 'on' OR public.payroll_run_action_on() THEN
    RETURN NEW;
  END IF;
  SELECT p.branch_id INTO v_branch FROM public.profiles p WHERE p.id = NEW.employee_id;
  IF v_branch IS NULL OR v_branch IS NOT DISTINCT FROM OLD.branch_id THEN
    RETURN NEW;
  END IF;
  IF COALESCE(public.payroll_run_status_for(OLD.branch_id, OLD.pay_period), 'draft') IN ('pending', 'approved') THEN
    RETURN NEW;
  END IF;
  NEW.branch_id := v_branch;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.payroll_entries_follow_employee_branch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payroll_entries_follow_employee_branch ON public.payroll_entries;
CREATE TRIGGER payroll_entries_follow_employee_branch
  BEFORE UPDATE ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.payroll_entries_follow_employee_branch();
