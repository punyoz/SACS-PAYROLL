/**
 * Holiday duty and holiday pay (20261102010000). Real numbers: a 26,100
 * monthly salary, so the daily rate is 26,100 x 12 / 261 = 1,200.
 *
 *   school closed, not assigned, no tap   no deduction, no premium
 *   not assigned, worked                  premium held until HR approves
 *   assigned, worked                      regular +100 % (1,200), special +30 % (360)
 *   assigned, no tap                      no deduction (HR decides)
 *   holiday on a rest day, worked         regular 260 % (3,120), special 150 % (1,800)
 *   special WORKING day                   an ordinary day: an absence is deducted
 */

import { describe, expect, it } from "vitest";
import { computeAttendancePay, holidayPayPct } from "@/lib/payroll/attendance-pay";
import { dutyHours, validateDutyInput } from "@/lib/attendance/holiday-duty";
import { holidayAppliesTo, holidayBadgeLabel, isDayOff, validateHolidayInput } from "@/lib/attendance/holidays";

const RATES = { daily: 1200, hourly: 150, absent_pct: 100, half_day_pct: 50, regular_holiday_premium_pct: 100, special_holiday_premium_pct: 30 };
const EMP_LOG = (id, date, worked = true) => ({
  id, log_date: date, status: worked ? "On Time" : "Holiday",
  time_in: worked ? `${date}T00:00:00Z` : null, time_out: worked ? `${date}T09:00:00Z` : null,
  late_minutes: 0, undertime_minutes: 0, is_half_day: false,
});
const HOLIDAYS = Object.assign(new Map([
  ["2026-11-01", "special"], // All Saints' Day, a Sunday
  ["2026-11-02", "special"], // All Souls' Day, a Monday
  ["2026-11-30", "holiday"], // Bonifacio Day, a Monday
]), { names: new Map([["2026-11-01", "All Saints' Day"], ["2026-11-02", "All Souls' Day"], ["2026-11-30", "Bonifacio Day"]]), partialDays: new Set() });

function pay(logs, { assigned = [], approved = [], restDays = [] } = {}) {
  return computeAttendancePay({
    logs, rates: RATES, periodStart: "2026-11-01", periodEnd: "2026-11-30", holidays: HOLIDAYS,
    holidayPremiumAllowed: (key) => assigned.includes(key) || approved.includes(key),
    restDays: new Set(restDays),
  });
}

describe("holiday pay with holiday duty", () => {
  it("a closed holiday with no tap: no deduction and no premium", () => {
    const result = pay([EMP_LOG("a", "2026-11-02", false)]);
    expect(result.amounts.absent).toBe(0);
    expect(result.amounts.holiday_premium).toBe(0);
    expect(result.deductions).toHaveLength(0);
  });

  it("an Absent written before the day became a holiday is not deducted either", () => {
    const result = pay([{ ...EMP_LOG("a", "2026-11-02", false), status: "Absent" }]);
    expect(result.amounts.absent).toBe(0);
  });

  it("worked without an assignment: the premium waits for HR, then +30 % (360)", () => {
    const pending = pay([EMP_LOG("w", "2026-11-02")]);
    expect(pending.amounts.holiday_premium).toBe(0);
    expect(pending.counts.holiday_days_pending).toBe(1);
    const approved = pay([EMP_LOG("w", "2026-11-02")], { approved: ["2026-11-02"] });
    expect(approved.amounts.holiday_premium).toBe(360);
  });

  it("assigned and worked: special day +30 % (360), regular holiday +100 % (1,200)", () => {
    const result = pay([EMP_LOG("s", "2026-11-02"), EMP_LOG("r", "2026-11-30")], { assigned: ["2026-11-02", "2026-11-30"] });
    expect(result.earnings.map((l) => [l.log_date, l.amount, l.pay_pct])).toEqual([
      ["2026-11-02", 360, 30],
      ["2026-11-30", 1200, 100],
    ]);
    expect(result.amounts.holiday_premium).toBe(1560);
    expect(result.earnings[0].note).toBe("All Souls' Day · 8 hrs · +30% of daily rate");
  });

  it("assigned and did not report: never deducted by itself", () => {
    const result = pay([EMP_LOG("n", "2026-11-30", false)], { assigned: ["2026-11-30"] });
    expect(result.amounts.absent).toBe(0);
    expect(result.amounts.holiday_premium).toBe(0);
  });

  it("a holiday on a rest day pays the whole rate: special 150 % (1,800), regular 260 % (3,120)", () => {
    const special = pay([EMP_LOG("x", "2026-11-01")], { assigned: ["2026-11-01"], restDays: ["2026-11-01"] });
    expect(special.earnings[0]).toMatchObject({ amount: 1800, pay_pct: 150, rest_day: true });
    expect(special.earnings[0].note).toContain("(rest day)");
    expect(holidayPayPct("holiday", { regularPct: 100, specialPct: 30, restDay: true })).toBeCloseTo(260);
    expect(1200 * holidayPayPct("holiday", { regularPct: 100, specialPct: 30, restDay: true }) / 100).toBeCloseTo(3120);
  });

  it("without the duty check (older callers) every worked holiday is paid, as before", () => {
    const result = computeAttendancePay({ logs: [EMP_LOG("o", "2026-11-30")], rates: RATES, periodStart: "2026-11-01", periodEnd: "2026-11-30", holidays: HOLIDAYS });
    expect(result.amounts.holiday_premium).toBe(1200);
  });

  it("a special WORKING day is an ordinary day: an absence costs a day (1,200)", () => {
    // Feb 25 is not in the day-off map (src/app/api/accountant/payroll/route.js leaves it out).
    const result = computeAttendancePay({
      logs: [{ ...EMP_LOG("f", "2026-02-25", false), status: "Absent" }], rates: RATES,
      periodStart: "2026-02-16", periodEnd: "2026-02-28", holidays: Object.assign(new Map(), { names: new Map(), partialDays: new Set() }),
    });
    expect(result.amounts.absent).toBe(1200);
  });
});

describe("holiday helpers", () => {
  it("a special working day is never a day off; the others are, unless part-day", () => {
    expect(isDayOff({ type: "special_working", day_part: "whole" })).toBe(false);
    expect(isDayOff({ type: "special", day_part: "whole" })).toBe(true);
    expect(isDayOff({ type: "suspension", day_part: "pm" })).toBe(false);
  });

  it("a branch-only day applies to its branches alone", () => {
    expect(holidayAppliesTo({ branch_ids: null }, "b1")).toBe(true);
    expect(holidayAppliesTo({ branch_ids: [] }, null)).toBe(true);
    expect(holidayAppliesTo({ branch_ids: ["b1", "b2"] }, "b2")).toBe(true);
    expect(holidayAppliesTo({ branch_ids: ["b1"] }, "b3")).toBe(false);
    expect(holidayAppliesTo({ branch_ids: ["b1"] }, null)).toBe(false);
  });

  it("badges read as the type and the name", () => {
    expect(holidayBadgeLabel({ type: "special", name: "All Souls' Day" })).toBe("Special non-working day: All Souls' Day");
    expect(holidayBadgeLabel({ type: "holiday", name: "Bonifacio Day" })).toBe("Regular holiday: Bonifacio Day");
    expect(holidayBadgeLabel({ type: "special_working", name: "EDSA People Power Revolution Anniversary" })).toBe("Special working day: EDSA People Power Revolution Anniversary");
  });

  it("accepts a special working day, whole day only", () => {
    expect(validateHolidayInput({ holiday_date: "2026-02-25", name: "EDSA", type: "special_working" })).toBeNull();
    expect(validateHolidayInput({ holiday_date: "2026-02-25", name: "EDSA", type: "special_working", day_part: "pm", cutoff: "12:00" })).toMatch(/Only a suspension/);
  });

  it("duty shifts: 08:00-17:00 is 8 hours, a short shift has no break", () => {
    expect(dutyHours("08:00", "17:00")).toBe(8);
    expect(dutyHours("07:00", "11:00")).toBe(4);
    expect(validateDutyInput({ shift_start: "17:00", shift_end: "08:00" })).toMatch(/end after/);
    expect(validateDutyInput({ shift_start: "08:00", shift_end: "12:00", required_hours: 13 })).toMatch(/at most 12/);
    expect(validateDutyInput({ shift_start: "08:00", shift_end: "12:00", note: "x".repeat(201) })).toMatch(/200/);
    expect(validateDutyInput({ shift_start: "08:00", shift_end: "12:00", note: "Guard duty" })).toBeNull();
  });
});
