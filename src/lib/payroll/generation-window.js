/**
 * When a payslip may be generated for a pay period (all dates Asia/Manila).
 *
 *   opens_on   the period's last day (Oct 1-15 -> Oct 15): the generation day
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

export const GENERATION_LEAD_DAYS = 0;
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
 * With the payslip schedule (src/lib/payroll/schedule.js): generation opens
 * on the period's generation date and stays open window_days. The attendance
 * a payslip counts is complete on that day (the generation day itself
 * carries to the next window), so every payslip generated is Final.
 *
 *   before generation_date     "not_open"  "Payslip generation on Oct 15, 2026."
 *   generation_date..closes_on "final"     Final payslip, locked once written
 *   after closes_on            "closed"    only a Super Admin override
 */
export function scheduledGenerationWindow(period, schedule, { today = manilaDateKey(), payCalendar = [] } = {}) {
  const { pay_date: payDate, scheduled } = payDateFor(period.end_key, payCalendar);
  const opensOn = schedule.generation_date;
  const closesOn = schedule.closes_on;
  const range = `${formatDateKey(opensOn)}${closesOn !== opensOn ? ` – ${formatDateKey(closesOn)}` : ""}`;

  let state;
  let message;
  if (today < opensOn) {
    state = "not_open";
    message = `Payslip generation on ${formatDateKey(opensOn)} (open until ${formatDateKey(closesOn)}).`;
  } else if (today <= closesOn) {
    state = "final";
    message = `Payslip generation is open ${range}: generating creates the Final payslip, locked once saved.`;
  } else {
    state = "closed";
    message = `Payslip generation closed on ${formatDateKey(closesOn)}. A Super Admin override is needed.`;
  }

  return {
    state,
    can_generate: state === "final",
    scheduled: true,
    opens_on: opensOn,
    closes_on: closesOn,
    generation_date: opensOn,
    period_start: period.start_key,
    period_end: period.end_key,
    pay_date: payDate,
    pay_date_scheduled: scheduled,
    // 2nd half: the cut-off before the generation day; 1st half deducts nothing.
    attendance_through: schedule.attendance_cutoff || (today < period.end_key ? today : period.end_key),
    attendance_cutoff: schedule.attendance_cutoff || null,
    today,
    message,
    // "October 1-15, 2026: Payslip generation on Oct 15, 2026 · open until Oct 19, 2026"
    banner: `${period.label || `${formatDateKey(period.start_key)} – ${formatDateKey(period.end_key)}`}: Payslip generation on ${formatDateKey(opensOn)} · open until ${formatDateKey(closesOn)}`,
  };
}

/**
 * @param {{ start_key: string, end_key: string, label?: string }} period
 * @param {{ today?: string, payCalendar?: string[], schedule?: object|null }} [options]
 *   schedule: payslipSchedule.forPeriod(period.start_key); without it (the
 *   migration not applied yet) the original window below (opens on the period's last day).
 */
export function generationWindow(period, { today = manilaDateKey(), payCalendar = [], schedule = null } = {}) {
  if (schedule) return scheduledGenerationWindow(period, schedule, { today, payCalendar });
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
