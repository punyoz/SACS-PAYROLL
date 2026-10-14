/**
 * Per-employee work schedules (supabase/migrations/
 * 20261013010000_employee_schedules_cutoffs_early_bird.sql).
 *
 * The schedule a day is judged on, in priority order:
 *   (1) the employee's own schedule         work_schedule_assignments.employee_id
 *   (2) the schedule of the employee's level work_schedule_assignments.employee_level
 *   (3) the branch schedule                  system_config "attendance:<branch>"
 *   (4) the default schedule                 system_config "attendance"
 *
 * The database decides it (public.attendance_schedule_for), so the RFID status
 * engine, the nightly close, timesheets and payroll can never disagree. This
 * file only asks it, shapes the answer like src/lib/attendance/policy.js, and
 * falls back to the branch policy while the migration is not applied.
 */

import { getBranchAttendancePolicy, loadAttendanceConfig, resolveAttendancePolicy, timeToMinutes } from "@/lib/attendance/policy";

export const EMPLOYEE_LEVELS = Object.freeze([
  { value: "preschool", label: "Pre-school" },
  { value: "grade_school", label: "Grade School" },
  { value: "high_school", label: "High School" },
  { value: "senior_high", label: "Senior High School" },
  { value: "non_teaching", label: "Non-teaching" },
]);

export const LEVEL_VALUES = EMPLOYEE_LEVELS.map((level) => level.value);

export function levelLabel(value) {
  return EMPLOYEE_LEVELS.find((level) => level.value === value)?.label || null;
}

/** ISO weekdays, 1 = Monday ... 7 = Sunday. */
export const WEEKDAYS = Object.freeze([
  { value: 1, short: "Mon" },
  { value: 2, short: "Tue" },
  { value: 3, short: "Wed" },
  { value: 4, short: "Thu" },
  { value: 5, short: "Fri" },
  { value: 6, short: "Sat" },
  { value: 7, short: "Sun" },
]);

export const MON_TO_FRI = Object.freeze([1, 2, 3, 4, 5]);

const pad = (n) => String(n).padStart(2, "0");

/** 480 -> "08:00". */
export function minutesToHHMM(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return null;
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

/** "Mon–Fri", "Mon–Sat", "Mon, Wed, Fri". */
export function describeWorkingDays(days) {
  const list = [...new Set((days || []).map(Number))].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!list.length) return "—";
  const contiguous = list.every((d, i) => i === 0 || d === list[i - 1] + 1);
  const name = (d) => WEEKDAYS[d - 1].short;
  return contiguous && list.length > 2 ? `${name(list[0])}–${name(list[list.length - 1])}` : list.map(name).join(", ");
}

/**
 * True when the day is not a working day under these ISO working days
 * (Mon–Fri when none). Holidays are handled by the caller.
 */
export function isOffDay(dateKey, workingDays) {
  const jsDay = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  const iso = jsDay === 0 ? 7 : jsDay;
  const days = Array.isArray(workingDays) && workingDays.length ? workingDays.map(Number) : MON_TO_FRI;
  return !days.includes(iso);
}

/**
 * Validates a schedule profile from a request body.
 * @returns {{ value?: object, error?: string }}
 */
export function validateScheduleInput(body = {}) {
  const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
  const workStart = String(body.work_start ?? "").trim().slice(0, 5);
  const workEnd = String(body.work_end ?? "").trim().slice(0, 5);
  const grace = Number(body.grace_minutes);
  const hours = Number(body.work_hours);
  const days = [...new Set((Array.isArray(body.working_days) ? body.working_days : []).map(Number))].sort((a, b) => a - b);

  if (!name || name.length > 80) return { error: "Give the schedule a name (up to 80 characters)." };
  const start = timeToMinutes(workStart);
  const end = timeToMinutes(workEnd);
  if (start === null || end === null) return { error: "Work start and end must be times (HH:MM)." };
  if (end <= start) return { error: "Work end must be after work start." };
  if (!Number.isInteger(grace) || grace < 0 || grace > 120) return { error: "Late grace period is 0 to 120 minutes." };
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return { error: "Required work hours per day is more than 0 and at most 24." };
  if (hours * 60 > end - start + 0.001) return { error: "Required work hours cannot be longer than the time from work start to work end." };
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return { error: "Choose at least one working day." };

  return {
    value: {
      name,
      work_start: minutesToHHMM(start),
      work_end: minutesToHHMM(end),
      grace_minutes: grace,
      work_hours: Math.round(hours * 100) / 100,
      working_days: days,
    },
  };
}

/** An attendance_schedule_for() row as a policy object (policy.js shape + extras). */
export function scheduleRowToPolicy(row, branchId = null) {
  if (!row || row.work_start === undefined || row.work_start === null) return null;
  const days = Array.isArray(row.working_days) && row.working_days.length ? row.working_days.map(Number) : null;
  return {
    work_start: minutesToHHMM(row.work_start),
    work_end: minutesToHHMM(row.work_end),
    grace: Number(row.grace) || 0,
    work_hours: Number(row.work_hours) || 8,
    working_days: days,
    branch_id: branchId || null,
    // employee | level | branch | default
    source: row.source || "default",
    schedule_name: row.schedule_name || null,
    schedule_key: row.schedule_key || null,
  };
}

/**
 * The schedule one employee works on one day. Falls back to the branch policy
 * when the schedule function is not there yet. Never throws.
 */
export async function getEmployeeAttendancePolicy(supabase, { employeeId, branchId = null, dayKey }) {
  try {
    if (!employeeId || !dayKey) throw new Error("no employee");
    const { data, error } = await supabase.rpc("attendance_schedule_for", {
      p_employee: employeeId,
      p_branch: branchId || null,
      p_day: dayKey,
    });
    if (error) throw error;
    const policy = scheduleRowToPolicy(Array.isArray(data) ? data[0] : data, branchId);
    if (!policy) throw new Error("no schedule");
    return policy;
  } catch {
    return { ...(await getBranchAttendancePolicy(supabase, branchId)), working_days: null, schedule_name: null };
  }
}

/**
 * One employee's schedule for every day of a range (at most 62 days), as a
 * Map dateKey -> policy. `branchFor(dateKey)` picks the branch for a day (a
 * tapped day keeps the branch it was recorded at). Falls back to the branch
 * policy per day when the schedule function is not there yet. Never throws.
 */
export async function loadEmployeeScheduleDays(supabase, { employeeId, branchId = null, from, to, branchFor = null }) {
  const days = new Map();
  try {
    // The function answers at most 62 days per call.
    for (let chunkStart = from; chunkStart <= to;) {
      const chunkEnd = new Date(`${chunkStart}T00:00:00Z`);
      chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 61);
      const endKey = chunkEnd.toISOString().slice(0, 10) < to ? chunkEnd.toISOString().slice(0, 10) : to;
      const { data, error } = await supabase.rpc("attendance_schedules_between", {
        p_employee: employeeId,
        p_branch: branchId || null,
        p_from: chunkStart,
        p_to: endKey,
      });
      if (error || !Array.isArray(data) || !data.length) throw error || new Error("no schedules");
      data.forEach((row) => {
        const policy = scheduleRowToPolicy(row, branchId);
        if (policy) days.set(String(row.day).slice(0, 10), policy);
      });
      const next = new Date(`${endKey}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      chunkStart = next.toISOString().slice(0, 10);
    }
  } catch {
    days.clear();
  }

  // Days the database did not answer for, and days recorded at another branch
  // with no schedule of the employee's own: the branch's policy.
  const branchIds = new Set([branchId || ""]);
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const keys = [];
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    keys.push(key);
    if (branchFor) branchIds.add(branchFor(key) || "");
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const config = await loadAttendanceConfig(supabase, [...branchIds].filter(Boolean));
  keys.forEach((key) => {
    const dayBranch = (branchFor && branchFor(key)) || branchId || null;
    const own = days.get(key);
    if (own && (own.source === "employee" || own.source === "level" || String(dayBranch || "") === String(branchId || ""))) return;
    days.set(key, { ...resolveAttendancePolicy(config, dayBranch), working_days: null, schedule_name: null });
  });
  return days;
}
