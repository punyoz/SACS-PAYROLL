/**
 * Special working days (20261124130000, 2026-11-23): pure helpers shared by
 * the API, payroll and the pages. The database decides the schedule
 * (special_working_day_for / attendance_schedule_for); this mirrors who is
 * covered, for notifications, lists and the extra-day pay.
 */
export const SPECIAL_DAY_AUDIENCES = Object.freeze({ all: "Everyone", teaching: "Teaching staff", non_teaching: "Non-Teaching staff", employees: "Chosen employees" });
export const SPECIAL_DAY_PAY = Object.freeze({ makeup: "Make-up / regular working day", extra: "Extra working day (paid on top)" });

/** True when the day covers this person (same rule as special_working_day_for). */
export function coveredBySpecialDay(day, person) {
  if (!day || day.cancelled_at || !person) return false;
  const branches = day.branch_ids || [];
  if (branches.length && !branches.includes(person.branch_id)) return false;
  if (day.audience === "all") return true;
  if (day.audience === "teaching") return person.employee_type === "Teaching";
  if (day.audience === "non_teaching") return person.employee_type === "Non-Teaching";
  return (day.employee_ids || []).includes(person.id);
}

const time12 = (t) => {
  const [h, m] = String(t || "").split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/** "Sat Nov 28", "Make-up working day", "8:00 AM–12:00 PM", "Teaching staff". */
export function specialDayLabel(day) {
  const date = new Date(`${day.work_date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).replace(",", "");
  return {
    date,
    kind: day.pay_type === "extra" ? "Extra working day" : "Make-up working day",
    hours: `${time12(day.start_time)}–${time12(day.end_time)}`,
    who: SPECIAL_DAY_AUDIENCES[day.audience] || "Chosen employees",
  };
}

/**
 * Pure (tested): the extra-day pay lines for one employee in a payslip span.
 * Paid only on a covered extra day the employee tapped in on: daily rate × premium_pct / 100.
 */
export function extraDayLines({ days = [], person, logs = [], dailyRate = 0, spanStart, spanEnd }) {
  const tapped = new Set(logs.filter((l) => l.time_in).map((l) => String(l.log_date).slice(0, 10)));
  return days
    .filter((d) => d.pay_type === "extra" && d.work_date >= spanStart && d.work_date <= spanEnd && coveredBySpecialDay(d, person) && tapped.has(d.work_date))
    .map((d) => {
      const amount = Math.round(Number(dailyRate) * (Number(d.premium_pct) || 130)) / 100;
      const l = specialDayLabel(d);
      return { work_date: d.work_date, amount, pct: Number(d.premium_pct) || 130, note: `Special working day (${l.date}): ${d.reason}, ${l.hours}, ${Number(d.premium_pct) || 130}% of the daily rate` };
    });
}
