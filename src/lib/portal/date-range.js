/**
 * Date ranges for the attendance lists (alpha test A1, 2026-11-09), in
 * Manila days ("YYYY-MM-DD"). Shared by DateRangeFilter and the API routes.
 */

import { isDateKey, manilaDateKey, periodForDateKey } from "@/lib/payroll/periods";

/** Longest range a list may ask for (one year). */
export const MAX_RANGE_DAYS = 366;

export function addDaysKey(key, days) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

function monthRange(key) {
  const [y, m] = key.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${key.slice(0, 7)}-01`, to: `${key.slice(0, 7)}-${String(last).padStart(2, "0")}` };
}

/** The quick choices, as of `today` (Manila). */
export function rangePresets(today = manilaDateKey()) {
  const cutoff = periodForDateKey(today);
  const lastCutoff = periodForDateKey(addDaysKey(cutoff.start_key, -1));
  const month = monthRange(today);
  const lastMonth = monthRange(addDaysKey(month.from, -1));
  return [
    { id: "this_cutoff", label: "This cutoff", from: cutoff.start_key, to: cutoff.end_key },
    { id: "last_cutoff", label: "Last cutoff", from: lastCutoff.start_key, to: lastCutoff.end_key },
    { id: "this_month", label: "This month", from: month.from, to: month.to },
    { id: "last_month", label: "Last month", from: lastMonth.from, to: lastMonth.to },
  ];
}

/** The default range: this cutoff. */
export function defaultRange(today = manilaDateKey()) {
  const { from, to } = rangePresets(today)[0];
  return { from, to };
}

/**
 * A range as asked for, checked. Returns { from, to, error } -- error is a
 * sentence to show (To before From, a missing date, longer than `maxDays`).
 */
export function checkRange({ from, to } = {}, maxDays = MAX_RANGE_DAYS) {
  if (!isDateKey(from) || !isDateKey(to)) return { from, to, error: "Choose both a From and a To date." };
  if (to < from) return { from, to, error: "The To date is before the From date." };
  const days = daysBetween(from, to);
  if (days > maxDays) return { from, to, error: `Choose ${maxDays} days or fewer (this range is ${days} days).` };
  return { from, to, error: null };
}

/** Page and page size from a URL, within bounds. */
export function pageParams(url, { defaultSize = 25, maxSize = 100 } = {}) {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
  const size = Math.min(maxSize, Math.max(1, Math.floor(Number(url.searchParams.get("page_size")) || defaultSize)));
  return { page, size, offset: (page - 1) * size };
}
