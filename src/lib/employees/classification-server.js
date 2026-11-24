/**
 * Server side of Part A (20261121010000): loads the classification history,
 * the leave credit and pay rules, records a classification change (applied
 * on its date), and computes leave balances per leave type.
 */
import { getEmployeeAttendancePolicy } from "@/lib/attendance/work-schedules";
import { requestDays } from "@/lib/leave-requests/split";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";
import {
  CREDIT_LEAVE_TYPES,
  POOL_LEAVE_TYPE,
  CLASSIFICATION_FIELDS,
  SIL_LEAVE_TYPES,
  classificationOn,
  eligibilityError,
  leaveEntitlement,
  payRuleFor,
} from "@/lib/employees/classification";

const PROFILE_COLUMNS = "id,full_name,branch_id,role,employee_type,employment_status,employment_type,on_payroll,contract_end_date,classification_unconfirmed,date_hired,separated_on";

const todayKey = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

/** { profiles: Map id -> profile, changes: Map id -> change rows } */
export async function loadClassificationContext(supabase, employeeIds) {
  const ids = [...new Set((employeeIds || []).filter(Boolean))];
  const profiles = new Map();
  const changes = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return { profiles, changes };
  const [p, c] = await Promise.all([
    fetchAllIn(() => supabase.from("profiles").select(PROFILE_COLUMNS).order("id", { ascending: true }), "id", ids),
    fetchAllIn(() => supabase.from("employee_classification_changes").select("*").is("cancelled_at", null).order("id", { ascending: true }), "employee_id", ids),
  ]);
  if (p.error) throw new Error(p.error.message);
  if (c.error) throw new Error(c.error.message);
  (p.data || []).forEach((row) => profiles.set(row.id, row));
  (c.data || []).forEach((row) => changes.get(row.employee_id)?.push(row));
  return { profiles, changes };
}

export async function loadLeaveRules(supabase) {
  const result = await fetchAllRows(() => supabase.from("leave_credit_rules").select("*").order("effective_from", { ascending: true }).order("id", { ascending: true }));
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

export async function loadPayRules(supabase) {
  const result = await fetchAllRows(() => supabase.from("employee_pay_rules").select("*").order("effective_from", { ascending: true }).order("id", { ascending: true }));
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

/** The statutory leaves (maternity, paternity, …), in their display order. */
export async function loadStatutoryLeaves(supabase) {
  const result = await supabase.from("statutory_leave_types").select("*").order("sort_order", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

/** An "hr" section setting from system_config as a positive number, or the fallback. */
export async function readHrNumber(supabase, key, fallback) {
  const result = await supabase.from("system_config").select("value").eq("section", "hr").eq("key", key).maybeSingle();
  const n = Number(result.data?.value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Scheduled hours a week, from the employee's work schedule on `dateKey`. */
export async function weeklyHoursFor(supabase, { employeeId, branchId, dateKey }) {
  const policy = await getEmployeeAttendancePolicy(supabase, { employeeId, branchId, dayKey: dateKey });
  const days = Array.isArray(policy?.working_days) && policy.working_days.length ? policy.working_days.length : 5;
  return (Number(policy?.work_hours) || 8) * days;
}

/**
 * Leave balances for `year`, per leave type, for each employee:
 * { [id]: { by_type: { [type]: { allotment, used, remaining, override } }, with_pay_allotment,
 *           with_pay_used, with_pay_remaining, sil_remaining, without_pay_used } }
 * Only approved requests count. `requests` (optional) are the approved rows
 * already read; otherwise they are read here.
 */
export async function leaveBalances(supabase, employeeIds, year, { requests = null } = {}) {
  const ids = [...new Set((employeeIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const [{ profiles, changes }, rules, overridesResult, regularAfterMonths] = await Promise.all([
    loadClassificationContext(supabase, ids),
    loadLeaveRules(supabase),
    fetchAllIn(() => supabase.from("leave_credit_overrides").select("*").eq("year", year).order("id", { ascending: true }), "employee_id", ids),
    readHrNumber(supabase, "regular_credits_after_months", 12),
  ]);
  if (overridesResult.error) throw new Error(overridesResult.error.message);
  let approved = requests;
  if (!approved) {
    const r = await fetchAllIn(() => supabase.from("leave_requests").select("id,employee_id,leave_type,start_date,end_date,status,pay_status,half_day")
      .eq("status", "approved").gte("start_date", `${year}-01-01`).lte("start_date", `${year}-12-31`).order("id", { ascending: true }), "employee_id", ids);
    if (r.error) throw new Error(r.error.message);
    approved = r.data || [];
  }
  const out = {};
  for (const id of ids) {
    const profile = profiles.get(id) || {};
    const history = changes.get(id) || [];
    const entitlement = leaveEntitlement({
      rules, current: profile, changes: history, year, dateHired: profile.date_hired, separatedOn: profile.separated_on,
      overrides: (overridesResult.data || []).filter((o) => o.employee_id === id), regularAfterMonths,
    });
    const mine = approved.filter((r) => String(r.employee_id) === String(id) && String(r.status).toLowerCase() === "approved"
      && Number(String(r.start_date).slice(0, 4)) === Number(year));
    const paid = (type) => mine.filter((r) => r.leave_type === type && String(r.pay_status || "with_pay").toLowerCase() !== "without_pay")
      .reduce((sum, r) => sum + requestDays(r), 0);
    const withoutPay = mine.filter((r) => String(r.pay_status).toLowerCase() === "without_pay").reduce((s, r) => s + requestDays(r), 0);
    if (entitlement[POOL_LEAVE_TYPE]) {
      // ONE pool (2026-11-24): every credit type draws from it; each type's "remaining" is the pool's, so every
      // check (filing, approval split, Final Pay) reads the shared total.
      const e = entitlement[POOL_LEAVE_TYPE];
      const used = CREDIT_LEAVE_TYPES.reduce((s, t) => s + paid(t), 0);
      const remaining = Math.max(0, e.days - used);
      const by_type = Object.fromEntries(CREDIT_LEAVE_TYPES.map((type) => [type, { allotment: e.days, computed: e.computed, used: paid(type), remaining, override: e.override, parts: e.parts, pooled: true }]));
      out[id] = {
        by_type,
        pool: { allotment: e.days, computed: e.computed, used, remaining, override: e.override, parts: e.parts, used_by_type: Object.fromEntries(CREDIT_LEAVE_TYPES.map((t) => [t, paid(t)])) },
        with_pay_allotment: e.days, with_pay_used: used, with_pay_remaining: remaining, sil_remaining: remaining, without_pay_used: withoutPay,
      };
      continue;
    }
    const by_type = Object.fromEntries(CREDIT_LEAVE_TYPES.map((type) => {
      const used = paid(type);
      const e = entitlement[type];
      return [type, { allotment: e.days, computed: e.computed, used, remaining: Math.max(0, e.days - used), override: e.override, parts: e.parts }];
    }));
    // The yearly totals are vacation + sick + emergency: maternity and paternity
    // leave are statutory days for a birth, not a yearly allowance to spend.
    const sum = (key, types = SIL_LEAVE_TYPES) => types.reduce((s, t) => s + by_type[t][key], 0);
    out[id] = {
      by_type,
      with_pay_allotment: sum("allotment"),
      with_pay_used: sum("used"),
      with_pay_remaining: sum("remaining"),
      sil_remaining: sum("remaining"),
      without_pay_used: withoutPay,
    };
  }
  return out;
}

/**
 * Record a classification change. Applied at once when its date is today or
 * earlier (employee_classification_apply), otherwise by the nightly job on the
 * date. Returns { change } or { error }.
 */
export async function recordClassificationChange(supabase, { employeeId, field, value, effectiveOn, reason, actor }) {
  if (!CLASSIFICATION_FIELDS.includes(field)) return { error: "Unknown field." };
  const { profiles, changes } = await loadClassificationContext(supabase, [employeeId]);
  const profile = profiles.get(employeeId);
  if (!profile) return { error: "Employee not found." };
  const before = classificationOn(profile, changes.get(employeeId) || [], effectiveOn)[field];
  const newValue = field === "on_payroll" ? String(Boolean(value)) : (value === null || value === "" ? null : String(value));
  const oldValue = field === "on_payroll" ? String(before) : (before ?? null);
  if (oldValue === newValue) return { error: "That is already the value on that date." };
  const inserted = await supabase.from("employee_classification_changes").insert({
    employee_id: employeeId, field, old_value: oldValue, new_value: newValue, effective_on: effectiveOn,
    reason: String(reason || "").trim().slice(0, 500), changed_by: actor?.userId || null, changed_by_name: actor?.name || null,
  }).select("*").maybeSingle();
  if (inserted.error) return { error: inserted.error.message };
  if (effectiveOn <= todayKey()) {
    const applied = await supabase.rpc("employee_classification_apply", { p_today: todayKey() });
    if (applied.error) return { error: applied.error.message, change: inserted.data };
  }
  return { change: inserted.data };
}

/** The pay rule for an employee on `dateKey`, with their classification then. */
export async function payRuleOn(supabase, employeeId, dateKey) {
  const [{ profiles, changes }, rules] = await Promise.all([loadClassificationContext(supabase, [employeeId]), loadPayRules(supabase)]);
  const profile = profiles.get(employeeId);
  if (!profile) return { rule: null, classification: null };
  const classification = classificationOn(profile, changes.get(employeeId) || [], dateKey);
  return { rule: payRuleFor(rules, classification, dateKey), classification };
}

/** Plain-word refusal when the employee's pay rule on `dateKey` excludes `what`, else null. Never throws. */
export async function eligibilityRefusal(supabase, employeeId, what, dateKey = todayKey()) {
  try {
    const { rule, classification } = await payRuleOn(supabase, employeeId, dateKey);
    return eligibilityError(rule, what, classification || {});
  } catch {
    return null;
  }
}
