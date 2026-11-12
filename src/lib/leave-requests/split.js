/**
 * Leave over the yearly balance (decision 2026-11-12): never blocked. The
 * first days, up to the paid days remaining, are WITH pay; the days after
 * them are WITHOUT pay (deducted at the daily rate). Days are counted as the
 * balance counts them: every calendar day from start to end. Client-safe (the
 * filing and approval screens show the same split the server applies).
 */

/** Inclusive day count between two YYYY-MM-DD dates (0 when invalid). */
export function countLeaveDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

export function addDaysKey(key, days) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * { with_pay_days, without_pay_days, with_pay_end, without_pay_start } for a
 * request and the paid days remaining. A without-pay request is all without pay.
 */
export function splitForBalance({ start_date: start, end_date: end, pay_status: pay }, remaining) {
  const days = countLeaveDays(start, end || start);
  if (pay === "without_pay") return { with_pay_days: 0, without_pay_days: days, with_pay_end: null, without_pay_start: days ? start : null };
  const paid = Math.max(0, Math.min(days, Math.floor(Number(remaining) || 0)));
  return {
    with_pay_days: paid,
    without_pay_days: days - paid,
    with_pay_end: paid ? addDaysKey(start, paid - 1) : null,
    without_pay_start: days - paid ? addDaysKey(start, paid) : null,
  };
}

/** "3 days with pay, 2 days without pay" (or just one part). */
export function describeSplit(split) {
  const day = (n) => `${n} day${n === 1 ? "" : "s"}`;
  return [split.with_pay_days ? `${day(split.with_pay_days)} with pay` : null, split.without_pay_days ? `${day(split.without_pay_days)} without pay` : null]
    .filter(Boolean).join(", ");
}
