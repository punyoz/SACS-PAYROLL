/**
 * The payslip schedule (Super Admin → Payslip Schedule;
 * public.payroll_schedule_settings, 20261009010000). All dates Asia/Manila
 * "YYYY-MM-DD" keys.
 *
 *   Generation day   1st half: the 15th · 2nd half: the month's last day
 *                    (both configurable, effective-dated per pay period)
 *   Weekend/holiday  set per half: 1st half next working day (default),
 *                    2nd half previous working day (default, so it stays in
 *                    the month); either may be same day / previous / next
 *                    working day — a rest day is a Sat/Sun or a whole-day
 *                    holiday / suspension, as attendance_is_rest_day()
 *   Window           generation day .. + window_days − 1 (default 5)
 *   Attendance       the 2nd half deducts attendance up to the day BEFORE its
 *                    generation day; the generation day itself carries to the
 *                    next month's window (the processing-day rule). The
 *                    1st half deducts nothing.
 *
 * This mirrors public.payroll_generation_date_for() / payroll_schedule_for()
 * so the payroll can read any month's cut-off without a query per month.
 * It replaces the attendance_lock_day rate once the migration is applied;
 * until then loadPayslipSchedule() returns null and callers keep the rate.
 */

export const DEFAULT_WINDOW_DAYS = 5;
export const DEFAULT_NON_WORKING_DAY_RULE = "previous_working_day";
// The 1st half deducts nothing, so a weekend 15th moves forward (Sun Nov 15,
// 2026 -> Mon Nov 16); the 2nd half keeps DEFAULT_NON_WORKING_DAY_RULE.
export const DEFAULT_FIRST_HALF_RULE = "next_working_day";
export const NON_WORKING_DAY_RULES = Object.freeze(["same_day", "previous_working_day", "next_working_day"]);

const pad = (n) => String(n).padStart(2, "0");

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isWeekend(dateKey) {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** The settings version in force for a period (newest effective_from, then newest saved). */
export function settingsFor(periodStart, settingsRows = []) {
  return [...(settingsRows || [])]
    .filter((row) => String(row.effective_from || "").slice(0, 10) <= periodStart)
    .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from))
      || String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
}

/** The weekend / holiday rule for the period's half. */
export function ruleFor(periodStart, settings = {}) {
  return String(periodStart).slice(8, 10) === "01"
    ? settings?.first_half_rule || DEFAULT_FIRST_HALF_RULE
    : settings?.non_working_day_rule || DEFAULT_NON_WORKING_DAY_RULE;
}

/**
 * The generation date of one period under the given settings.
 * @param {string} periodStart  "YYYY-MM-01" or "YYYY-MM-16"
 * @param {{ first_half_day?: number|null, second_half_day?: number|null, first_half_rule?: string, non_working_day_rule?: string }} settings
 *   non_working_day_rule governs the 2nd half, first_half_rule the 1st.
 * @param {(dateKey: string) => boolean} isWholeDayHoliday
 */
export function generationDateFor(periodStart, settings = {}, isWholeDayHoliday = () => false) {
  const [year, month] = periodStart.split("-").map(Number);
  const last = lastDayOfMonth(year, month);
  const first = periodStart.slice(8, 10) === "01";
  const wanted = first
    ? Number(settings?.first_half_day) || 15
    : Math.min(Number(settings?.second_half_day) || 31, last);
  let day = `${year}-${pad(month)}-${pad(Math.min(wanted, last))}`;

  const rule = ruleFor(periodStart, settings);
  const isRestDay = (key) => isWeekend(key) || isWholeDayHoliday(key);
  for (let steps = 0; rule !== "same_day" && isRestDay(day) && steps < 14; steps += 1) {
    day = addDays(day, rule === "previous_working_day" ? -1 : 1);
  }
  return day;
}

/**
 * @param {{ settings?: Array, holidays?: Array<{ holiday_date: string, day_part?: string }> }} source
 *   settings: payroll_schedule_settings rows; holidays: attendance_holidays rows
 */
export function createPayslipSchedule({ settings = [], holidays = [] } = {}) {
  const wholeDays = new Set((holidays || [])
    .filter((row) => (row.day_part || "whole") === "whole")
    .map((row) => String(row.holiday_date).slice(0, 10)));
  const isWholeDayHoliday = (key) => wholeDays.has(key);

  function forPeriod(periodStart) {
    const setting = settingsFor(periodStart, settings);
    const windowDays = Number(setting?.window_days) || DEFAULT_WINDOW_DAYS;
    const generationDate = generationDateFor(periodStart, setting || {}, isWholeDayHoliday);
    const [year, month] = periodStart.split("-").map(Number);
    const monthEnd = `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`;
    const dayBefore = addDays(generationDate, -1);
    return {
      period_start: periodStart,
      generation_date: generationDate,
      closes_on: addDays(generationDate, windowDays - 1),
      window_days: windowDays,
      non_working_day_rule: ruleFor(periodStart, setting || {}),
      // Only the 2nd half deducts attendance.
      attendance_cutoff: periodStart.slice(8, 10) === "16" ? (dayBefore < monthEnd ? dayBefore : monthEnd) : null,
      setting_id: setting?.id || null,
    };
  }

  /** Day of the month the month's 2nd half reads attendance to (for semi-monthly.js lockDayFor). */
  function lockDayFor(monthKey) {
    return Number(forPeriod(`${monthKey}-16`).attendance_cutoff.slice(8, 10));
  }

  return { forPeriod, lockDayFor, isWholeDayHoliday };
}

function isMissingRelation(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("42p01") || text.includes("pgrst205") || text.includes("does not exist")
    || text.includes("could not find the table") || text.includes("schema cache");
}

/**
 * Reads the settings and whole-day holidays. Returns null when the schedule
 * tables are not there yet (migration not applied): callers keep the old
 * attendance_lock_day behaviour (window opens on the period's last day).
 */
export async function loadPayslipSchedule(supabase) {
  const [settingsResult, holidayResult] = await Promise.all([
    supabase.from("payroll_schedule_settings")
      .select("id,effective_from,first_half_day,second_half_day,window_days,first_half_rule,non_working_day_rule,created_at"),
    supabase.from("attendance_holidays").select("holiday_date,day_part"),
  ]);
  if (settingsResult.error) {
    if (isMissingRelation(settingsResult.error)) return null;
    throw new Error(settingsResult.error.message);
  }
  if (holidayResult.error) throw new Error(holidayResult.error.message);
  return createPayslipSchedule({ settings: settingsResult.data || [], holidays: holidayResult.data || [] });
}
