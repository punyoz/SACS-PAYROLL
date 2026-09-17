/**
 * RFID attendance: only the FIRST and the LAST tap of a day count.
 *
 * People tap a card more than once — the reader was slow, they weren't sure it
 * registered, they tapped again on the way out. The rule:
 *
 *   - The first tap of the day is Time In, and decides Present / Late.
 *   - Every later tap moves Time Out to that tap, so once the day is over Time
 *     Out is the last tap of the day.
 *   - A tap within DUPLICATE_TAP_WINDOW_MS of the previous recorded tap is the
 *     same tap repeated, and is ignored.
 *
 * One attendance_logs row per employee per day carries this. Earlier versions
 * started a fresh row on a third tap, and hard deletes are blocked at the
 * database level, so days recorded before this fix can still have several rows.
 * collapseDailyTaps() folds those into one record so every screen and report
 * reads the same first and last tap.
 */

export const DUPLICATE_TAP_WINDOW_MS = 60 * 1000;

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
 * Decide what a new tap does to the employee's day.
 *
 * @param {Array} dayRows  every attendance_logs row for this employee today
 * @param {string} nowIso  when the card was tapped
 * @returns {{ action: "time_in" }
 *         | { action: "duplicate", record: object }
 *         | { action: "time_out", target: object, time_in: string }}
 *   `target` is the row to update: the one holding the day's first tap.
 */
export function planTap(dayRows, nowIso) {
  const rows = (dayRows || []).filter((row) => tapTimes(row).length);
  if (!rows.length) return { action: "time_in" };

  const day = collapseGroup(rows);
  const lastTap = Math.max(...rows.flatMap(tapTimes));
  const now = toTime(nowIso);

  if (now !== null && now - lastTap <= DUPLICATE_TAP_WINDOW_MS) {
    return { action: "duplicate", record: day };
  }

  const target = rows.reduce((best, row) => {
    const bestIn = toTime(best.time_in) ?? Infinity;
    const rowIn = toTime(row.time_in) ?? Infinity;
    return rowIn < bestIn ? row : best;
  });

  return { action: "time_out", target, time_in: day.time_in };
}
