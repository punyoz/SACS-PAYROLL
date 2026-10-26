/**
 * BIR Form 2316 (Certificate of Compensation Payment / Tax Withheld) and the
 * 1604-C alphalist, computed from what the system actually paid in a
 * calendar year (scenario AC-11, 2026-10-22). Safe for the browser: no
 * server imports. The loader is src/lib/payroll/bir-forms.js.
 *
 * Sources, per employee and year:
 *   Final payslips      regular semi-monthly entries (status "paid") whose
 *                       period falls in the year, and the final-pay entry of
 *                       an employee separated that year
 *   Benefits ledger     payroll_exempt_benefits_paid: the 13th month plus the
 *                       licensed-teacher subsidy paid as an "other benefit"
 *                       (advances, payouts, adjustments) — the same figures the
 *                       payroll uses for the exempt ceiling
 *   Tax table           the monthly payroll_tax_brackets version in force on
 *                       the last day of the year, annualized (annualTaxTable:
 *                       the TRAIN annual table is the monthly one times 12)
 *
 * Box mapping (2316, January 2018 ENCS):
 *   34  13th month and other benefits, up to the exempt ceiling
 *   36  employee share of SSS, PhilHealth and Pag-IBIG
 *   37  subsidy whose tax treatment is "exempt"
 *   38  total non-taxable (34 + 36 + 37)
 *   39  basic salary earned (after absences, late, undertime, unpaid leave)
 *       less the contributions in 36
 *   48  13th month and other benefits above the ceiling
 *   50  overtime pay
 *   51A holiday and overload pay
 *   51B incentives, and subsidy whose tax treatment is "taxable"
 *   52  total taxable (39 + 48 + 50 + 51A + 51B)
 *   19  gross compensation (38 + 52); 20 = 38; 21 = 52; 23 = 21 (no previous
 *       employer is recorded); 24 tax due on 23; 25A tax withheld; 26 = 25A
 *
 * Not recorded by the system, so always zero / blank: previous employer
 * (16-18, 22, 25B), minimum wage earner (9-11, 29-33), de minimis (35),
 * allowances (40-44), commissions and fees (45-47), hazard pay (49).
 *
 * The year-end difference (tax due − tax withheld) is shown, never applied:
 * the Accountant settles it with a payroll correction (decided 2026-10-22).
 */

import { roundPeso } from "@/lib/payroll/money";
import { monthlyWithholdingTax, usesSemiMonthlyRules } from "@/lib/payroll/semi-monthly";
import { periodFromLabel } from "@/lib/payroll/periods";

const peso = (value) => roundPeso(Number(value) || 0);
const num = (value) => Number(value) || 0;

export const DEFAULT_BENEFITS_CEILING = 90000;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The month number (1-12) of a "October 1-15, 2026" period label; 0 when it is not one. */
export function periodMonth(label) {
  const match = /^([A-Za-z]+)\s+\d{1,2}-\d{1,2},\s*(\d{4})$/.exec(String(label || "").trim());
  if (!match) return 0;
  return MONTHS.indexOf(match[1].toLowerCase()) + 1;
}

/** The year of a "October 1-15, 2026" period label; 0 when it is not one. */
export function periodYear(label) {
  const match = /^[A-Za-z]+\s+\d{1,2}-\d{1,2},\s*(\d{4})$/.exec(String(label || "").trim());
  return match ? Number(match[1]) : 0;
}

/**
 * The annual table from the monthly one: each bracket times 12, back on the
 * round figures the monthly table rounded away (20,833 × 12 = 249,996 →
 * 250,000; 8,541.80 × 12 = 102,501.60 → 102,500), so the result is the
 * BIR annual table exactly.
 */
export function annualTaxTable(monthlyTable) {
  return (monthlyTable || []).map((row) => ({
    over: num(row.over) > 0 ? Math.round((num(row.over) * 12) / 1000) * 1000 : 0,
    base: Math.round((num(row.base) * 12) / 100) * 100,
    rate: num(row.rate),
  }));
}

/** Annual income tax on `taxable` from the monthly table ({ over, base, rate } rows). */
export function annualTaxDue(taxable, monthlyTable) {
  const amount = Math.max(0, num(taxable));
  if (!amount || !(monthlyTable || []).length) return 0;
  return peso(monthlyWithholdingTax(amount, annualTaxTable(monthlyTable)));
}

/**
 * One payslip's figures for the 2316. `entry` is a paid payroll entry with
 * (at least) pay_period and the payroll object's totals, deductions,
 * basic_earned and subsidy, or final_pay.breakdown for a final pay.
 * `subsidyTreatment` resolves a final pay's subsidy (its balance's treatment).
 */
export function payslipFigures(entry, { subsidyTreatment = null } = {}) {
  const payroll = entry?.payroll || {};
  const out = { basic: 0, contributions: 0, overtime: 0, holiday_overload: 0, incentives: 0, subsidy_exempt: 0, subsidy_taxable: 0, withheld: 0, final_pay: false };

  const breakdown = payroll.final_pay?.breakdown;
  if (breakdown) {
    out.final_pay = true;
    const lines = Array.isArray(breakdown.deductions) ? breakdown.deductions : [];
    out.basic = peso(breakdown.basic_earned);
    out.contributions = peso(lines.filter((d) => ["sss", "philhealth", "pagibig"].includes(d.kind)).reduce((s, d) => s + num(d.amount), 0));
    out.withheld = peso(lines.filter((d) => d.kind === "withholding_tax").reduce((s, d) => s + num(d.amount), 0));
    const payout = peso(breakdown.subsidy?.payout);
    // The 13th month and an "other benefit" subsidy are in the benefits ledger.
    if (payout > 0 && subsidyTreatment === "exempt") out.subsidy_exempt = payout;
    else if (payout > 0 && subsidyTreatment === "taxable") out.subsidy_taxable = payout;
    return out;
  }

  const t = payroll.totals || {};
  const d = payroll.deductions || {};
  out.contributions = peso(num(d.sss) + num(d.philhealth) + num(d.pagibig));
  out.withheld = peso(d.withholding_tax);
  out.overtime = peso(t.overtime_pay);
  out.holiday_overload = peso(num(t.holiday_pay) + num(t.overload_pay));
  // Early Bird / Perfect Attendance bonuses on semi-monthly payslips are
  // "other benefits" in the benefits ledger (2026-10-26), counted there.
  const bonusesAreBenefits = usesSemiMonthlyRules(periodFromLabel(entry?.pay_period)?.start_key);
  out.incentives = peso(num(t.other_incentive)
    + (bonusesAreBenefits ? 0 : num(t.early_bird_winner_incentive) + num(t.perfect_attendance_incentive)));
  const subsidyPaid = peso(t.subsidy_pay);
  const treatment = payroll.subsidy?.tax_treatment || "other_benefit";
  if (subsidyPaid > 0 && treatment === "exempt") out.subsidy_exempt = subsidyPaid;
  else if (subsidyPaid > 0 && treatment === "taxable") out.subsidy_taxable = subsidyPaid;

  if (payroll.basic_earned !== undefined && payroll.basic_earned !== null) {
    out.basic = peso(payroll.basic_earned);
  } else {
    // Older payslips: gross less every other earning, less attendance deductions.
    const attendance = num(t.absence_deduction) + num(t.late_deduction) + num(t.undertime_deduction) + num(t.half_day_deduction) + num(t.leave_without_pay_deduction);
    out.basic = Math.max(0, peso(num(t.gross_pay) - out.overtime - out.holiday_overload - out.incentives - subsidyPaid - attendance));
  }
  return out;
}

/**
 * The 2316 figures for one employee and year.
 * @param {object} input
 * @param {number} input.year
 * @param {{ date_hired?: string, separated_on?: string }} input.employee
 * @param {Array<{ figures: object, month: number }>} input.payslips  payslipFigures() + the month it was paid (12 = December)
 * @param {Array<{ kind: string, amount: number }>} input.benefits     the year's benefits-ledger rows
 * @param {number} input.ceiling
 * @param {Array} input.taxTable                                       monthly { over, base, rate } rows
 */
export function compute2316({ year, employee = {}, payslips = [], benefits = [], ceiling = DEFAULT_BENEFITS_CEILING, taxTable = [] }) {
  const sum = (key, list = payslips) => peso(list.reduce((s, p) => s + num(p.figures[key]), 0));

  const contributions = sum("contributions");
  const basicEarned = sum("basic");
  const benefitsTotal = peso(benefits.reduce((s, b) => s + num(b.amount), 0));
  const thirteenth = peso(benefits.filter((b) => b.kind === "thirteenth_month").reduce((s, b) => s + num(b.amount), 0));
  const benefitsExempt = peso(Math.min(benefitsTotal, Math.max(0, num(ceiling))));

  const box = {};
  box[34] = benefitsExempt;
  box[36] = contributions;
  box[37] = sum("subsidy_exempt");
  box[38] = peso(box[34] + box[36] + box[37]);
  box[39] = Math.max(0, peso(basicEarned - contributions));
  box[48] = peso(benefitsTotal - benefitsExempt);
  box[50] = sum("overtime");
  box["51A"] = sum("holiday_overload");
  box["51B"] = peso(sum("incentives") + sum("subsidy_taxable"));
  box[52] = peso(box[39] + box[48] + box[50] + box["51A"] + box["51B"]);
  box[19] = peso(box[38] + box[52]);
  box[20] = box[38];
  box[21] = box[52];
  box[22] = 0;
  box[23] = peso(box[21] + box[22]);
  box[24] = annualTaxDue(box[23], taxTable);
  box["25A"] = sum("withheld");
  box["25B"] = 0;
  box[26] = peso(box["25A"] + box["25B"]);
  box[27] = 0;
  box[28] = peso(box[26] + box[27]);

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const hired = String(employee.date_hired || "").slice(0, 10);
  const separated = String(employee.separated_on || "").slice(0, 10);
  const periodFrom = hired && hired > yearStart && hired <= yearEnd ? hired : yearStart;
  const periodTo = separated && separated >= yearStart && separated < yearEnd ? separated : yearEnd;

  const december = payslips.filter((p) => p.month === 12);
  const withheldDecember = sum("withheld", december);
  const difference = peso(box[24] - box[26]);

  return {
    year: Number(year),
    period_from: periodFrom,
    period_to: periodTo,
    separated_in_year: Boolean(separated && separated >= yearStart && separated <= yearEnd),
    boxes: box,
    thirteenth_month: thirteenth,
    other_benefits: peso(benefitsTotal - thirteenth),
    basic_earned: basicEarned,
    payslip_count: payslips.length,
    withheld_jan_nov: peso(box["25A"] - withheldDecember),
    withheld_december: withheldDecember,
    // > 0: under-withheld (to collect); < 0: over-withheld (to refund).
    difference,
    settlement: Math.abs(difference) < 0.01 ? "none" : difference > 0 ? "collect" : "refund",
  };
}

/** "Last, First Middle" split for the alphalist from a profile. */
export function nameParts(profile = {}) {
  const last = String(profile.last_name || "").trim();
  const first = String(profile.first_name || "").trim();
  const middle = String(profile.middle_initial || profile.middle_name || "").trim();
  if (last || first) return { last, first: [first, String(profile.suffix || "").trim()].filter(Boolean).join(" "), middle };
  const full = String(profile.full_name || "").trim();
  const parts = full.split(/\s+/);
  return { last: parts.length > 1 ? parts[parts.length - 1] : full, first: parts.length > 1 ? parts.slice(0, -1).join(" ") : "", middle: "" };
}

/**
 * The 1604-C alphalist columns (Schedule 1: employees as of December 31;
 * Schedule 2: employees separated before December 31). [header, value(row)].
 * `row` is { seq, tin, name: nameParts(), form: compute2316() }.
 */
export const ALPHALIST_COLUMNS = [
  ["Seq. No.", (r) => r.seq],
  ["TIN", (r) => r.tin],
  ["Last name", (r) => r.name.last],
  ["First name", (r) => r.name.first],
  ["Middle name", (r) => r.name.middle],
  ["Employment from", (r) => r.form.period_from],
  ["Employment to", (r) => r.form.period_to],
  ["Gross compensation income", (r) => r.form.boxes[19]],
  ["13th month pay and other benefits (non-taxable)", (r) => r.form.boxes[34]],
  ["De minimis benefits", () => 0],
  ["SSS, PHIC, Pag-IBIG contributions and union dues", (r) => r.form.boxes[36]],
  ["Salaries and other forms of compensation (non-taxable)", (r) => r.form.boxes[37]],
  ["Total non-taxable / exempt compensation", (r) => r.form.boxes[38]],
  ["Basic salary (taxable)", (r) => r.form.boxes[39]],
  ["13th month pay and other benefits (taxable)", (r) => r.form.boxes[48]],
  ["Salaries and other forms of compensation (taxable)", (r) => (r.form.boxes[50] + r.form.boxes["51A"] + r.form.boxes["51B"])],
  ["Total taxable compensation income", (r) => r.form.boxes[52]],
  ["Tax due", (r) => r.form.boxes[24]],
  ["Tax withheld January - November", (r) => r.form.withheld_jan_nov],
  ["Tax withheld December", (r) => r.form.withheld_december],
  ["Total tax withheld", (r) => r.form.boxes[26]],
  ["Under-withheld (to collect)", (r) => Math.max(0, r.form.difference)],
  ["Over-withheld (to refund)", (r) => Math.max(0, -r.form.difference)],
  // One employer for the whole year and tax withheld equal to tax due (RR 2-98).
  ["Substituted filing", (r) => (!r.form.separated_in_year && r.form.settlement === "none" ? "Yes" : "No")],
];

/** One alphalist row's values, in ALPHALIST_COLUMNS order. */
export function alphalistRow(row) {
  return ALPHALIST_COLUMNS.map(([, value]) => {
    const v = value(row);
    return typeof v === "number" ? peso(v) : (v ?? "");
  });
}

/** CSV text of rows (arrays), with a header. */
export function toCsv(header, rows) {
  const cell = (value) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
  };
  return `${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
