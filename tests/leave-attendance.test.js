/**
 * Approved leave in attendance (20260928010000_leave_attendance_sync.sql):
 *
 *   - On Leave is its own status: never Absent, never an attended day, and
 *     payroll deducts nothing for it (the leave line pays or deducts it);
 *   - an RFID tap on a day covered by APPROVED leave is refused on the
 *     server, nothing is saved, and the attempt is kept for HR;
 *   - pending leave never blocks a tap;
 *   - HR approving reports the days that already have a real tap, and HR can
 *     cancel approved leave until it ends (the database releases the days).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, users, rpc } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

import { computeAttendancePay } from "@/lib/payroll/attendance-pay";
import { DEFAULT_RATES } from "@/lib/payroll/rates";
import { attendanceBucket, isAttendedStatus, normalizeAttendanceStatus, STATUS_TONES } from "@/lib/attendance/status";

const BRANCH = "branch-a";
const EMP = "u-emp";
const CARD = "0012345678";

const rates = (overrides = {}) => Object.fromEntries(
  Object.entries({ ...DEFAULT_RATES, ...overrides }).map(([type, value]) => [type, { value, config_id: `cfg-${type}` }]),
);

const leaveRow = (fields = {}) => ({
  id: "leave-1",
  employee_id: EMP,
  employee_name: "Ella Employee",
  position: "Employee",
  leave_type: "Sick Leave",
  pay_status: "with_pay",
  start_date: "2026-09-29",
  end_date: "2026-09-30",
  reason: "Flu",
  proof_url: "",
  status: "approved",
  submitted_at: "2026-09-20T00:00:00Z",
  decided_at: "2026-09-21T00:00:00Z",
  decided_by_name: "Hana HR",
  branch_id: BRANCH,
  ...fields,
});

describe("On Leave status", () => {
  it("is its own bucket: not absent, not attended", () => {
    expect(normalizeAttendanceStatus("on leave")).toBe("On Leave");
    expect(attendanceBucket("On Leave")).toBe("leave");
    expect(isAttendedStatus("On Leave")).toBe(false);
    expect(STATUS_TONES["On Leave"]).toBe("blue");
  });

  it("costs nothing in payroll and is not an attended day", () => {
    const result = computeAttendancePay({
      logs: [
        { id: "a", log_date: "2026-09-29", status: "On Leave", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false },
        { id: "b", log_date: "2026-09-28", status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false, time_in: "x", time_out: "y" },
      ],
      rates: rates({ daily: 600, absent_pct: 100 }),
      periodStart: "2026-09-16",
      periodEnd: "2026-09-30",
    });
    expect(result.counts.absent_days).toBe(0);
    expect(result.counts.attended_days).toBe(1);
    expect(result.amounts.absent).toBe(0);
    expect(result.deductions).toEqual([]);
  });
});

describe("isEmployeeOnLeave", () => {
  beforeEach(() => resetDb());

  const client = async () => {
    const { createClient } = await import("@supabase/supabase-js");
    return createClient("https://project.supabase.co", "service");
  };

  it("uses the database definition", async () => {
    const { isEmployeeOnLeave } = await import("@/lib/attendance/leave");
    rpc.results.attendance_approved_leave = { data: [leaveRow()], error: null };
    const leave = await isEmployeeOnLeave(await client(), EMP, "2026-09-29");
    expect(leave).toMatchObject({ id: "leave-1", leave_type: "Sick Leave", approved_by: "Hana HR" });
    expect(rpc.calls.at(-1)).toEqual({ fn: "attendance_approved_leave", args: { p_employee_id: EMP, p_day: "2026-09-29" } });
  });

  it("falls back to approved requests only, inclusive of both ends", async () => {
    const { isEmployeeOnLeave } = await import("@/lib/attendance/leave");
    rpc.results.attendance_approved_leave = { data: null, error: { message: "function does not exist" } };
    table("leave_requests").push(leaveRow(), leaveRow({ id: "leave-2", start_date: "2026-10-05", end_date: "2026-10-05", status: "pending_admin" }));
    const supabase = await client();

    expect(await isEmployeeOnLeave(supabase, EMP, "2026-09-30")).toMatchObject({ id: "leave-1" });
    expect(await isEmployeeOnLeave(supabase, EMP, "2026-10-01")).toBeNull();
    // Pending leave never counts.
    expect(await isEmployeeOnLeave(supabase, EMP, "2026-10-05")).toBeNull();
  });
});

describe("RFID tap on a leave day", () => {
  let POST;
  let createSessionToken;
  let SESSION_COOKIE;

  const tap = () => {
    const token = createSessionToken({
      user_id: "u-admin", role: "admin", branch_id: BRANCH, email: "admin@sacs.test",
      full_name: "Ada Admin", session_id: "s-1",
    });
    return new Request("https://sacs.test/api/admin/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ rfid_code: CARD }),
    });
  };

  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-leave-attendance";
    resetDb();
    users.push(
      { id: "u-admin", email: "admin@sacs.test", user_metadata: { role: "admin", full_name: "Ada Admin", branch_id: BRANCH } },
      {
        id: EMP,
        email: "emp@sacs.test",
        user_metadata: { role: "employee", full_name: "Ella Employee", employee_id: "SACS-001", rfid_uid: CARD, branch_id: BRANCH },
      },
    );
    table("profiles").push(
      { id: "u-admin", branch_id: BRANCH, role: "admin" },
      { id: EMP, full_name: "Ella Employee", email: "emp@sacs.test", branch_id: BRANCH, role: "employee" },
    );

    ({ POST } = await import("@/app/api/admin/attendance/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("is refused with the leave message, saves nothing and is kept for HR", async () => {
    rpc.results.attendance_approved_leave = { data: [leaveRow()], error: null };

    const res = await POST(tap());
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data).toMatchObject({ error: "You are on leave today. Attendance tap is not allowed.", on_leave: true });
    expect(table("attendance_logs")).toHaveLength(0);
    expect(table("attendance_blocked_taps")).toEqual([expect.objectContaining({
      employee_id: EMP, leave_request_id: "leave-1", source: "rfid_tap", reason: data.error,
    })]);
    expect(table("audit_logs").some((row) => row.action === "rfid_blocked_on_leave" && row.status === "failed")).toBe(true);
  });

  it("works normally when no approved leave covers today", async () => {
    rpc.results.attendance_approved_leave = { data: [], error: null };

    const res = await POST(tap());
    expect(res.status).toBe(200);
    expect(table("attendance_logs")).toHaveLength(1);
    expect(table("attendance_blocked_taps")).toHaveLength(0);
  });
});

describe("HR leave decisions and attendance", () => {
  let PATCH;
  let createSessionToken;
  let SESSION_COOKIE;

  const patch = (body) => {
    const token = createSessionToken({
      user_id: "u-hr", role: "hr", branch_id: null, email: "hr@sacs.test",
      full_name: "Hana HR", session_id: "s-2",
    });
    return new Request("https://sacs.test/api/hr/leave-requests", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify(body),
    });
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T02:00:00Z"));
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-leave-attendance";
    resetDb();
    users.push({ id: "u-hr", email: "hr@sacs.test", user_metadata: { role: "hr", full_name: "Hana HR" } });
    table("profiles").push({ id: "u-hr", role: "hr" });

    ({ PATCH } = await import("@/app/api/hr/leave-requests/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("approving reports days that already have a real tap", async () => {
    table("leave_requests").push(leaveRow({ status: "pending_admin", decided_at: null, decided_by_name: null }));
    const conflict = { log_id: "log-9", log_date: "2026-09-29", status: "On Time" };
    rpc.results.attendance_sync_leave = { data: { marked: 1, removed: 0, conflicts: [conflict] }, error: null };

    const res = await PATCH(patch({ id: "leave-1", action: "approve" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.attendance_conflicts).toEqual([conflict]);
    expect(table("leave_requests")[0].status).toBe("approved");
    vi.useRealTimers();
  });

  it("cancels approved leave that has not ended, keeping the approver", async () => {
    table("leave_requests").push(leaveRow());

    const res = await PATCH(patch({ id: "leave-1", action: "cancel" }));
    expect(res.status).toBe(200);
    expect(table("leave_requests")[0]).toMatchObject({
      status: "cancelled", cancelled_by: "u-hr", cancelled_by_name: "Hana HR", decided_by_name: "Hana HR",
    });
    expect(rpc.calls.some((call) => call.fn === "attendance_sync_leave" && call.args.p_leave_id === "leave-1")).toBe(true);
    vi.useRealTimers();
  });

  it("refuses to cancel leave that has already ended, or is not approved", async () => {
    table("leave_requests").push(
      leaveRow({ id: "old", start_date: "2026-09-01", end_date: "2026-09-02" }),
      leaveRow({ id: "pending", status: "pending_admin" }),
    );

    expect((await PATCH(patch({ id: "old", action: "cancel" }))).status).toBe(409);
    expect((await PATCH(patch({ id: "pending", action: "cancel" }))).status).toBe(409);
    expect(table("leave_requests").map((row) => row.status)).toEqual(["approved", "pending_admin"]);
    vi.useRealTimers();
  });
});
