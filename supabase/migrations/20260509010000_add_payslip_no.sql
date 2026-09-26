-- Add unique payslip number to payroll_records
ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS payslip_no TEXT;
-- Guarded so the file can be run again (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_records_payslip_no_unique') THEN
    ALTER TABLE payroll_records ADD CONSTRAINT payroll_records_payslip_no_unique UNIQUE (payslip_no);
  END IF;
END;
$$;
