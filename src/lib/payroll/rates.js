/**
 * Effective-dated payroll rates (public.payroll_rate_configs).
 *
 * A rate is never overwritten: every change is a new row with the date it
 * takes effect. Payroll uses the version in force on the pay period's FIRST
 * day, never the live value, so changing a rate mid-period changes nothing
 * until the next period, and past payslips never move:
 *
 *   SELECT value FROM payroll_rate_configs
 *   WHERE rate_type = X AND effective_date <= period_start
 *   ORDER BY effective_date DESC, created_at DESC LIMIT 1
 *
 * Scopes, most specific first: employee, position, branch, global. The first
 * scope with a version in force wins.
 */

export const RATE_TYPES = Object.freeze({
  hourly: { label: "Hourly rate", unit: "peso", hint: "Undertime: minutes ÷ 60 × this rate" },
  daily: { label: "Daily rate", unit: "peso", hint: "Absent, Late (as absences), Half Day and Leave Without Pay are a share of this. Can differ per branch." },
  half_day_pct: { label: "Half Day deduction", unit: "percent", hint: "% of the daily rate deducted for a Half Day" },
  absent_pct: { label: "Absent deduction", unit: "percent", hint: "% of the daily rate deducted for an Absent day" },
  late_days_per_absent: { label: "Late days per absence", unit: "count", hint: "Every N late days in a period are charged as 1 absence (0 = off)" },
  late_minute_charge_pct: { label: "Per-minute late charge", unit: "percent", hint: "% of the hourly rate charged per late minute, on top of the rule above (0 = off)" },
  early_bird_bonus: { label: "Early Bird bonus", unit: "peso", hint: "Added per Early Bird day" },
  perfect_attendance_bonus: { label: "Perfect Attendance bonus", unit: "peso", hint: "Added when a period has no Late, Undertime, Absent or Half Day" },
  sss_pct: { label: "SSS contribution", unit: "percent", hint: "% of the period's basic salary" },
  philhealth_pct: { label: "PhilHealth contribution", unit: "percent", hint: "% of the period's basic salary" },
  pagibig_pct: { label: "Pag-IBIG contribution", unit: "percent", hint: "% of the period's basic salary" },
});

export const RATE_TYPE_KEYS = Object.freeze(Object.keys(RATE_TYPES));

/**
 * Used only when the rate table cannot be read at all (migration not applied
 * yet). Same starting values the migration seeds, which reproduce the rules
 * payroll used before rates were configurable.
 */
export const DEFAULT_RATES = Object.freeze({
  hourly: 68.75,
  daily: 550,
  half_day_pct: 50,
  absent_pct: 100,
  late_days_per_absent: 3,
  late_minute_charge_pct: 0,
  early_bird_bonus: 0,
  perfect_attendance_bonus: 0,
  sss_pct: 2,
  philhealth_pct: 2,
  pagibig_pct: 2,
});

export const RATE_SCOPES = Object.freeze(["employee", "position", "branch", "global"]);

const RATE_COLUMNS = "id,rate_type,scope,scope_ref,value,effective_date,note,created_by,created_by_name,created_at";

function sameRef(a, b) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** Newest version first: later effective date, then later creation. */
function newestFirst(a, b) {
  if (a.effective_date !== b.effective_date) return a.effective_date < b.effective_date ? 1 : -1;
  return String(b.created_at || "").localeCompare(String(a.created_at || ""));
}

/**
 * The version of one rate in force on `periodStart` for one employee.
 *
 * @param {Array} configs      payroll_rate_configs rows
 * @param {string} rateType
 * @param {{ employeeId?: string, branchId?: string|null, position?: string }} who
 * @param {string} periodStart "YYYY-MM-DD"
 * @returns {{ rate_type: string, value: number, config_id: string|null,
 *             effective_date: string|null, scope: string, scope_ref: string|null,
 *             source: "config"|"default" }}
 */
export function resolveRate(configs, rateType, who = {}, periodStart) {
  const refs = {
    employee: who.employeeId,
    position: who.position,
    branch: who.branchId,
    global: null,
  };

  for (const scope of RATE_SCOPES) {
    const ref = refs[scope];
    if (scope !== "global" && !String(ref ?? "").trim()) continue;
    const match = (configs || [])
      .filter((c) => c.rate_type === rateType
        && c.scope === scope
        && (scope === "global" || sameRef(c.scope_ref, ref))
        && String(c.effective_date) <= String(periodStart))
      .sort(newestFirst)[0];
    if (match) {
      return {
        rate_type: rateType,
        value: Number(match.value) || 0,
        config_id: match.id || null,
        effective_date: match.effective_date,
        scope,
        scope_ref: scope === "global" ? null : match.scope_ref,
        source: "config",
      };
    }
  }

  return {
    rate_type: rateType,
    value: DEFAULT_RATES[rateType] ?? 0,
    config_id: null,
    effective_date: null,
    scope: "global",
    scope_ref: null,
    source: "default",
  };
}

/** Hours in a working day, for deriving an hourly rate from a daily one. */
export const HOURS_PER_DAY = 8;

/**
 * Every rate type resolved for one employee and period.
 *
 * A branch (or position / employee) with its own daily rate but no hourly
 * rate of its own gets hourly = daily ÷ 8, so undertime follows that branch's
 * salary instead of the school-wide hourly rate.
 */
export function resolveRates(configs, who, periodStart) {
  const resolved = Object.fromEntries(RATE_TYPE_KEYS.map((type) => [type, resolveRate(configs, type, who, periodStart)]));
  const specificity = (rate) => (rate.source === "default" ? RATE_SCOPES.length : RATE_SCOPES.indexOf(rate.scope));
  if (specificity(resolved.daily) < specificity(resolved.hourly)) {
    resolved.hourly = {
      ...resolved.daily,
      rate_type: "hourly",
      value: Math.round((resolved.daily.value / HOURS_PER_DAY) * 100) / 100,
      source: "derived",
    };
  }
  return resolved;
}

/** Plain { type: value } view of resolveRates()'s result. */
export function rateValues(resolved) {
  return Object.fromEntries(Object.entries(resolved || {}).map(([type, rate]) => [type, Number(rate?.value) || 0]));
}

/**
 * Read every version. Never throws: when the table is missing or unreadable
 * `available` is false and payroll processing refuses to run (see the
 * payroll route), because rates it cannot trace must not reach a payslip.
 */
export async function loadRateConfigs(supabase) {
  try {
    const result = await supabase
      .from("payroll_rate_configs")
      .select(RATE_COLUMNS)
      .order("effective_date", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(5000);
    if (result.error) throw result.error;
    return { configs: result.data || [], available: true };
  } catch (error) {
    return { configs: [], available: false, error: error?.message || String(error) };
  }
}

/**
 * Versions of one rate (one scope) oldest first, each with the day it stopped
 * applying: "₱100 (Jan 1 – Sep 25) → ₱110 (Sep 26 – present)".
 */
export function rateHistory(configs, rateType, scope = "global", scopeRef = null) {
  const versions = (configs || [])
    .filter((c) => c.rate_type === rateType && c.scope === scope && (scope === "global" || sameRef(c.scope_ref, scopeRef)))
    .sort((a, b) => -newestFirst(a, b));

  // Several versions on one date: only the newest of them ever applied.
  const effective = versions.filter((v, i) => !versions.slice(i + 1).some((later) => later.effective_date === v.effective_date));

  return effective.map((version, index) => {
    const next = effective[index + 1];
    let until = null;
    if (next) {
      const day = new Date(`${next.effective_date}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() - 1);
      until = day.toISOString().slice(0, 10);
    }
    return { ...version, value: Number(version.value) || 0, until };
  });
}

/** Validation for a new version. Returns an error message, or null. */
export function validateRateInput({ rate_type: rateType, scope, scope_ref: scopeRef, value, effective_date: effectiveDate }) {
  if (!RATE_TYPES[rateType]) return "Unknown rate type.";
  if (!RATE_SCOPES.includes(scope)) return "Scope must be global, branch, position or employee.";
  if (scope !== "global" && !String(scopeRef ?? "").trim()) return "Choose which branch, position or employee this rate is for.";
  const amount = Number(value);
  if (value === "" || value === null || value === undefined || !Number.isFinite(amount) || amount < 0) {
    return "Enter a value of 0 or more.";
  }
  if (RATE_TYPES[rateType].unit === "percent" && amount > 100) return "A percentage cannot be more than 100.";
  if (RATE_TYPES[rateType].unit === "count" && (!Number.isInteger(amount) || amount > 31)) return "Enter a whole number from 0 to 31.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveDate || ""))) return "Choose the date the new value takes effect.";
  return null;
}
