// Part B step 2 (2026-11-22): a half-day leave counts as 0.5 day everywhere leave is counted.
import { describe, expect, it } from "vitest";
import { requestDays } from "@/lib/leave-requests/split";
import { normalizeLeaveRequest } from "@/lib/leave-requests/store";

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
