/**
 * Government contributions and withholding tax (Philippines).
 *
 * From LEGAL_RULES_EFFECTIVE on, payroll computes the employee's share of
 * each contribution from the legal base instead of a flat % of the half-month
 * basic, and withholds income tax from the BIR table:
 *
 *   SSS         sss_pct (5) % of the monthly salary credit (MSC): the bracket
 *               of the SSS salary credit table the salary falls in
 *               (payroll_sss_msc_brackets, src/lib/payroll/sss-msc.js). Without
 *               a saved table, the salary rounded to the nearest ₱500
 *               (₱5,250–5,749.99 → ₱5,500) within sss_msc_min–max
 *               (₱5,000–₱35,000), the same credits.
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
import { roundPeso } from "@/lib/payroll/money";

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
  return roundPeso(value);
}

const num = (rates, key) => Number(rates?.[key]?.value ?? rates?.[key] ?? 0) || 0;

/**
 * The SSS monthly salary credit for a monthly salary. With an MSC table
 * (public.payroll_sss_msc_brackets, src/lib/payroll/sss-msc.js) the credit is
 * the bracket the salary falls in; without one (table not set up yet) the
 * salary rounded to the nearest ₱500 within sss_msc_min–max, which gives the
 * same result as the 2025 SSS schedule.
 */
export function sssMonthlySalaryCredit(monthlySalary, rates, mscTable = null) {
  const salary = Math.max(0, Number(monthlySalary) || 0);
  if (Array.isArray(mscTable) && mscTable.length) {
    let msc = mscTable[0].msc;
    mscTable.forEach((row) => { if (salary >= row.from) msc = row.msc; });
    return msc;
  }
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
export function monthlyContributions(monthlySalary, rates, { mscTable = null } = {}) {
  const salary = Math.max(0, Number(monthlySalary) || 0);
  if (!salary) return { sss: 0, philhealth: 0, pagibig: 0, sss_msc: 0, basis: null };

  const msc = sssMonthlySalaryCredit(salary, rates, mscTable);
  const sssPct = num(rates, "sss_pct");
  const sss = peso(msc * sssPct / 100);

  const floor = num(rates, "philhealth_floor");
  const ceiling = num(rates, "philhealth_ceiling");
  const philhealthBase = Math.min(Math.max(salary, floor), ceiling || salary);
  const philhealthPct = num(rates, "philhealth_pct");
  const philhealth = peso(philhealthBase * philhealthPct / 100);

  const maxFund = num(rates, "pagibig_max_salary");
  const pagibigPct = salary <= PAGIBIG_LOW_SALARY ? Math.min(PAGIBIG_LOW_PCT, num(rates, "pagibig_pct")) : num(rates, "pagibig_pct");
  const pagibigBase = Math.min(salary, maxFund || salary);
  const pagibig = peso(pagibigBase * pagibigPct / 100);

  // The rate and the base each share was taken from, for the payslip
  // ("SSS (5% of ₱18,000 salary credit)").
  const basis = {
    sss: { pct: sssPct, base: msc, base_label: "salary credit" },
    philhealth: { pct: philhealthPct, base: peso(philhealthBase), base_label: philhealthBase > salary ? "floor" : philhealthBase < salary ? "ceiling" : "basic" },
    pagibig: { pct: pagibigPct, base: peso(pagibigBase), base_label: pagibigBase < salary ? "fund salary cap" : "basic" },
  };
  return { sss, philhealth, pagibig, sss_msc: msc, basis };
}

/**
 * The EMPLOYER's monthly share of each contribution (2026-10-26): the
 * school's own cost on top of the employee's pay. It is never deducted from
 * the employee, never part of gross, taxable income or net pay, and never on
 * the employee's payslip; the remittance report adds it to the employee
 * share for what the school pays each agency.
 *
 *   SSS         sss_er_pct (10) % of the same salary credit, plus EC
 *               (Employees' Compensation, employer only): sss_ec_low (₱10)
 *               below sss_ec_threshold (₱15,000) of salary credit, else
 *               sss_ec_high (₱30)
 *   PhilHealth  philhealth_er_pct (2.5) % of the same base as the employee's
 *   Pag-IBIG    pagibig_er_pct (2) % of the salary up to the maximum fund
 *               salary (the employer's 2% has no low-salary reduction)
 *
 * Withholding tax has no employer share: the school only remits what it
 * withheld.
 */
export function employerContributions(monthlySalary, rates, { mscTable = null } = {}) {
  const salary = Math.max(0, Number(monthlySalary) || 0);
  if (!salary) return { sss: 0, sss_ec: 0, philhealth: 0, pagibig: 0, total: 0 };

  const msc = sssMonthlySalaryCredit(salary, rates, mscTable);
  const sss = peso(msc * num(rates, "sss_er_pct") / 100);
  const sssEc = peso(msc >= num(rates, "sss_ec_threshold") ? num(rates, "sss_ec_high") : num(rates, "sss_ec_low"));

  const floor = num(rates, "philhealth_floor");
  const ceiling = num(rates, "philhealth_ceiling");
  const philhealthBase = Math.min(Math.max(salary, floor), ceiling || salary);
  const philhealth = peso(philhealthBase * num(rates, "philhealth_er_pct") / 100);

  const maxFund = num(rates, "pagibig_max_salary");
  const pagibig = peso(Math.min(salary, maxFund || salary) * num(rates, "pagibig_er_pct") / 100);

  return { sss, sss_ec: sssEc, philhealth, pagibig, total: peso(sss + sssEc + philhealth + pagibig), sss_msc: msc };
}

/** Half of each monthly share: what one semi-monthly payslip deducts. */
export function periodContributions(monthlySalary, rates, options = {}) {
  const monthly = monthlyContributions(monthlySalary, rates, options);
  return {
    sss: peso(monthly.sss / 2),
    philhealth: peso(monthly.philhealth / 2),
    pagibig: peso(monthly.pagibig / 2),
    sss_msc: monthly.sss_msc,
  };
}

const formatBase = (value) => {
  const amount = Number(value) || 0;
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `₱${amount.toLocaleString("en-PH", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

/**
 * A contribution's payslip label with its rate and base, e.g.
 * "SSS (5% of ₱18,000 salary credit)". Just the name when the payslip has no
 * basis (a fixed amount, one set for the employee, or a payslip from before).
 */
export function contributionLabel(name, basis) {
  if (!basis || !Number.isFinite(Number(basis.pct))) return name;
  const base = basis.base_label ? ` ${basis.base_label}` : "";
  return `${name} (${Number(basis.pct)}% of ${formatBase(basis.base)}${base})`;
}

/**
 * The withholding tax label with its bracket, e.g. "Withholding tax (15% over
 * ₱20,833)"; "(exempt)" in the lowest bracket. Just the name without one.
 */
export function withholdingTaxLabel(name, bracket) {
  if (!bracket || !Number.isFinite(Number(bracket.rate_pct))) return name;
  if (!(Number(bracket.rate_pct) > 0)) return `${name} (exempt bracket)`;
  const base = Number(bracket.base) > 0 ? `${formatBase(bracket.base)} + ` : "";
  return `${name} (${base}${Number(bracket.rate_pct)}% over ${formatBase(bracket.over)})`;
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
