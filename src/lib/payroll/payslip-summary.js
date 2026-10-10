/**
 * What a generated payslip shows next to its amounts, and keeps as its audit
 * snapshot: the attendance numbers it was computed from, and how each
 * deduction was arrived at ("Absent: 2 days × 650.00 = 1,300.00").
 *
 * Built once, at generation, from the same figures the amounts came from
 * (buildEmployeePayroll in the payroll route), so the explanation can never
 * drift from the money.
 */

import { roundPeso } from "@/lib/payroll/money";

/** 1300 -> "1,300.00" (no currency sign: the PDF font has no peso sign). */
export function money(value) {
  const n = roundPeso(Number(value) || 0);
  const [whole, cents] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? "" : "s"}`;

/**
 * @param {object} args
 * @param {object} args.auto      computeAttendancePay() output
 * @param {object} [args.leave]   the employee's leave summary for the period
 * @param {string} args.through   last day counted ("YYYY-MM-DD")
 */
export function buildAttendanceSummary({ auto, leave, through }) {
  const counts = auto?.counts || {};
  return {
    attendance_through: through,
    days_present: counts.attended_days || 0,
    days_absent: counts.absent_days || 0,
    half_days: counts.half_days || 0,
    late_days: counts.late_days || 0,
    late_minutes: counts.late_minutes || 0,
    undertime_minutes: counts.undertime_minutes || 0,
    leave_with_pay_days: leave?.with_pay_days || 0,
    leave_without_pay_days: leave?.without_pay_days || 0,
    leave_days: (leave?.with_pay_days || 0) + (leave?.without_pay_days || 0),
    incomplete_days: (auto?.blocking || []).length,
    overtime_minutes: counts.overtime_minutes || 0,
  };
}

/**
 * One line per deduction with an amount: { type, label, amount, basis }.
 *
 * @param {object} args
 * @param {object} args.payroll  computeTotals() output (amounts actually charged)
 * @param {object} args.auto     computeAttendancePay() output (unit amounts)
 * @param {object} args.rates    rate values in force (rateValues())
 * @param {boolean} args.legal   legal contribution tables in force
 * @param {string} [args.taxBasis]  how the withholding tax was computed, when not the semi-monthly table
 * @param {object} [args.contributionSource]  per type "legal" | "fixed" | "employee" (school payroll sheet)
 */
export function buildDeductionBasis({ payroll, auto, rates, legal, taxBasis, contributionSource }) {
  const d = payroll?.deductions || {};
  const t = payroll?.totals || {};
  const unit = auto?.unit_amounts || {};
  const hourly = Number(unit.hourly ?? rates?.hourly) || 0;
  const daily = Number(unit.daily ?? rates?.daily) || 0;
  const lines = [];
  const add = (type, label, amount, basis) => {
    if (roundPeso(amount) > 0) lines.push({ type, label, amount: roundPeso(amount), basis: `${label}: ${basis} = ${money(amount)}` });
  };

  add("absent", "Absent", t.absence_deduction, `${plural(d.absences_days || 0, "day")} × ${money(unit.absent ?? daily)}`);

  // Late follows the Payroll Rates rules: every N late days = 1 absence, plus
  // the optional per-minute charge.
  const lateParts = [];
  const perAbsent = Number(unit.late_days_per_absent) || 0;
  const dayCharge = Number(auto?.amounts?.late_days_charge) || 0;
  const minuteCharge = Number(auto?.amounts?.late_minutes_charge) || 0;
  if (dayCharge > 0 && perAbsent > 0) {
    const groups = Math.floor((d.late_days || 0) / perAbsent);
    lateParts.push(`${plural(d.late_days || 0, "late day")} ÷ ${perAbsent} = ${plural(groups, "absence")} × ${money(unit.absent ?? daily)}`);
  }
  if (minuteCharge > 0) {
    const pct = Number(unit.late_minute_pct) || 0;
    lateParts.push(`${d.late_minutes || 0} min × (${money(hourly)}/hr ÷ 60${pct === 100 ? "" : ` × ${pct}%`})`);
  }
  add("late", "Late", t.late_deduction, lateParts.join(" + ") || `${d.late_minutes || 0} min late`);

  add("undertime", "Undertime", t.undertime_deduction, `${d.undertime_minutes || 0} min × (${money(hourly)}/hr ÷ 60)`);
  add("half_day", "Half Day", t.half_day_deduction, `${plural(d.half_days || 0, "day")} × ${money(unit.half_day ?? daily / 2)}`);
  add("leave_without_pay", "Leave without pay", t.leave_without_pay_deduction, `${plural(d.leave_without_pay_days || 0, "day")} × ${money(daily)}`);

  const statutoryBasis = (type) => (contributionSource?.[type] === "fixed"
    ? "fixed monthly amount"
    : contributionSource?.[type] === "employee"
      ? "amount set for this employee"
      : legal
        ? "employee share per the contribution table"
        : `${Number(rates?.[`${type}_pct`]) || 0}% of basic ${money(payroll?.basic_salary)}`);
  add("sss", "SSS", d.sss, statutoryBasis("sss"));
  add("philhealth", "PhilHealth", d.philhealth, statutoryBasis("philhealth"));
  add("pagibig", "Pag-IBIG", d.pagibig, statutoryBasis("pagibig"));
  add("withholding_tax", "Withholding tax", d.withholding_tax, taxBasis || (legal ? "BIR semi-monthly withholding table" : "as entered"));
  add("carry_over", "Balance carried over", t.carry_over_deduction, "negative 2nd half net pay of the previous month");
  const loans = Array.isArray(payroll?.loans) ? payroll.loans.filter((line) => Number(line.amount) > 0) : [];
  add("loan", "Loans", d.loan, loans.length
    ? loans.map((line) => `${money(line.amount)} (${line.description}), balance ${money(line.balance_after)}${Number(line.shortfall) > 0 ? `, partial` : ""}`).join("; ")
    : "amortization");
  const advances = Array.isArray(payroll?.cash_advances) ? payroll.cash_advances : [];
  add("cash_advance", "Cash advance", d.cash_advance, advances.length
    ? advances.map((line) => `${money(line.amount)}${line.description ? ` (${line.description})` : ""}, balance ${money(line.balance_after)}`).join("; ")
    : "installment");

  return lines;
}
