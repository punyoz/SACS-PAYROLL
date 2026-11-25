/**
 * Negative pay items on a per-cutoff payslip (2026-11-25). An approved Additional Pay item with a
 * negative amount (a take-back, an "Adjustment" below zero) is counted in the payslip's net pay; the
 * line list must show it too, or the payslip does not add up (Gross − Total deductions ≠ Net).
 * It is listed as a deduction of its own, and "Incentives" keeps the positive part.
 */

const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {object} payroll   the payslip being built (audit.lines.incentives: its incentive lines)
 * @param {number} otherIncentive  totals.other_incentive (net of positive and negative items)
 * @returns {{ incentives: number, deductions: Array<{ label: string, amount: number, note: string|null }> }}
 */
export function splitNegativeIncentives(payroll, otherIncentive) {
  const lines = payroll?.audit?.lines?.incentives || payroll?.lines?.incentives || [];
  const negatives = lines.filter((l) => l.type === "incentive" && cents(l.amount) < 0);
  const negativeTotal = cents(negatives.reduce((s, l) => s + cents(l.amount), 0));
  return {
    incentives: cents(cents(otherIncentive) - negativeTotal),
    deductions: negatives.map((l) => {
      const text = String(l.note || "").replace(/^Adjustment:\s*/, "");
      const [label, ...rest] = text.split(". ");
      return { label: label || "Adjustment", amount: cents(-cents(l.amount)), note: rest.join(". ") || null };
    }),
  };
}
