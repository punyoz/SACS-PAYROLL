-- Positions HR can choose from and add to (alpha test B3, 2026-11-09).
--
-- Before: an employee's position was not editable. The server set it from the
-- role: "Employee", "Accountant" or "HR Officer".
-- Now: HR picks the position from a list and can add a new one. The list
-- never holds the same position twice, whatever the capitals or spaces
-- ("Teacher I" = "teacher  i"): a unique index on the folded name, and the
-- API (src/lib/hr/positions.js) saves the employee with the existing spelling.
--
-- Seeded with the three role defaults and every position already on a
-- profile (read only; no profile is changed). Browsers have no access (RLS
-- on, no grants); the API reads and writes it with employee_information.
--
-- Additive. Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.employee_positions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 80),
  created_by      UUID REFERENCES public.profiles(id),
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_positions_name_folded_key
  ON public.employee_positions (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));

ALTER TABLE public.employee_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.employee_positions FROM anon, authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'employee_positions' AND policyname = 'employee_positions_no_client_access') THEN
    CREATE POLICY employee_positions_no_client_access ON public.employee_positions
      FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
GRANT SELECT, INSERT ON public.employee_positions TO service_role;

INSERT INTO public.employee_positions (name)
SELECT DISTINCT ON (lower(regexp_replace(btrim(p), '\s+', ' ', 'g'))) regexp_replace(btrim(p), '\s+', ' ', 'g')
FROM (
  SELECT unnest(ARRAY['Employee', 'Accountant', 'HR Officer']) AS p
  UNION ALL
  SELECT position FROM public.profiles WHERE position IS NOT NULL AND char_length(btrim(position)) BETWEEN 2 AND 80
) seed
ORDER BY lower(regexp_replace(btrim(p), '\s+', ' ', 'g')), p
ON CONFLICT DO NOTHING;
