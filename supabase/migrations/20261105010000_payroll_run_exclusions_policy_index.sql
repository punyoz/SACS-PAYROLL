-- Full system check 2026-11-05: the two advisor findings on
-- payroll_run_exclusions (added by 20261029080000_partial_runs_supplemental).
--
-- 1. rls_enabled_no_policy: RLS is on and clients have no grants, but unlike
--    every other public table it had no explicit deny policy
--    (20261014040000_rls_no_client_access_policies pattern). Added, so the
--    table's stance is stated, not implied.
-- 2. unindexed_foreign_keys: acknowledged_by had no covering index.
-- No data is changed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'payroll_run_exclusions'
      AND policyname = 'payroll_run_exclusions_no_client_access'
  ) THEN
    CREATE POLICY payroll_run_exclusions_no_client_access ON public.payroll_run_exclusions
      AS PERMISSIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payroll_run_exclusions_acknowledged_by_idx
  ON public.payroll_run_exclusions (acknowledged_by);
