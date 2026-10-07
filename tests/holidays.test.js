/**
 * Holidays and suspensions (/api/admin/holidays, attendance_holidays):
 *
 *   - Super Admin manages every type and generates a year's fixed holidays;
 *   - HR adds and removes suspensions, from today on; Admin cannot change them;
 *   - anyone who sees attendance may read them (dashboards, calendars);
 *   - a day already started is recomputed (attendance_apply_holiday);
 *   - payroll never deducts an Absent on a holiday, charges half for one on a
 *     partial suspension, skips Holiday days, and names each holiday it paid.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, rpc } from "./helpers/fake-supabase.js";
import { computeAttendancePay } from "@/lib/payroll/attendance-pay";
import { validateHolidayInput, isValidDateKey, describeDayPart, isDayOff } from "@/lib/attendance/holidays";
import { holidayPayLines, describeHolidayLine } from "@/lib/payroll/holiday-lines";
import { attendanceBucket, isAttendedStatus } from "@/lib/attendance/status";

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
const HR = { userId: "u-hr", role: "hr", fullName: "Hana HR" };
const ADMIN = { userId: "u-admin", role: "admin", branchId: "branch-a" };
const EMPLOYEE = { userId: "u-emp", role: "employee", branchId: "branch-a" };
const TODAY = "2026-10-07";

async function route() {
  return import("@/app/api/admin/holidays/route");
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T08:00:00+08:00`));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-holidays";
  resetDb();
  table("profiles").push({ id: "u-admin", branch_id: "branch-a", role: "admin" }, { id: "u-emp", branch_id: "branch-a", role: "employee" });
  rpc.results.attendance_apply_holiday = { data: 3, error: null };
  rpc.results.attendance_seed_holidays = { data: 15, error: null };
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("holiday input", () => {
  it("accepts a real date, a name and a type", () => {
    expect(validateHolidayInput({ holiday_date: "2026-12-08", name: "Immaculate Conception", type: "special" })).toBeNull();
    expect(validateHolidayInput({ holiday_date: "2026-10-20", name: "Typhoon", type: "suspension", day_part: "pm", cutoff: "12:00" })).toBeNull();
  });

  it("refuses an impossible date, a blank name, an unknown type, a partial holiday, and a partial day without its time", () => {
    expect(isValidDateKey("2026-02-30")).toBe(false);
    expect(validateHolidayInput({ holiday_date: "2026-02-30", name: "X", type: "holiday" })).toMatch(/date/);
    expect(validateHolidayInput({ holiday_date: "2026-12-08", name: " ", type: "holiday" })).toMatch(/name/);
    expect(validateHolidayInput({ holiday_date: "2026-12-08", name: "X", type: "fiesta" })).toMatch(/Suspension/);
    expect(validateHolidayInput({ holiday_date: "2026-12-08", name: "X", type: "holiday", day_part: "pm", cutoff: "12:00" })).toMatch(/Only a suspension/);
    expect(validateHolidayInput({ holiday_date: "2026-12-08", name: "X", type: "suspension", day_part: "am" })).toMatch(/resumes/);
  });

  it("describes a partial suspension, and only a whole day is a day off", () => {
    expect(describeDayPart({ day_part: "pm", cutoff: "13:00" })).toBe("Work suspended from 1:00 PM");
    expect(describeDayPart({ day_part: "am", cutoff: "10:30:00" })).toBe("Work resumes at 10:30 AM");
    expect(describeDayPart({ day_part: "whole" })).toBe("");
    expect(isDayOff({ day_part: "whole" })).toBe(true);
    expect(isDayOff({ day_part: "pm" })).toBe(false);
  });
});

describe("/api/admin/holidays: Super Admin", () => {
  it("adds a holiday, records who added it, and recomputes a day that has already passed", async () => {
    const { POST } = await route();
    const response = await POST(requestAs(SUPER, "/api/admin/holidays", "POST", {
      holiday_date: "2026-10-05", name: "Declared holiday", type: "special",
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.remarked_records).toBe(3);
    expect(table("attendance_holidays")[0]).toMatchObject({
      holiday_date: "2026-10-05", type: "special", day_part: "whole", cutoff: null, created_by: "u-sa", created_by_name: "Sam Super",
    });
    expect(rpc.calls.find((c) => c.fn === "attendance_apply_holiday").args).toEqual({ p_day: "2026-10-05", p_actor: "u-sa" });
  });

  it("does not recompute a day that has not come yet", async () => {
    const { POST } = await route();
    const body = await (await POST(requestAs(SUPER, "/api/admin/holidays", "POST", {
      holiday_date: "2026-12-24", name: "Christmas Eve", type: "special",
    }))).json();
    expect(body.remarked_records).toBe(0);
    expect(rpc.calls.some((c) => c.fn === "attendance_apply_holiday")).toBe(false);
  });

  it("refuses a date that is already a holiday", async () => {
    table("attendance_holidays").push({ holiday_date: "2026-12-25", name: "Christmas Day", type: "holiday" });
    const { POST } = await route();
    const response = await POST(requestAs(SUPER, "/api/admin/holidays", "POST", {
      holiday_date: "2026-12-25", name: "Christmas", type: "holiday",
    }));
    expect(response.status).toBe(409);
    expect(table("attendance_holidays")).toHaveLength(1);
  });

  it("generates a year's holidays fixed by law (attendance_seed_holidays)", async () => {
    const { POST } = await route();
    const body = await (await POST(requestAs(SUPER, "/api/admin/holidays", "POST", { action: "generate", year: 2028 }))).json();
    expect(body).toMatchObject({ success: true, year: 2028, added: 15 });
    expect(rpc.calls.find((c) => c.fn === "attendance_seed_holidays").args).toMatchObject({ p_year: 2028 });
  });

  it("removes a holiday that has not happened yet, or one added by mistake today for today; keeps a past one", async () => {
    table("attendance_holidays").push(
      { holiday_date: "2099-12-08", name: "Future", type: "special", created_at: "2026-01-01T00:00:00Z" },
      { holiday_date: TODAY, name: "Added today", type: "suspension", created_at: `${TODAY}T00:30:00Z` },
      { holiday_date: "2026-10-06", name: "Yesterday", type: "special", created_at: "2026-10-01T00:00:00Z" },
    );
    const { DELETE } = await route();
    expect((await DELETE(requestAs(SUPER, "/api/admin/holidays?date=2099-12-08", "DELETE"))).status).toBe(200);
    expect((await DELETE(requestAs(SUPER, `/api/admin/holidays?date=${TODAY}`, "DELETE"))).status).toBe(200);
    expect((await DELETE(requestAs(SUPER, "/api/admin/holidays?date=2026-10-06", "DELETE"))).status).toBe(409);
    expect(table("attendance_holidays").map((row) => row.holiday_date)).toEqual(["2026-10-06"]);
  });
});

describe("/api/admin/holidays: HR, Admin, Employee", () => {
  it("HR adds a same-day afternoon suspension", async () => {
    const { POST } = await route();
    const response = await POST(requestAs(HR, "/api/admin/holidays", "POST", {
      holiday_date: TODAY, name: "Typhoon (LGU)", type: "suspension", day_part: "pm", cutoff: "12:00",
    }));
    expect(response.status).toBe(200);
    expect(table("attendance_holidays")[0]).toMatchObject({ type: "suspension", day_part: "pm", cutoff: "12:00", created_by: "u-hr" });
  });

  it("HR cannot add a holiday, or a suspension for a past day", async () => {
    const { POST } = await route();
    expect((await POST(requestAs(HR, "/api/admin/holidays", "POST", { holiday_date: "2026-12-24", name: "X", type: "special" }))).status).toBe(403);
    expect((await POST(requestAs(HR, "/api/admin/holidays", "POST", { holiday_date: "2026-10-06", name: "X", type: "suspension" }))).status).toBe(400);
    expect((await POST(requestAs(HR, "/api/admin/holidays", "POST", { action: "generate", year: 2028 }))).status).toBe(403);
    expect(table("attendance_holidays")).toHaveLength(0);
  });

  it("HR removes a future suspension but not a holiday", async () => {
    table("attendance_holidays").push(
      { holiday_date: "2026-10-20", name: "Typhoon", type: "suspension" },
      { holiday_date: "2026-11-30", name: "Bonifacio Day", type: "holiday" },
    );
    const { DELETE } = await route();
    expect((await DELETE(requestAs(HR, "/api/admin/holidays?date=2026-10-20", "DELETE"))).status).toBe(200);
    expect((await DELETE(requestAs(HR, "/api/admin/holidays?date=2026-11-30", "DELETE"))).status).toBe(403);
  });

  it("Admin cannot change holidays; an employee can read the upcoming ones", async () => {
    table("attendance_holidays").push(
      { holiday_date: "2026-10-01", name: "Past", type: "special" },
      { holiday_date: "2026-11-01", name: "All Saints' Day", type: "special", day_part: "whole" },
      { holiday_date: "2026-11-30", name: "Bonifacio Day", type: "holiday", day_part: "whole" },
    );
    const { POST, GET } = await route();
    expect((await POST(requestAs(ADMIN, "/api/admin/holidays", "POST", { holiday_date: "2026-12-24", name: "X", type: "suspension" }))).status).toBe(403);
    const body = await (await GET(requestAs(EMPLOYEE, "/api/admin/holidays?upcoming=5"))).json();
    expect(body.holidays.map((h) => h.name)).toEqual(["All Saints' Day", "Bonifacio Day"]);
    expect(body.holidays[1].type_label).toBe("Regular Holiday");
    expect(body.can_manage).toBeNull();
  });
});

describe("payroll on holidays and suspensions", () => {
  const rates = { daily: 500, hourly: 62.5, absent_pct: 100, half_day_pct: 50, regular_holiday_premium_pct: 100, special_holiday_premium_pct: 30 };
  const holidaysOf = (entries, { names = {}, partial = [] } = {}) => {
    const map = new Map(entries);
    map.names = new Map(Object.entries(names));
    map.partialDays = new Set(partial);
    return map;
  };

  it("does not deduct an Absent record dated on a holiday, and skips Holiday days", () => {
    const pay = computeAttendancePay({
      logs: [
        { id: "a", log_date: "2026-12-07", status: "Absent" },
        { id: "b", log_date: "2026-12-08", status: "Absent" },
        { id: "c", log_date: "2026-12-09", status: "Holiday" },
      ],
      rates,
      periodStart: "2026-12-01",
      periodEnd: "2026-12-15",
      holidays: holidaysOf([["2026-12-08", "special"]]),
    });
    expect(pay.counts.absent_days).toBe(1);
    expect(pay.counts.attended_days).toBe(0);
    expect(pay.amounts.absent).toBe(500);
  });

  it("charges half a day for an absence on a morning / afternoon suspension", () => {
    const pay = computeAttendancePay({
      logs: [{ id: "a", log_date: "2026-10-20", status: "Absent" }],
      rates,
      periodStart: "2026-10-16",
      periodEnd: "2026-10-31",
      holidays: holidaysOf([], { names: { "2026-10-20": "Typhoon" }, partial: ["2026-10-20"] }),
    });
    expect(pay.counts.absent_days).toBe(0.5);
    expect(pay.amounts.absent).toBe(250);
    expect(pay.deductions[0]).toMatchObject({ quantity: 0.5, note: "Typhoon: half day" });
  });

  it("names the holiday worked and its hours; a whole-day suspension earns no premium", () => {
    const worked = (id, date) => ({ id, log_date: date, status: "On Time", time_in: `${date}T00:00:00Z`, time_out: `${date}T08:00:00Z` });
    const pay = computeAttendancePay({
      logs: [worked("a", "2026-11-30"), worked("b", "2026-10-21")],
      rates,
      periodStart: "2026-10-16",
      periodEnd: "2026-11-30",
      holidays: holidaysOf([["2026-11-30", "holiday"], ["2026-10-21", "suspension"]], { names: { "2026-11-30": "Bonifacio Day", "2026-10-21": "Typhoon" } }),
    });
    expect(pay.earnings).toHaveLength(1);
    expect(pay.earnings[0]).toMatchObject({ holiday_name: "Bonifacio Day", hours: 8, amount: 500, note: "Bonifacio Day · 8 hrs" });

    const lines = holidayPayLines({ audit: { lines: { incentives: pay.earnings } } });
    expect(lines).toEqual([{ date: "2026-11-30", name: "Bonifacio Day", type: "holiday", hours: 8, amount: 500 }]);
    expect(describeHolidayLine(lines[0])).toBe("Bonifacio Day, Nov 30 (8 h)");
  });

  it("reads an older payslip line without a name or hours", () => {
    const lines = holidayPayLines({ audit: { lines: { incentives: [
      { type: "holiday_premium", amount: 150, quantity: 0.5, log_date: "2026-08-21", holiday_type: "special" },
      { type: "overtime", amount: 99 },
    ] } } });
    expect(lines).toEqual([{ date: "2026-08-21", name: "Special day", type: "special", hours: 4, amount: 150 }]);
  });
});

describe("the Holiday status", () => {
  it("is neither attended nor absent", () => {
    expect(attendanceBucket("Holiday")).toBe("holiday");
    expect(isAttendedStatus("Holiday")).toBe(false);
  });
});

describe("holidays on the boards and the employee dashboard", () => {
  beforeEach(async () => {
    const { users } = await import("./helpers/fake-supabase.js");
    users.push(
      { id: "u-admin", email: "u-admin@sacs.test", user_metadata: { role: "admin", branch_id: "branch-a" } },
      { id: "u-emp", email: "u-emp@sacs.test", user_metadata: { role: "employee", full_name: "Ella Employee", employee_id: "SACS-001", branch_id: "branch-a" } },
    );
    table("profiles").splice(0, table("profiles").length,
      { id: "u-admin", branch_id: "branch-a", role: "admin", archived: false },
      { id: "u-emp", full_name: "Ella Employee", email: "u-emp@sacs.test", branch_id: "branch-a", role: "employee", archived: false },
    );
    table("attendance_holidays").push(
      { holiday_date: TODAY, name: "Typhoon (LGU)", type: "suspension", day_part: "whole" },
      { holiday_date: "2026-10-20", name: "Afternoon off", type: "suspension", day_part: "pm", cutoff: "12:00:00" },
      { holiday_date: "2026-11-01", name: "All Saints' Day", type: "special", day_part: "whole" },
    );
  });

  it("the Admin board lists people who have not tapped on a day off as Holiday, not Absent", async () => {
    const { GET } = await import("@/app/api/admin/attendance/route");
    const body = await (await GET(requestAs(ADMIN, "/api/admin/attendance"))).json();
    const row = body.attendance_logs.find((r) => r.employee_id === "u-emp");
    expect(row).toMatchObject({ status: "Holiday", holiday_name: "Typhoon (LGU)" });
    expect(body.panels.absent_today).toBe(0);
  });

  it("the employee stats carry the month's holidays and the next one", async () => {
    const { GET } = await import("@/app/api/employee/stats/route");
    const body = await (await GET(requestAs({ ...EMPLOYEE, userId: "u-emp" }, "/api/employee/stats"))).json();
    expect(body.holidays.map((h) => h.date)).toEqual([TODAY, "2026-10-20"]);
    expect(body.holidays[1].note).toBe("Work suspended from 12:00 PM");
    expect(body.next_holiday).toMatchObject({ date: TODAY, name: "Typhoon (LGU)" });
  });
});
