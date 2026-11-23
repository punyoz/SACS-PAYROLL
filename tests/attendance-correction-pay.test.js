// Attendance correction requests (2026-11-23): the pay difference shown to HR
// and put on the next payslip. Refund and reduction cases.
import { describe, it, expect } from "vitest";
import { countedSpan, payDifference } from "@/lib/attendance/correction-pay";

const rates = { daily: 1000, hourly: 125, absent_pct: 100, half_day_pct: 50, late_minute_charge_pct: 100, late_days_per_absent: 0, perfect_attendance_bonus: 0 };
const span = { start_key: "2026-11-01", end_key: "2026-11-15" };
const day = (id, date, over = {}) => ({ id, log_date: date, status: "On Time", time_in: `${date}T00:00:00Z`, time_out: `${date}T09:00:00Z`, late_minutes: 0, undertime_minutes: 0, is_half_day: false, ...over });
const logs = [day("a", "2026-11-03"), day("b", "2026-11-05", { status: "Absent", time_in: null, time_out: null }), day("c", "2026-11-06")];

describe("attendance correction pay difference", () => {
  it("refund: an Absent day corrected to present gives the day's deduction back", () => {
    const r = payDifference({ logs, logId: "b", dateKey: "2026-11-05", rates, span,
      before: { status: "Absent", time_in: null, time_out: null, late_minutes: 0, undertime_minutes: 0, is_half_day: false },
      after: { status: "On Time", time_in: "2026-11-05T00:00:00Z", time_out: "2026-11-05T09:00:00Z", late_minutes: 0, undertime_minutes: 0, is_half_day: false } });
    expect(r.kind).toBe("underpayment");
    expect(r.amount).toBe(1000);
    expect(r.line).toBe("Attendance correction (Nov 5): Absent → On Time, +₱1,000.00");
    expect(r.text).toMatch(/^Refund ₱1,000\.00/);
  });

  it("reduction: a correction that adds late minutes is shown as a deduction, never silent", () => {
    const r = payDifference({ logs, logId: "c", dateKey: "2026-11-06", rates, span,
      before: { status: "On Time", time_in: "2026-11-06T00:00:00Z", time_out: "2026-11-06T09:00:00Z", late_minutes: 0, undertime_minutes: 0, is_half_day: false },
      after: { status: "Late", time_in: "2026-11-06T00:30:00Z", time_out: "2026-11-06T09:00:00Z", late_minutes: 30, undertime_minutes: 0, is_half_day: false } });
    expect(r.kind).toBe("overpayment");
    expect(r.amount).toBeGreaterThan(0);
    expect(r.line).toMatch(/^Attendance correction \(Nov 6\): On Time → Late, −₱/);
    expect(r.text).toMatch(/^Deduct ₱/);
  });

  it("no change in pay: nothing to adjust", () => {
    const same = { status: "On Time", time_in: "2026-11-03T00:00:00Z", time_out: "2026-11-03T09:05:00Z", late_minutes: 0, undertime_minutes: 0, is_half_day: false };
    expect(payDifference({ logs, logId: "a", dateKey: "2026-11-03", rates, span, before: same, after: same }).amount).toBe(0);
  });
});

describe("which paid payslip counted the day", () => {
  it("a 1st half counts its window only under the per-cutoff rule; semi-monthly leaves it to the 2nd half", () => {
    const w = { start_key: "2026-10-01", end_key: "2026-10-14" };
    expect(countedSpan({ payroll: { monthly: { half: "first", rule: "per_cutoff", window: w } } })).toEqual(w);
    expect(countedSpan({ payroll: { monthly: { half: "first", rule: "semi_monthly", window: w } } })).toBeNull();
    expect(countedSpan({ payroll: { monthly: { half: "second", window: { start_key: "2026-10-01", end_key: "2026-10-31" } } } })).toEqual({ start_key: "2026-10-01", end_key: "2026-10-31" });
  });
});
