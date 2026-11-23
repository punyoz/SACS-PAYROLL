/**
 * Attendance correction requests (Batch 3, 2026-11-23): the pay difference of
 * a correction whose day was already on a paid payslip. Shown to HR before
 * approving; on approval it becomes an approved adjustment on the next payslip
 * (attendance_review_correction_v2). Never deducted silently: a reduction is
 * shown the same way.
 *
 * The difference is computed with the payslip's own rate snapshot over the
 * whole attendance span it counted (so cutoff rules such as "N lates = an
 * absent" and Perfect Attendance are included), once with the day as it was
 * and once as corrected; everything else is identical.
 */
import { computeAttendancePay, peso } from "@/lib/payroll/attendance-pay";
import { attendanceSpanOf } from "@/lib/payroll/final-payslips";

const PAY_PARTS = { plus: ["perfect_attendance", "overtime", "holiday_premium"], minus: ["late", "undertime", "half_day", "absent"] };

/** The attendance part of pay: earnings and incentives minus deductions. */
export function attendanceNet(result) {
  const a = result?.amounts || {};
  const plus = PAY_PARTS.plus.reduce((t, k) => t + (Number(a[k]) || 0), 0);
  const minus = PAY_PARTS.minus.reduce((t, k) => t + (Number(a[k]) || 0), 0);
  return peso(plus - minus);
}

const shortDate = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const money = (n) => `₱${Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Pure part (tested): the difference between two versions of one day inside the
 * same span. `logs` are the span's logs; `before` / `after` replace the day.
 */
export function payDifference({ logs, logId, before, after, rates, span, leaveDays = new Set(), halfLeaveDays = new Set(), dateKey }) {
  const swap = (day) => (logs || []).map((l) => (l.id === logId ? { ...l, ...day } : l));
  const args = { rates, periodStart: span.start_key, periodEnd: span.end_key, leaveDays, halfLeaveDays };
  const b = attendanceNet(computeAttendancePay({ ...args, logs: swap(before) }));
  const a = attendanceNet(computeAttendancePay({ ...args, logs: swap(after) }));
  const diff = peso(a - b);
  if (Math.abs(diff) < 0.005) return { amount: 0 };
  const change = `${before.status} → ${after.status}`;
  const amount = Math.abs(diff);
  return {
    kind: diff > 0 ? "underpayment" : "overpayment",
    amount,
    line: `Attendance correction (${shortDate(dateKey)}): ${change}, ${diff > 0 ? "+" : "−"}${money(amount)}`,
    text: diff > 0 ? `Refund ${money(amount)}: ${change} on ${shortDate(dateKey)}` : `Deduct ${money(amount)}: ${change} on ${shortDate(dateKey)}`,
  };
}

/**
 * The pay effect of a pending request (null-safe): { processed: false } when no
 * paid payslip counted that day (the day is simply paid right when processed),
 * else { processed, entry_id, payslip_no, period, kind, amount, line, text }.
 */
export async function correctionPayEffect(supabase, correction, preview) {
  const dateKey = String(correction.log_date).slice(0, 10);
  const { data: entries } = await supabase.from("payroll_entries").select("id,employee_id,status,pay_period,payslip_no,payroll,created_at")
    .eq("employee_id", correction.employee_id).neq("status", "draft").order("created_at", { ascending: false }).limit(40);
  const entry = (entries || []).find((e) => {
    const span = attendanceSpanOf(e);
    return span && dateKey >= span.start_key && dateKey <= span.end_key;
  });
  if (!entry) return { processed: false };
  const span = attendanceSpanOf(entry);
  const payroll = typeof entry.payroll === "string" ? JSON.parse(entry.payroll) : entry.payroll;
  const rates = payroll?.audit?.rates || null;
  if (!rates) return { processed: true, entry_id: entry.id, payslip_no: entry.payslip_no, period: entry.pay_period, amount: null, text: "The paid payslip has no rate snapshot: the difference can't be computed here." };
  const [{ data: logs }, { data: leaves }] = await Promise.all([
    supabase.from("attendance_logs").select("id,employee_id,log_date,time_in,time_out,status,late_minutes,undertime_minutes,is_half_day,is_early_bird,shift_start_minutes,shift_end_minutes")
      .eq("employee_id", correction.employee_id).eq("archived_duplicate", false).gte("log_date", span.start_key).lte("log_date", span.end_key),
    supabase.from("leave_requests").select("start_date,end_date,half_day,status").eq("employee_id", correction.employee_id).eq("status", "approved")
      .lte("start_date", span.end_key).gte("end_date", span.start_key),
  ]);
  const leaveDays = new Set();
  const halfLeaveDays = new Set();
  for (const r of leaves || []) {
    for (let d = new Date(`${String(r.start_date).slice(0, 10)}T00:00:00Z`); d <= new Date(`${String(r.end_date).slice(0, 10)}T00:00:00Z`); d = new Date(d.getTime() + 864e5)) {
      (r.half_day ? halfLeaveDays : leaveDays).add(d.toISOString().slice(0, 10));
    }
  }
  const pick = (v) => ({ status: v.status, time_in: v.time_in, time_out: v.time_out, late_minutes: Number(v.late_minutes) || 0, undertime_minutes: Number(v.undertime_minutes) || 0, is_half_day: Boolean(v.is_half_day) });
  // Before: the stored day (its minutes and flags are untouched while pending) with its original status.
  const stored = (logs || []).find((l) => l.id === correction.log_id) || preview.before;
  const before = pick({ ...stored, status: correction.original_status, time_in: correction.original_time_in, time_out: correction.original_time_out });
  const effect = payDifference({ logs: logs || [], logId: correction.log_id, before, after: pick(preview.after), rates, span, leaveDays, halfLeaveDays, dateKey });
  return { processed: true, entry_id: entry.id, payslip_no: entry.payslip_no, period: entry.pay_period, ...effect };
}
