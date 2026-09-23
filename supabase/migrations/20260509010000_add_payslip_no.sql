-- Add unique payslip number to payroll_records
ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS payslip_no TEXT;
ALTER TABLE payroll_records ADD CONSTRAINT payroll_records_payslip_no_unique UNIQUE (payslip_no);
