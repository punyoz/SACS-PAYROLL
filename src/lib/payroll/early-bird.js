/**
 * Early Bird incentive: ONE winner per pay period, the employee with the most
 * early RFID time-ins (supabase/migrations/
 * 20261013010000_employee_schedules_cutoffs_early_bird.sql).
 *
 *   Early time in   at least `threshold_minutes` (default 15) before the
 *                   employee's OWN work start that day (their schedule:
 *                   own → level → branch → default). 8:00 start: 7:45 counts,
 *                   7:46 does not. The status engine stores the difference
 *                   on each row (attendance_logs.arrival_offset_minutes).
 *   Counted over    the half's attendance window (the days its payslip
 *                   deducts, src/lib/payroll/semi-monthly.js).
 *   Eligible        at least one early time in, and, while
 *                   `exclude_unexcused_absence` is on, no Absent day in the
 *                   window (an approved leave day is On Leave, not Absent).
 *   Tie-breakers    1. earliest average time in against their own start
 *                   2. fewest Late days   3. fewest Absent days
 *                   then the lowest employee code, so the result never
 *                   depends on read order (recorded as `tie_broken_by`).
 *   Amount          `incentive_amount` (Super Admin or HR). 0 = switched off.
 *
 * The winner is stored per period in early_bird_winners and locks when HR
 * approves the period's first payroll run (approve_payroll_run,
 * 20261014010000); the database then refuses any change.
 */

import { roundPeso } from "@/lib/payroll/money";
import { normalizeAttendanceStatus } from "@/lib/attendance/status";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

export const EARLY_BIRD_SECTION = "early_bird";
export const EARLY_BIRD_LINE = "early_bird_incentive";
export const EARLY_BIRD_LABEL = "Early Bird Incentive";

export const DEFAULT_EARLY_BIRD_SETTINGS = Object.freeze({
  threshold_minutes: 15,
  incentive_amount: 0,
  exclude_unexcused_absence: true,
});

const PAID_ROLES = ["employee", "accountant"];

/** system_config rows (or a { key: value } section) -> settings. */
export function parseEarlyBirdSettings(source) {
  const values = Array.isArray(source)
    ? Object.fromEntries(source.filter((row) => row.section === EARLY_BIRD_SECTION).map((row) => [row.key, row.value]))
    : source || {};
  const threshold = Number(values.threshold_minutes);
  const amount = Number(values.incentive_amount);
  const exclude = String(values.exclude_unexcused_absence ?? "true").trim().toLowerCase();
  return {
    threshold_minutes: Number.isInteger(threshold) && threshold >= 0 && threshold <= 240 ? threshold : DEFAULT_EARLY_BIRD_SETTINGS.threshold_minutes,
    incentive_amount: Number.isFinite(amount) && amount > 0 ? roundPeso(amount) : 0,
    exclude_unexcused_absence: !["false", "0", "no", "off"].includes(exclude),
  };
}

export async function loadEarlyBirdSettings(supabase) {
  try {
    const result = await supabase.from("system_config").select("section,key,value").eq("section", EARLY_BIRD_SECTION);
    if (result.error) throw result.error;
    return parseEarlyBirdSettings(result.data || []);
  } catch {
    return { ...DEFAULT_EARLY_BIRD_SETTINGS };
  }
}

/** Manila minutes after midnight of an instant. */
function manilaMinutes(iso) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour12: false, hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(iso));
  return (Number(parts.find((p) => p.type === "hour")?.value || 0) % 24) * 60 + Number(parts.find((p) => p.type === "minute")?.value || 0);
}

/**
 * The arrival offset of a row: stored by the status engine, else worked out
 * from the time in and the stored shift start. null when unknown.
 */
export function arrivalOffset(row) {
  if (row?.arrival_offset_minutes !== null && row?.arrival_offset_minutes !== undefined) return Number(row.arrival_offset_minutes);
  if (row?.time_in && row?.shift_start_minutes !== null && row?.shift_start_minutes !== undefined) {
    return manilaMinutes(row.time_in) - Number(row.shift_start_minutes);
  }
  return null;
}

/** True when a time in counts as early: at least `threshold` minutes before the start. */
export function isEarlyTimeIn(offsetMinutes, threshold = DEFAULT_EARLY_BIRD_SETTINGS.threshold_minutes) {
  return offsetMinutes !== null && offsetMinutes !== undefined && Number.isFinite(Number(offsetMinutes))
    && Number(offsetMinutes) <= -Number(threshold);
}

/**
 * Per-employee figures for the window from attendance_logs rows
 * ({ id, employee_id, status, log_date, time_in, arrival_offset_minutes }).
 * One row per employee per day is assumed (archived duplicates excluded).
 */
export function earlyBirdStats(rows, { threshold = DEFAULT_EARLY_BIRD_SETTINGS.threshold_minutes, from = null, to = null } = {}) {
  const stats = new Map();
  const seen = new Set();
  (rows || []).forEach((row) => {
    const employeeId = String(row.employee_id || "");
    const day = String(row.log_date || "").slice(0, 10);
    if (!employeeId || (from && day < from) || (to && day > to)) return;
    const dayKey = `${employeeId}|${day}`;
    if (seen.has(dayKey)) return;
    seen.add(dayKey);
    if (!stats.has(employeeId)) {
      stats.set(employeeId, { employee_id: employeeId, early_count: 0, early_log_ids: [], offset_sum: 0, offset_days: 0, late_count: 0, absent_count: 0 });
    }
    const s = stats.get(employeeId);
    const status = normalizeAttendanceStatus(row.status, "");
    if (status === "Late") s.late_count += 1;
    if (status === "Absent") s.absent_count += 1;
    const offset = row.time_in ? arrivalOffset(row) : null;
    if (offset === null || !Number.isFinite(offset)) return;
    s.offset_sum += offset;
    s.offset_days += 1;
    if (isEarlyTimeIn(offset, threshold)) {
      s.early_count += 1;
      if (row.id) s.early_log_ids.push(String(row.id));
    }
  });
  stats.forEach((s) => {
    s.average_offset_minutes = s.offset_days ? Math.round((s.offset_sum / s.offset_days) * 100) / 100 : null;
  });
  return stats;
}

const compareNullable = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a - b;
};

/**
 * The winner among candidates ({ employee_id, employee_name, employee_code,
 * early_count, average_offset_minutes, late_count, absent_count, ... }).
 * @returns {{ winner: object|null, ranking: object[] }}
 */
export function pickEarlyBirdWinner(candidates, { excludeUnexcused = true } = {}) {
  const eligible = (candidates || []).filter((c) => c.early_count > 0 && (!excludeUnexcused || !c.absent_count));
  const criteria = [
    (a, b) => b.early_count - a.early_count,
    (a, b) => compareNullable(a.average_offset_minutes, b.average_offset_minutes),
    (a, b) => a.late_count - b.late_count,
    (a, b) => a.absent_count - b.absent_count,
  ];
  const byCriteria = (a, b) => criteria.reduce((result, compare) => result || compare(a, b), 0);
  const ranking = [...eligible].sort((a, b) => byCriteria(a, b)
    || String(a.employee_code || "").localeCompare(String(b.employee_code || ""), "en", { numeric: true })
    || String(a.employee_id).localeCompare(String(b.employee_id)));
  const winner = ranking[0] || null;
  if (winner && ranking[1] && byCriteria(winner, ranking[1]) === 0) {
    return { winner: { ...winner, tie_broken_by: "employee_code" }, ranking };
  }
  return { winner, ranking };
}

function isMissing(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("42p01") || text.includes("42703") || text.includes("pgrst205") || text.includes("does not exist")
    || text.includes("could not find") || text.includes("schema cache");
}

/** Everyone who can win: paid staff, not archived, not inactive, pay not on hold. */
async function loadCandidates(supabase) {
  const base = "id,full_name,employee_id,branch_id,role,archived,employee_status";
  let result = await fetchAllRows(() => supabase.from("profiles").select(`${base},payroll_hold`)
    .in("role", PAID_ROLES).eq("archived", false).order("id", { ascending: true }));
  if (result.error && isMissing(result.error)) {
    result = await fetchAllRows(() => supabase.from("profiles").select(base)
      .in("role", PAID_ROLES).eq("archived", false).order("id", { ascending: true }));
  }
  if (result.error) throw new Error(result.error.message);
  return (result.data || []).filter((row) => String(row.employee_status || "active").toLowerCase() !== "inactive" && row.payroll_hold !== true);
}

/** The stored winner of a period (null when none yet or the table is missing). */
export async function readEarlyBirdWinner(supabase, periodLabel) {
  const result = await supabase.from("early_bird_winners").select("*").eq("period_label", periodLabel).maybeSingle();
  if (result.error) return null;
  return result.data || null;
}

/** A stored row as the shape payroll and the screens use. */
export function shapeWinner(row) {
  if (!row) return null;
  return {
    period_label: row.period_label,
    window: { start_key: String(row.window_start).slice(0, 10), end_key: String(row.window_end).slice(0, 10) },
    employee_id: row.employee_id || null,
    employee_name: row.employee_name || null,
    branch_id: row.branch_id || null,
    early_count: Number(row.early_count) || 0,
    average_offset_minutes: row.average_offset_minutes === null || row.average_offset_minutes === undefined ? null : Number(row.average_offset_minutes),
    late_count: Number(row.late_count) || 0,
    absent_count: Number(row.absent_count) || 0,
    amount: roundPeso(row.amount),
    threshold_minutes: Number(row.threshold_minutes) || 0,
    source_log_ids: Array.isArray(row.source_log_ids) ? row.source_log_ids : [],
    ranking: Array.isArray(row.ranking) ? row.ranking : [],
    tie_broken_by: row.ranking?.[0]?.tie_broken_by || null,
    computed_at: row.computed_at || null,
    finalized: Boolean(row.finalized_at),
    finalized_at: row.finalized_at || null,
  };
}

/**
 * The period's winner: the stored one when it is locked, otherwise computed
 * from the window's attendance and stored (replacing an unlocked one).
 *
 * @param {object} supabase  service-role client
 * @param {{ period: { label, start_key, end_key }, window: { start_key, end_key }, actor?: { userId, name } }} options
 * @returns {Promise<{ enabled: boolean, available: boolean, winner: object|null, settings: object }>}
 *   enabled false: the amount is 0 (switched off); available false: the
 *   migration is not applied. Never throws for either.
 */
export async function resolveEarlyBirdWinner(supabase, { period, window, actor = null }) {
  const settings = await loadEarlyBirdSettings(supabase);
  const stored = await supabase.from("early_bird_winners").select("*").eq("period_label", period.label).maybeSingle();
  if (stored.error) return { enabled: settings.incentive_amount > 0, available: false, winner: null, settings };
  if (stored.data?.finalized_at) return { enabled: true, available: true, winner: shapeWinner(stored.data), settings };
  if (settings.incentive_amount <= 0) return { enabled: false, available: true, winner: null, settings };

  const [candidates, attendance] = await Promise.all([
    loadCandidates(supabase),
    fetchAllRows(() => supabase.from("attendance_logs")
      .select("id,employee_id,status,log_date,time_in,arrival_offset_minutes,shift_start_minutes")
      .gte("log_date", window.start_key)
      .lte("log_date", window.end_key)
      .eq("archived_duplicate", false)
      .order("log_date", { ascending: true })
      .order("id", { ascending: true })),
  ]);
  if (attendance.error) {
    if (isMissing(attendance.error)) return { enabled: true, available: false, winner: null, settings };
    throw new Error(attendance.error.message);
  }

  const stats = earlyBirdStats(attendance.data || [], { threshold: settings.threshold_minutes, from: window.start_key, to: window.end_key });
  const pool = candidates.map((person) => ({
    employee_id: person.id,
    employee_name: person.full_name || "Employee",
    employee_code: person.employee_id || "",
    branch_id: person.branch_id || null,
    ...(stats.get(String(person.id)) || { early_count: 0, early_log_ids: [], average_offset_minutes: null, late_count: 0, absent_count: 0 }),
  }));
  const { winner, ranking } = pickEarlyBirdWinner(pool, { excludeUnexcused: settings.exclude_unexcused_absence });

  const row = {
    period_label: period.label,
    period_start: period.start_key,
    period_end: period.end_key,
    window_start: window.start_key,
    window_end: window.end_key,
    employee_id: winner?.employee_id || null,
    employee_name: winner?.employee_name || null,
    branch_id: winner?.branch_id || null,
    early_count: winner?.early_count || 0,
    average_offset_minutes: winner?.average_offset_minutes ?? null,
    late_count: winner?.late_count || 0,
    absent_count: winner?.absent_count || 0,
    amount: winner ? settings.incentive_amount : 0,
    threshold_minutes: settings.threshold_minutes,
    exclude_unexcused: settings.exclude_unexcused_absence,
    source_log_ids: winner?.early_log_ids || [],
    ranking: ranking.slice(0, 5).map((c, index) => ({
      rank: index + 1,
      employee_id: c.employee_id,
      employee_name: c.employee_name,
      early_count: c.early_count,
      average_offset_minutes: c.average_offset_minutes,
      late_count: c.late_count,
      absent_count: c.absent_count,
      ...(index === 0 && winner?.tie_broken_by ? { tie_broken_by: winner.tie_broken_by } : {}),
    })),
    computed_at: new Date().toISOString(),
    computed_by: actor?.userId || null,
    computed_by_name: actor?.name || null,
  };
  const saved = await supabase.from("early_bird_winners").upsert(row, { onConflict: "period_label" }).select("*").maybeSingle();
  if (saved.error) {
    // Locked between the read and the write: the stored winner stands.
    const again = await readEarlyBirdWinner(supabase, period.label);
    if (again?.finalized_at) return { enabled: true, available: true, winner: shapeWinner(again), settings };
    throw new Error(saved.error.message);
  }
  const savedRow = Array.isArray(saved.data) ? saved.data[0] : saved.data;
  return { enabled: true, available: true, winner: shapeWinner(savedRow || row), settings };
}

/** The payslip line for the winner (a payroll_incentives row; traceable to the early time-ins). */
export function earlyBirdLine(winner) {
  if (!winner?.employee_id || !(Number(winner.amount) > 0)) return null;
  return {
    type: EARLY_BIRD_LINE,
    quantity: winner.early_count,
    unit: "early time-in",
    rate: null,
    rate_config_id: null,
    amount: roundPeso(winner.amount),
    source_log_id: null,
    source_log_ids: winner.source_log_ids || [],
    is_override: false,
    note: `${EARLY_BIRD_LABEL}: ${winner.early_count} early time-in${winner.early_count === 1 ? "" : "s"} (at least ${winner.threshold_minutes} min before start), ${winner.period_label}`,
    log_date: null,
  };
}
