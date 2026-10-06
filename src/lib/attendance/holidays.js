/**
 * Holidays (public.attendance_holidays): the days besides Saturday and Sunday
 * on which nobody is marked Absent, Late or Incomplete.
 *
 *   type "holiday"  regular holiday (regular_holiday_premium_pct when worked)
 *   type "special"  special non-working day (special_holiday_premium_pct)
 *
 * The nightly close and the payroll read this table. Super Admin keeps it
 * up to date from each year's proclamation (System Configuration ->
 * Holidays, /api/admin/holidays).
 */

export const HOLIDAY_TYPES = Object.freeze(["holiday", "special"]);
export const HOLIDAY_NAME_MAX = 100;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in "YYYY-MM-DD" form. */
export function isValidDateKey(value) {
  const key = String(value || "");
  if (!DATE_KEY.test(key)) return false;
  const date = new Date(`${key}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key;
}

/** Validation for a new holiday. Returns an error message, or null. */
export function validateHolidayInput({ holiday_date: date, name, type } = {}) {
  if (!isValidDateKey(date)) return "Choose the holiday's date.";
  const label = String(name ?? "").trim();
  if (!label) return "Enter the holiday's name.";
  if (label.length > HOLIDAY_NAME_MAX) return `The name can be at most ${HOLIDAY_NAME_MAX} characters.`;
  if (!HOLIDAY_TYPES.includes(String(type || ""))) return "Choose Regular Holiday or Special Non-Working Day.";
  return null;
}

/**
 * Holidays between two date keys: Map of date key -> { name, type }.
 * An empty map when the table cannot be read.
 */
export async function readHolidayMap(supabase, startKey, endKey) {
  try {
    const result = await supabase
      .from("attendance_holidays")
      .select("holiday_date,name,type")
      .gte("holiday_date", startKey)
      .lte("holiday_date", endKey);
    if (result.error) return new Map();
    return new Map((result.data || []).map((row) => [
      String(row.holiday_date).slice(0, 10),
      { name: String(row.name || "Holiday"), type: row.type === "special" ? "special" : "holiday" },
    ]));
  } catch {
    return new Map();
  }
}
