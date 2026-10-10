-- profiles.employee_status: allow 'On Leave' and 'Inactive'.
--
-- The live check constraint was first added by hand in the dashboard with
-- only Active / Pending / Archived (20261009010000 added AWOL / Separated).
-- The app has always written two more values, and both were refused:
--   * 'On Leave' / 'Inactive': the HR Create / Edit Employee status pick list
--     (src/app/hr/employee-form-dialog.jsx, src/lib/employees/record.js);
--   * 'Inactive': archiving an employee (DELETE /api/admin/employees) and
--     scripts/purge-archived-employees.mjs; attendance_close_days already
--     skips 'inactive' profiles.
-- 'Archived' stays for any row that still carries it. No rows change.

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_employee_status_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_employee_status_check
  CHECK (employee_status = ANY (ARRAY['Active', 'Pending', 'On Leave', 'Inactive', 'Archived', 'AWOL', 'Separated']));
