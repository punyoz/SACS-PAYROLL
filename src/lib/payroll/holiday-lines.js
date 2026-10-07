/**
 * The holiday premium a payslip paid, one line per holiday worked: which
 * holiday, the day, the hours it paid for and the amount. Read from the
 * payslip's own computation (payroll.audit.lines.incentives, type
 * "holiday_premium", src/lib/payroll/attendance-pay.js), so a payslip, its
 * PDF and the Holiday Work report always agree with what was paid.
 *
 * Payslips computed before the lines carried a name and hours still list
 * their days; the name then reads "Regular holiday" / "Special day".
 */

import { roundPeso } from "@/lib/payroll/money";

const TYPE_FALLBACK = { holiday: "Regular holiday", special: "Special day" };

/** "Bonifacio Day · 8 hrs" (the stored note) -> "Bonifacio Day". */
function nameFromNote(note) {
  const text = String(note || "");
  const at = text.lastIndexOf(" · ");
  return at > 0 ? text.slice(0, at) : "";
}

/**
 * @param {object} payroll  payroll_entries.payroll
 * @returns {Array<{ date: string|null, name: string, type: string, hours: number|null, amount: number }>}
 *   oldest day first.
 */
export function holidayPayLines(payroll) {
  const lines = payroll?.audit?.lines?.incentives;
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((line) => line?.type === "holiday_premium" && Number(line.amount) > 0)
    .map((line) => {
      const type = line.holiday_type === "special" ? "special" : "holiday";
      const hours = Number.isFinite(Number(line.hours))
        ? Number(line.hours)
        : Number.isFinite(Number(line.quantity)) ? Math.round(Number(line.quantity) * 8 * 100) / 100 : null;
      return {
        date: line.log_date ? String(line.log_date).slice(0, 10) : null,
        name: String(line.holiday_name || nameFromNote(line.note) || TYPE_FALLBACK[type]),
        type,
        hours,
        amount: roundPeso(line.amount),
      };
    })
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

/** "Nov 30" for a date key (Manila calendar day). */
export function shortHolidayDate(dateKey) {
  if (!dateKey) return "";
  const date = new Date(`${dateKey}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" }).format(date);
}

/** "Bonifacio Day, Nov 30 (8 h)". */
export function describeHolidayLine(line) {
  const when = shortHolidayDate(line?.date);
  const hours = line?.hours !== null && line?.hours !== undefined ? ` (${line.hours} h)` : "";
  return `${line?.name || "Holiday"}${when ? `, ${when}` : ""}${hours}`;
}
