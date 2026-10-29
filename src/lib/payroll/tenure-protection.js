/**
 * Tenure Pay Protection (supabase/migrations/20261015010000_tenure_pay_protection.sql).
 *
 * Some employees with long service have a contract clause: their pay is not
 * deducted for absence, lateness, holiday work, suspensions, summer break or
 * Christmas break. Payroll honours it only when ALL of these hold for the day:
 *
 *   1. the policy that applies to the employee's branch is active
 *      (a branch's own policy, or the system-wide one);
 *   2. HR (or an Admin / Super Admin) has GRANTED it to that employee and the
 *      grant is in force on the day (effective_from <= day < revoked_on) --
 *      tenure alone never applies it, since it rests on a signed contract;
 *   3. the employee has the policy's minimum tenure on that day
 *      (date_hired + min_tenure_years);
 *   4. the policy covers the day's category.
 *
 * The day's category is decided by the day first, then by the deduction:
 *
 *   inside a summer / Christmas break period   summer_break / christmas_break
 *   a holiday or special day                   holiday
 *   a (whole-day or partial) suspension        suspension
 *   any other day: Absent, Half Day            absence
 *                  Late                        late
 *
 * A day inside a break (or on a holiday / suspension) is judged ONLY by that
 * day's category: an employee whose policy leaves "summer break" unchecked
 * stays unpaid in summer even when "absence" is covered. Undertime on an
 * ordinary day is not a covered category.
 *
 * Without protection nothing changes: the same Absent, Late, Half Day and
 * Undertime deductions as before (summer and Christmas break days the nightly
 * close marks Absent stay unpaid).
 */

export const PROTECTION_CATEGORIES = [
  { key: "absence", label: "Absence", column: "cover_absence" },
  { key: "late", label: "Late", column: "cover_late" },
  { key: "holiday", label: "Holiday", column: "cover_holiday" },
  { key: "suspension", label: "Suspension", column: "cover_suspension" },
  { key: "summer_break", label: "Summer break", column: "cover_summer_break" },
  { key: "christmas_break", label: "Christmas break", column: "cover_christmas_break" },
];
export const BREAK_KINDS = [
  { key: "summer", label: "Summer break", category: "summer_break" },
  { key: "christmas", label: "Christmas break", category: "christmas_break" },
];
export const DEFAULT_MIN_TENURE_YEARS = 2;
export const MAX_BREAK_DAYS = 120;

const isDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const keyOf = (value) => String(value || "").slice(0, 10);

/**
 * "2024-06-01" + 24 months -> "2026-06-01". Clamped to the month's last day
 * like Postgres' date + interval: Feb 29, 2024 + 12 months -> Feb 28, 2025.
 */
export function addMonths(dateKey, months) {
  const [y, m, d] = keyOf(dateKey).split("-").map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function daysBetween(fromKey, toKey) {
  return Math.round((Date.parse(`${keyOf(toKey)}T00:00:00Z`) - Date.parse(`${keyOf(fromKey)}T00:00:00Z`)) / 86400000);
}

/** The minimum tenure in whole months (1.5 years -> 18). */
function tenureMonths(minYears) {
  return Math.max(0, Math.round((Number(minYears) || 0) * 12));
}

/** The first day the employee has the minimum tenure, or null without a hire date. */
export function eligibleFrom(dateHired, minYears) {
  if (!isDateKey(keyOf(dateHired))) return null;
  return addMonths(dateHired, tenureMonths(minYears));
}

/** True when the employee has at least `minYears` of service on `dateKey`. */
export function meetsTenure(dateHired, dateKey, minYears) {
  const from = eligibleFrom(dateHired, minYears);
  return Boolean(from) && from <= keyOf(dateKey);
}

/** Completed years of service on dateKey, one decimal (2y 6m -> 2.5); null without a hire date. */
export function tenureYears(dateHired, dateKey) {
  const hired = keyOf(dateHired);
  const on = keyOf(dateKey);
  if (!isDateKey(hired) || !isDateKey(on) || on < hired) return isDateKey(hired) ? 0 : null;
  const [hy, hm, hd] = hired.split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  const months = (y - hy) * 12 + (m - hm) - (d < hd ? 1 : 0);
  return Math.floor(Math.max(0, months) / 12 * 10) / 10;
}

/**
 * The school year a date belongs to (Philippine school year from June):
 * "2026-10-14" -> "2026-2027", "2027-04-20" -> "2026-2027".
 */
export function schoolYearOf(dateKey) {
  const [y, m] = keyOf(dateKey).split("-").map(Number);
  const start = m >= 6 ? y : y - 1;
  return `${start}-${start + 1}`;
}

/** "2026-2027" -> { start_key: "2026-06-01", end_key: "2027-07-31" }: where its breaks may fall. */
export function schoolYearSpan(schoolYear) {
  const match = /^(\d{4})-(\d{4})$/.exec(String(schoolYear || ""));
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  return { start_key: `${match[1]}-06-01`, end_key: `${match[2]}-07-31` };
}

/** The previous, current and next school years around dateKey. */
export function schoolYearOptions(dateKey) {
  const start = Number(schoolYearOf(dateKey).slice(0, 4));
  return [start - 1, start, start + 1].map((y) => `${y}-${y + 1}`);
}

/** A policy row as payroll uses it. */
export function shapePolicy(row) {
  const categories = {};
  PROTECTION_CATEGORIES.forEach((c) => { categories[c.key] = row ? row[c.column] !== false : true; });
  return {
    id: row?.id || null,
    branch_id: row?.branch_id || null,
    use_global: row?.branch_id ? row.use_global === true : false,
    min_tenure_years: row && row.min_tenure_years !== null && row.min_tenure_years !== undefined
      ? Number(row.min_tenure_years)
      : DEFAULT_MIN_TENURE_YEARS,
    categories,
    is_active: row ? row.is_active !== false : true,
    updated_by_name: row?.updated_by_name || null,
    updated_by_role: row?.updated_by_role || null,
    updated_at: row?.updated_at || null,
  };
}

/**
 * The policy in force for a branch: the branch's own (unless it follows the
 * system-wide one), else the system-wide row, else the defaults.
 */
export function policyFor(policies, branchId) {
  const rows = policies || [];
  const own = branchId ? rows.find((row) => row.branch_id && String(row.branch_id) === String(branchId)) : null;
  if (own && own.use_global !== true) return { ...shapePolicy(own), source: "branch" };
  const global = rows.find((row) => !row.branch_id) || null;
  return { ...shapePolicy(global), source: global ? "system" : "default" };
}

/** Validates a policy from the settings screen. */
export function validatePolicyInput(body = {}) {
  const years = Number(body.min_tenure_years);
  if (body.min_tenure_years === "" || body.min_tenure_years === null || !Number.isFinite(years) || years < 0 || years > 50) {
    return { error: "Minimum tenure must be between 0 and 50 years." };
  }
  const categories = body.categories && typeof body.categories === "object" ? body.categories : {};
  // Counted in whole months (2.5 years = 30 months); stored to 2 decimals.
  const value = { min_tenure_years: Math.round(years * 100) / 100, is_active: body.is_active !== false };
  PROTECTION_CATEGORIES.forEach((c) => { value[c.column] = categories[c.key] === true; });
  return { value };
}

/** Validates a break period for a school year. */
export function validateBreakInput(body = {}) {
  const schoolYear = String(body.school_year || "").trim();
  const span = schoolYearSpan(schoolYear);
  if (!span) return { error: "Choose the school year (e.g. 2026-2027)." };
  const kind = String(body.kind || "").trim();
  if (!BREAK_KINDS.some((k) => k.key === kind)) return { error: "Choose summer break or Christmas break." };
  const start = keyOf(body.start_date);
  const end = keyOf(body.end_date);
  if (!isDateKey(start) || !isDateKey(end)) return { error: "Choose the first and last day of the break." };
  if (end < start) return { error: "The last day of the break cannot be before its first day." };
  if (daysBetween(start, end) + 1 > MAX_BREAK_DAYS) return { error: `A break can be at most ${MAX_BREAK_DAYS} days long.` };
  if (start < span.start_key || end > span.end_key) {
    return { error: `School year ${schoolYear} breaks must fall between ${span.start_key} and ${span.end_key}.` };
  }
  return { value: { school_year: schoolYear, kind, start_date: start, end_date: end, note: String(body.note || "").trim().slice(0, 500) || null } };
}

/** "summer" | "christmas" | null: the break period dateKey falls in (archived ones ignored). */
export function breakKindOn(breaks, dateKey) {
  const key = keyOf(dateKey);
  const hit = (breaks || []).find((row) => row.archived !== true
    && keyOf(row.start_date) <= key && key <= keyOf(row.end_date));
  return hit ? hit.kind : null;
}

/** True when two break rows share a day. */
export function breaksOverlap(a, b) {
  return keyOf(a.start_date) <= keyOf(b.end_date) && keyOf(b.start_date) <= keyOf(a.end_date);
}

/** The employee's grant in force on dateKey: effective_from <= day < revoked_on. */
export function grantOn(grants, employeeId, dateKey) {
  const key = keyOf(dateKey);
  return (grants || []).find((row) => String(row.employee_id) === String(employeeId)
    && keyOf(row.effective_from) <= key
    && (!row.revoked_on || key < keyOf(row.revoked_on))) || null;
}

/** The open (not revoked) grant of an employee: in force now, or starting later. */
export function openGrant(grants, employeeId) {
  return (grants || []).find((row) => String(row.employee_id) === String(employeeId) && !row.revoked_on) || null;
}

/** The deduction-type category of an ordinary day. */
const TYPE_CATEGORY = { absent: "absence", half_day: "absence", late: "late" };

/**
 * The category a deduction on dateKey falls under (see the header).
 * @param {object} day   { breakKind, holidayType } for the date
 * @param {string} type  "absent" | "half_day" | "late" | "undertime"
 */
export function categoryFor(day, type) {
  if (day?.breakKind) return BREAK_KINDS.find((k) => k.key === day.breakKind)?.category || null;
  if (day?.holidayType === "suspension") return "suspension";
  if (day?.holidayType === "holiday" || day?.holidayType === "special") return "holiday";
  return TYPE_CATEGORY[type] || null;
}

/**
 * Payroll's question for one employee: is this deduction waived?
 *
 * @param {object} args
 * @param {object} args.employee   { id, branch_id, date_hired }
 * @param {Array}  args.policies   tenure_protection_policies rows
 * @param {Array}  args.grants     tenure_protection_grants rows
 * @param {Array}  args.breaks     school_break_periods rows
 * @param {(dateKey: string) => string|null} [args.holidayTypeOn]
 *                                 "holiday" | "special" | "suspension" | null
 * @returns {null | ((dateKey: string, type: string) => null | {
 *   grant_id: string, category: string, policy_source: string, min_tenure_years: number }
 * )}  null when the employee can never be protected (no grant at all).
 */
export function buildProtection({ employee, policies, grants, breaks, holidayTypeOn }) {
  const own = (grants || []).filter((row) => String(row.employee_id) === String(employee?.id));
  if (!employee?.id || !own.length) return null;
  const policy = policyFor(policies, employee.branch_id);
  if (!policy.is_active) return null;

  return (dateKey, type) => {
    const key = keyOf(dateKey);
    const grant = grantOn(own, employee.id, key);
    if (!grant) return null;
    if (!meetsTenure(employee.date_hired, key, policy.min_tenure_years)) return null;
    const category = categoryFor({ breakKind: breakKindOn(breaks, key), holidayType: holidayTypeOn?.(key) || null }, type);
    if (!category || !policy.categories[category]) return null;
    return { grant_id: grant.id, category, policy_source: policy.source, min_tenure_years: policy.min_tenure_years };
  };
}
