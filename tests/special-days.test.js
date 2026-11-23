// Special working days (2026-11-23).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { coveredBySpecialDay, extraDayLines, specialDayLabel } from "@/lib/attendance/special-days";

const B1 = "b1";
const day = (over) => ({ id: "d", work_date: "2026-11-28", branch_ids: [B1], audience: "teaching", employee_ids: [], start_time: "08:00", end_time: "12:00", reason: "Saturday classes", pay_type: "extra", premium_pct: 130, ...over });
const ana = { id: "ana", branch_id: B1, employee_type: "Teaching" };

describe("who is covered", () => {
  it("branch and audience; chosen employees; a cancelled day covers nobody", () => {
    expect(coveredBySpecialDay(day(), ana)).toBe(true);
    expect(coveredBySpecialDay(day(), { ...ana, employee_type: "Non-Teaching" })).toBe(false);
    expect(coveredBySpecialDay(day(), { ...ana, branch_id: "b2" })).toBe(false);
    expect(coveredBySpecialDay(day({ branch_ids: [] }), { ...ana, branch_id: "b2" })).toBe(true);
    expect(coveredBySpecialDay(day({ audience: "employees", employee_ids: ["ana"] }), ana)).toBe(true);
    expect(coveredBySpecialDay(day({ cancelled_at: "2026-11-25" }), ana)).toBe(false);
  });
  it("label", () => {
    expect(specialDayLabel(day())).toEqual({ date: "Sat Nov 28", kind: "Extra working day", hours: "8:00 AM–12:00 PM", who: "Teaching staff" });
  });
});

describe("extra day pay", () => {
  it("paid only when tapped in, at daily × 130%; a make-up day pays nothing extra; outside the span nothing", () => {
    const tapped = [{ log_date: "2026-11-28", time_in: "2026-11-28T07:55:00+08:00" }];
    expect(extraDayLines({ days: [day()], person: ana, logs: tapped, dailyRate: 1000, spanStart: "2026-11-16", spanEnd: "2026-11-30" }))
      .toEqual([expect.objectContaining({ amount: 1300, note: "Special working day (Sat Nov 28): Saturday classes, 8:00 AM–12:00 PM, 130% of the daily rate" })]);
    expect(extraDayLines({ days: [day()], person: ana, logs: [], dailyRate: 1000, spanStart: "2026-11-16", spanEnd: "2026-11-30" })).toEqual([]);
    expect(extraDayLines({ days: [day({ pay_type: "makeup" })], person: ana, logs: tapped, dailyRate: 1000, spanStart: "2026-11-16", spanEnd: "2026-11-30" })).toEqual([]);
    expect(extraDayLines({ days: [day()], person: ana, logs: tapped, dailyRate: 1000, spanStart: "2026-11-01", spanEnd: "2026-11-15" })).toEqual([]);
  });
});

describe("the schedule", () => {
  it("a make-up day is a working day for the covered only; the old schedule is kept word for word as the base", () => {
    const sql = readFileSync("supabase/migrations/20261124130000_special_working_days.sql", "utf8");
    expect(sql).toMatch(/working_days := CASE WHEN sp\.pay_type = 'makeup' THEN ARRAY\[0, 1, 2, 3, 4, 5, 6\]/);
    expect(sql).toMatch(/RETURN QUERY SELECT \* FROM public\.attendance_schedule_base_for/);
    expect(sql).toMatch(/'substitution', 'special_working_day'/);
    expect(readFileSync("scripts/rollback/rollback-special-working-days.sql", "utf8")).toMatch(/DROP FUNCTION IF EXISTS public\.attendance_schedule_base_for/);
  });
});
