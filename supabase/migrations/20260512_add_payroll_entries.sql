-- Persist payroll entries (drafts + pending submissions) to the database
-- so accountant drafts survive Vercel cold starts that clear /tmp.

CREATE TABLE IF NOT EXISTS public.payroll_entries (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL,
  employee_name TEXT NOT NULL,
  employee_code TEXT,
  employee_type TEXT,
  position TEXT,
  pay_period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  approval_id TEXT,
  payroll JSONB NOT NULL,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payroll_entries_status_idx ON public.payroll_entries (status);
CREATE INDEX IF NOT EXISTS payroll_entries_employee_period_idx ON public.payroll_entries (employee_id, pay_period);
