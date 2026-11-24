// Part B (2026-11-22): overtime requests are checked on the server before
// anything is saved, with plain-word refusals; the limits are settings.
import { describe, expect, it } from "vitest";
import { REQUEST_SETTINGS, checkOvertimeRequest, overtimePaidText } from "@/lib/overtime-requests/rules";
import { computeAttendancePay } from "@/lib/payroll/attendance-pay";
import { DEFAULT_RATES } from "@/lib/payroll/rates";

const settings = Object.fromEntries(Object.entries(REQUEST_SETTINGS).map(([k, d]) => [k, d.fallback]));
const today = "2026-11-20"; // a Friday
const base = { request_date: "2026-11-23", planned_start: "17:00", planned_end: "19:00", reason: "Grade encoding for Q2" };
const check = (input, extra = {}) => checkOvertimeRequest({ ...base, ...input }, { today, settings, ...extra });

describe("overtime request checks (Part B)", () => {
  it("defaults pending policy manual: 3 h a day, 10 h a cutoff, 1 day before, 2 days late", () => {
    expect(settings).toEqual({ overtime_max_hours_day: 3, overtime_max_hours_cutoff: 10, file_days_before: 1, late_filing_days_after: 2, overtime_regular_pct: 125 });
    expect(REQUEST_SETTINGS.overtime_regular_pct.min).toBe(125); // never below the Labor Code minimum
  });

  it("accepts a request filed a day or more ahead", () => {
    expect(check({})).toMatchObject({ minutes: 120, late_filing: false, period_label: "November 16-30, 2026" });
  });

  it("more than the daily limit is refused", () => {
    expect(check({ planned_end: "20:30" }).error).toBe("Overtime is at most 3 h a day. This request is 3 h 30 min.");
  });

  it("today or up to 2 days after is a late filing; later is refused", () => {
    expect(check({ request_date: "2026-11-20" })).toMatchObject({ late_filing: true });
    expect(check({ request_date: "2026-11-18" })).toMatchObject({ late_filing: true });
    expect(check({ request_date: "2026-11-17" }).error).toMatch(/at least 1 day before, or up to 2 days after as a late filing/);
  });

  it("refuses a second request for the same day and anything over the cutoff limit", () => {
    expect(check({}, { open: [{ request_date: "2026-11-23", minutes: 60 }] }).error).toMatch(/already have an overtime request for 2026-11-23/);
    const open = [{ request_date: "2026-11-17", minutes: 180 }, { request_date: "2026-11-18", minutes: 180 }, { request_date: "2026-11-19", minutes: 180 }];
    expect(check({}, { open }).error).toBe("This would make 11 h of overtime in November 16-30, 2026; the limit is 10 h a cutoff (1 h left).");
    // Another cutoff's overtime does not count.
    expect(check({}, { open: [{ request_date: "2026-11-10", minutes: 600 }] }).error).toBeUndefined();
  });

  it("only for categories the pay rules allow (Part A)", () => {
    expect(check({}, { refusal: "Teaching · Contractual · Part-time employees are not eligible for overtime (pay rules)." }).error)
      .toMatch(/not eligible for overtime/);
  });

  it("plain words for bad input", () => {
    expect(check({ request_date: "23/11/2026" }).error).toBe("Choose the date of the overtime.");
    expect(check({ planned_start: "5pm" }).error).toBe("Enter the planned start and end times (HH:MM).");
    expect(check({ planned_end: "16:00" }).error).toMatch(/end must be after the planned start/);
    expect(check({ reason: " x " }).error).toMatch(/at least 3 characters/);
  });

  it("paid = the smaller of approved and worked, said in words", () => {
    expect(overtimePaidText(120, 75)).toBe("Approved 2 h, worked 1 h 15 min → 1 h 15 min paid");
    expect(overtimePaidText(120, 210)).toBe("Approved 2 h, worked 3 h 30 min → 2 h paid");
    expect(overtimePaidText(90, null)).toBe("Approved 1 h 30 min; paid after the time-out tap");
    expect(overtimePaidText(120, null, { pending: true })).toBe("Requested 2 h; paid after the time-out tap if approved");
    expect(overtimePaidText(120, 75, { pending: true })).toBe("Requested 2 h, worked 1 h 15 min → 1 h 15 min paid if approved");
  });
});

describe("overtime pay rate (Part B, 2026-11-22)", () => {
  const rates = (o = {}) => Object.fromEntries(Object.entries({ ...DEFAULT_RATES, daily: 800, hourly: 100, overtime_premium_pct: 0, ...o }).map(([t, value]) => [t, { value, config_id: `cfg-${t}` }]));
  const log = (id, date) => ({ id, log_date: date, status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, time_in: `${date}T08:00:00+08:00`, time_out: `${date}T19:00:00+08:00` });
  const pay = (extra) => computeAttendancePay({
    logs: [log("a", "2026-11-17"), log("b", "2026-11-21")], rates: rates(), periodStart: "2026-11-16", periodEnd: "2026-11-30",
    overtime: new Map([["a", 120], ["b", 60]]), overtimeRegularPct: 125, ...extra,
  }).earnings.filter((e) => e.type === "overtime");

  it("a regular working day pays 125% of the hourly rate (the setting)", () => {
    const [regular] = pay();
    expect(regular).toMatchObject({ source_log_id: "a", rate: 125, rate_pct: 125, amount: 250 });
  });

  it("a rest day pays the rest-day premium (130%, 2026-11-26); a holiday keeps the rate table's rate", () => {
    const rest = pay({ restDays: new Set(["2026-11-21"]) }).find((e) => e.source_log_id === "b");
    expect(rest).toMatchObject({ rate: 130, amount: 130, rate_pct: 130, rest_day: true, rate_config_id: "cfg-rest_day_premium_pct" });
    const rest35 = computeAttendancePay({
      logs: [log("b", "2026-11-21")], rates: rates({ rest_day_premium_pct: 35 }), periodStart: "2026-11-16", periodEnd: "2026-11-30",
      overtime: new Map([["b", 60]]), overtimeRegularPct: 125, restDays: new Set(["2026-11-21"]),
    }).earnings.find((e) => e.type === "overtime");
    expect(rest35).toMatchObject({ rate: 135, amount: 135, rate_pct: 135 });
    // A holiday that is also a rest day keeps the holiday rules (the rate table's overtime rate).
    const both = pay({ restDays: new Set(["2026-11-21"]), holidays: new Map([["2026-11-21", "holiday"]]) }).find((e) => e.source_log_id === "b" && e.type === "overtime");
    expect(both).toMatchObject({ rate: 100 });
    expect(both.rate_pct).toBeUndefined();
    const holidays = new Map([["2026-11-17", "holiday"]]);
    expect(pay({ holidays }).find((e) => e.source_log_id === "a")).toMatchObject({ rate: 100 });
  });

  it("without the setting (older callers) the rate table applies everywhere", () => {
    expect(pay({ overtimeRegularPct: undefined }).find((e) => e.source_log_id === "a")).toMatchObject({ rate: 100, amount: 200 });
  });
});
