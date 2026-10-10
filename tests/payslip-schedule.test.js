/**
 * Payslip schedule (src/lib/payroll/schedule.js), its generation window
 * (src/lib/payroll/generation-window.js) and the attendance-deduction cap
 * (src/lib/payroll/semi-monthly.js). The dates match the SQL tests of
 * 20261009010000 (docs/payroll-schedule-loans-awol.md §1).
 */

import { describe, it, expect } from "vitest";
import { createPayslipSchedule, generationDateFor, loadPayslipSchedule, settingsFor } from "@/lib/payroll/schedule";
import { generationWindow } from "@/lib/payroll/generation-window";
import { computeSecondHalf, monthlyWindow, payrollMonthFor } from "@/lib/payroll/semi-monthly";

const HOLIDAYS = [
  { holiday_date: "2026-11-01", day_part: "whole" },
  { holiday_date: "2026-11-30", day_part: "whole" },
  { holiday_date: "2026-12-25", day_part: "whole" },
  { holiday_date: "2026-12-30", day_part: "whole" },
  { holiday_date: "2026-12-31", day_part: "whole" },
  { holiday_date: "2027-03-15", day_part: "pm", cutoff: "12:00" },
];
const schedule = createPayslipSchedule({ holidays: HOLIDAYS });

describe("Generation dates (1st half: next working day, 2nd half: previous, by default)", () => {
  it.each([
    ["2026-10-01", "2026-10-15", null],
    ["2026-10-16", "2026-10-30", "2026-10-29"],   // Oct 31 is a Saturday
    ["2026-11-01", "2026-11-16", null],           // Nov 15 is a Sunday: Mon Nov 16
    ["2026-11-16", "2026-11-27", "2026-11-26"],   // Nov 30 Bonifacio Day
    ["2026-12-16", "2026-12-29", "2026-12-28"],   // Dec 31 and Dec 30 holidays
    ["2027-02-16", "2027-02-26", "2027-02-25"],   // short month, Feb 28 a Sunday
  ])("%s → %s", (start, generation, cutoff) => {
    const s = schedule.forPeriod(start);
    expect(s.generation_date).toBe(generation);
    expect(s.attendance_cutoff).toBe(cutoff);
    expect(s.window_days).toBe(5);
  });

  it("a half-day suspension is still a working day", () => {
    expect(generationDateFor("2027-03-01", {}, (d) => false)).toBe("2027-03-15");
    expect(schedule.forPeriod("2027-03-01").generation_date).toBe("2027-03-15");
  });

  it("each half has its own rule; the Super Admin can set the 1st half back to the previous working day", () => {
    expect(generationDateFor("2026-11-01", {})).toBe("2026-11-16");
    expect(generationDateFor("2026-11-01", { first_half_rule: "previous_working_day" })).toBe("2026-11-13");
    expect(generationDateFor("2026-11-01", { first_half_rule: "same_day" })).toBe("2026-11-15");
    // The 2nd-half rule never moves the 1st half, and the reverse.
    expect(generationDateFor("2026-11-01", { non_working_day_rule: "previous_working_day" })).toBe("2026-11-16");
    expect(generationDateFor("2026-10-16", { first_half_rule: "next_working_day" })).toBe("2026-10-30");
    const s = createPayslipSchedule({ settings: [{ effective_from: "2026-11-01", first_half_rule: "previous_working_day", window_days: 5 }] });
    expect(s.forPeriod("2026-11-01")).toMatchObject({ generation_date: "2026-11-13", non_working_day_rule: "previous_working_day" });
  });

  it("same-day and next-working-day rules", () => {
    expect(generationDateFor("2026-10-16", { non_working_day_rule: "same_day" })).toBe("2026-10-31");
    expect(generationDateFor("2026-10-16", { non_working_day_rule: "next_working_day" })).toBe("2026-11-02");
  });

  it("configured days, clamped to the month end", () => {
    expect(generationDateFor("2026-10-01", { first_half_day: 13, non_working_day_rule: "same_day" })).toBe("2026-10-13");
    expect(generationDateFor("2027-02-16", { second_half_day: 31, non_working_day_rule: "same_day" })).toBe("2027-02-28");
  });

  it("the attendance cut-off never passes the month end (next-working-day into next month)", () => {
    const s = createPayslipSchedule({ settings: [{ effective_from: "2026-10-16", non_working_day_rule: "next_working_day", window_days: 5 }] });
    expect(s.forPeriod("2026-10-16").generation_date).toBe("2026-11-02");
    expect(s.forPeriod("2026-10-16").attendance_cutoff).toBe("2026-10-31");
  });
});

describe("Effective-dated settings", () => {
  const rows = [
    { id: "a", effective_from: "2027-01-16", non_working_day_rule: "same_day", window_days: 3, created_at: "2026-10-09T01:00:00Z" },
    { id: "b", effective_from: "2027-02-01", window_days: 7, non_working_day_rule: "previous_working_day", created_at: "2026-10-09T02:00:00Z" },
  ];
  it("earlier periods keep the defaults; each version governs from its period", () => {
    expect(settingsFor("2027-01-01", rows)).toBe(null);
    expect(settingsFor("2027-01-16", rows).id).toBe("a");
    expect(settingsFor("2027-02-16", rows).id).toBe("b");
    const s = createPayslipSchedule({ settings: rows });
    expect(s.forPeriod("2027-01-16")).toMatchObject({ generation_date: "2027-01-31", window_days: 3, closes_on: "2027-02-02" });
  });
});

describe("Attendance windows from the schedule (replaces lock day 15)", () => {
  it("Oct deducts Oct 1–29; Nov deducts Oct 30 – Nov 26; Dec deducts Nov 27 – Dec 28", () => {
    expect(monthlyWindow("2026-10", schedule.lockDayFor)).toEqual({ start_key: "2026-10-01", end_key: "2026-10-29" });
    expect(monthlyWindow("2026-11", schedule.lockDayFor)).toEqual({ start_key: "2026-10-30", end_key: "2026-11-26" });
    expect(monthlyWindow("2026-12", schedule.lockDayFor)).toEqual({ start_key: "2026-11-27", end_key: "2026-12-28" });
  });

  it("the generation day itself belongs to the next month's payroll", () => {
    expect(payrollMonthFor("2026-10-29", null, schedule.lockDayFor)).toBe("2026-10");
    expect(payrollMonthFor("2026-10-30", null, schedule.lockDayFor)).toBe("2026-11");
  });
});

describe("Generation window with the schedule", () => {
  const oct1 = { start_key: "2026-10-01", end_key: "2026-10-15", label: "October 1-15, 2026" };
  const s = schedule.forPeriod("2026-10-01");

  it("before the generation day: not open, says when", () => {
    const w = generationWindow(oct1, { today: "2026-10-09", schedule: s });
    expect(w.state).toBe("not_open");
    expect(w.can_generate).toBe(false);
    expect(w.message).toContain("Oct 15, 2026");
    expect(w.banner).toBe("October 1-15, 2026: Payslip generation on Oct 15, 2026 · open until Oct 19, 2026");
  });

  it("on the generation day and through the window: Final", () => {
    expect(generationWindow(oct1, { today: "2026-10-15", schedule: s }).state).toBe("final");
    expect(generationWindow(oct1, { today: "2026-10-19", schedule: s }).state).toBe("final");
  });

  it("after the window: closed (Super Admin override)", () => {
    expect(generationWindow(oct1, { today: "2026-10-20", schedule: s }).state).toBe("closed");
  });

  it("the 2nd half counts attendance to the cut-off", () => {
    const oct16 = { start_key: "2026-10-16", end_key: "2026-10-31", label: "October 16-31, 2026" };
    const w = generationWindow(oct16, { today: "2026-10-30", schedule: schedule.forPeriod("2026-10-16") });
    expect(w.state).toBe("final");
    expect(w.attendance_through).toBe("2026-10-29");
  });

  it("without the schedule (migration not applied) the original window still opens on the period's last day, not before", () => {
    const w = generationWindow(oct1, { today: "2026-10-15" });
    expect(w.state).toBe("draft");
    expect(w.opens_on).toBe("2026-10-15");
    expect(generationWindow(oct1, { today: "2026-10-14" }).state).toBe("not_open");
  });
});

describe("loadPayslipSchedule", () => {
  const client = (settingsResult) => ({
    from: (table) => ({
      select: async () => (table === "payroll_schedule_settings" ? settingsResult : { data: HOLIDAYS, error: null }),
    }),
  });

  it("null when the table is not there yet, so callers keep the old behaviour", async () => {
    expect(await loadPayslipSchedule(client({ data: null, error: { code: "42P01", message: 'relation "payroll_schedule_settings" does not exist' } }))).toBe(null);
    expect(await loadPayslipSchedule(client({ data: null, error: { code: "PGRST205", message: "Could not find the table in the schema cache" } }))).toBe(null);
  });

  it("other errors are not swallowed", async () => {
    await expect(loadPayslipSchedule(client({ data: null, error: { code: "57014", message: "timeout" } }))).rejects.toThrow("timeout");
  });

  it("builds the schedule from settings and holidays", async () => {
    const s = await loadPayslipSchedule(client({ data: [], error: null }));
    expect(s.forPeriod("2026-11-16").generation_date).toBe("2026-11-27");
  });
});

describe("Attendance deductions are capped at the monthly salary", () => {
  const base = { monthlySalary: 30000, divisor: 261, contributions: { sss: 400, pagibig: 200 } };

  it("a whole month absent (22 days × ₱1,379.31 = ₱30,344.82) deducts only ₱30,000", () => {
    const r = computeSecondHalf({ ...base, absentDays: 22 });
    expect(r.daily_rate).toBe(1379.31);
    expect(r.absence_deduction).toBe(30344.82);
    expect(r.attendance_deductions).toBe(30000);
    expect(r.attendance_cap_applied).toBe(true);
    expect(r.monthly_gross).toBe(0);
  });

  it("earnings still count when attendance is capped", () => {
    const r = computeSecondHalf({ ...base, absentDays: 22, incentives: 500 });
    expect(r.monthly_gross).toBe(500);
  });

  it("below the salary nothing changes (worked example 7.1)", () => {
    const r = computeSecondHalf({ ...base, absentDays: 1, otherAttendanceDeductions: 129.31, firstHalfPaid: 15000,
      cashAdvance: 2100, taxTable: [{ over: 0, base: 0, rate: 0 }, { over: 20833, base: 0, rate: 0.15 }, { over: 33333, base: 1875, rate: 0.2 }] });
    expect(r.attendance_cap_applied).toBe(false);
    expect(r.monthly_gross).toBe(28491.38);
    expect(r.withholding_tax).toBe(1058.76);
    expect(r.second_half_net).toBe(9732.62);
  });

  it("AWOL November (worked example 7.2): 14 absences → ₱10,689.66", () => {
    expect(computeSecondHalf({ ...base, absentDays: 14 }).monthly_gross).toBe(10689.66);
  });
});
