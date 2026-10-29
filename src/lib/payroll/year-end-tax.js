/**
 * Year-end tax annualization (2026-10-29). Accountant only. Safe for the
 * browser: no server imports. The loaders are in src/lib/payroll/bir-forms.js
 * (loadBirYear, loadYearEndTaxContext); the table and the Accountant-only
 * functions are supabase/migrations/20261029010000_tax_annualization.sql.
 *
 *   1. The Accountant runs the annualization for a tax year: per employee,
 *      the year's gross, non-taxable and taxable compensation, the tax due from
 *      the BIR annual table and the tax withheld (compute2316). It is stored as
 *      its own record (payroll_tax_annualizations), re-runnable at any time.
 *   2. The Accountant schedules the difference onto a 2nd-cutoff payslip,
 *      normally December 16-31. When that payslip is processed it computes the
 *      final amount (yearEndAdjustment): tax due on the whole year, this
 *      payslip included, less every peso withheld (the regular withholding of
 *      every payslip, this one's included, and adjustments already settled).
 *   3. The payslip carries it as its own line (applyYearEndTax): a deduction
 *      when under-withheld, a refund added to net pay when over-withheld. The
 *      regular withholding tax line of that payslip and of every earlier one
 *      stays exactly as computed.
 *
 * A collection is never more than the payslip can pay: the rest stays on the
 * annualization's balance (re-run it and schedule it onto a later payslip).
 */

import { roundPeso } from "@/lib/payroll/money";
import { compute2316 } from "@/lib/payroll/bir-2316";

const peso = (value) => roundPeso(Number(value) || 0);
const num = (value) => Number(value) || 0;
const money = (value) => `₱${peso(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const YEAR_END_TAX_LABEL = "Year-end tax adjustment";

/** A 2nd-cutoff period label of the tax year, or January 16-31 of the next year. */
export function yearEndTargetAllowed(label, taxYear) {
  const match = /^([A-Z][a-z]+) 16-(\d{2}), (\d{4})$/.exec(String(label || "").trim());
  if (!match) return false;
  const year = Number(match[3]);
  return year === Number(taxYear) || (year === Number(taxYear) + 1 && match[1] === "January");
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "December 16-31, 2026" for a month (1-12) of a year. */
export function secondCutoffLabel(year, month) {
  const last = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return `${MONTH_NAMES[Number(month) - 1]} 16-${last}, ${year}`;
}

/**
 * The 2nd-cutoff payslips an adjustment for `taxYear` can go on, from
 * `fromKey` (today, "YYYY-MM-DD") on: the rest of the tax year's 16-end
 * cutoffs and January 16-31 of the next year. December 16-31 first.
 */
export function yearEndTargetOptions(taxYear, fromKey) {
  const y = Number(taxYear);
  const from = String(fromKey || "");
  const options = [];
  for (let month = 1; month <= 12; month += 1) {
    const end = `${y}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(y, month, 0)).getUTCDate()).padStart(2, "0")}`;
    if (end >= from) options.push(secondCutoffLabel(y, month));
  }
  if (`${y + 1}-01-31` >= from) options.push(secondCutoffLabel(y + 1, 1));
  const december = secondCutoffLabel(y, 12);
  return options.sort((a, b) => (a === december ? -1 : b === december ? 1 : 0));
}

/** What an annualization row stores, from a compute2316() form. */
export function annualizationFigures(form) {
  const b = form.boxes;
  return {
    gross_compensation: peso(b[19]),
    non_taxable: peso(b[38]),
    taxable_compensation: peso(b[52]),
    tax_due: peso(b[24]),
    tax_withheld: peso(form.withheld_regular ?? b["25A"]),
    adjustments_settled: peso(form.year_end_adjustment || 0),
    // > 0 to collect, < 0 to refund.
    balance: peso(form.difference),
    payslip_count: form.payslip_count,
    boxes: b,
  };
}

/**
 * The adjustment the target payslip carries.
 * @param {object} input
 * @param {number} input.year                   the tax year
 * @param {object} input.employee               { date_hired, separated_on }
 * @param {{ payslips: Array, benefits: Array, adjustments: Array }} input.prior
 *        the tax year's Final payslips (payslipFigures + month), benefits and
 *        settled adjustments, without this payslip
 * @param {{ figures: object, month: number, benefits?: Array }|null} input.current
 *        this payslip, when it is of the tax year (null for January of the next)
 * @param {number} input.ceiling
 * @param {Array} input.taxTable                monthly { over, base, rate } rows
 * @param {number} input.available              what this payslip can still pay (its net before the adjustment)
 * @returns {null | { kind: "collect"|"refund", amount, shortfall, tax_due, taxable, withheld, settled_before, difference }}
 */
export function yearEndAdjustment({ year, employee = {}, prior, current = null, ceiling, taxTable, available = 0 }) {
  const payslips = [...(prior?.payslips || []), ...(current ? [current] : [])];
  const benefits = [...(prior?.benefits || []), ...(current?.benefits || [])];
  const adjustments = prior?.adjustments || [];
  const form = compute2316({ year, employee, payslips, benefits, ceiling, taxTable, adjustments });
  const difference = peso(form.difference);
  if (Math.abs(difference) < 0.01) return null;
  const base = {
    tax_due: form.boxes[24],
    taxable: form.boxes[23],
    withheld: form.withheld_regular,
    settled_before: form.year_end_adjustment,
    difference,
  };
  if (difference > 0) {
    const amount = peso(Math.min(difference, Math.max(0, num(available))));
    return { ...base, kind: "collect", amount, shortfall: peso(difference - amount) };
  }
  return { ...base, kind: "refund", amount: peso(-difference), shortfall: 0 };
}

/**
 * Put an adjustment on a 2nd-cutoff payroll object (after the month is
 * settled): payroll.year_end_tax, its own audit line, net pay and total
 * deductions. deductions.withholding_tax is never touched.
 */
export function applyYearEndTax(payroll, adjustment, { annualizationId = null, taxYear } = {}) {
  if (!adjustment) return payroll;
  const signed = adjustment.kind === "collect" ? peso(adjustment.amount) : -peso(adjustment.amount);
  const t = payroll.totals;
  const m = payroll.monthly || null;
  const before = m && m.second_half_net !== undefined ? num(m.second_half_net) : num(t.net_pay);
  const after = peso(before - signed);

  const what = adjustment.kind === "collect" ? "under-withheld" : "over-withheld, refunded";
  const note = `${taxYear} annualization: tax due ${money(adjustment.tax_due)} on ${money(adjustment.taxable)} taxable, `
    + `withheld ${money(peso(adjustment.withheld + adjustment.settled_before))} (${what})`
    + (adjustment.shortfall > 0 ? `; ${money(adjustment.shortfall)} more stays to collect` : "");
  payroll.year_end_tax = {
    annualization_id: annualizationId,
    tax_year: Number(taxYear),
    kind: adjustment.kind,
    amount: peso(adjustment.amount),
    // + collected / − refunded, as the BIR forms add it to the tax withheld.
    signed,
    shortfall: peso(adjustment.shortfall),
    tax_due: peso(adjustment.tax_due),
    taxable: peso(adjustment.taxable),
    withheld_before: peso(adjustment.withheld),
    settled_before: peso(adjustment.settled_before),
    label: `${YEAR_END_TAX_LABEL} ${taxYear} (${adjustment.kind === "collect" ? "under-withheld" : "refund"})`,
    note,
  };
  if (Math.abs(signed) < 0.01) return payroll;

  t.year_end_tax_adjustment = signed;
  t.total_deductions = peso(num(t.total_deductions) + signed);
  t.net_pay = after > 0 ? after : 0;
  if (m) {
    m.year_end_tax = payroll.year_end_tax;
    m.net_pay = t.net_pay;
    m.carry_over_out = after < 0 ? peso(-after) : 0;
  }
  if (payroll.sheet) {
    payroll.sheet.net_pay = peso(num(payroll.sheet.net_pay) - signed);
    payroll.sheet.net_note = [payroll.sheet.net_note, `${signed > 0 ? "Less" : "Plus"} ${money(Math.abs(signed))} year-end tax adjustment`].filter(Boolean).join("; ");
  }
  const line = {
    type: adjustment.kind === "collect" ? "year_end_tax" : "year_end_tax_refund",
    quantity: 1, unit: "year", rate: null, rate_config_id: null,
    amount: peso(adjustment.amount), source_log_id: null, is_override: false, note, log_date: null,
  };
  if (payroll.audit?.lines) {
    if (adjustment.kind === "collect") payroll.audit.lines.deductions.push(line);
    else payroll.audit.lines.incentives.push(line);
  }
  return payroll;
}

/** A per-cutoff payslip's line for it (monthly.cutoff.deductions); a refund is a credit. */
export function yearEndCutoffLine(yearEndTax) {
  if (!yearEndTax || !(peso(yearEndTax.amount) > 0)) return null;
  return {
    label: yearEndTax.label,
    amount: peso(yearEndTax.amount),
    note: yearEndTax.note,
    ...(yearEndTax.kind === "refund" ? { credit: true } : {}),
  };
}
