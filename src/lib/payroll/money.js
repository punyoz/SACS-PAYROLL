/**
 * Peso rounding shared by every payroll calculation.
 *
 * Four modules each carried their own `Math.round(amount * 100) / 100`. That
 * rounds in binary floating point, where many two-decimal-place halves are
 * stored a hair below the half: 1.005 * 100 is 100.49999999999999, so 1.005
 * rounded to 1.00 instead of 1.01, and 0.285 to 0.28. The error is at most a
 * centavo per line, but it landed on payslips and statutory contributions.
 *
 * roundPeso() first trims the multiplication back to 15 significant digits
 * (the precision a double actually carries), which restores the decimal half
 * that was typed, and only then rounds -- half away from zero, the way the
 * amounts are rounded by hand. Amounts are still JavaScript numbers; the
 * database stores them as NUMERIC.
 */

/**
 * @param {unknown} value
 * @returns {number} rounded to centavos; 0 for anything non-numeric; never -0.
 */
export function roundPeso(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount === 0) return 0;

  const sign = amount < 0 ? -1 : 1;
  const cents = Math.round(Number((Math.abs(amount) * 100).toPrecision(15)));
  const result = (sign * cents) / 100;
  return result === 0 ? 0 : result;
}
