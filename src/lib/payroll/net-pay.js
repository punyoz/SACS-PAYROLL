/**
 * Net pay floor.
 *
 * Net pay is gross minus deductions, and nothing stopped that going negative:
 * enough absences, or a Leave Without Pay stretch, could push total deductions
 * past the basic salary and produce a payslip reading "-₱1,250.00". A negative
 * net pay is not a payment — the employee is owed nothing, not asked to pay the
 * school — so it is floored at zero.
 *
 * Applied in two places so it holds for every path:
 *
 *   - where the figure is computed (the accountant's payroll route), so nothing
 *     negative is ever stored in the first place;
 *   - where a stored figure is read back (payroll entries, payroll records and
 *     the employee's own payslips), so rows written before this rule existed
 *     also display as 0.00 rather than negative.
 *
 * NOTE ON THE PAYSLIP ARITHMETIC
 * `total_deductions` is deliberately left truthful. When the floor bites, a
 * payslip therefore shows gross − deductions ≠ net (say 8,000 − 9,250 → 0.00).
 * That is the intended reading: the deductions genuinely were 9,250, and the
 * 1,250 shortfall is a real fact someone needs to see. Capping the deductions
 * instead would balance the arithmetic by hiding it. If the shortfall should
 * carry into the next period, that is a payroll policy decision and needs its
 * own field — it is not implemented here.
 */

/** Round to centavos, treating anything non-numeric as zero. */
export function toPesoAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

/**
 * Round to centavos and clamp at zero.
 *
 * @param {unknown} value
 * @returns {number} 0 or greater, never negative and never -0.
 */
export function floorNetPay(value) {
  const amount = toPesoAmount(value);
  return amount > 0 ? amount : 0;
}
