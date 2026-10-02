/**
 * RFID attendance: the FIRST tap of a day is Time In, the LAST is Time Out.
 *
 * Every tap is accepted, however soon after the previous one (there is no
 * cooldown), and every tap is kept as its own row in public.attendance_taps.
 * The day's attendance_logs row is rebuilt from them on each tap:
 *
 *   - one tap:   Time In only (Incomplete once the shift is over);
 *   - two taps+: Time In = first tap, Time Out = last tap, so a tap after a
 *                Time Out simply moves the Time Out to it.
 *   - a day HR / Admin corrected keeps its corrected times; a tap after the
 *     correction is still stored, and the day is flagged for review.
 *
 * One attendance_logs row per employee per day carries this. Earlier versions
 * started a fresh row on a third tap, and hard deletes are blocked at the
 * database level, so days recorded before this fix can still have several rows.
 * collapseDailyTaps() folds those into one record so every screen and report
 * reads the same first and last tap.
 */

function toTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export function hoursBetween(startIso, endIso) {
  const start = toTime(startIso);
  const end = toTime(endIso);
  if (start === null || end === null || end <= start) return 0;
  return Math.round(((end - start) / 3600000) * 100) / 100;
}

/** Every tap timestamp a row represents (its time in and its time out). */
function tapTimes(row) {
  return [toTime(row.time_in), toTime(row.time_out)].filter((t) => t !== null);
}

/**
 * Fold one employee-day's rows into a single record: time in = earliest tap,
 * time out = latest tap after it (null when there was only one tap), status
 * from the row holding the first tap.
 */
function collapseGroup(rows) {
  const withTaps = rows.filter((row) => tapTimes(row).length);
  if (!withTaps.length) {
    return { ...rows[0] };
  }

  const firstRow = withTaps.reduce((best, row) => {
    const bestIn = toTime(best.time_in) ?? Math.min(...tapTimes(best));
    const rowIn = toTime(row.time_in) ?? Math.min(...tapTimes(row));
    return rowIn < bestIn ? row : best;
  });

  const allTaps = withTaps.flatMap(tapTimes).sort((a, b) => a - b);
  const first = allTaps[0];
  const last = allTaps[allTaps.length - 1];

  const timeIn = new Date(first).toISOString();
  const timeOut = last > first ? new Date(last).toISOString() : null;

  return {
    ...firstRow,
    time_in: timeIn,
    time_out: timeOut,
    total_hours: timeOut ? hoursBetween(timeIn, timeOut) : 0,
    tap_rows: rows.length,
  };
}

/**
 * Collapse attendance rows to one record per employee per day.
 * Rows without an employee id or a date are passed through untouched.
 * Output order follows the first appearance of each employee-day in `rows`.
 */
export function collapseDailyTaps(rows, {
  employeeKey = (row) => row.employee_id,
  dateKey = (row) => row.log_date,
} = {}) {
  const groups = new Map();
  const passthrough = [];
  const order = [];

  (rows || []).forEach((row) => {
    const employee = employeeKey(row);
    const date = dateKey(row);
    if (!employee || !date) {
      passthrough.push(row);
      return;
    }
    const key = `${employee}|${date}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(row);
  });

  return [...order.map((key) => collapseGroup(groups.get(key))), ...passthrough];
}

/**
 * First and last of a set of tap times: { time_in, time_out, tap_count }.
 * time_out is null with a single tap (or taps all at the same instant).
 */
export function firstAndLastTap(times) {
  const sorted = (times || []).map(toTime).filter((t) => t !== null).sort((a, b) => a - b);
  if (!sorted.length) return { time_in: null, time_out: null, tap_count: 0 };
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    time_in: new Date(first).toISOString(),
    time_out: last > first ? new Date(last).toISOString() : null,
    tap_count: sorted.length,
  };
}

/**
 * Decide what a new tap does to the employee's day. Every tap counts.
 *
 * @param {Array} dayRows   every attendance_logs row for this employee that day
 * @param {string} nowIso   when the card was tapped
 * @param {string[]} [rawTaps]  the day's earlier raw taps (attendance_taps.tapped_at)
 * @returns {{ action: "time_in" }
 *         | { action: "after_correction", target: object }
 *         | { action: "time_out", target: object, time_in: string, time_out: string|null }}
 *   `target` is the row to update: the one holding the day's first tap.
 */
export function planTap(dayRows, nowIso, rawTaps = []) {
  const rows = (dayRows || []).filter((row) => tapTimes(row).length);
  if (!rows.length) return { action: "time_in" };

  const target = rows.reduce((best, row) => {
    const bestIn = toTime(best.time_in) ?? Infinity;
    const rowIn = toTime(row.time_in) ?? Infinity;
    return rowIn < bestIn ? row : best;
  });

  // HR / Admin set this day's times; a new tap never overwrites them.
  if (String(target.status || "") === "Corrected") return { action: "after_correction", target };

  const day = firstAndLastTap([
    ...rows.flatMap((row) => [row.time_in, row.time_out]),
    ...(rawTaps || []),
    nowIso,
  ]);
  return { action: "time_out", target, time_in: day.time_in, time_out: day.time_out };
}
