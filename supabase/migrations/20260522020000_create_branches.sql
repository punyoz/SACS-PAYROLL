-- Branches table for Super Admin branch management module.
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.branches (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name     TEXT NOT NULL,
  location TEXT,
  code     TEXT,
  status   TEXT NOT NULL DEFAULT 'Active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS name       TEXT,
  ADD COLUMN IF NOT EXISTS location   TEXT,
  ADD COLUMN IF NOT EXISTS code       TEXT,
  ADD COLUMN IF NOT EXISTS status     TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Enforce non-null on name after the fact (safe if column already exists).
ALTER TABLE public.branches
  ALTER COLUMN name SET NOT NULL;

CREATE INDEX IF NOT EXISTS branches_status_idx ON public.branches (status);

-- Seed the default main branch only when the table is empty.
INSERT INTO public.branches (name, location, code, status)
SELECT 'Main Campus', 'SACS — Main Branch', 'MAIN-01', 'Active'
WHERE NOT EXISTS (SELECT 1 FROM public.branches LIMIT 1);
