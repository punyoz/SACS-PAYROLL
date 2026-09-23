-- Persist payroll entries (drafts + pending submissions) to the database
-- so accountant drafts survive Vercel cold starts that clear /tmp.
--
-- This migration is idempotent: it creates the table if missing, and
-- otherwise tops up any columns/indexes that don't already exist. Safe
-- to run against an environment where an earlier partial attempt left
-- a payroll_entries table with a different schema.

CREATE TABLE IF NOT EXISTS public.payroll_entries (
  id UUID PRIMARY KEY
);

ALTER TABLE public.payroll_entries
  ADD COLUMN IF NOT EXISTS employee_id UUID,
  ADD COLUMN IF NOT EXISTS employee_name TEXT,
  ADD COLUMN IF NOT EXISTS employee_code TEXT,
  ADD COLUMN IF NOT EXISTS employee_type TEXT,
  ADD COLUMN IF NOT EXISTS position TEXT,
  ADD COLUMN IF NOT EXISTS pay_period TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS approval_id TEXT,
  ADD COLUMN IF NOT EXISTS payroll JSONB,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS payroll_entries_status_idx
  ON public.payroll_entries (status);

CREATE INDEX IF NOT EXISTS payroll_entries_employee_period_idx
  ON public.payroll_entries (employee_id, pay_period);
