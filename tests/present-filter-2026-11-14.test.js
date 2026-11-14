import { describe, expect, it } from "vitest";
import { ATTENDANCE_STATUSES, PRESENT_FILTER, PRESENT_STATUSES, isAttendedStatus, matchesStatusFilter } from "@/lib/attendance/status";

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
