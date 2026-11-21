// Part B (2026-11-22): overtime requests are checked on the server before
// anything is saved, with plain-word refusals; the limits are settings.
import { describe, expect, it } from "vitest";
import { REQUEST_SETTINGS, checkOvertimeRequest, overtimePaidText } from "@/lib/overtime-requests/rules";

const settings = Object.fromEntries(Object.entries(REQUEST_SETTINGS).map(([k, d]) => [k, d.fallback]));
const today = "2026-11-20"; // a Friday
const base = { request_date: "2026-11-23", planned_start: "17:00", planned_end: "19:00", reason: "Grade encoding for Q2" };
const check = (input, extra = {}) => checkOvertimeRequest({ ...base, ...input }, { today, settings, ...extra });

describe("overtime request checks (Part B)", () => {
  it("defaults pending policy manual: 3 h a day, 10 h a cutoff, 1 day before, 2 days late", () => {
    expect(settings).toEqual({ overtime_max_hours_day: 3, overtime_max_hours_cutoff: 10, file_days_before: 1, late_filing_days_after: 2 });
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
