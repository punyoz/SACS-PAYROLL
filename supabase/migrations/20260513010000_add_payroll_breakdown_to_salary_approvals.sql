-- Add payroll_breakdown column to salary_approvals so the full computation
-- (deductions, net pay) is stored with each payroll submission.
ALTER TABLE salary_approvals ADD COLUMN IF NOT EXISTS payroll_breakdown JSONB;
