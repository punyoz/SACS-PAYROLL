/**
 * Government contributions and withholding tax (Philippines).
 *
 * From LEGAL_RULES_EFFECTIVE on, payroll computes the employee's share of
 * each contribution from the legal base instead of a flat % of the half-month
 * basic, and withholds income tax from the BIR table:
 *
 *   SSS         sss_pct (5) % of the monthly salary credit (MSC). The MSC is
 *               the monthly salary rounded to the nearest ₱500 bracket
 *               (₱5,250–5,749.99 → ₱5,500), kept within sss_msc_min–max
 *               (₱5,000–₱35,000).
 *   PhilHealth  philhealth_pct (2.5) % of the monthly basic salary, kept
 *               within philhealth_floor–ceiling (₱10,000–₱100,000). The
 *               premium is 5%, shared equally with the employer.
 *   Pag-IBIG    pagibig_pct (2) % of the monthly salary up to
 *               pagibig_max_salary (₱10,000), i.e. at most ₱200 a month;
 *               1% when the salary is ₱1,500 or less.
 *
 * Each figure is monthly; each semi-monthly payslip carries half of it.
 *
 * Withholding tax uses the BIR semi-monthly table in force since
 * 1 January 2023 (TRAIN law), on the period's taxable compensation: gross pay
 * less attendance and Leave Without Pay deductions, less the employee's
 * SSS, PhilHealth and Pag-IBIG.
 *
 * Every percentage and limit above is an effective-dated rate the Super Admin
 * can change (src/lib/payroll/rates.js), because these are revised every few
 * years. The tax table is fixed by law and lives here.
 *
 * Verify the values against the current SSS, PhilHealth, Pag-IBIG and BIR
 * circulars before relying on them.
 */

/** Pay periods starting on or after this date use the rules above. */
export const LEGAL_RULES_EFFECTIVE = "2026-10-01";

/** True when the period (by its first day, "YYYY-MM-DD") uses the legal rules. */
export function usesLegalRules(periodStart) {
  return String(periodStart || "") >= LEGAL_RULES_EFFECTIVE;
}

/**
 * BIR withholding tax table, semi-monthly (RR 11-2018 Annex E, 2023 onward):
 * over `over`, tax = `base` + `rate` × (taxable − `over`).
 */
export const SEMI_MONTHLY_TAX_TABLE = Object.freeze([
  Object.freeze({ over: 0, base: 0, rate: 0 }),
  Object.freeze({ over: 10417, base: 0, rate: 0.15 }),
  Object.freeze({ over: 16667, base: 937.5, rate: 0.2 }),
  Object.freeze({ over: 33333, base: 4270.7, rate: 0.25 }),
  Object.freeze({ over: 83333, base: 16770.7, rate: 0.3 }),
  Object.freeze({ over: 333333, base: 91770.7, rate: 0.35 }),
]);

const PAGIBIG_LOW_SALARY = 1500;
const PAGIBIG_LOW_PCT = 1;

function peso(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

const num = (rates, key) => Number(rates?.[key]?.value ?? rates?.[key] ?? 0) || 0;

/** The SSS monthly salary credit for a monthly salary. */
export function sssMonthlySalaryCredit(monthlySalary, rates) {
  const salary = Math.max(0, Number(monthlySalary) || 0);
  const min = num(rates, "sss_msc_min");
  const max = num(rates, "sss_msc_max");
  const bracket = Math.floor((salary + 250) / 500) * 500;
  return Math.min(Math.max(bracket, min), max || bracket);
}

/**
 * The employee's MONTHLY share of each contribution.
 *
 * @param {number} monthlySalary  the employee's monthly basic salary
 * @param {object} rates          rateValues() / resolveRates() output
 */
export function monthlyContributions(monthlySalary, rates) {
  const salary = Math.max(0, Number(monthlySalary) || 0);
  if (!salary) return { sss: 0, philhealth: 0, pagibig: 0, sss_msc: 0 };

  const msc = sssMonthlySalaryCredit(salary, rates);
  const sss = peso(msc * num(rates, "sss_pct") / 100);

  const floor = num(rates, "philhealth_floor");
  const ceiling = num(rates, "philhealth_ceiling");
  const philhealthBase = Math.min(Math.max(salary, floor), ceiling || salary);
  const philhealth = peso(philhealthBase * num(rates, "philhealth_pct") / 100);

  const maxFund = num(rates, "pagibig_max_salary");
  const pagibigPct = salary <= PAGIBIG_LOW_SALARY ? Math.min(PAGIBIG_LOW_PCT, num(rates, "pagibig_pct")) : num(rates, "pagibig_pct");
  const pagibig = peso(Math.min(salary, maxFund || salary) * pagibigPct / 100);

  return { sss, philhealth, pagibig, sss_msc: msc };
}

/** Half of each monthly share: what one semi-monthly payslip deducts. */
export function periodContributions(monthlySalary, rates) {
  const monthly = monthlyContributions(monthlySalary, rates);
  return {
    sss: peso(monthly.sss / 2),
    philhealth: peso(monthly.philhealth / 2),
    pagibig: peso(monthly.pagibig / 2),
    sss_msc: monthly.sss_msc,
  };
}

/** Withholding tax on one semi-monthly period's taxable compensation. */
export function withholdingTax(taxable, table = SEMI_MONTHLY_TAX_TABLE) {
  const amount = Math.max(0, Number(taxable) || 0);
  let bracket = table[0];
  for (const row of table) {
    if (amount > row.over) bracket = row;
  }
  return peso(bracket.base + (amount - bracket.over) * bracket.rate);
}

/**
 * Taxable compensation for one period: what the employee earned (basic plus
 * overtime and holiday pay) less attendance and Leave Without Pay deductions
 * and less their own SSS, PhilHealth and Pag-IBIG. Never below zero.
 * Early Bird / Perfect Attendance incentives are left out: they fall within
 * the ₱90,000 tax-exempt "other benefits" ceiling.
 */
export function taxableCompensation({ basic = 0, earnings = 0, attendanceDeductions = 0, contributions = 0 }) {
  return Math.max(0, peso(Number(basic) + Number(earnings) - Number(attendanceDeductions) - Number(contributions)));
}
