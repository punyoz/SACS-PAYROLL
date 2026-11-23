/**
 * Employee category, employment status and employment type (Part A,
 * 20261121010000): the values in effect on a date, leave credits per
 * classification, and the pay rules per classification. Pure functions
 * (client-safe); the loaders are in classification-server.js.
 */

export const CATEGORY_OPTIONS = ["Teaching", "Non-Teaching"];
export const EMPLOYMENT_STATUS_OPTIONS = ["Regular", "Probationary", "Contractual"];
// The school has no part-time employees (2026-11-23): everyone is Full-time; the field is not shown.
export const EMPLOYMENT_TYPE_OPTIONS = ["Full-time"];
// Yearly credits. Maternity, paternity and other statutory leaves are filed per
// event (statutory_leave_types), never granted yearly.
export const CREDIT_LEAVE_TYPES = ["Vacation Leave", "Sick Leave", "Emergency Leave"];
// The paid leave that counts toward the 5-day service incentive leave (Labor Code Art. 95).
export const SIL_LEAVE_TYPES = ["Vacation Leave", "Sick Leave", "Emergency Leave"];
export const SIL_MIN_DAYS = 5;
export const PAY_BASIS_LABELS = { monthly: "Monthly salary" };
/** HR settings (system_config, section "hr"), pending the policy manual. */
export const HR_SETTINGS = {
  probation_months: { label: "Probation length (months)", min: 1, max: 24, fallback: 6 },
  probation_reminder_days: { label: "Remind HR before probation ends (days)", min: 1, max: 120, fallback: 30 },
  contract_reminder_days: { label: "Remind HR before a contract ends (days)", min: 1, max: 120, fallback: 30 },
};

export const CLASSIFICATION_FIELDS = ["employee_type", "employment_status", "on_payroll", "contract_end_date"];
/** Refusal for an edit that changes them silently: they change with a date and a reason. */
export const CHANGE_WITH_DATE = 'Category and employment status change with an effective date and a reason: use "Change status".';

/** The classification fields `next` changes compared with `current` (blank values ignored). */
export function changedClassification(current = {}, next = {}) {
  return ["employee_type", "employment_status"].filter((f) => next[f] && current[f] && String(next[f]) !== String(current[f]));
}

export const FIELD_LABELS = {
  employee_type: "Category",
  employment_status: "Employment status",
  employment_type: "Employment type",
  on_payroll: "On payroll",
  contract_end_date: "Contract end date",
};

const DAY = 864e5;
const dayNumber = (key) => Math.round(Date.parse(`${key}T00:00:00Z`) / DAY);
const keyOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);

/** "Teaching · Regular" (blank parts left out). */
export function classificationLabel(c = {}) {
  return [c.employee_type, c.employment_status].filter(Boolean).join(" · ");
}

/**
 * The value of each field in effect on `dateKey`. `current` is the profile
 * now; `changes` the employee's classification changes (cancelled ones are
 * ignored). On a date before the first change of a field, the value is that
 * change's old value; after the last one, its new value; with no change, the
 * current value.
 */
export function classificationOn(current = {}, changes = [], dateKey) {
  const out = {};
  for (const field of CLASSIFICATION_FIELDS) {
    const rows = changes.filter((c) => c.field === field && !c.cancelled_at)
      .sort((a, b) => String(a.effective_on).localeCompare(String(b.effective_on)) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
    const before = rows.filter((c) => String(c.effective_on) <= dateKey);
    let value;
    if (before.length) value = before[before.length - 1].new_value;
    else if (rows.length) value = rows[0].old_value;
    else value = current[field];
    out[field] = field === "on_payroll" ? value !== false && value !== "false" : (value ?? null);
  }
  return out;
}

/** Dates (inclusive ranges) between `from` and `to` where the classification stays the same. */
export function classificationSegments(current, changes, from, to) {
  const cuts = [...new Set(changes.filter((c) => !c.cancelled_at && c.effective_on > from && c.effective_on <= to).map((c) => String(c.effective_on)))].sort();
  const starts = [from, ...cuts];
  return starts.map((start, i) => ({
    from: start,
    to: i + 1 < starts.length ? keyOf(dayNumber(starts[i + 1]) - 1) : to,
    classification: classificationOn(current, changes, start),
  }));
}

/** The rule row in effect on `dateKey` for a leave type and classification, or null. */
export function leaveRuleFor(rules, leaveType, c, dateKey) {
  return (rules || [])
    // Category × Status: only the Full-time rows count (no part-time employees, 2026-11-23).
    .filter((r) => r.leave_type === leaveType && r.employee_type === c.employee_type && r.employment_status === c.employment_status
      && (r.employment_type || "Full-time") === "Full-time" && String(r.effective_from) <= dateKey)
    .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0] || null;
}

/** The pay rule in effect on `dateKey` for a classification, or null. */
export function payRuleFor(rules, c, dateKey) {
  return (rules || [])
    .filter((r) => r.employee_type === c.employee_type && r.employment_status === c.employment_status
      && (r.employment_type || "Full-time") === "Full-time" && String(r.effective_from) <= dateKey)
    .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0] || null;
}

const halfDown = (n) => Math.floor(n * 2 + 1e-9) / 2;

/**
 * Leave credits for one employee and year, per leave type.
 *
 * The year is cut where the classification changes (and starts on the hire
 * date): each part earns its rule's days × (days in the part / days in the
 * year).
 * Rounded down to the half day. A per-employee override for the year (the
 * latest one) replaces the computed days. The grant is automatic: nothing is
 * stored, the credits follow the rules and the history.
 *
 * @returns {{ [leaveType]: { days, computed, override: object|null, parts: object[] } }}
 */
export function leaveEntitlement({ rules, overrides = [], current, changes = [], year, dateHired = null, separatedOn = null }) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const yearDays = dayNumber(yearEnd) - dayNumber(yearStart) + 1;
  const from = dateHired && dateHired > yearStart ? dateHired : yearStart;
  const to = separatedOn && separatedOn < yearEnd ? separatedOn : yearEnd;
  const parts = from > to ? [] : classificationSegments(current, changes, from, to);
  const out = {};
  for (const leaveType of CREDIT_LEAVE_TYPES) {
    let total = 0;
    const lines = parts.map((part) => {
      // A record with no status / type on file earns the defaults the app shows
      // (Teaching, Regular, Full-time) rather than nothing.
      const c = {
        employee_type: part.classification.employee_type || "Teaching",
        employment_status: part.classification.employment_status || "Regular",
        employment_type: part.classification.employment_type || "Full-time",
      };
      const rule = leaveRuleFor(rules, leaveType, c, part.from);
      const days = dayNumber(part.to) - dayNumber(part.from) + 1;
      const hoursFactor = 1; // no part-time pro-ration (2026-11-23)
      const earned = (Number(rule?.days_per_year) || 0) * (days / yearDays) * hoursFactor;
      total += earned;
      return { from: part.from, to: part.to, classification: part.classification, rule_days: Number(rule?.days_per_year) || 0, hours_factor: hoursFactor, earned };
    });
    const computed = halfDown(total);
    const override = overrides.filter((o) => o.leave_type === leaveType && Number(o.year) === Number(year))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    out[leaveType] = { days: override ? Number(override.days) : computed, computed, override, parts: lines };
  }
  return out;
}

/**
 * Classifications whose paid leave (vacation + sick + emergency) adds up to
 * less than the 5-day service incentive leave (Labor Code Art. 95), from the
 * rules in effect on `dateKey`.
 */
export function legalMinimumWarnings(rules, dateKey) {
  const out = [];
  for (const employee_type of CATEGORY_OPTIONS) {
    for (const employment_status of EMPLOYMENT_STATUS_OPTIONS) {
      for (const employment_type of EMPLOYMENT_TYPE_OPTIONS) {
        const c = { employee_type, employment_status, employment_type };
        const total = SIL_LEAVE_TYPES.reduce((sum, t) => sum + (Number(leaveRuleFor(rules, t, c, dateKey)?.days_per_year) || 0), 0);
        if (total < SIL_MIN_DAYS) out.push({ ...c, total });
      }
    }
  }
  return out;
}

/** Plain-word refusal when a classification's pay rule does not allow `what`, else null. */
export function eligibilityError(rule, what, c) {
  const key = { loan: "loan_eligible", incentive: "incentive_eligible", subsidy: "subsidy_eligible", overtime: "overtime_allowed" }[what];
  if (!rule || !key || rule[key] !== false) return null;
  const noun = { loan: "loans", incentive: "incentives", subsidy: "subsidies", overtime: "overtime" }[what];
  return `${classificationLabel(c)} employees are not eligible for ${noun} (pay rules).`;
}

/**
 * Why `person` cannot file a statutory leave, or null. `type` is a
 * statutory_leave_types row; `days` the calendar days asked; `priorEvents` how
 * many of this leave the person already has (approved or pending).
 */
export function statutoryRefusal(type, person = {}, { days, priorEvents = 0 } = {}) {
  if (!type?.enabled) return `${type?.leave_type || "This leave"} is not offered by the school yet.`;
  const sex = String(person.sex || "").toLowerCase();
  const married = String(person.civil_status || "").toLowerCase() === "married";
  if (type.eligibility === "female" && sex !== "female") return `${type.leave_type} is for female employees.`;
  if (type.eligibility === "married_male" && !(sex === "male" && married)) return `${type.leave_type} is for married male employees.`;
  if (type.max_events && priorEvents >= type.max_events) {
    return `${type.leave_type} is granted for the first ${type.max_events} times only; this would be time ${priorEvents + 1}.`;
  }
  if (Number(days) > Number(type.days)) return `${type.leave_type} is at most ${Number(type.days)} days.`;
  return null;
}
