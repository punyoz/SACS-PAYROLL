// Part B step 2 (2026-11-22): a half-day leave counts as 0.5 day everywhere leave is counted.
import { describe, expect, it } from "vitest";
import { requestDays } from "@/lib/leave-requests/split";
import { normalizeLeaveRequest } from "@/lib/leave-requests/store";
import { computeAttendancePay } from "@/lib/payroll/attendance-pay";
import { DEFAULT_RATES } from "@/lib/payroll/rates";
import { leaveApprovedAfterFinal } from "@/lib/payroll/final-payslips";

describe("half-day leave counting", () => {
  it("a half day is 0.5; a whole-day request keeps the inclusive count", () => {
    expect(requestDays({ start_date: "2026-11-24", end_date: "2026-11-24", half_day: "AM" })).toBe(0.5);
    expect(requestDays({ start_date: "2026-11-24", end_date: "2026-11-24", half_day: "PM" })).toBe(0.5);
    expect(requestDays({ start_date: "2026-11-24", end_date: "2026-11-26" })).toBe(3);
    expect(requestDays({ start_date: "2026-11-24" })).toBe(1);
  });

  it("only AM or PM is kept on a request", () => {
    expect(normalizeLeaveRequest({ half_day: "AM" }).half_day).toBe("AM");
    expect(normalizeLeaveRequest({ half_day: "noon" }).half_day).toBeNull();
    expect(normalizeLeaveRequest({}).half_day).toBeNull();
  });
});

describe("half-day leave in payroll", () => {
  const rates = Object.fromEntries(Object.entries({ ...DEFAULT_RATES, daily: 800, hourly: 100, absent_pct: 100 }).map(([t, value]) => [t, { value, config_id: `cfg-${t}` }]));
  const absent = (id, date) => ({ id, log_date: date, status: "Absent", late_minutes: 0, undertime_minutes: 0, is_half_day: false, time_in: null, time_out: null });
  const pay = (extra = {}) => computeAttendancePay({ logs: [absent("a", "2026-11-17")], rates, periodStart: "2026-11-16", periodEnd: "2026-11-30", ...extra });

  it("an Absent on a half-day leave day deducts half a day (the other half is the leave)", () => {
    const line = pay({ halfLeaveDays: new Set(["2026-11-17"]) }).deductions.find((d) => d.type === "absent");
    expect(line).toMatchObject({ quantity: 0.5, amount: 400, note: "Half-day leave: the worked half missed" });
  });

  it("without a half-day leave the Absent is a whole day; a whole-day leave is never an absence", () => {
    expect(pay().deductions.find((d) => d.type === "absent")).toMatchObject({ quantity: 1, amount: 800 });
    expect(pay({ leaveDays: new Set(["2026-11-17"]) }).deductions.find((d) => d.type === "absent")).toBeUndefined();
  });
});

describe("leave approved after its day's Final payslip (Action needed)", () => {
  const entry = (o = {}) => ({ id: "e1", employee_id: "u1", status: "paid", payslip_no: "PS-202611-0003", pay_period: "November 1-15, 2026",
    payroll: { audit: { period: { start_key: "2026-11-01", end_key: "2026-11-15" } }, generation: { generated_at: "2026-11-16T02:00:00Z" } }, ...o });
  const leave = (o = {}) => ({ id: "l1", employee_id: "u1", employee_name: "Bea Cruz", leave_type: "Sick Leave", start_date: "2026-11-10", end_date: "2026-11-10", status: "approved", half_day: "AM", decided_at: "2026-11-18T01:00:00Z", ...o });

  it("lists a half day approved after the payslip that counted its day", () => {
    expect(leaveApprovedAfterFinal([leave()], [entry()])).toEqual([expect.objectContaining({
      leave_id: "l1", full_name: "Bea Cruz", payslip_no: "PS-202611-0003", detail: "Sick Leave 2026-11-10 (AM half day) · after PS-202611-0003",
    })]);
  });

  it("not when approved before the payslip, outside its days, not Final, or not approved", () => {
    expect(leaveApprovedAfterFinal([leave({ decided_at: "2026-11-15T01:00:00Z" })], [entry()])).toEqual([]);
    expect(leaveApprovedAfterFinal([leave({ start_date: "2026-11-20", end_date: "2026-11-20" })], [entry()])).toEqual([]);
    expect(leaveApprovedAfterFinal([leave()], [entry({ status: "submitted" })])).toEqual([]);
    expect(leaveApprovedAfterFinal([leave({ status: "rejected" })], [entry()])).toEqual([]);
    expect(leaveApprovedAfterFinal([leave({ employee_id: "u2" })], [entry()])).toEqual([]);
  });
});
