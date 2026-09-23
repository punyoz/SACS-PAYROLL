-- Ensure the leave_requests table exists with the columns the app's
-- leave-request store (src/lib/leave-requests/store.js) expects, and add the
-- new pay_status column ('with_pay' | 'without_pay') used for the employee
-- Leave Balance UI and the payroll Leave Without Pay deduction.
--
-- No CREATE TABLE for leave_requests exists anywhere else in this repo's
-- migration history (the store falls back to Supabase Storage JSON / /tmp
-- when the table is absent), so this is written defensively: it creates the
-- table if missing, and only adds the new column if the table already
-- exists out-of-band in your environment.

CREATE TABLE IF NOT EXISTS public.leave_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   TEXT,
  employee_name TEXT NOT NULL,
  position      TEXT,
  leave_type    TEXT NOT NULL,
  pay_status    TEXT NOT NULL DEFAULT 'with_pay',
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  reason        TEXT,
  proof_url     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending_admin',
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS pay_status TEXT NOT NULL DEFAULT 'with_pay';
