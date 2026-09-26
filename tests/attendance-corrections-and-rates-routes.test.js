/**
 * The two new write paths around payroll:
 *   - payroll rates (Super Admin): append a version; a date inside an
 *     already-processed pay period moves to the next period, with a warning;
 *   - attendance corrections: employees file only for their own records,
 *     reviewers never decide their own, Admin only for its branch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, rpc } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

let createSessionToken;
let SESSION_COOKIE;

function requestAs({ userId, role, branchId = "branch-a", fullName = "Tester" }, url, method = "GET", body) {
  const token = createSessionToken({
    user_id: userId, role, branch_id: branchId, email: `${userId}@sacs.test`, full_name: fullName, session_id: "s-1",
  });
  return new Request(`https://sacs.test${url}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-corrections-rates";
  resetDb();
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("Payroll rates", () => {
  const SUPER = { userId: "u-sa", role: "super_admin", branchId: null, fullName: "Sam Super" };

  it("adds a version as given when no processed period is in the way", async () => {
    const { POST } = await import("@/app/api/admin/payroll-rates/route");
    const response = await POST(requestAs(SUPER, "/api/admin/payroll-rates", "POST", {
      rate_type: "hourly", scope: "global", value: 110, effective_date: "2026-10-01",
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ effective_date: "2026-10-01", adjusted: false, warning: null });
    expect(table("payroll_rate_configs")[0]).toMatchObject({
      rate_type: "hourly", value: 110, effective_date: "2026-10-01", created_by: "u-sa", created_by_name: "Sam Super", scope_ref: null,
    });
  });

  it("moves a date inside an already-processed period to the next period, and says so", async () => {
    table("payroll_entries").push(
      { id: "e1", employee_id: "x", pay_period: "September 1-15, 2026", status: "paid" },
      { id: "e2", employee_id: "y", pay_period: "September 16-30, 2026", status: "draft" },
    );
    const { POST } = await import("@/app/api/admin/payroll-rates/route");
    const body = await (await POST(requestAs(SUPER, "/api/admin/payroll-rates", "POST", {
      rate_type: "sss_pct", scope: "global", value: 4.5, effective_date: "2026-09-10",
    }))).json();
    expect(body).toMatchObject({ effective_date: "2026-09-16", adjusted: true });
    expect(body.warning).toMatch(/September 1-15, 2026 has already been processed/);
    expect(table("payroll_rate_configs")[0].effective_date).toBe("2026-09-16");
  });

  it("validates the value, scope and percentage cap", async () => {
    const { POST } = await import("@/app/api/admin/payroll-rates/route");
    const post = (payload) => POST(requestAs(SUPER, "/api/admin/payroll-rates", "POST", payload));
    expect((await post({ rate_type: "sss_pct", scope: "global", value: 150, effective_date: "2026-10-01" })).status).toBe(400);
    expect((await post({ rate_type: "hourly", scope: "branch", value: 90, effective_date: "2026-10-01" })).status).toBe(400);
    expect((await post({ rate_type: "nope", scope: "global", value: 1, effective_date: "2026-10-01" })).status).toBe(400);
    expect(table("payroll_rate_configs")).toHaveLength(0);
  });

  it("is Super Admin only", async () => {
    const { POST } = await import("@/app/api/admin/payroll-rates/route");
    for (const role of ["admin", "hr", "accountant", "employee"]) {
      const response = await POST(requestAs({ userId: `u-${role}`, role }, "/api/admin/payroll-rates", "POST", {
        rate_type: "hourly", scope: "global", value: 1, effective_date: "2026-10-01",
      }));
      expect(response.status, role).toBe(403);
    }
  });
});

describe("Attendance corrections", () => {
  const EMPLOYEE = { userId: "u-emp", role: "employee" };

  beforeEach(() => {
    table("profiles").push(
      { id: "u-emp", branch_id: "branch-a" },
      { id: "u-other", branch_id: "branch-b" },
      { id: "u-admin", branch_id: "branch-a" },
    );
    table("attendance_logs").push(
      { id: "log-mine", employee_id: "u-emp", log_date: "2026-09-18", status: "Incomplete" },
      { id: "log-theirs", employee_id: "u-other", log_date: "2026-09-18", status: "Incomplete" },
    );
    table("attendance_corrections").push(
      { id: "c-mine", employee_id: "u-emp", log_id: "log-mine", log_date: "2026-09-18", status: "pending" },
      { id: "c-other-branch", employee_id: "u-other", log_id: "log-theirs", log_date: "2026-09-18", status: "pending" },
    );
  });

  it("files a request for the employee's own record, as Manila time on that day", async () => {
    const { POST } = await import("@/app/api/attendance/corrections/route");
    const response = await POST(requestAs(EMPLOYEE, "/api/attendance/corrections", "POST", {
      log_id: "log-mine", corrected_time: "17:00", reason: "Reader was offline",
    }));
    expect(response.status).toBe(200);
    expect(rpc.calls).toContainEqual({
      fn: "attendance_request_correction",
      args: { p_log_id: "log-mine", p_employee_id: "u-emp", p_corrected_time_out: "2026-09-18T09:00:00.000Z", p_reason: "Reader was offline" },
    });
  });

  it("will not file for someone else's record", async () => {
    const { POST } = await import("@/app/api/attendance/corrections/route");
    const response = await POST(requestAs(EMPLOYEE, "/api/attendance/corrections", "POST", {
      log_id: "log-theirs", corrected_time: "17:00", reason: "Not my record",
    }));
    expect(response.status).toBe(404);
    expect(rpc.calls).toHaveLength(0);
  });

  it("lets an employee see only their own requests, and not decide any", async () => {
    const { GET, PATCH } = await import("@/app/api/attendance/corrections/route");
    const list = await (await GET(requestAs(EMPLOYEE, "/api/attendance/corrections?status=all"))).json();
    expect(list.corrections.map((c) => c.id)).toEqual(["c-mine"]);
    const decide = await PATCH(requestAs(EMPLOYEE, "/api/attendance/corrections", "PATCH", { correction_id: "c-mine", decision: "approve" }));
    expect(decide.status).toBe(403);
  });

  it("keeps an Admin to its own branch", async () => {
    const { PATCH } = await import("@/app/api/attendance/corrections/route");
    const admin = { userId: "u-admin", role: "admin" };
    const foreign = await PATCH(requestAs(admin, "/api/attendance/corrections", "PATCH", { correction_id: "c-other-branch", decision: "approve" }));
    expect(foreign.status).toBe(403);
    const own = await PATCH(requestAs(admin, "/api/attendance/corrections", "PATCH", { correction_id: "c-mine", decision: "reject", resolution: "absent" }));
    expect(own.status).toBe(200);
    expect(rpc.calls.at(-1)).toMatchObject({ fn: "attendance_review_correction", args: { p_decision: "reject", p_resolution: "absent", p_reviewer: "u-admin" } });
  });

  it("never lets a reviewer decide their own request", async () => {
    table("attendance_corrections").push({ id: "c-hr-own", employee_id: "u-hr", log_id: "x", status: "pending" });
    const { PATCH } = await import("@/app/api/attendance/corrections/route");
    const response = await PATCH(requestAs({ userId: "u-hr", role: "hr", branchId: null }, "/api/attendance/corrections", "PATCH", { correction_id: "c-hr-own", decision: "approve" }));
    expect(response.status).toBe(403);
  });
});

describe("Today's non-tappers and correcting an absence", () => {
  // Monday 28 Sep 2026, 10:00 Manila.
  const MONDAY = new Date("2026-09-28T02:00:00Z");
  const HR = { userId: "u-hr", role: "hr", branchId: null, fullName: "Hana HR" };
  const ADMIN = { userId: "u-admin", role: "admin", branchId: "branch-a", fullName: "Ada Admin" };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MONDAY);
    table("profiles").push(
      { id: "u-tapped", full_name: "Tapped In", role: "employee", branch_id: "branch-a", employee_type: "Teaching", date_hired: "2026-01-01" },
      { id: "u-missing", full_name: "Not Yet", role: "employee", branch_id: "branch-a", employee_type: "Teaching", date_hired: "2026-01-01" },
      { id: "u-leave", full_name: "On Leave", role: "accountant", branch_id: "branch-a", employee_id: "SACS-009", date_hired: "2026-01-01" },
      { id: "u-archived", full_name: "Gone", role: "employee", branch_id: "branch-a", archived: true },
      { id: "u-newhire", full_name: "Starts Later", role: "employee", branch_id: "branch-a", date_hired: "2026-10-01" },
      { id: "u-other-branch", full_name: "Elsewhere", role: "employee", branch_id: "branch-b", date_hired: "2026-01-01" },
      { id: "u-admin", full_name: "Ada Admin", role: "admin", branch_id: "branch-a" },
    );
    table("attendance_logs").push({
      id: "log-today", employee_id: "u-tapped", employee_name: "Tapped In", log_date: "2026-09-28",
      time_in: "2026-09-28T00:05:00Z", status: "On Time", archived_duplicate: false, branch_id: "branch-a",
    });
    table("leave_requests").push({ employee_id: "SACS-009", status: "approved", start_date: "2026-09-28", end_date: "2026-09-29" });
  });

  afterEach(() => vi.useRealTimers());

  it("lists today's non-tappers as Absent on HR's Attendance page", async () => {
    const { GET } = await import("@/app/api/hr/attendance/route");
    const body = await (await GET(requestAs(HR, "/api/hr/attendance?date=2026-09-28"))).json();
    const names = body.logs.map((row) => [row.employee_name, row.status, Boolean(row.not_yet_tapped)]);
    expect(names).toEqual(expect.arrayContaining([
      ["Tapped In", "On Time", false],
      ["Not Yet", "Absent", true],
      ["Elsewhere", "Absent", true],
    ]));
    // On approved leave, archived, not hired yet, and staff accounts are not listed.
    expect(names.map((n) => n[0])).not.toEqual(expect.arrayContaining(["On Leave"]));
    expect(names.map((n) => n[0])).not.toContain("Gone");
    expect(names.map((n) => n[0])).not.toContain("Starts Later");
    expect(names.map((n) => n[0])).not.toContain("Ada Admin");
    expect(body.summary.absent).toBe(2);
  });

  it("adds nobody on a rest day", async () => {
    vi.setSystemTime(new Date("2026-09-27T02:00:00Z")); // Sunday
    const { GET } = await import("@/app/api/hr/attendance/route");
    const body = await (await GET(requestAs(HR, "/api/hr/attendance?date=2026-09-27"))).json();
    expect(body.logs.filter((row) => row.not_yet_tapped)).toHaveLength(0);
  });

  it("shows them on the status board to reviewers, scoped to the Admin's branch", async () => {
    const { GET } = await import("@/app/api/attendance/logs/route");
    const board = await (await GET(requestAs(ADMIN, "/api/attendance/logs"))).json();
    const absent = board.logs.filter((row) => row.not_yet_tapped).map((row) => row.employee_name);
    expect(absent).toEqual(["Not Yet"]);
    expect(board.can_review).toBe(true);
  });

  it("does not call an employee absent in their own view before the day is over", async () => {
    const { GET } = await import("@/app/api/attendance/logs/route");
    const own = await (await GET(requestAs({ userId: "u-missing", role: "employee" }, "/api/attendance/logs"))).json();
    expect(own.logs.filter((row) => row.not_yet_tapped)).toHaveLength(0);
  });

  it("lets HR correct an absence with the real times and a reason", async () => {
    const { PATCH } = await import("@/app/api/attendance/corrections/route");
    const response = await PATCH(requestAs(HR, "/api/attendance/corrections", "PATCH", {
      action: "correct_absence", employee_id: "u-missing", log_date: "2026-09-28",
      time_in: "08:05", time_out: "09:30", note: "Reader was offline this morning",
    }));
    expect(response.status).toBe(200);
    expect(rpc.calls.at(-1)).toEqual({
      fn: "attendance_correct_absence",
      args: {
        p_employee_id: "u-missing",
        p_log_date: "2026-09-28",
        p_time_in: "2026-09-28T00:05:00.000Z",
        p_time_out: "2026-09-28T01:30:00.000Z",
        p_reviewer: "u-hr",
        p_reviewer_name: "Hana HR",
        p_note: "Reader was offline this morning",
      },
    });
  });

  it("validates the input and keeps an Admin to its branch", async () => {
    const { PATCH } = await import("@/app/api/attendance/corrections/route");
    const patch = (who, body) => PATCH(requestAs(who, "/api/attendance/corrections", "PATCH", { action: "correct_absence", ...body }));
    const valid = { employee_id: "u-missing", log_date: "2026-09-28", time_in: "08:00", time_out: "17:00", note: "Reader was offline" };
    expect((await patch(HR, { ...valid, time_out: "07:00" })).status).toBe(400);
    expect((await patch(HR, { ...valid, note: "no" })).status).toBe(400);
    expect((await patch(HR, { ...valid, time_in: "8am" })).status).toBe(400);
    expect((await patch(ADMIN, { ...valid, employee_id: "u-other-branch" })).status).toBe(403);
    expect((await patch({ userId: "u-missing", role: "employee" }, valid)).status).toBe(403);
    expect(rpc.calls.filter((c) => c.fn === "attendance_correct_absence")).toHaveLength(0);
  });
});
