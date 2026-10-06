/**
 * Semi-monthly payroll, for pay periods starting on or after
 * SEMI_MONTHLY_RULES_EFFECTIVE:
 *
 *   1st half (1-15)    Monthly Salary / 2. No deductions at all.
 *   2nd half (16-end)  settles the whole month:
 *     Daily Rate        = Monthly Salary × 12 / divisor (divisor ≤ 31 is
 *                         working days per MONTH: Monthly Salary / divisor)
 *     Hourly Rate       = Daily Rate / 8
 *     Absence Deduction = Daily Rate × (days absent + days leave without pay)
 *     Overload Pay      = Hourly Rate × overload hours × (1 + premium %)
 *     Monthly Gross     = Monthly Salary − Absence Deduction + Incentives + Overload Pay
 *                         (− late / undertime / half day, + overtime / holiday pay)
 *     Taxable Income    = Monthly Gross − (SSS + PhilHealth + Pag-IBIG)
 *     Withholding Tax   = MONTHLY tax table on Taxable Income, once
 *     Monthly Net       = Monthly Gross − contributions − tax
 *     2nd Half Net Pay  = Monthly Net − 1st half already paid − balance carried in
 *   A negative 2nd half is paid as 0 and the balance carries to next month.
 *
 * Attendance lock: month M's payroll covers attendance from the day after
 * last month's lock day to M's lock day. A leave or incentive belongs to the
 * first month whose lock date is on or after both its date and the day it was
 * filed, so anything filed after the lock moves to the next month.
 *
 * Every amount is rounded to centavos.
 */

import { roundPeso } from "@/lib/payroll/money";

/** Pay periods starting on or after this date use the rules above. */
export const SEMI_MONTHLY_RULES_EFFECTIVE = "2026-10-01";
export const SEMI_MONTHLY_RULE = "semi_monthly";
export const HOURS_PER_DAY = 8;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const pad = (n) => String(n).padStart(2, "0");
const peso = (value) => roundPeso(value);

export function usesSemiMonthlyRules(periodStart) {
  return String(periodStart || "") >= SEMI_MONTHLY_RULES_EFFECTIVE;
}

/** "first" for a period starting on the 1st, else "second". */
export function halfOf(periodStart) {
  return String(periodStart || "").slice(8, 10) === "01" ? "first" : "second";
}

/** "2026-10-17" -> "2026-10". */
export function monthKeyOf(dateKey) {
  return String(dateKey || "").slice(0, 7);
}

/** "2026-10" ± months. */
export function shiftMonth(monthKey, delta) {
  const [year, month] = String(monthKey).split("-").map(Number);
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

function daysInMonth(monthKey) {
  const [year, month] = String(monthKey).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Both halves of a month, with their period labels. */
export function monthInfo(monthKey) {
  const [year, month] = String(monthKey).split("-").map(Number);
  const last = daysInMonth(monthKey);
  const name = MONTHS[month - 1];
  return {
    month_key: monthKey,
    label: `${name} ${year}`,
    start_key: `${monthKey}-01`,
    end_key: `${monthKey}-${pad(last)}`,
    first_half_label: `${name} 1-15, ${year}`,
    second_half_label: `${name} 16-${last}, ${year}`,
  };
}

/** The month's lock date: its lock day, or the month end (0, or past the end). */
export function lockDateKey(monthKey, lockDay) {
  const day = Math.floor(Number(lockDay) || 0);
  const last = daysInMonth(monthKey);
  return `${monthKey}-${pad(day > 0 && day < last ? day : last)}`;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The attendance days month M's 2nd half counts.
 * @param {string} monthKey             "YYYY-MM"
 * @param {(monthKey: string) => number} lockDayFor  lock day in force for a month
 */
export function monthlyWindow(monthKey, lockDayFor, { carryOver = true } = {}) {
  const previousLock = lockDateKey(shiftMonth(monthKey, -1), lockDayFor(shiftMonth(monthKey, -1)));
  // carryOver false: days after the lock day are never deducted, so each
  // month reads from its own 1st (the school: the 1st to the 15th).
  const start = carryOver ? addDays(previousLock, 1) : `${monthKey}-01`;
  return {
    start_key: start > SEMI_MONTHLY_RULES_EFFECTIVE ? start : SEMI_MONTHLY_RULES_EFFECTIVE,
    end_key: lockDateKey(monthKey, lockDayFor(monthKey)),
  };
}

/** The payroll month ("YYYY-MM") a dated item filed on filedKey belongs to. */
export function payrollMonthFor(dateKey, filedKey, lockDayFor) {
  const anchor = filedKey && filedKey > dateKey ? filedKey : dateKey;
  const month = monthKeyOf(anchor);
  return anchor > lockDateKey(month, lockDayFor(month)) ? shiftMonth(month, 1) : month;
}

/** Daily rate from the monthly salary. A divisor of 31 or less is working days per month. */
export function dailyRateFor(monthlySalary, divisor) {
  const salary = Math.max(0, Number(monthlySalary) || 0);
  const days = Number(divisor) || 0;
  if (!salary || days <= 0) return 0;
  return peso(days <= 31 ? salary / days : (salary * 12) / days);
}

export function hourlyRateFor(dailyRate) {
  return peso((Number(dailyRate) || 0) / HOURS_PER_DAY);
}

export function overloadPayFor(hourlyRate, hours, premiumPct = 0) {
  return peso((Number(hourlyRate) || 0) * (Number(hours) || 0) * (1 + (Number(premiumPct) || 0) / 100));
}

/**
 * Tax from the monthly table: rows { over, base, rate } (rate a fraction),
 * the highest `over` the taxable income exceeds.
 */
export function monthlyWithholdingTax(taxable, table) {
  const amount = Math.max(0, Number(taxable) || 0);
  const rows = [...(table || [])].sort((a, b) => Number(a.over) - Number(b.over));
  if (!rows.length) return 0;
  let bracket = rows[0];
  rows.forEach((row) => { if (amount > Number(row.over)) bracket = row; });
  return peso(Math.max(0, Number(bracket.base) + (amount - Number(bracket.over)) * Number(bracket.rate)));
}

/** payroll_tax_brackets rows -> the { over, base, rate } table above. */
export function taxTableFromRows(rows) {
  return (rows || [])
    .map((row) => ({ over: Number(row.bracket_over) || 0, base: Number(row.base_tax) || 0, rate: (Number(row.rate_pct) || 0) / 100 }))
    .sort((a, b) => a.over - b.over);
}

/** The version of the tax table in force on a date: rows saved together, newest first. */
export function resolveTaxTableRows(rows, dateKey) {
  const inForce = (rows || []).filter((row) => String(row.effective_date) <= String(dateKey));
  if (!inForce.length) return [];
  const newest = inForce.reduce((best, row) => (
    String(row.effective_date) > String(best.effective_date)
    || (String(row.effective_date) === String(best.effective_date) && String(row.created_at || "") > String(best.created_at || ""))
      ? row : best
  ));
  return inForce.filter((row) => row.version_id === newest.version_id);
}

/** 1st half: the full semi-monthly salary, nothing deducted. */
export function computeFirstHalf({ monthlySalary }) {
  const pay = peso((Number(monthlySalary) || 0) / 2);
  return { semi_monthly_pay: pay, gross_pay: pay, total_deductions: 0, net_pay: pay };
}

/**
 * 2nd half: the whole month, less what the 1st half already paid.
 *
 * absenceDeduction, when given, is the computed per-day amount (absent days
 * at the daily rate plus Leave Without Pay); otherwise Daily Rate × days.
 * withholdingTax, when given, replaces the table's figure (a logged override).
 */
export function computeSecondHalf({
  monthlySalary,
  dailyRate,
  divisor,
  absentDays = 0,
  leaveWithoutPayDays = 0,
  leaveWithPayDays = 0,
  absenceDeduction,
  otherAttendanceDeductions = 0,
  incentives = 0,
  overloadHours = 0,
  overloadPremiumPct = 0,
  overloadPay,
  otherEarnings = 0,
  // Cash advance installments: taken from the net only, never from taxable income.
  cashAdvance = 0,
  contributions = {},
  taxTable = [],
  withholdingTax,
  firstHalfPaid = 0,
  carryIn = 0,
}) {
  const salary = peso(monthlySalary);
  const daily = dailyRate !== undefined && dailyRate !== null ? peso(dailyRate) : dailyRateFor(salary, divisor);
  const hourly = hourlyRateFor(daily);
  const absence = absenceDeduction !== undefined && absenceDeduction !== null
    ? peso(absenceDeduction)
    : peso(daily * ((Number(absentDays) || 0) + (Number(leaveWithoutPayDays) || 0)));
  const overload = overloadPay !== undefined && overloadPay !== null
    ? peso(overloadPay)
    : overloadPayFor(hourly, overloadHours, overloadPremiumPct);

  const monthlyGross = peso(salary - absence - peso(otherAttendanceDeductions) + peso(incentives) + overload + peso(otherEarnings));
  const sss = peso(contributions.sss);
  const philhealth = peso(contributions.philhealth);
  const pagibig = peso(contributions.pagibig);
  const contributionTotal = peso(sss + philhealth + pagibig);
  const taxable = Math.max(0, peso(monthlyGross - contributionTotal));
  const tableTax = monthlyWithholdingTax(taxable, taxTable);
  const tax = withholdingTax !== undefined && withholdingTax !== null ? peso(withholdingTax) : tableTax;
  const cashAdvanceTotal = peso(cashAdvance);
  const monthlyNet = peso(monthlyGross - contributionTotal - tax - cashAdvanceTotal);
  const paid = peso(firstHalfPaid);
  const carried = peso(carryIn);
  const secondHalf = peso(monthlyNet - paid - carried);

  return {
    monthly_salary: salary,
    daily_rate: daily,
    hourly_rate: hourly,
    absent_days: Number(absentDays) || 0,
    leave_without_pay_days: Number(leaveWithoutPayDays) || 0,
    leave_with_pay_days: Number(leaveWithPayDays) || 0,
    absence_deduction: absence,
    other_attendance_deductions: peso(otherAttendanceDeductions),
    incentives: peso(incentives),
    overload_hours: Number(overloadHours) || 0,
    overload_pay: overload,
    other_earnings: peso(otherEarnings),
    monthly_gross: monthlyGross,
    sss,
    philhealth,
    pagibig,
    contributions: contributionTotal,
    taxable_income: taxable,
    table_withholding_tax: tableTax,
    withholding_tax: tax,
    cash_advance: cashAdvanceTotal,
    monthly_net: monthlyNet,
    first_half_paid: paid,
    carry_in: carried,
    second_half_net: secondHalf,
    net_pay: secondHalf > 0 ? secondHalf : 0,
    carry_over_out: secondHalf < 0 ? peso(-secondHalf) : 0,
  };
}
