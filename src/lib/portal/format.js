/**
 * Display helpers for the React portals.
 *
 * Line-for-line ports of the formatting helpers in public/legacy/js/app.js
 * and js/employee.js (named in each comment), so a value reads exactly the
 * same in the rebuilt screens as in the legacy ones. Display only: nothing
 * here decides pay, attendance or access.
 */

const MANILA = "Asia/Manila";

/** "₱ 12,345.00" (fmtPeso, employee.js). */
export function formatPeso(amount) {
  const n = Number(amount || 0);
  return `₱ ${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "₱ 12,345" (fmtPesoShort, employee.js). */
export function formatPesoShort(amount) {
  const n = Number(amount || 0);
  return `₱ ${n.toLocaleString("en-PH", { maximumFractionDigits: 0 })}`;
}

/** "08:05 AM" in Manila time, or null (formatPhTime, employee.js). */
export function formatPhTime(isoString) {
  if (!isoString) return null;
  try {
    return new Intl.DateTimeFormat("en-PH", {
      timeZone: MANILA,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
      .format(new Date(isoString))
      .toUpperCase();
  } catch {
    return null;
  }
}

/** "08:05 am" or "—" (attFormatTime, app.js). */
export function formatTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-PH", { timeZone: MANILA, hour: "2-digit", minute: "2-digit", hour12: true }).format(date);
}

/** "Mon, Oct 06, 2026" for a YYYY-MM-DD key (attFormatDate, app.js). */
export function formatDateKey(key) {
  if (!key) return "—";
  const date = new Date(`${key}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("en-PH", { timeZone: MANILA, month: "short", day: "2-digit", year: "numeric", weekday: "short" }).format(date);
}

/** "Mon" for a YYYY-MM-DD key. */
export function weekdayOf(key) {
  try {
    return new Intl.DateTimeFormat("en-PH", { timeZone: MANILA, weekday: "short" }).format(new Date(`${key}T00:00:00+08:00`));
  } catch {
    return "";
  }
}

/** "October 7, 2026" / "Oct 07, 2026" for an ISO instant. */
export function formatIssued(iso, month = "long") {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-PH", {
      month,
      day: month === "long" ? "numeric" : "2-digit",
      year: "numeric",
      timeZone: MANILA,
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

/** Today's YYYY-MM-DD in Manila (attManilaDateKey, app.js). */
export function manilaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MANILA, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** "HH:MM" (24 h, Manila) of an instant, for a time input (attTimeInputValue, app.js). */
export function timeInputValue(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: MANILA, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/** Two-letter initials (getInitials, employee.js). */
export function initialsOf(name, fallback = "EM") {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

/* ── Attendance statuses (app.js ATTENDANCE_STATUS_LIST) ── */

export const ATTENDANCE_STATUS_LIST = [
  "On Time", "Early Bird", "Late", "Undertime", "Half Day", "Absent",
  "Incomplete", "Pending Correction", "Corrected", "On Leave", "Holiday",
];

/** Canonical label; a pre-engine "Present" reads as On Time (normalizeAttendanceStatusLabel). */
export function normalizeAttendanceStatus(status) {
  const key = String(status || "").trim().toLowerCase();
  if (!key) return "—";
  if (key === "present") return "On Time";
  return ATTENDANCE_STATUS_LIST.find((s) => s.toLowerCase() === key) || String(status);
}

/** Present / late / absent / leave / holiday bucket for the month calendar (attendanceCalendarClass). */
export function attendanceBucket(status) {
  const label = normalizeAttendanceStatus(status);
  if (label === "Absent") return "absent";
  if (label === "On Leave") return "leave";
  if (label === "Holiday") return "holiday";
  if (label === "Late" || label === "Undertime" || label === "Half Day") return "late";
  if (label === "On Time" || label === "Early Bird" || label === "Corrected") return "present";
  return "";
}

/** "Sick Leave · Sep 28 – Sep 29, 2026 · With pay · Approved by …" (attendanceLeaveSummary). */
export function leaveSummary(leave) {
  if (!leave) return "Approved leave";
  const fmt = (key) => {
    const date = new Date(`${key}T00:00:00+08:00`);
    if (!key || Number.isNaN(date.getTime())) return key || "—";
    return new Intl.DateTimeFormat("en-PH", { timeZone: MANILA, month: "short", day: "numeric", year: "numeric" }).format(date);
  };
  const range = leave.start_date === leave.end_date ? fmt(leave.start_date) : `${fmt(leave.start_date)} – ${fmt(leave.end_date)}`;
  const parts = [leave.leave_type || "Leave", range, leave.pay_status === "without_pay" ? "Without pay" : "With pay"];
  if (leave.approved_by) parts.push(`Approved by ${leave.approved_by}`);
  return parts.join(" · ");
}

/** "Bonifacio Day, Nov 30 (8 h)" (holidayLineLabel). */
export function holidayLineLabel(line) {
  const date = line?.date ? new Date(`${line.date}T00:00:00+08:00`) : null;
  const when = date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat("en-PH", { timeZone: MANILA, month: "short", day: "numeric" }).format(date)
    : "";
  const hours = line?.hours !== null && line?.hours !== undefined ? ` (${line.hours} h)` : "";
  return `${line?.name || "Holiday"}${when ? `, ${when}` : ""}${hours}`;
}

/* ── Digit fields (DIGIT_FIELD_SPECS, app.js) ── */

export const DIGIT_FIELD_SPECS = {
  sss_number: { maxLength: 10, groups: [2, 7, 1] },
  pagibig_number: { maxLength: 12, groups: [4, 4, 4] },
  philhealth_number: { maxLength: 12, groups: [2, 9, 1] },
  tin_number: { maxLength: 12, groups: [3, 3, 3, 3] },
  bank_account_number: { maxLength: 20, groups: null },
  cp_number: { maxLength: 11, groups: [4, 3, 4], separator: " " },
  emergency_contact_number: { maxLength: 11, groups: [4, 3, 4], separator: " " },
};

export function digitsOnly(value) {
  return String(value || "").replace(/\D+/g, "");
}

export function formatDigitGroups(digits, groups, separator = "-") {
  if (!groups || !groups.length) return digits;
  let result = "";
  let pos = 0;
  for (let i = 0; i < groups.length && pos < digits.length; i++) {
    const chunk = digits.slice(pos, pos + groups[i]);
    if (!chunk) break;
    result += (i > 0 ? separator : "") + chunk;
    pos += groups[i];
  }
  return result;
}

/** Format a digit field by its spec name, capped at the spec's length. */
export function formatDigitField(value, specName) {
  const spec = DIGIT_FIELD_SPECS[specName];
  if (!spec) return String(value || "");
  return formatDigitGroups(digitsOnly(value).slice(0, spec.maxLength), spec.groups, spec.separator);
}

/** Government IDs and bank numbers reach the browser masked ("••••1234"). */
export function isMaskedPii(value) {
  return String(value || "").includes("•");
}

export function formatPiiForDisplay(value, groups) {
  if (isMaskedPii(value)) return String(value);
  const digits = digitsOnly(value);
  return digits ? formatDigitGroups(digits, groups) : "";
}

/** "0917 123 4567" for a stored contact number, or "". */
export function formatContactNumber(value) {
  const digits = digitsOnly(value);
  return digits ? formatDigitGroups(digits, DIGIT_FIELD_SPECS.cp_number.groups, DIGIT_FIELD_SPECS.cp_number.separator) : "";
}
