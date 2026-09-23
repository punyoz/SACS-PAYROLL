-- Unify the four hardcoded branch-assignment tables (employees_branch_main/_2/_3/_4)
-- into a single table that references the real `branches` table by id, removing the
-- old 4-branch cap. Matches the rewrite in public/legacy/js/admin.js and hr.js, and
-- src/app/api/admin/branch-employees/route.js.
--
-- IMPORTANT — run this manually, and read before running:
-- The old tables only ever stored a positional slot ('main'/'2'/'3'/'4'), never which
-- real branch that slot meant — the UI faked labels by matching slot position against
-- the Nth *active* branch (ordered by created_at) at render time. This migration
-- reproduces that same best-effort mapping to carry over existing assignments, using
-- whatever branches exist in `branches` at the time you run this. Any assignment whose
-- slot has no corresponding active branch (e.g. a '3' assignment when only 2 active
-- branches exist) is left unmigrated — that employee will show as unassigned afterward
-- and needs a one-time manual re-pick in Branch Assignment.

CREATE TABLE IF NOT EXISTS public.employee_branch_assignments (
  user_id     UUID PRIMARY KEY,
  branch_id   UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS employee_branch_assignments_branch_id_idx
  ON public.employee_branch_assignments (branch_id);

-- Best-effort carry-over from the old positional tables, one slot at a time.
DO $$
DECLARE
  ordered_branches UUID[];
BEGIN
  SELECT ARRAY_AGG(id ORDER BY created_at ASC)
  INTO ordered_branches
  FROM public.branches
  WHERE status = 'Active';

  IF to_regclass('public.employees_branch_main') IS NOT NULL AND ordered_branches[1] IS NOT NULL THEN
    INSERT INTO public.employee_branch_assignments (user_id, branch_id, assigned_by, assigned_at)
    SELECT user_id, ordered_branches[1], assigned_by, assigned_at
    FROM public.employees_branch_main
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  IF to_regclass('public.employees_branch_2') IS NOT NULL AND ordered_branches[2] IS NOT NULL THEN
    INSERT INTO public.employee_branch_assignments (user_id, branch_id, assigned_by, assigned_at)
    SELECT user_id, ordered_branches[2], assigned_by, assigned_at
    FROM public.employees_branch_2
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  IF to_regclass('public.employees_branch_3') IS NOT NULL AND ordered_branches[3] IS NOT NULL THEN
    INSERT INTO public.employee_branch_assignments (user_id, branch_id, assigned_by, assigned_at)
    SELECT user_id, ordered_branches[3], assigned_by, assigned_at
    FROM public.employees_branch_3
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  IF to_regclass('public.employees_branch_4') IS NOT NULL AND ordered_branches[4] IS NOT NULL THEN
    INSERT INTO public.employee_branch_assignments (user_id, branch_id, assigned_by, assigned_at)
    SELECT user_id, ordered_branches[4], assigned_by, assigned_at
    FROM public.employees_branch_4
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
END;
$$;

-- Drop the old tables now that any migratable data has been copied.
DROP TABLE IF EXISTS public.employees_branch_main;
DROP TABLE IF EXISTS public.employees_branch_2;
DROP TABLE IF EXISTS public.employees_branch_3;
DROP TABLE IF EXISTS public.employees_branch_4;
