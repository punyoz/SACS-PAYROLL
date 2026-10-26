/**
 * Government remittance for one payroll month (2026-10-26): what the school
 * pays SSS, PhilHealth and Pag-IBIG for each employee — the employee share
 * withheld from pay PLUS the employer share (and, for SSS, the employer-only
 * EC) — and the withholding tax it remits to the BIR (one figure: tax has no
 * employer share). For the Accountant and HR (GET /api/payroll/remittance);
 * never shown to the employee.
 *
 * The employee share is what the payslips deducted (both halves of the
 * month). The employer share is what each 2nd-half payslip recorded at
 * processing (payroll.employer_contributions); a payslip processed before
 * that existed has none, and the row says so (`employer_recorded` false)
 * instead of guessing it from today's rates.
 */

import { roundPeso } from "@/lib/payroll/money";

const peso = (value) => roundPeso(value);
const num = (value) => Number(value) || 0;

export const REMITTANCE_COLUMNS = [
  ["sss_ee", "SSS employee"], ["sss_er", "SSS employer"], ["sss_ec", "SSS EC"], ["sss_total", "SSS remit"],
  ["philhealth_ee", "PhilHealth employee"], ["philhealth_er", "PhilHealth employer"], ["philhealth_total", "PhilHealth remit"],
  ["pagibig_ee", "Pag-IBIG employee"], ["pagibig_er", "Pag-IBIG employer"], ["pagibig_total", "Pag-IBIG remit"],
  ["withholding_tax", "Withholding tax (BIR)"], ["total_remit", "Total remit"],
];

/**
 * @param {Array} entries   payroll_entries rows of the month (both halves)
 * @param {Map}   [branchNames]  branch id -> name
 * @returns {{ rows: Array, totals: object, missing_employer: number }}
 */
export function buildRemittance(entries, branchNames = new Map()) {
  const byEmployee = new Map();
  (entries || []).forEach((entry) => {
    const payroll = entry.payroll || {};
    const d = payroll.deductions || {};
    const row = byEmployee.get(entry.employee_id) || {
      employee_id: entry.employee_id, employee_name: entry.employee_name || "—", employee_code: entry.employee_code || "",
      branch_name: branchNames.get(entry.branch_id) || "—", statuses: [], payslips: [],
      sss_ee: 0, sss_er: 0, sss_ec: 0, philhealth_ee: 0, philhealth_er: 0, pagibig_ee: 0, pagibig_er: 0, withholding_tax: 0,
      employer_recorded: true, has_contributions: false,
    };
    row.statuses.push(entry.status === "paid" ? "Final" : "Draft");
    row.payslips.push(entry.payslip_no || entry.pay_period);
    row.sss_ee = peso(row.sss_ee + num(d.sss));
    row.philhealth_ee = peso(row.philhealth_ee + num(d.philhealth));
    row.pagibig_ee = peso(row.pagibig_ee + num(d.pagibig));
    row.withholding_tax = peso(row.withholding_tax + num(d.withholding_tax));
    const contributes = num(d.sss) + num(d.philhealth) + num(d.pagibig) > 0;
    if (contributes) row.has_contributions = true;
    const er = payroll.employer_contributions?.employer;
    if (er) {
      row.sss_er = peso(row.sss_er + num(er.sss));
      row.sss_ec = peso(row.sss_ec + num(er.sss_ec));
      row.philhealth_er = peso(row.philhealth_er + num(er.philhealth));
      row.pagibig_er = peso(row.pagibig_er + num(er.pagibig));
    } else if (contributes) {
      // Contributions deducted but no employer share recorded (processed
      // before 2026-10-26): flagged for the Accountant to check by hand.
      row.employer_recorded = false;
    }
    byEmployee.set(entry.employee_id, row);
  });

  const rows = [...byEmployee.values()].map((row) => {
    const sssTotal = peso(row.sss_ee + row.sss_er + row.sss_ec);
    const philhealthTotal = peso(row.philhealth_ee + row.philhealth_er);
    const pagibigTotal = peso(row.pagibig_ee + row.pagibig_er);
    return {
      ...row,
      sss_total: sssTotal,
      philhealth_total: philhealthTotal,
      pagibig_total: pagibigTotal,
      total_remit: peso(sssTotal + philhealthTotal + pagibigTotal + row.withholding_tax),
      status: [...new Set(row.statuses)].join(" / "),
    };
  }).sort((a, b) => String(a.employee_name).localeCompare(String(b.employee_name)));

  const totals = Object.fromEntries(REMITTANCE_COLUMNS.map(([key]) => [key, peso(rows.reduce((sum, row) => sum + num(row[key]), 0))]));
  return { rows, totals, missing_employer: rows.filter((row) => !row.employer_recorded).length };
}
