/**
 * The school's payroll sheet (Shepherd Angels Christian School of Antipolo,
 * "Payroll for the period of March 16-31, 2026"), as payroll rules:
 *
 *   Rate          = Monthly Salary ÷ 2
 *   Daily         = Rate ÷ 12        (Working days per year = 24, i.e. per month)
 *   Days          = 12 − days missed (Absent, Leave Without Pay, a Half Day = ½)
 *   Reg. Hrs.     = Days × 8
 *   Amount        = Rate × Days ÷ 12 = Rate − Daily × days missed
 *   OT Rate       = Rate ÷ 96 × 1.25 (hourly × 125%)
 *   OT Amount     = OT hours × OT Rate
 *   Total Amount  = Amount + OT Amount (+ holiday pay and incentives)
 *   Total Ded.    = Cash Advance + SSS + PhilHealth + Pag-IBIG + Tax + Late/Undertime
 *   Net Pay       = Total Amount − Total Deduction
 *
 * With payroll_per_half on, each half is paid on its own attendance like
 * this, instead of the 2nd half settling the month (semi-monthly.js).
 * Contributions follow contribution_method / contribution_half; cash
 * advances are scheduled by src/lib/payroll/cash-advance.js.
 *
 * Worked example (Nate, Angelica T., 10.5 days, Rate 5,250):
 *   Daily 437.50; missed 1.5 days → Amount 5,250 − 656.25 = 4,593.75;
 *   SSS 400 + Pag-IBIG 200 = 600; Net 3,993.75 (the sheet prints 3,994).
 */

import { roundPeso } from "@/lib/payroll/money";
import { resolveRate } from "@/lib/payroll/rates";
import { usesSemiMonthlyRules, HOURS_PER_DAY } from "@/lib/payroll/semi-monthly";
import { monthlyContributions } from "@/lib/payroll/statutory";

const peso = (value) => roundPeso(value);
const CONTRIBUTION_TYPES = ["sss", "philhealth", "pagibig"];

/** "2026-10-17" -> "2026-10-01": the day the per-half rule is read on. */
function monthStartOf(dateKey) {
  return `${String(dateKey || "").slice(0, 7)}-01`;
}

/**
 * True when a period is paid on its own attendance (the school's sheet). Read
 * on the 1st of the period's month, so both halves of a month always follow
 * one rule, and only for semi-monthly periods (from October 1, 2026).
 */
export function usesPerHalfRule(configs, periodStart) {
  if (!usesSemiMonthlyRules(periodStart)) return false;
  return Number(resolveRate(configs, "payroll_per_half", {}, monthStartOf(periodStart)).value) === 1;
}

/** "first" for a period starting on the 1st, else "second". */
export function halfOfPeriod(periodStart) {
  return String(periodStart || "").slice(8, 10) === "01" ? "first" : "second";
}

/**
 * The employee's MONTHLY SSS / PhilHealth / Pag-IBIG.
 *
 *   contribution_method 1  the fixed amounts (sss_fixed, philhealth_fixed, pagibig_fixed)
 *   contribution_method 0  the legal tables (statutory.js)
 *
 * An amount set for the employee (Super Admin → Contribution Amounts; 0 =
 * exempt) wins over either.
 *
 * @param {number} monthlySalary
 * @param {object} rates          rateValues() for the employee and period
 * @param {object} [employeeAmounts]  { sss?, philhealth?, pagibig? } set for the employee
 */
export function monthlyContributionsFor(monthlySalary, rates, employeeAmounts = {}) {
  const fixed = Number(rates?.contribution_method) === 1;
  const legal = fixed ? null : monthlyContributions(monthlySalary, rates);
  const result = {};
  const source = {};
  CONTRIBUTION_TYPES.forEach((type) => {
    const own = employeeAmounts?.[type];
    if (own !== undefined && own !== null && own !== "") {
      result[type] = peso(own);
      source[type] = "employee";
    } else if (fixed) {
      result[type] = peso(rates?.[`${type}_fixed`]);
      source[type] = "fixed";
    } else {
      result[type] = peso(legal[type]);
      source[type] = "legal";
    }
  });
  return { ...result, source };
}

/**
 * What one half deducts of the month's contributions:
 * contribution_half 1 = all on the 1-15 payslip, 2 = all on the 16-end
 * payslip, 3 = half on each (the 2nd half takes the odd centavo).
 */
export function contributionsForHalf(monthly, half, contributionHalf) {
  const mode = Number(contributionHalf) || 3;
  const out = {};
  CONTRIBUTION_TYPES.forEach((type) => {
    const amount = peso(monthly?.[type]);
    if (mode === 1) out[type] = half === "first" ? amount : 0;
    else if (mode === 2) out[type] = half === "second" ? amount : 0;
    else {
      const first = peso(amount / 2);
      out[type] = half === "first" ? first : peso(amount - first);
    }
  });
  return out;
}

/** Monday-to-Friday days in [startKey, endKey] that are not holidays. */
export function workingDaysIn(startKey, endKey, holidays = null) {
  let count = 0;
  const cursor = new Date(`${startKey}T00:00:00Z`);
  const end = new Date(`${endKey}T00:00:00Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    const key = cursor.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays?.has?.(key)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/**
 * Days in a half on the sheet: half the divisor when it is days per MONTH
 * (24 → 12), otherwise the half's own working days.
 */
export function periodDaysFor(divisor, workingDays) {
  const days = Number(divisor) || 0;
  if (days > 0 && days <= 31) return days / 2;
  return Number(workingDays) || 0;
}

/**
 * The sheet's columns for one payslip, from the figures the payslip charged.
 * Every money column is in centavos, so the columns always add up to the
 * totals row; the school's sheet rounds each cell to the peso.
 */
export function sheetFigures({
  basic,
  daily,
  hourly,
  periodDays,
  absenceDeduction = 0,
  halfDayDeduction = 0,
  leaveWithoutPayDeduction = 0,
  lateDeduction = 0,
  undertimeDeduction = 0,
  overtimeMinutes = 0,
  overtimePay = 0,
  overtimePremiumPct = 0,
  holidayPay = 0,
  incentives = 0,
  cashAdvance = 0,
  sss = 0,
  philhealth = 0,
  pagibig = 0,
  withholdingTax = 0,
}) {
  const rate = peso(basic);
  const missedAmount = peso(Number(absenceDeduction) + Number(halfDayDeduction) + Number(leaveWithoutPayDeduction));
  const dailyRate = Number(daily) || 0;
  const days = Math.max(0, Math.round((Number(periodDays) - (dailyRate > 0 ? missedAmount / dailyRate : 0)) * 100) / 100);
  const amount = peso(rate - missedAmount);
  const otAmount = peso(overtimePay);
  const otherPay = peso(Number(holidayPay) + Number(incentives));
  const totalAmount = peso(amount + otAmount + otherPay);
  const lateUndertime = peso(Number(lateDeduction) + Number(undertimeDeduction));
  const totalDeduction = peso(Number(cashAdvance) + Number(sss) + Number(philhealth) + Number(pagibig) + Number(withholdingTax) + lateUndertime);
  return {
    period_days: Number(periodDays) || 0,
    days,
    regular_hours: Math.round(days * HOURS_PER_DAY * 100) / 100,
    rate,
    amount,
    ot_hours: Math.round((Number(overtimeMinutes) / 60) * 100) / 100,
    ot_rate: peso((Number(hourly) || 0) * (1 + (Number(overtimePremiumPct) || 0) / 100)),
    ot_amount: otAmount,
    other_pay: otherPay,
    total_amount: totalAmount,
    cash_advance: peso(cashAdvance),
    sss: peso(sss),
    philhealth: peso(philhealth),
    pagibig: peso(pagibig),
    withholding_tax: peso(withholdingTax),
    late_undertime: lateUndertime,
    total_deduction: totalDeduction,
    net_pay: peso(totalAmount - totalDeduction),
  };
}

/**
 * The sheet row for a payroll entry. Payslips computed with the per-half rule
 * carry their own payroll.sheet; older ones are rebuilt from their totals.
 */
export function sheetRowFromEntry(entry) {
  const payroll = entry?.payroll || {};
  const net = peso(payroll.totals?.net_pay);
  if (payroll.sheet && typeof payroll.sheet === "object") return { ...payroll.sheet, net_pay: net };

  const d = payroll.deductions || {};
  const t = payroll.totals || {};
  const counts = payroll.audit?.attendance?.counts || {};
  const daily = Number(payroll.audit?.rates?.daily?.value) || 0;
  const hourly = Number(payroll.audit?.rates?.hourly?.value) || 0;
  const monthly = payroll.monthly || null;
  const settledMonth = monthly?.half === "second";
  const row = sheetFigures({
    // A 2nd half that settled the month carries the MONTHLY salary.
    basic: settledMonth ? peso(Number(payroll.basic_salary || 0) / 2) : payroll.basic_salary,
    daily,
    hourly,
    periodDays: counts.attended_days !== undefined
      ? Number(counts.attended_days || 0) + Number(counts.absent_days || 0) + Number(d.leave_with_pay_days || 0) + Number(d.leave_without_pay_days || 0)
      : 0,
    absenceDeduction: t.absence_deduction,
    halfDayDeduction: t.half_day_deduction,
    leaveWithoutPayDeduction: t.leave_without_pay_deduction,
    lateDeduction: t.late_deduction,
    undertimeDeduction: t.undertime_deduction,
    overtimeMinutes: counts.overtime_minutes || 0,
    overtimePay: t.overtime_pay,
    overtimePremiumPct: payroll.audit?.rates?.overtime_premium_pct?.value,
    holidayPay: t.holiday_pay,
    incentives: t.total_incentives,
    cashAdvance: d.cash_advance,
    sss: d.sss,
    philhealth: d.philhealth,
    pagibig: d.pagibig,
    withholdingTax: d.withholding_tax,
  });
  // A 2nd half that settled the month: its net is what it actually paid.
  if (settledMonth) {
    return { ...row, net_pay: net, settled_month: true, ...(Math.abs(row.net_pay - net) >= 0.01 ? { net_note: "Adjusted for what the 1-15 payslip paid" } : {}) };
  }
  return { ...row, net_pay: net };
}

const SUM_COLUMNS = [
  "rate", "amount", "ot_hours", "ot_amount", "other_pay", "total_amount", "cash_advance",
  "sss", "philhealth", "pagibig", "withholding_tax", "late_undertime", "total_deduction", "net_pay",
];

/** The totals row: each column summed exactly (centavos). */
export function sheetTotals(rows) {
  const totals = Object.fromEntries(SUM_COLUMNS.map((key) => [key, 0]));
  (rows || []).forEach((row) => {
    SUM_COLUMNS.forEach((key) => { totals[key] += Number(row?.[key]) || 0; });
  });
  SUM_COLUMNS.forEach((key) => {
    totals[key] = key === "ot_hours" ? Math.round(totals[key] * 100) / 100 : peso(totals[key]);
  });
  return totals;
}
