-- Add unique payslip number to payroll_entries so every submitted payroll
-- carries the same human-readable ID that appears on the printed payslip.
ALTER TABLE public.payroll_entries
  ADD COLUMN IF NOT EXISTS payslip_no TEXT;
