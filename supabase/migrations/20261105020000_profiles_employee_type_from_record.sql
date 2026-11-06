-- Full system check 2026-11-05: Add Employee (POST /api/admin/employees, also
-- used by the CSV import) stored the employee type and account status in
-- the account record (user_metadata) but not in profiles, so every new hire
-- took the column defaults ("Teaching", "Active"). Listings and payroll read
-- profiles (src/lib/payroll/staff.js prefers it), so a Non-Teaching hire
-- showed and was paid as Teaching. The route is fixed; this copies the type
-- HR entered into profiles where the two disagree.
--
-- Only rows whose account record holds a valid type and differs are touched.
-- HR's edit (PATCH /api/hr/employees) always writes both copies, so a
-- difference can only come from the bug. Nothing is deleted; approved
-- payslips keep the type stored on them (payroll_entries.employee_type).

UPDATE public.profiles p
SET employee_type = u.raw_user_meta_data->>'employee_type',
    updated_at = NOW()
FROM auth.users u
WHERE u.id = p.id
  AND u.raw_user_meta_data->>'employee_type' IN ('Teaching', 'Non-Teaching')
  AND p.employee_type IS DISTINCT FROM u.raw_user_meta_data->>'employee_type';
