/**
 * When a payslip may be generated for a pay period (all dates Asia/Manila).
 *
 *   opens_on   3 days before the period's last day (Oct 1-15 -> Oct 12)
 *   pay_date   the first Pay Calendar date (System Configuration -> Payroll)
 *              on or after the period's last day, within PAY_CALENDAR_SEARCH_DAYS;
 *              without one, DEFAULT_PAY_DATE_OFFSET_DAYS after the last day
 *
 *   before opens_on            "not_open"  generation refused
 *   opens_on .. period end     "draft"     a Draft, counting attendance up to today
 *   after period end .. pay    "final"     a Final payslip, locked once written
 *   after pay_date             "closed"    only a Super Admin override
 *
 * The API enforces this (src/app/api/accountant/payroll/route.js); the portal
 * only mirrors it to disable the buttons.
 */

import { manilaDateKey } from "@/lib/payroll/periods";

export const GENERATION_LEAD_DAYS = 3;
export const DEFAULT_PAY_DATE_OFFSET_DAYS = 5;
export const PAY_CALENDAR_SEARCH_DAYS = 20;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "YYYY-MM-DD" + n days (calendar arithmetic, no timezone involved). */
export function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "2026-10-12" -> "Oct 12, 2026". */
export function formatDateKey(dateKey) {
  const [y, m, d] = String(dateKey || "").split("-").map(Number);
  if (!y || !m || !d) return String(dateKey || "");
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** The pay date for a period ending on `endKey`. */
export function payDateFor(endKey, payCalendar = []) {
  const limit = addDays(endKey, PAY_CALENDAR_SEARCH_DAYS);
  const scheduled = (Array.isArray(payCalendar) ? payCalendar : [])
    .map((value) => String(value || "").slice(0, 10))
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key) && key >= endKey && key <= limit)
    .sort()[0];
  return { pay_date: scheduled || addDays(endKey, DEFAULT_PAY_DATE_OFFSET_DAYS), scheduled: Boolean(scheduled) };
}

/**
 * @param {{ start_key: string, end_key: string, label?: string }} period
 * @param {{ today?: string, payCalendar?: string[] }} [options]
 */
export function generationWindow(period, { today = manilaDateKey(), payCalendar = [] } = {}) {
  const opensOn = addDays(period.end_key, -GENERATION_LEAD_DAYS);
  const { pay_date: payDate, scheduled } = payDateFor(period.end_key, payCalendar);

  let state;
  let message;
  if (today < opensOn) {
    state = "not_open";
    message = `Payslip generation opens on ${formatDateKey(opensOn)}.`;
  } else if (today <= period.end_key) {
    state = "draft";
    message = `Generates a Draft that includes attendance up to ${formatDateKey(today)}. It becomes Final when generated after ${formatDateKey(period.end_key)}.`;
  } else if (today <= payDate) {
    state = "final";
    message = `The period has ended: generating now creates the Final payslip, locked once saved. Open until the pay date, ${formatDateKey(payDate)}.`;
  } else {
    state = "closed";
    message = `Payslip generation closed on the pay date, ${formatDateKey(payDate)}. A Super Admin override is needed.`;
  }

  return {
    state,
    can_generate: state === "draft" || state === "final",
    opens_on: opensOn,
    period_start: period.start_key,
    period_end: period.end_key,
    pay_date: payDate,
    pay_date_scheduled: scheduled,
    // Attendance is counted up to here: days that have not happened yet are
    // never absences.
    attendance_through: today < period.end_key ? today : period.end_key,
    today,
    message,
  };
}

/** The Pay Calendar dates (system_config payroll.pay_calendar), [] when unset or unreadable. */
export async function loadPayCalendar(supabase) {
  try {
    const result = await supabase
      .from("system_config")
      .select("value")
      .eq("section", "payroll")
      .eq("key", "pay_calendar")
      .limit(1);
    if (result.error) return [];
    const raw = (result.data || [])[0]?.value;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}
