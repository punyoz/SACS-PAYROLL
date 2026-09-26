/**
 * The two new write paths around payroll:
 *   - payroll rates (Super Admin): append a version; a date inside an
 *     already-processed pay period moves to the next period, with a warning;
 *   - attendance corrections: employees file only for their own records,
 *     reviewers never decide their own, Admin only for its branch.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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
