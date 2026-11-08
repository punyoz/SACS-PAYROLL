/**
 * The Super Admin's payroll export (Backup & Recovery, 2026-11-08): the
 * columns of the file and the CSV quoting. Used by
 * src/app/api/admin/backup/payroll/route.js.
 */

/** [header, field, kind] in file order. Amounts are the stored numbers. */
export const PAYROLL_EXPORT_COLUMNS = [
  ["Payslip No.", "payslip_no"], ["Employee ID", "employee_code"], ["Employee", "employee_name"], ["Type", "employee_type"],
  ["Position", "position"], ["Branch", "branch_name"], ["Pay period", "pay_period"], ["Cutoff", "cutoff"], ["Status", "status"],
  ["Basic salary", "basic_salary", "money"], ["Overtime pay", "overtime_pay", "money"], ["Bonus", "bonus", "money"], ["Gross pay", "gross_pay", "money"],
  ["SSS", "sss", "money"], ["PhilHealth", "philhealth", "money"], ["Pag-IBIG", "pagibig", "money"], ["Withholding tax", "withholding_tax", "money"],
  ["Absences", "absences_deduction", "money"], ["Cash advance", "cash_advance", "money"], ["Total deductions", "total_deductions", "money"], ["Net pay", "net_pay", "money"],
  ["Submitted", "submitted_at"], ["Approved", "approved_at"], ["Created", "created_at"], ["Updated", "updated_at"],
  ["Made in testing mode", "created_in_testing_mode"], ["Payslip ID", "id"], ["Employee profile ID", "employee_id"], ["Branch ID", "branch_id"],
];

/** A CSV field; text that a spreadsheet would run as a formula is prefixed with '. */
export function csvField(value, kind) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
  if (kind !== "money" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

