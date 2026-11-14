import { describe, expect, it } from "vitest";
import { ATTENDANCE_STATUSES, PRESENT_FILTER, PRESENT_STATUSES, isAttendedStatus, isPresentRow, matchesStatusFilter } from "@/lib/attendance/status";

// "Present" on every dashboard and in the status filters (decision 2026-11-14).
describe("the shared Present group", () => {
  it("is On Time, Early Bird, Late, Undertime, Half Day, Corrected", () => {
    expect(PRESENT_STATUSES).toEqual(["On Time", "Early Bird", "Late", "Undertime", "Half Day", "Corrected"]);
    expect(ATTENDANCE_STATUSES.filter(isAttendedStatus)).toEqual(PRESENT_STATUSES);
  });

  it("filters rows the same way the dashboards count them", () => {
    for (const s of ATTENDANCE_STATUSES) expect(matchesStatusFilter(s, PRESENT_FILTER)).toBe(PRESENT_STATUSES.includes(s));
    expect(matchesStatusFilter("Late", "Late")).toBe(true);
    expect(matchesStatusFilter("Late", "Absent")).toBe(false);
    expect(matchesStatusFilter("Absent", "all")).toBe(true);
    expect(matchesStatusFilter("Absent", "")).toBe(true);
  });
});

// Round 4: tapped in today, not out yet (Incomplete once the shift ends) = present today.
describe("present today with no tap-out yet", () => {
  const TODAY = "2026-11-16";
  it("counts a time-in today whatever its status; a past Incomplete day stays out", () => {
    expect(isPresentRow({ log_date: TODAY, status: "Incomplete", time_in: `${TODAY}T00:05:00Z` }, TODAY)).toBe(true);
    expect(isPresentRow({ log_date: TODAY, status: "Pending Correction", time_in: `${TODAY}T00:05:00Z` }, TODAY)).toBe(true);
    expect(isPresentRow({ log_date: "2026-11-13", status: "Incomplete", time_in: "2026-11-13T00:05:00Z" }, TODAY)).toBe(false);
    expect(isPresentRow({ log_date: TODAY, status: "Absent", time_in: null }, TODAY)).toBe(false);
    expect(isPresentRow({ log_date: "2026-11-13", status: "Late", time_in: "2026-11-13T00:40:00Z" }, TODAY)).toBe(true);
  });
});
