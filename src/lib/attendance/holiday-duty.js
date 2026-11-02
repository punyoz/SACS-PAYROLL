/**
 * Holiday duty (20261102010000).
 *
 * School rule (decided 2026-11-02): on a holiday the school is CLOSED.
 * Required hours are 0 for everyone and the day is never an absence, late or
 * undertime. HR may require specific staff to report (guards, maintenance,
 * registrar, event duty): public.holiday_duty_assignments, one row per
 * employee per holiday, with the shift and an optional note.
 *
 *   assigned + worked     paid the holiday premium (payroll)
 *   assigned + no tap     flagged for HR's decision, never deducted by itself
 *   not assigned + taps   flagged for HR: approved (public.holiday_work_reviews)
 *                         = paid the premium; rejected or pending = not
 *
 * Only HR creates or changes assignments and decisions (/api/holiday-duty);
 * every change is written to public.holiday_duty_history with who made it.
 */

export const DUTY_NOTE_MAX = 200;
export const DUTY_MAX_HOURS = 12;
export const ASSIGN_VIA = Object.freeze(["employee", "branch", "position"]);
export const WORK_DECISIONS = Object.freeze(["approved", "rejected"]);

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "08:00" / "08:00:00" -> minutes after midnight, or null. */
export function minutesOf(value) {
  const match = HHMM.exec(String(value || "").slice(0, 5));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Required hours for a duty shift: the span, less a one-hour meal break when
 * the span is over 5 hours (08:00-17:00 = 8 hours, as the normal shift).
 */
export function dutyHours(start, end) {
  const a = minutesOf(start);
  const b = minutesOf(end);
  if (a === null || b === null || b <= a) return 0;
  const span = (b - a) / 60;
  return Math.round((span > 5 ? span - 1 : span) * 100) / 100;
}

/** Validation for an assignment's shift and note. Returns an error message, or null. */
export function validateDutyInput({ shift_start: start, shift_end: end, note, required_hours: hours } = {}) {
  if (minutesOf(start) === null) return "Enter the start of the duty shift (HH:MM).";
  if (minutesOf(end) === null) return "Enter the end of the duty shift (HH:MM).";
  if (minutesOf(end) <= minutesOf(start)) return "The duty shift must end after it starts.";
  if (hours !== undefined && hours !== null && hours !== "") {
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0 || value > DUTY_MAX_HOURS) return `Required hours must be more than 0 and at most ${DUTY_MAX_HOURS}.`;
  } else if (dutyHours(start, end) <= 0) {
    return "The duty shift is too short.";
  }
  if (note !== undefined && note !== null && String(note).length > DUTY_NOTE_MAX) return `The note can be at most ${DUTY_NOTE_MAX} characters.`;
  return null;
}

const keyOf = (value) => String(value || "").slice(0, 10);

/**
 * One employee's duty for a date range: { assignments: Map(date -> row),
 * reviews: Map(date -> { decision, note, decided_by_name }) }. Empty maps when
 * the tables are not there yet (migration not applied).
 */
export async function loadEmployeeDuty(supabase, employeeId, from, to) {
  const assignments = new Map();
  const reviews = new Map();
  try {
    const [duty, review] = await Promise.all([
      supabase.from("holiday_duty_assignments")
        .select("holiday_date,shift_start,shift_end,required_hours,note,assigned_by_name")
        .eq("employee_id", employeeId).gte("holiday_date", from).lte("holiday_date", to),
      supabase.from("holiday_work_reviews")
        .select("holiday_date,decision,note,decided_by_name")
        .eq("employee_id", employeeId).gte("holiday_date", from).lte("holiday_date", to),
    ]);
    (duty.error ? [] : duty.data || []).forEach((row) => assignments.set(keyOf(row.holiday_date), row));
    (review.error ? [] : review.data || []).forEach((row) => reviews.set(keyOf(row.holiday_date), row));
  } catch {
    // Supplementary: without the tables there is no duty and no review.
  }
  return { assignments, reviews };
}

/**
 * For payroll: employee id -> { assigned: Set(date), approved: Set(date) }
 * over a period. A holiday premium is paid only for a date in either set.
 * `available` is false when the tables cannot be read (migration not
 * applied): payroll then keeps the earlier rule (any worked holiday is paid).
 */
export async function loadDutyForPeriod(supabase, from, to) {
  const byEmployee = new Map();
  const entry = (id) => {
    if (!byEmployee.has(id)) byEmployee.set(id, { assigned: new Set(), approved: new Set() });
    return byEmployee.get(id);
  };
  try {
    const [duty, review] = await Promise.all([
      supabase.from("holiday_duty_assignments").select("employee_id,holiday_date").gte("holiday_date", from).lte("holiday_date", to),
      supabase.from("holiday_work_reviews").select("employee_id,holiday_date,decision").gte("holiday_date", from).lte("holiday_date", to),
    ]);
    if (duty.error || review.error) return { available: false, byEmployee };
    (duty.data || []).forEach((row) => entry(String(row.employee_id)).assigned.add(keyOf(row.holiday_date)));
    (review.data || []).filter((row) => row.decision === "approved")
      .forEach((row) => entry(String(row.employee_id)).approved.add(keyOf(row.holiday_date)));
    return { available: true, byEmployee };
  } catch {
    return { available: false, byEmployee };
  }
}
