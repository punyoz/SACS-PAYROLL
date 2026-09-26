/**
 * Semi-monthly pay periods (1-15 and 16-end of month), worked on "YYYY-MM-DD"
 * keys so the answer never depends on the server's timezone.
 *
 * Labels match the ones the accountant payroll route has always produced
 * ("September 16-30, 2026"), because payroll_entries.pay_period stores them.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n) => String(n).padStart(2, "0");

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Today's date in Asia/Manila as "YYYY-MM-DD". */
export function manilaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

/** The pay period containing a date key. */
export function periodForDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const monthIndex = month - 1;
  const firstHalf = day <= 15;
  const startDay = firstHalf ? 1 : 16;
  const endDay = firstHalf ? 15 : daysInMonth(year, monthIndex);
  return {
    start_key: `${year}-${pad(month)}-${pad(startDay)}`,
    end_key: `${year}-${pad(month)}-${pad(endDay)}`,
    label: `${MONTHS[monthIndex]} ${startDay}-${endDay}, ${year}`,
  };
}

/** "September 16-30, 2026" -> its range, or null when it is not a period label. */
export function periodFromLabel(label) {
  const match = /^([A-Za-z]+)\s+(\d{1,2})-(\d{1,2}),\s*(\d{4})$/.exec(String(label || "").trim());
  if (!match) return null;
  const monthIndex = MONTHS.findIndex((name) => name.toLowerCase() === match[1].toLowerCase());
  if (monthIndex < 0) return null;
  const year = Number(match[4]);
  const period = periodForDateKey(`${year}-${pad(monthIndex + 1)}-${pad(Number(match[2]))}`);
  // Only a real period's own label round-trips ("September 1-15", not "September 3-9").
  return period.label === `${MONTHS[monthIndex]} ${Number(match[2])}-${Number(match[3])}, ${year}` ? period : null;
}

/** The period right after the one containing a date key. */
export function nextPeriod(dateKey) {
  const current = periodForDateKey(dateKey);
  const end = new Date(`${current.end_key}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return periodForDateKey(end.toISOString().slice(0, 10));
}

/** Every date key from start to end, inclusive. */
export function dateKeysBetween(startKey, endKey) {
  const keys = [];
  const cursor = new Date(`${startKey}T00:00:00Z`);
  const end = new Date(`${endKey}T00:00:00Z`);
  while (cursor <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}
