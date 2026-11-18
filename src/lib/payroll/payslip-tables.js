/**
 * One payslip layout for every role (2026-11-18): Earnings, Incentives and
 * Deductions tables, then gross, total deductions and net pay. Built from the
 * payslip's stored figures only (never recomputes): the grouped lines
 * (line-tags.js), a final pay's breakdown, a per-cutoff payslip's own lines,
 * or an older payslip's flat fields. The core rows (basic, overtime, holiday,
 * SSS, PhilHealth, Pag-IBIG, tax, attendance, loans) always show, ₱0 when
 * none; every other line (13th month, subsidy, leave conversion, each loan,
 * incentives) shows when it has an amount.
 *
 * Row: { key, label, amount, text?, credit?, note? }; text replaces the amount
 * (e.g. "2nd half"), credit marks a line added to pay among the deductions.
 * null for an older semi-monthly payslip without per-cutoff lines (kept on its
 * own layout).
 */

import { FIRST_HALF_NOTE, pesoText } from "@/lib/payroll/line-tags";

const num = (value) => Number(value) || 0;
const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? "" : "s"}`;
const DEFERRED = "2nd half";

const EARNINGS = [["basic", "Basic salary"], ["overtime", "Overtime"], ["holiday", "Holiday pay"]];
const INCENTIVES = [["perfect", "Perfect attendance"]];
const DEDUCTIONS = [["sss", "SSS"], ["philhealth", "PhilHealth"], ["pagibig", "Pag-IBIG"], ["withholding_tax", "Withholding tax"],
  ["absent", "Absences"], ["late", "Late"], ["undertime", "Undertime"], ["half_day", "Half day"], ["lwop", "Leave without pay"]];

/** The fixed rows in order (each line with that key in its place, else ₱0), then `after`, then every other line. */
function withFixed(fixed, lines, { deferred = [], after = [] } = {}) {
  const used = new Set();
  const rows = fixed.flatMap(([key, label]) => {
    const found = lines.filter((l) => l.key === key);
    found.forEach((l) => used.add(l));
    if (found.length) return found;
    return [deferred.includes(key) ? { key, label, amount: 0, text: DEFERRED } : { key, label, amount: 0 }];
  });
  return [...rows, ...after, ...lines.filter((l) => !used.has(l))];
}

const INCENTIVE_KEYS = new Set(["perfect", "early_bird", "incentives"]);
const SHORT_LABEL = { basic: null, overtime: "Overtime", holiday: "Holiday pay", perfect: "Perfect attendance", absent: "Absences", lwop: "Leave without pay" };

/** line_groups: payrollLineGroups() (Accountant / HR) or employeePayslipView() (My Payslips). */
function fromGroups(g, holidayLines) {
  const lines = (g.groups || []).flatMap((group) => group.lines.map((l) => ({
    key: l.key, label: SHORT_LABEL[l.key] || l.label, amount: num(l.amount), note: l.how || null, sign: l.sign,
  })));
  const additions = lines.filter((l) => l.sign === "+" && l.key !== "year_end_refund");
  const refund = lines.filter((l) => l.key === "year_end_refund").map((l) => ({ ...l, credit: true }));
  const deductions = lines.filter((l) => l.sign !== "+" && (num(l.amount) > 0 || l.key !== "late")).concat(refund);
  const first = g.half === "first";
  const leave = num(g.leave_with_pay_days);
  const loans = deductions.some((l) => /^(loan|offset|cash_advance|carry)-/.test(l.key));
  const notes = [g.first_half_note, g.hire_note].filter(Boolean);
  const carry = num(g.carry_over_out?.amount ?? g.carry_over_out);
  if (carry > 0) notes.push(`Carried to next month (deductions above this payslip's pay): ${pesoText(carry)}`);
  return {
    earnings: withFixed(EARNINGS, additions.filter((l) => !INCENTIVE_KEYS.has(l.key))),
    holiday_lines: holidayLines || [],
    incentives: withFixed(INCENTIVES, additions.filter((l) => INCENTIVE_KEYS.has(l.key))),
    deductions: [
      ...withFixed(DEDUCTIONS, deductions, {
        deferred: first ? ["sss", "philhealth", "pagibig", "withholding_tax"] : [],
        after: [{ key: "leave_with_pay", label: "Leave with pay", amount: 0, text: leave > 0 ? `${plural(leave, "day")}, no deduction` : "0 days" }],
      }),
      ...(loans ? [] : [{ key: "loans", label: "Loans / cash advance", amount: 0, ...(first ? { text: DEFERRED } : {}) }]),
    ],
    gross: num(g.gross),
    total_deductions: num(g.total_deductions),
    notes,
  };
}

const FINAL_EARNING = { thirteenth_month: "13th month pay (pro-rated)", subsidy: "Licensed teacher subsidy", leave_conversion: "Unused leave conversion" };
const FINAL_DEDUCTION = { sss: "SSS", philhealth: "PhilHealth", pagibig: "Pag-IBIG", withholding_tax: "Withholding tax", carry_over: "Balance carried over", loan: "Loan" };

/** A final pay (payroll.final_pay.breakdown, final-pay.js): every month, the 13th month, subsidy, leave and loans. */
function fromFinalPay(fp, overpayment) {
  const month = (l) => (l.month_key ? ` (${l.month_key})` : "");
  const earnings = (fp.earnings || []).map((l) => ({
    key: l.kind, label: l.kind === "salary" ? `Salary${month(l)}` : l.label || FINAL_EARNING[l.kind] || l.kind, amount: num(l.amount), note: l.note || null,
  }));
  const deductions = (fp.deductions || []).map((l) => ({
    key: l.kind,
    label: l.kind === "loan" ? (l.note || "Loan").split(" — ")[0] : `${l.label || FINAL_DEDUCTION[l.kind] || l.kind}${month(l)}`,
    amount: num(l.amount), note: l.kind === "loan" ? l.note : l.note || null, ...(l.credit ? { credit: true } : {}),
  }));
  const hasLoan = deductions.some((l) => l.key === "loan");
  return {
    earnings: withFixed([["salary", "Salary"], ["thirteenth_month", FINAL_EARNING.thirteenth_month]], earnings),
    holiday_lines: [],
    incentives: [],
    deductions: [...withFixed([["sss", "SSS"], ["philhealth", "PhilHealth"], ["pagibig", "Pag-IBIG"], ["withholding_tax", "Withholding tax"]], deductions),
      ...(hasLoan ? [] : [{ key: "loans", label: "Loans / cash advance", amount: 0 }])],
    gross: num(fp.gross),
    total_deductions: num(fp.total_deductions),
    notes: num(overpayment) > 0 ? [`Deductions above the final pay (recovered by HR): ${pesoText(overpayment)}`] : [],
  };
}

/** A per-cutoff payslip whose lines could not be grouped: its own stored lines. */
function fromCutoff(c, holidayLines) {
  const leave = num(c.leave_with_pay_days);
  return {
    earnings: c.earnings.map((l, i) => ({ key: /^Holiday/.test(l.label) ? "holiday" : `e${i}`, label: l.label, amount: num(l.amount), note: l.note || null })),
    holiday_lines: holidayLines || [],
    incentives: [],
    deductions: [
      ...c.deductions.filter((l) => l.credit || num(l.amount) > 0).map((l, i) => ({ key: `d${i}`, label: l.label, amount: num(l.amount), note: l.note || null, ...(l.credit ? { credit: true } : {}) })),
      { key: "leave_with_pay", label: "Leave with pay", amount: 0, text: leave > 0 ? `${plural(leave, "day")}, no deduction` : "0 days" },
    ],
    gross: num(c.gross_pay),
    total_deductions: num(c.total_deductions),
    notes: c.half === "first" ? [FIRST_HALF_NOTE] : [],
  };
}

/** An older payslip's flat fields: buildPayslipDetails() (nested) or My Payslips (flat). */
function fromClassic(p) {
  if (p.has_breakdown === false) {
    return { earnings: [{ key: "gross", label: "Gross pay", amount: num(p.gross_pay) }], holiday_lines: [], incentives: [], deductions: [{ key: "total", label: "Deductions", amount: num(p.total_deductions) }], gross: num(p.gross_pay), total_deductions: num(p.total_deductions), notes: [] };
  }
  const e = p.earnings || p;
  const d = p.deductions || p;
  const inc = p.incentives || p;
  const lwp = num(d.leave_with_pay_days);
  const row = (key, label, amount) => ({ key, label, amount: num(amount) });
  const extra = (key, label, amount) => (num(amount) > 0 ? [row(key, label, amount)] : []);
  return {
    earnings: [row("basic", "Basic salary", e.basic_salary), row("overtime", "Overtime", e.overtime), row("holiday", "Holiday pay", e.holiday_pay),
      ...extra("transportation", "Transportation", p.transportation), ...extra("rice", "Rice allowance", p.rice), ...extra("bonus", "Bonus", p.bonus)],
    holiday_lines: p.holiday_lines || [],
    incentives: [
      ...extra("early_bird_bonus", num(inc.early_bird_days) ? `Early bird bonus (${plural(inc.early_bird_days, "day")})` : "Early bird bonus", inc.early_bird_incentive),
      row("perfect", "Perfect attendance", inc.perfect_attendance_incentive),
      ...extra("early_bird", "Early Bird Incentive", inc.early_bird_winner_incentive),
    ],
    deductions: [
      row("sss", "SSS", d.sss), row("philhealth", "PhilHealth", d.philhealth), row("pagibig", "Pag-IBIG", d.pagibig), row("withholding_tax", "Withholding tax", d.withholding_tax),
      row("absent", "Absences", d.absence_deduction),
      row("late", num(d.late_days) ? `Late (${plural(d.late_days, "day")})` : "Late", d.late_deduction),
      row("undertime", num(d.undertime_minutes) ? `Undertime (${d.undertime_minutes} min)` : "Undertime", d.undertime_deduction),
      row("half_day", num(d.half_days) ? `Half day (${plural(d.half_days, "day")})` : "Half day", d.half_day_deduction),
      { key: "leave_with_pay", label: "Leave with pay", amount: 0, text: plural(lwp, "day") },
      row("lwop", "Leave without pay", d.leave_without_pay_deduction),
      row("cash_advance", "Cash advance", d.cash_advance),
    ],
    gross: num(e.gross_pay ?? p.gross_pay),
    total_deductions: num(d.total_deductions ?? p.total_deductions),
    notes: [],
  };
}

/** @param {object} p a payslip as buildPayslipDetails() or My Payslips returns it (final_pay: the stored breakdown). */
export function payslipTables(p) {
  if (!p) return null;
  if (p.final_pay?.earnings) return fromFinalPay(p.final_pay, p.final_pay_overpayment);
  if (p.line_groups?.groups) return fromGroups(p.line_groups, p.holiday_lines);
  if (p.monthly?.cutoff && Array.isArray(p.monthly.cutoff.earnings)) return fromCutoff(p.monthly.cutoff, p.holiday_lines);
  if (p.monthly) return null;
  return fromClassic(p);
}
