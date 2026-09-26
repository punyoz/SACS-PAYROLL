/**
 * Attendance -> payroll: effective-dated rates, the per-log deduction and
 * incentive lines, and the pay-period helpers they depend on.
 */

import { describe, it, expect } from "vitest";
import { computeAttendancePay } from "@/lib/payroll/attendance-pay";
import { resolveRate, resolveRates, rateHistory, validateRateInput, DEFAULT_RATES, RATE_TYPE_KEYS } from "@/lib/payroll/rates";
import { periodForDateKey, periodFromLabel, nextPeriod } from "@/lib/payroll/periods";
import {
  normalizeAttendanceStatus,
  isUnresolvedStatus,
  isCorrectableStatus,
  STATUS_TONES,
  ATTENDANCE_STATUSES,
} from "@/lib/attendance/status";

const PERIOD = { start: "2026-09-16", end: "2026-09-30" };

const rates = (overrides = {}) => Object.fromEntries(
  Object.entries({ ...DEFAULT_RATES, ...overrides }).map(([type, value]) => [type, { value, config_id: `cfg-${type}` }]),
);

const log = (id, date, fields = {}) => ({
  id,
  log_date: date,
  status: "On Time",
  late_minutes: 0,
  undertime_minutes: 0,
  is_half_day: false,
  is_early_bird: false,
  ...fields,
});

describe("Pay periods", () => {
  it("maps a date to its semi-monthly period", () => {
    expect(periodForDateKey("2026-09-26")).toEqual({ start_key: "2026-09-16", end_key: "2026-09-30", label: "September 16-30, 2026" });
    expect(periodForDateKey("2026-02-03").end_key).toBe("2026-02-15");
    expect(periodForDateKey("2028-02-20").end_key).toBe("2028-02-29");
  });

  it("reads a period back from its label, and only a real period's label", () => {
    expect(periodFromLabel("September 1-15, 2026")?.start_key).toBe("2026-09-01");
    expect(periodFromLabel("September 16-30, 2026")?.end_key).toBe("2026-09-30");
    expect(periodFromLabel("September 3-9, 2026")).toBeNull();
    expect(periodFromLabel("")).toBeNull();
  });

  it("finds the next period across a month end", () => {
    expect(nextPeriod("2026-09-20").start_key).toBe("2026-10-01");
    expect(nextPeriod("2026-12-31").start_key).toBe("2027-01-01");
  });
});

describe("Attendance statuses", () => {
  it("reads pre-engine 'Present' rows as On Time", () => {
    expect(normalizeAttendanceStatus("Present")).toBe("On Time");
    expect(normalizeAttendanceStatus("half day")).toBe("Half Day");
    expect(normalizeAttendanceStatus("nonsense", "x")).toBe("x");
  });

  it("has a badge tone for every status", () => {
    ATTENDANCE_STATUSES.forEach((status) => expect(STATUS_TONES[status]).toBeTruthy());
    expect(STATUS_TONES["Early Bird"]).toBe("green");
    expect(STATUS_TONES["Half Day"]).toBe("orange");
    expect(STATUS_TONES.Corrected).toBe("blue");
  });

  it("knows which records block payroll and which can be corrected", () => {
    expect(isUnresolvedStatus("Incomplete")).toBe(true);
    expect(isUnresolvedStatus("Pending Correction")).toBe(true);
    expect(isUnresolvedStatus("Corrected")).toBe(false);
    expect(isCorrectableStatus("Incomplete")).toBe(true);
    expect(isCorrectableStatus("On Time")).toBe(false);
  });
});

describe("Effective-dated rates", () => {
  const configs = [
    { id: "g1", rate_type: "hourly", scope: "global", scope_ref: null, value: 100, effective_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
    { id: "g2", rate_type: "hourly", scope: "global", scope_ref: null, value: 110, effective_date: "2026-09-26", created_at: "2026-09-20T00:00:00Z" },
    { id: "b1", rate_type: "daily", scope: "branch", scope_ref: "branch-a", value: 700, effective_date: "2026-06-01", created_at: "2026-05-01T00:00:00Z" },
    { id: "g3", rate_type: "daily", scope: "global", scope_ref: null, value: 550, effective_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
    { id: "e1", rate_type: "daily", scope: "employee", scope_ref: "emp-1", value: 900, effective_date: "2026-10-01", created_at: "2026-09-01T00:00:00Z" },
  ];

  it("uses the version in force on the period's FIRST day, not the live one", () => {
    // ₱110 starts Sep 26: the Sep 16-30 period still uses ₱100.
    expect(resolveRate(configs, "hourly", {}, "2026-09-16").value).toBe(100);
    expect(resolveRate(configs, "hourly", {}, "2026-10-01").value).toBe(110);
  });

  it("prefers the most specific scope that is in force", () => {
    const who = { employeeId: "emp-1", branchId: "branch-a" };
    expect(resolveRate(configs, "daily", who, "2026-09-16")).toMatchObject({ value: 700, scope: "branch" });
    expect(resolveRate(configs, "daily", who, "2026-10-01")).toMatchObject({ value: 900, scope: "employee" });
    expect(resolveRate(configs, "daily", { branchId: "branch-b" }, "2026-09-16")).toMatchObject({ value: 550, scope: "global" });
  });

  it("uses a branch's own daily rate, and derives its hourly rate from it", () => {
    const branchConfigs = [
      ...configs,
      { id: "bd", rate_type: "daily", scope: "branch", scope_ref: "branch-b", value: 640, effective_date: "2026-09-01", created_at: "2026-08-01T00:00:00Z" },
    ];
    const resolved = resolveRates(branchConfigs, { branchId: "branch-b" }, "2026-09-16");
    expect(resolved.daily).toMatchObject({ value: 640, scope: "branch" });
    expect(resolved.hourly).toMatchObject({ value: 80, source: "derived" });
    // Other branches keep the global rates.
    expect(resolveRates(branchConfigs, { branchId: "branch-c" }, "2026-09-16").hourly.value).toBe(100);
  });

  it("falls back to the defaults when no version exists", () => {
    expect(resolveRate([], "absent_pct", {}, "2026-09-16")).toMatchObject({ value: 100, source: "default" });
    expect(Object.keys(resolveRates([], {}, "2026-09-16"))).toHaveLength(RATE_TYPE_KEYS.length);
    expect(resolveRate([], "late_days_per_absent", {}, "2026-09-16").value).toBe(3);
  });

  it("builds the history with each version's end date", () => {
    const history = rateHistory(configs, "hourly");
    expect(history.map((v) => [v.value, v.effective_date, v.until])).toEqual([
      [100, "2026-01-01", "2026-09-25"],
      [110, "2026-09-26", null],
    ]);
  });

  it("validates a new version", () => {
    expect(validateRateInput({ rate_type: "sss_pct", scope: "global", value: 120, effective_date: "2026-10-01" })).toMatch(/100/);
    expect(validateRateInput({ rate_type: "hourly", scope: "branch", value: 5, effective_date: "2026-10-01" })).toMatch(/branch/);
    expect(validateRateInput({ rate_type: "hourly", scope: "global", value: "", effective_date: "2026-10-01" })).toMatch(/value/);
    expect(validateRateInput({ rate_type: "hourly", scope: "global", value: 110, effective_date: "2026-10-01" })).toBeNull();
    expect(validateRateInput({ rate_type: "late_days_per_absent", scope: "global", value: 2.5, effective_date: "2026-10-01" })).toMatch(/whole number/);
    expect(validateRateInput({ rate_type: "late_days_per_absent", scope: "global", value: 0, effective_date: "2026-10-01" })).toBeNull();
  });
});

describe("Attendance deductions and incentives", () => {
  const compute = (logs, rateOverrides, leaveDays) => computeAttendancePay({
    logs,
    leaveDays,
    rates: rates(rateOverrides),
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
  });

  const lates = (n) => Array.from({ length: n }, (_, i) => log(`l${i + 1}`, `2026-09-${16 + i}`, { status: "Late", late_minutes: 45 }));

  it("charges 3 late days as 1 absence by default, never the minutes", () => {
    expect(compute(lates(2), { daily: 600 }).amounts.late).toBe(0);

    const three = compute(lates(3), { daily: 600, absent_pct: 100 });
    expect(three.amounts.late).toBe(600);
    expect(three.counts.late_days).toBe(3);
    expect(three.deductions).toEqual([expect.objectContaining({
      type: "late", quantity: 3, amount: 600, source_log_id: "l3", source_log_ids: ["l1", "l2", "l3"],
    })]);

    // 7 late days = 2 absences; the 7th waits for two more.
    expect(compute(lates(7), { daily: 600 }).amounts.late).toBe(1200);
  });

  it("follows the Super Admin's lateness settings", () => {
    // 2 late = 1 absent.
    expect(compute(lates(4), { daily: 600, late_days_per_absent: 2 }).amounts.late).toBe(1200);
    // Rule off.
    expect(compute(lates(6), { daily: 600, late_days_per_absent: 0 }).amounts.late).toBe(0);
    // Per-minute charge: 45 min at 100% of ₱80/h = ₱60 a day, plus 3 late = 1 absent.
    const both = compute(lates(3), { daily: 600, hourly: 80, late_minute_charge_pct: 100 });
    expect(both.amounts).toMatchObject({ late_minutes_charge: 180, late_days_charge: 600, late: 780 });
    expect(both.deductions.filter((d) => d.unit === "minute").map((d) => d.source_log_id)).toEqual(["l1", "l2", "l3"]);
  });

  it("prices undertime by the minute at the hourly rate", () => {
    const result = compute([log("b", "2026-09-17", { status: "Undertime", undertime_minutes: 90 })], { hourly: 100 });
    expect(result.amounts.undertime).toBe(150);
    expect(result.deductions.map((d) => [d.type, d.source_log_id])).toEqual([["undertime", "b"]]);
  });

  it("deducts half day and absent as a share of the daily rate, and never an absence covered by leave", () => {
    const result = compute([
      log("h", "2026-09-16", { status: "Half Day", is_half_day: true }),
      log("x", "2026-09-17", { status: "Absent" }),
      log("y", "2026-09-18", { status: "Absent" }),
    ], { daily: 600, half_day_pct: 50, absent_pct: 100 }, new Set(["2026-09-18"]));
    expect(result.amounts.half_day).toBe(300);
    expect(result.amounts.absent).toBe(600);
    expect(result.counts.absent_days).toBe(1);
  });

  it("never counts an Incomplete or Pending Correction day, and reports it as blocking", () => {
    const result = compute([
      log("i", "2026-09-16", { status: "Incomplete", late_minutes: 45 }),
      log("p", "2026-09-17", { status: "Pending Correction" }),
      log("o", "2026-09-18"),
    ]);
    expect(result.blocking.map((b) => b.log_id)).toEqual(["i", "p"]);
    expect(result.amounts.late).toBe(0);
    expect(result.deductions).toHaveLength(0);
    expect(result.perfect_attendance).toBe(false);
  });

  it("pays early bird per day and perfect attendance per period, traced to logs", () => {
    const result = compute([
      log("e1", "2026-09-16", { status: "Early Bird", is_early_bird: true }),
      log("e2", "2026-09-17", { status: "Early Bird", is_early_bird: true }),
      log("c", "2026-09-18", { status: "Corrected" }),
    ], { early_bird_bonus: 20, perfect_attendance_bonus: 500 });
    expect(result.amounts.early_bird).toBe(40);
    expect(result.perfect_attendance).toBe(true);
    expect(result.amounts.perfect_attendance).toBe(500);
    const perfect = result.incentives.find((i) => i.type === "perfect_attendance");
    expect(perfect.source_log_ids).toEqual(["e1", "e2", "c"]);
  });

  it("gives no perfect attendance for a period with any Late, Undertime, Absent or Half Day", () => {
    ["late_minutes", "undertime_minutes"].forEach((field) => {
      expect(compute([log("a", "2026-09-16", { [field]: 5 })], { perfect_attendance_bonus: 500 }).perfect_attendance).toBe(false);
    });
    expect(compute([log("a", "2026-09-16", { status: "Absent" })], { perfect_attendance_bonus: 500 }).perfect_attendance).toBe(false);
    expect(compute([log("a", "2026-09-16", { is_half_day: true })], { perfect_attendance_bonus: 500 }).perfect_attendance).toBe(false);
    expect(compute([], { perfect_attendance_bonus: 500 }).perfect_attendance).toBe(false);
  });

  it("ignores logs outside the period", () => {
    const result = compute([log("old", "2026-09-15", { late_minutes: 60 })], { hourly: 100 });
    expect(result.amounts.late).toBe(0);
  });
});
