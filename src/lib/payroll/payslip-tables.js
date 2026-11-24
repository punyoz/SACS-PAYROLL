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

import { monthText } from "@/lib/payroll/final-pay-text";
import { FIRST_HALF_NOTE, pesoText } from "@/lib/payroll/line-tags";

const num = (value) => Number(value) || 0;
const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? "" : "s"}`;
const DEFERRED = "2nd half";

const EARNINGS = [["basic", "Basic salary"], ["overtime", "Overtime"], ["holiday", "Holiday pay"]];
const INCENTIVES = [["perfect", "Perfect attendance"]];
// Attendance first, then the government contributions, then the tax (loans follow).
const DEDUCTIONS = [["absent", "Absences"], ["late", "Late"], ["undertime", "Undertime"], ["half_day", "Half day"], ["lwop", "Leave without pay"],
  ["sss", "SSS"], ["philhealth", "PhilHealth"], ["pagibig", "Pag-IBIG"], ["withholding_tax", "Withholding tax"]];

/**
 * Paid leave in the Earnings (2026-11-26): "Leave with pay: 2 days (Vacation 1, Sick 1)", no amount (it is
 * inside the basic pay, never deducted), followed by a leave conversion line when there is one. The types
 * show when the payslip stored them and they add up to its days (payslips before this show the days only).
 */
export function leaveWithPayText(days, byType) {
  const total = num(days);
  if (total <= 0) return "0 days";
  const parts = Object.entries(byType && typeof byType === "object" ? byType : {}).filter(([, n]) => num(n) > 0);
  const sum = parts.reduce((t, [, n]) => t + num(n), 0);
  const types = parts.length && Math.abs(sum - total) < 0.001
    ? ` (${parts.map(([t, n]) => `${String(t).replace(/ Leave$/, "")} ${num(n)}`).join(", ")})` : "";
  return `${plural(total, "day")}${types}`;
}
const leaveRow = (days, byType) => ({ key: "leave_with_pay", label: "Leave with pay", amount: 0, text: leaveWithPayText(days, byType) });

/** Earnings: the leave row after the fixed rows, the leave conversion line right after it. */
function withLeave(earnings, days, byType) {
  const conversion = earnings.filter((l) => /^leave_conversion/.test(String(l.key || "")) || /^(Unused )?leave conversion/i.test(String(l.label || "")));
  const rest = earnings.filter((l) => !conversion.includes(l));
  const fixedCount = rest.findIndex((l) => !["basic", "overtime", "holiday"].includes(l.key));
  const at = fixedCount < 0 ? rest.length : fixedCount;
  return [...rest.slice(0, at), leaveRow(days, byType), ...conversion, ...rest.slice(at)];
}

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
    key: l.key, label: SHORT_LABEL[l.key] || l.label, amount: num(l.amount), note: l.how || null, formula: l.formula || shortHow(l.how), sign: l.sign,
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
    earnings: withLeave(withFixed(EARNINGS, additions.filter((l) => !INCENTIVE_KEYS.has(l.key))), leave, g.leave_with_pay_by_type),
    holiday_lines: holidayLines || [],
    incentives: withFixed(INCENTIVES, additions.filter((l) => INCENTIVE_KEYS.has(l.key))),
    deductions: [
      ...withFixed(DEDUCTIONS, deductions, {
        deferred: first ? ["sss", "philhealth", "pagibig", "withholding_tax"] : [],
      }),
      ...(loans ? [] : [{ key: "loans", label: "Loans / cash advance", amount: 0, ...(first ? { text: DEFERRED } : {}) }]),
    ],
    gross: num(g.gross),
    total_deductions: num(g.total_deductions),
    carry_over_out: carry > 0 ? carry : 0,
    notes,
  };
}

const FINAL_EARNING = { thirteenth_month: "13th month pay (pro-rated)", subsidy: "Licensed teacher subsidy", leave_conversion: "Unused leave conversion" };
const FINAL_DEDUCTION = { sss: "SSS", philhealth: "PhilHealth", pagibig: "Pag-IBIG", withholding_tax: "Withholding tax", carry_over: "Balance carried over", loan: "Loan", first_half_paid: "1st half already paid" };

/** A final pay (payroll.final_pay.breakdown, final-pay.js): every month, the 13th month, subsidy, leave and loans. */
function fromFinalPay(fp, overpayment) {
  const month = (l) => (l.month_key ? ` (${monthText(l.month_key)})` : "");
  const allEarnings = (fp.earnings || []).map((l) => ({
    key: l.kind, label: l.kind === "salary" ? `Salary${month(l)}` : l.label || FINAL_EARNING[l.kind] || l.kind, amount: num(l.amount), note: l.note || null,
  }));
  // A final pay never shows a negative gross (2026-11-22): a salary line below zero (the
  // 1st half paid more than was earned, stored before that rule) is shown as a deduction.
  const earnings = allEarnings.filter((l) => l.amount >= 0);
  const overpaid = allEarnings.filter((l) => l.amount < 0).map((l) => ({
    key: "first_half_paid", label: `Salary paid above earned${l.label.replace(/^Salary/, "")}`, amount: Math.abs(l.amount), note: l.note,
  }));
  const deductions = [...overpaid, ...(fp.deductions || []).map((l) => ({
    key: l.kind,
    label: l.kind === "loan" ? l.label || (l.note || "Loan").split(" — ")[0] : `${l.label || FINAL_DEDUCTION[l.kind] || l.kind}${month(l)}`,
    amount: num(l.amount), note: l.kind === "loan" ? l.note : l.note || null, ...(l.credit ? { credit: true } : {}),
  }))];
  const hasLoan = deductions.some((l) => l.key === "loan");
  const cent = (v) => Math.round(v * 100) / 100;
  const gross = cent(earnings.reduce((s, l) => s + l.amount, 0));
  const totalDeductions = cent(num(fp.total_deductions) + overpaid.reduce((s, l) => s + l.amount, 0));
  const recover = Math.max(num(overpayment), cent(totalDeductions - gross));
  return {
    earnings: withFixed([["salary", "Salary"], ["thirteenth_month", FINAL_EARNING.thirteenth_month]], earnings),
    holiday_lines: [],
    incentives: [],
    deductions: [...withFixed([["sss", "SSS"], ["philhealth", "PhilHealth"], ["pagibig", "Pag-IBIG"], ["withholding_tax", "Withholding tax"]], deductions),
      ...(hasLoan ? [] : [{ key: "loans", label: "Loans / cash advance", amount: 0 }])],
    gross: overpaid.length ? gross : num(fp.gross),
    total_deductions: overpaid.length ? totalDeductions : num(fp.total_deductions),
    overpayment_to_recover: recover > 0 ? recover : 0,
    notes: recover > 0 ? [`Overpayment to recover: ${pesoText(recover)} (listed for HR; never shown as negative pay)`] : [],
  };
}

/** A per-cutoff payslip whose lines could not be grouped: its own stored lines. */
function fromCutoff(c, holidayLines) {
  const leave = num(c.leave_with_pay_days);
  return {
    earnings: withLeave(c.earnings.map((l, i) => ({ key: /^Holiday/.test(l.label) ? "holiday" : `e${i}`, label: l.label, amount: num(l.amount), note: l.note || null })), leave, c.leave_with_pay_by_type),
    holiday_lines: holidayLines || [],
    incentives: [],
    deductions: [
      ...c.deductions.filter((l) => l.credit || num(l.amount) > 0).map((l, i) => ({ key: `d${i}`, label: l.label, amount: num(l.amount), note: l.note || null, ...(l.credit ? { credit: true } : {}) })),
    ],
    gross: num(c.gross_pay),
    total_deductions: num(c.total_deductions),
    carry_over_out: num(c.carry_over_out) > 0 ? num(c.carry_over_out) : 0,
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
    earnings: withLeave([row("basic", "Basic salary", e.basic_salary), row("overtime", "Overtime", e.overtime), row("holiday", "Holiday pay", e.holiday_pay),
      ...extra("transportation", "Transportation", p.transportation), ...extra("rice", "Rice allowance", p.rice), ...extra("bonus", "Bonus", p.bonus)], lwp, d.leave_with_pay_by_type),
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
      row("lwop", "Leave without pay", d.leave_without_pay_deduction),
      row("cash_advance", "Cash advance", d.cash_advance),
    ],
    gross: num(e.gross_pay ?? p.gross_pay),
    total_deductions: num(d.total_deductions ?? p.total_deductions),
    notes: [],
  };
}

/**
 * A line's "how" as the formula alone, for the PDF's Details column: no
 * "SSS: " name in front, no "= ₱amount" (the Amount column says it).
 */
export function shortHow(how) {
  if (!how) return null;
  return String(how).replace(/^[A-Za-z-]+:\s+/, "").replace(/\s*=\s*[−-]?₱[\d,.]+\s*$/, "").trim() || null;
}

/**
 * Deduction groups, in the payslip's order (2026-11-22): attendance, government
 * contributions, withholding tax, loans and advances, other. Final pay lines
 * carry the same kinds, so they group the same way.
 */
export const DEDUCTION_GROUPS = [
  ["attendance", "Attendance"],
  ["government", "Government contributions"],
  ["tax", "Tax"],
  ["loans", "Loans and advances"],
  ["other", "Other"],
];
const ATTENDANCE_KEYS = new Set(["absent", "late", "undertime", "half_day", "lwop", "leave_with_pay", "prior_attendance"]);
const GOVERNMENT_KEYS = new Set(["sss", "philhealth", "pagibig"]);
const TAX_KEYS = new Set(["withholding_tax", "year_end_tax", "year_end_refund"]);

export function deductionGroup(row) {
  const key = String(row?.key || "");
  if (ATTENDANCE_KEYS.has(key) || /^short_day(-|$)/.test(key)) return "attendance";
  if (GOVERNMENT_KEYS.has(key)) return "government";
  if (TAX_KEYS.has(key)) return "tax";
  if (/^(loan|loans|offset|cash_advance|carry|carry_over)(-|$)/.test(key)) return "loans";
  // Lines without a known key (an older per-cutoff payslip): read the label.
  const label = String(row?.label || "");
  if (/^(Absen|Late|Undertime|Half day|Short day|Leave with)/i.test(label)) return "attendance";
  if (/^(SSS|PhilHealth|Pag-IBIG)/i.test(label)) return "government";
  if (/tax/i.test(label)) return "tax";
  if (/loan|advance|carried/i.test(label)) return "loans";
  return "other";
}

const cents = (value) => Math.round((Number(value) || 0) * 100);

/**
 * The payslip adds up (2026-11-22): Gross = the earnings lines (incentives
 * included; they keep their sign: a final pay can hold a negative salary
 * line), Total deductions = the deduction lines (a credit counts against
 * them), Net = Gross - Total deductions + what is carried to next month or
 * is an overpayment to recover (deductions above the pay), each line rounded
 * to the centavo first. Returns every mismatch of ₱0.01 or more; [] when it adds up.
 */
export function payslipTotalsCheck(t, netPay) {
  if (!t) return [];
  const earned = [...t.earnings, ...t.incentives].reduce((total, r) => total + (r.text ? 0 : cents(r.amount)), 0);
  const deducted = t.deductions.reduce((total, r) => total + (r.text ? 0 : (r.credit ? -1 : 1) * Math.abs(cents(r.amount))), 0);
  const carried = cents(t.carry_over_out) + cents(t.overpayment_to_recover);
  const found = [];
  const out = (what, shown, lines) => found.push({ what, shown: shown / 100, lines: lines / 100, difference: (shown - lines) / 100 });
  if (cents(t.gross) !== earned) out("gross", cents(t.gross), earned);
  if (cents(t.total_deductions) !== deducted) out("total_deductions", cents(t.total_deductions), deducted);
  const expected = cents(t.gross) - cents(t.total_deductions) + carried;
  if (netPay !== undefined && netPay !== null && cents(netPay) !== expected) out("net_pay", cents(netPay), expected);
  return found;
}

/** Shown: a row with an amount, or words that say something (not "0 days" or a deferred "2nd half"). */
const shown = (r) => (r.text ? r.text !== DEFERRED && !/^0 days?$/.test(r.text) : num(r.amount) !== 0);

function tablesFor(p) {
  if (p.final_pay?.earnings) return fromFinalPay(p.final_pay, p.final_pay_overpayment);
  if (p.line_groups?.groups) return fromGroups(p.line_groups, p.holiday_lines);
  if (p.monthly?.cutoff && Array.isArray(p.monthly.cutoff.earnings)) return fromCutoff(p.monthly.cutoff, p.holiday_lines);
  if (p.monthly) return null;
  return fromClassic(p);
}

/**
 * @param {object} p a payslip as buildPayslipDetails() or My Payslips returns it (final_pay: the stored breakdown).
 * ₱0 rows are left out (2026-11-19): Gross, Total deductions and Net always show.
 */
export function payslipTables(p) {
  if (!p) return null;
  const t = tablesFor(p);
  if (!t) return null;
  // Each line to the centavo (the totals are checked against these: payslipTotalsCheck).
  const withFormula = (r) => ({ ...r, amount: Math.round((Number(r.amount) || 0) * 100) / 100, formula: r.formula ?? shortHow(r.note) });
  const order = DEDUCTION_GROUPS.map(([key]) => key);
  const deductions = t.deductions.filter(shown).map(withFormula).map((r) => ({ ...r, group: deductionGroup(r) }));
  // Grouped in the payslip's order; within a group the stored order stays (sort is stable).
  deductions.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  return { ...t, earnings: t.earnings.filter(shown).map(withFormula), incentives: t.incentives.filter(shown).map(withFormula), deductions };
}
