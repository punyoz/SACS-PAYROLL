/**
 * Attendance statuses.
 *
 * The database computes every status (trigger attendance_logs_compute_status,
 * supabase/migrations/20260926010000_attendance_status_engine.sql); this file
 * only names them, so the API routes and tests read them one way.
 *
 * Rows written before the engine existed said "Present"; the migration
 * recomputes them, and normalizeAttendanceStatus() still reads "Present" as
 * On Time in case an old row is met anywhere.
 *
 * On Leave is a working day covered by approved leave
 * (20260928010000_leave_attendance_sync.sql): neither attended nor absent.
 *
 * Holiday is a day with no tap on a holiday or whole-day suspension
 * (20261007010000_holiday_calendar.sql): neither attended nor absent either.
 */

export const ATTENDANCE_STATUSES = Object.freeze([
  "On Time",
  "Early Bird",
  "Late",
  "Undertime",
  "Half Day",
  "Absent",
  "Incomplete",
  "Pending Correction",
  "Corrected",
  "On Leave",
  "Holiday",
]);

/** Records payroll may not treat as worked or unworked until resolved. */
export const UNRESOLVED_STATUSES = Object.freeze(["Incomplete", "Pending Correction"]);

/** Records an employee may ask to correct (the time out is what is corrected). */
export const CORRECTABLE_STATUSES = Object.freeze(["Incomplete", "Undertime", "Half Day"]);

/** Badge tone per status: the Attendance dashboard colour code. */
export const STATUS_TONES = Object.freeze({
  "On Time": "green",
  "Early Bird": "green",
  Late: "yellow",
  Undertime: "yellow",
  "Half Day": "orange",
  Absent: "red",
  Incomplete: "gray",
  "Pending Correction": "gray",
  Corrected: "blue",
  "On Leave": "blue",
  Holiday: "teal",
});

const BY_LOWER = new Map(ATTENDANCE_STATUSES.map((status) => [status.toLowerCase(), status]));

/**
 * The canonical spelling of a status, or `fallback` when it is not one.
 * "Present" (pre-engine rows) reads as On Time.
 */
export function normalizeAttendanceStatus(value, fallback = "Absent") {
  const key = String(value ?? "").trim().toLowerCase();
  if (key === "present") return "On Time";
  return BY_LOWER.get(key) || fallback;
}

/** Counted as a day the employee came in (for present-day totals). */
export function isAttendedStatus(status) {
  const normalized = normalizeAttendanceStatus(status, "");
  return Boolean(normalized) && normalized !== "Absent" && normalized !== "On Leave"
    && normalized !== "Holiday" && !UNRESOLVED_STATUSES.includes(normalized);
}

export function isUnresolvedStatus(status) {
  return UNRESOLVED_STATUSES.includes(normalizeAttendanceStatus(status, ""));
}

export function isCorrectableStatus(status) {
  return CORRECTABLE_STATUSES.includes(normalizeAttendanceStatus(status, ""));
}

/**
 * The present / late / absent buckets the dashboards and reports count in:
 * "late" for Late, "absent" for Absent, "leave" for On Leave, "holiday" for
 * Holiday, "unresolved" for Incomplete and Pending Correction, and "present"
 * for every other day the employee came in.
 * An unknown value counts as absent, as it always has.
 */
export function attendanceBucket(status) {
  const normalized = normalizeAttendanceStatus(status, "Absent");
  if (normalized === "Late") return "late";
  if (normalized === "Absent") return "absent";
  if (normalized === "On Leave") return "leave";
  if (normalized === "Holiday") return "holiday";
  if (UNRESOLVED_STATUSES.includes(normalized)) return "unresolved";
  return "present";
}
