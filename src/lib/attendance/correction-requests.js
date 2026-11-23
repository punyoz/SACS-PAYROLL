/**
 * Attendance correction requests (2026-11-23): the words the employee and HR
 * see. The employee files an "Attendance correction request"; HR's own direct
 * change stays "Override".
 */
export const FIX_TYPES = Object.freeze({
  missing_in: "Missing time in",
  missing_out: "Missing time out",
  wrong_in: "Wrong time in",
  wrong_out: "Wrong time out",
});

export const REASON_CODES = Object.freeze({
  forgot_in: "Forgot to tap in",
  forgot_out: "Forgot to tap out",
  card_not_working: "Card not working",
  terminal_offline: "Terminal offline",
  other: "Other",
});

/** The fixes that fit a day's taps. */
export function fixTypesFor(day) {
  const types = [];
  if (!day?.time_in) types.push("missing_in");
  if (day?.time_in && !day?.time_out) types.push("missing_out");
  if (day?.time_in) types.push("wrong_in");
  if (day?.time_out) types.push("wrong_out");
  return types;
}

/** Which times the form asks for. */
export function timesNeeded(fixType, day) {
  if (fixType === "missing_in") return { in: true, out: !day?.time_out };
  if (fixType === "wrong_in") return { in: true, out: false };
  return { in: false, out: true };
}

/** An attendance flag's code -> the fix to prefill. */
export function fixForFlag(code, day) {
  if (code === "missing_tap") return day?.time_in ? "missing_out" : "missing_in";
  if (code === "absent_no_request") return "missing_in";
  if (code === "short_day") return "wrong_out";
  return fixTypesFor(day)[0] || "missing_in";
}

/** A day the employee may file a request for (the filing window and the limit are the database's). */
export function canRequestCorrection(day) {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  return Boolean(day) && !["Holiday", "On Leave", "Pending Correction"].includes(day.status) && String(day.log_date || "").slice(0, 10) <= today;
}
