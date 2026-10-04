/**
 * 13th month pay (December, separate payout):
 *
 *   13th Month = total basic salary actually earned in the year / 12
 *
 * Basic earned per payslip is the basic pay less unpaid absences (Absent
 * days and Leave Without Pay). Paid leave, late, undertime, incentives,
 * overtime and contributions do not change it. Semi-monthly payslips store
 * their own figure (payroll.basic_earned); older ones are derived from their
 * basic salary and absence lines.
 */

import { roundPeso } from "@/lib/payroll/money";
import { periodFromLabel } from "@/lib/payroll/periods";

const peso = (value) => roundPeso(value);

/** Basic pay one Final payslip earned, after unpaid absences. */
export function basicEarnedFromPayroll(payroll) {
  if (!payroll || typeof payroll !== "object") return 0;
  if (payroll.basic_earned !== undefined && payroll.basic_earned !== null) return peso(payroll.basic_earned);
  const totals = payroll.totals || {};
  return peso(Math.max(0, Number(payroll.basic_salary || 0)
    - Number(totals.absence_deduction || 0)
    - Number(totals.leave_without_pay_deduction || 0)));
}

/**
 * @param {Array} entries  payroll_entries rows ({ pay_period, status, payroll })
 * @param {number} year
 */
export function compute13thMonthFromEntries(entries, year) {
  const periods = (entries || [])
    .filter((entry) => String(entry.status || "").toLowerCase() === "paid")
    .map((entry) => {
      const payroll = typeof entry.payroll === "string" ? JSON.parse(entry.payroll) : entry.payroll;
      return { period: periodFromLabel(entry.pay_period), label: entry.pay_period, payroll };
    })
    .filter((row) => row.period && Number(row.period.start_key.slice(0, 4)) === Number(year))
    .sort((a, b) => a.period.start_key.localeCompare(b.period.start_key))
    .map((row) => ({ pay_period: row.label, start_key: row.period.start_key, basic_earned: basicEarnedFromPayroll(row.payroll) }));

  const total = peso(periods.reduce((sum, row) => sum + row.basic_earned, 0));
  return { year: Number(year), periods, total_basic_earned: total, amount: peso(total / 12) };
}

/** One employee's 13th month for a year, from their Final payslips. */
export async function compute13thMonth(supabase, employeeId, year) {
  const result = await supabase
    .from("payroll_entries")
    .select("pay_period,status,payroll")
    .eq("employee_id", employeeId)
    .eq("status", "paid");
  if (result.error) throw new Error(result.error.message);
  return { employee_id: employeeId, ...compute13thMonthFromEntries(result.data || [], year) };
}
