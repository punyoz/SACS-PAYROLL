/**
 * Holidays: Super Admin manages attendance_holidays, and payroll never
 * deducts an Absent record dated on a holiday (one the nightly close wrote
 * before the day was added).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table } from "./helpers/fake-supabase.js";
import { computeAttendancePay } from "@/lib/payroll/attendance-pay";
import { validateHolidayInput, isValidDateKey } from "@/lib/attendance/holidays";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

let createSessionToken;
let SESSION_COOKIE;

function requestAs({ userId, role, branchId = null, fullName = "Tester" }, url, method = "GET", body) {
  const token = createSessionToken({
    user_id: userId, role, branch_id: branchId, email: `${userId}@sacs.test`, full_name: fullName, session_id: "s-1",
  });
  return new Request(`https://sacs.test${url}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const SUPER = { userId: "u-sa", role: "super_admin", fullName: "Sam Super" };
const ADMIN = { userId: "u-admin", role: "admin", branchId: "branch-a" };

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-holidays";
  resetDb();
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("holiday input", () => {
  it("accepts a real date, a name and a type", () => {
    expect(validateHolidayInput({ holiday_date: "2026-12-08", name: "Immaculate Conception", type: "special" })).toBeNull();
  });

  it("refuses an impossible date, a blank name and an unknown type", () => {
    expect(isValidDateKey("2026-02-30")).toBe(false);
    expect(validateHolidayInput({ holiday_date: "2026-02-30", name: "X", type: "holiday" })).toMatch(/date/);
    expect(validateHolidayInput({ holiday_date: "2026-12-08", name: " ", type: "holiday" })).toMatch(/name/);
    expect(validateHolidayInput({ holiday_date: "2026-12-08", name: "X", type: "fiesta" })).toMatch(/Regular Holiday/);
  });
});

describe("/api/admin/holidays", () => {
  it("adds a holiday, records who added it, and counts the Absent records already on that day", async () => {
    table("attendance_logs").push(
      { id: "l1", employee_id: "e1", log_date: "2026-12-08", status: "Absent", archived_duplicate: false },
      { id: "l2", employee_id: "e2", log_date: "2026-12-08", status: "On Time", archived_duplicate: false },
    );
    const { POST } = await import("@/app/api/admin/holidays/route");
    const response = await POST(requestAs(SUPER, "/api/admin/holidays", "POST", {
      holiday_date: "2026-12-08", name: "Feast of the Immaculate Conception", type: "special",
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.absent_records).toBe(1);
    expect(table("attendance_holidays")[0]).toMatchObject({
      holiday_date: "2026-12-08", type: "special", created_by: "u-sa", created_by_name: "Sam Super",
    });
  });

  it("refuses a date that is already a holiday", async () => {
    table("attendance_holidays").push({ holiday_date: "2026-12-25", name: "Christmas Day", type: "holiday" });
    const { POST } = await import("@/app/api/admin/holidays/route");
    const response = await POST(requestAs(SUPER, "/api/admin/holidays", "POST", {
      holiday_date: "2026-12-25", name: "Christmas", type: "holiday",
    }));
    expect(response.status).toBe(409);
    expect(table("attendance_holidays")).toHaveLength(1);
  });

  it("removes a holiday that has not happened yet, but keeps one that has passed", async () => {
    table("attendance_holidays").push(
      { holiday_date: "2099-12-08", name: "Future", type: "special" },
      { holiday_date: "2020-12-08", name: "Past", type: "special" },
    );
    const { DELETE } = await import("@/app/api/admin/holidays/route");
    expect((await DELETE(requestAs(SUPER, "/api/admin/holidays?date=2099-12-08", "DELETE"))).status).toBe(200);
    expect((await DELETE(requestAs(SUPER, "/api/admin/holidays?date=2020-12-08", "DELETE"))).status).toBe(409);
    expect(table("attendance_holidays").map((row) => row.holiday_date)).toEqual(["2020-12-08"]);
  });

  it("is Super Admin's: an Admin cannot add one", async () => {
    const { POST } = await import("@/app/api/admin/holidays/route");
    const response = await POST(requestAs(ADMIN, "/api/admin/holidays", "POST", {
      holiday_date: "2026-12-08", name: "X", type: "special",
    }));
    expect(response.status).toBe(403);
  });
});

describe("payroll on a holiday", () => {
  const rates = { daily: 500, hourly: 62.5, absent_pct: 100, half_day_pct: 50 };

  it("does not deduct an Absent record dated on a holiday", () => {
    const pay = computeAttendancePay({
      logs: [
        { id: "a", log_date: "2026-12-07", status: "Absent" },
        { id: "b", log_date: "2026-12-08", status: "Absent" },
      ],
      rates,
      periodStart: "2026-12-01",
      periodEnd: "2026-12-15",
      holidays: new Map([["2026-12-08", "special"]]),
    });
    expect(pay.counts.absent_days).toBe(1);
    expect(pay.amounts.absent).toBe(500);
  });
});
