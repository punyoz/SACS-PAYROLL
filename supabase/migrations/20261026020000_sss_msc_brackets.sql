-- SSS monthly salary credit (MSC) table, and government contributions as
-- percentages from November 1, 2026 (decisions of 2026-10-26).
--
-- 1. payroll_sss_msc_brackets: the SSS schedule as data. SSS takes sss_pct %
--    (employee 5%) of the salary CREDIT the salary falls in, not of the raw
--    salary. Versioned by effective date like payroll_tax_brackets (one
--    version = the rows saved together); payroll uses the version in force on
--    the pay period's first day, so a new schedule never changes a payslip
--    already processed. Append-only: rows are never updated or deleted, a
--    change is a new version (Super Admin → System Configuration).
--    Seeded with the schedule from January 2025 (RA 11199: 15% of MSC,
--    employee 5%, employer 10%; MSC ₱5,000 to ₱35,000 in ₱500 steps):
--      salary below ₱5,250            → ₱5,000
--      ₱5,250 – ₱5,749.99             → ₱5,500   … ₱500 steps …
--      ₱34,750 and above              → ₱35,000
--    The existing sss_msc_min / sss_msc_max rates are used only while no
--    version is saved (the ₱500-step formula gives the same credits).
--
-- 2. contribution_method 0 from 2026-11-01: SSS, PhilHealth and Pag-IBIG are
--    computed from the legal rates (sss_pct, philhealth_pct with floor and
--    ceiling, pagibig_pct up to pagibig_max_salary) instead of the fixed
--    amounts (SSS ₱300, PhilHealth ₱400, Pag-IBIG ₱400). October 2026 keeps
--    the fixed amounts it was paid with. Tax stays once a month on the 2nd
--    half (monthly table), contributions on the 16-end payslip.
--
-- Additive. Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.payroll_sss_msc_brackets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id       UUID NOT NULL,
  effective_date   DATE NOT NULL,
  salary_from      NUMERIC(12, 2) NOT NULL CHECK (salary_from >= 0),
  msc              NUMERIC(12, 2) NOT NULL CHECK (msc > 0),
  note             TEXT,
  created_by       UUID REFERENCES public.profiles(id),
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (version_id, salary_from)
);

CREATE INDEX IF NOT EXISTS payroll_sss_msc_brackets_effective_idx
  ON public.payroll_sss_msc_brackets (effective_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_sss_msc_brackets_created_by_idx
  ON public.payroll_sss_msc_brackets (created_by);

-- History is never rewritten: a change is a new version.
CREATE OR REPLACE FUNCTION public.payroll_sss_msc_brackets_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'append_only: SSS salary credit versions are never changed or deleted; save a new version instead.'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Created only when missing (no DROP: re-runnable without destructive statements).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payroll_sss_msc_brackets_append_only'
                 AND tgrelid = 'public.payroll_sss_msc_brackets'::regclass) THEN
    CREATE TRIGGER payroll_sss_msc_brackets_append_only
      BEFORE UPDATE OR DELETE ON public.payroll_sss_msc_brackets
      FOR EACH ROW EXECUTE FUNCTION public.payroll_sss_msc_brackets_append_only();
  END IF;
END $$;

-- Server only, like payroll_tax_brackets (20261014040000).
ALTER TABLE public.payroll_sss_msc_brackets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_sss_msc_brackets FROM anon, authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'payroll_sss_msc_brackets'
                 AND policyname = 'payroll_sss_msc_brackets_no_client_access') THEN
    CREATE POLICY payroll_sss_msc_brackets_no_client_access ON public.payroll_sss_msc_brackets
      FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.payroll_sss_msc_brackets_append_only() FROM PUBLIC, anon, authenticated;

INSERT INTO public.payroll_sss_msc_brackets (version_id, effective_date, salary_from, msc, note, created_by_name)
SELECT '00000000-0000-4000-8000-000000002025'::UUID, DATE '2025-01-01', v.salary_from, v.msc,
       'SSS schedule from January 2025 (RA 11199): 15% of MSC, employee 5%, employer 10%', 'System default'
FROM (
  SELECT 0::NUMERIC AS salary_from, 5000::NUMERIC AS msc
  UNION ALL
  SELECT 4750 + 500 * k, 5000 + 500 * k FROM generate_series(1, 60) AS k
) AS v
WHERE NOT EXISTS (SELECT 1 FROM public.payroll_sss_msc_brackets);

-- Contributions as percentages from November 1, 2026.
INSERT INTO public.payroll_rate_configs (rate_type, scope, scope_ref, value, effective_date, note, created_by_name)
SELECT 'contribution_method', 'global', NULL, 0, DATE '2026-11-01',
       'SSS, PhilHealth and Pag-IBIG computed from the legal rates (decision 2026-10-26)', 'System (percentage contributions)'
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rate_configs
  WHERE rate_type = 'contribution_method' AND scope = 'global' AND effective_date = DATE '2026-11-01'
);
