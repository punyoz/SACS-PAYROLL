/**
 * HR / Admin correct any attendance record (PATCH /api/attendance/corrections
 * { action: "correct_record" }), and the Individual Employee Attendance page
 * (GET /api/attendance/employee/:id).
 *
 * The recompute itself (hours, late, undertime, status Corrected) happens in
 * the database function attendance_correct_record; these tests pin what the
 * route sends it, who may call it, and the audit entry it writes.
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

const HR = { userId: "u-hr", role: "hr", branchId: null, fullName: "Hana HR" };
const ADMIN = { userId: "u-admin", role: "admin", branchId: "branch-a", fullName: "Ada Admin" };

// What attendance_correct_record returns: the approved correction row, with
// the original taps and the recomputed facts next to the new values.
function fakeCorrection(args) {
  return {
    data: {
      id: "corr-1",
      log_id: args.p_log_id || "log-new",
      employee_id: args.p_employee_id,
      employee_name: "Emma Employee",
      log_date: args.p_log_date,
      correction_type: args.p_type,
      original_time_in: "2026-09-18T01:40:00.000Z",
      original_time_out: "2026-09-18T09:00:00.000Z",
      original_total_hours: 7.33,
      original_late_minutes: 100,
      original_undertime_minutes: 0,
      corrected_time_in: args.p_time_in || "2026-09-18T01:40:00.000Z",
      corrected_time_out: args.p_time_out || "2026-09-18T09:00:00.000Z",
      corrected_total_hours: 9,
      corrected_late_minutes: 0,
      corrected_undertime_minutes: 0,
      approved_by_name: args.p_reviewer_name,
      reason: args.p_note,
      status: "approved",
    },
    error: null,
  };
}

const patch = async (who, body) => {
  const { PATCH } = await import("@/app/api/attendance/corrections/route");
  return PATCH(requestAs(who, "/api/attendance/corrections", "PATCH", { action: "correct_record", ...body }));
};

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-correct-record";
  resetDb();
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));

  table("profiles").push(
    { id: "u-emp", full_name: "Emma Employee", role: "employee", branch_id: "branch-a", employee_id: "SACS-003" },
    { id: "u-far", full_name: "Fred Far", role: "employee", branch_id: "branch-b", employee_id: "SACS-009" },
    { id: "u-admin", full_name: "Ada Admin", role: "admin", branch_id: "branch-a" },
  );
  table("attendance_logs").push(
    // Tapped in at 9:40 by mistake (Late), tapped out 17:00.
    { id: "log-late", employee_id: "u-emp", employee_name: "Emma Employee", log_date: "2026-09-18", status: "Late",
      time_in: "2026-09-18T01:40:00.000Z", time_out: "2026-09-18T09:00:00.000Z", total_hours: 7.33, late_minutes: 100, undertime_minutes: 0 },
    // A normal On Time day, both taps present.
    { id: "log-ontime", employee_id: "u-emp", employee_name: "Emma Employee", log_date: "2026-09-17", status: "On Time",
      time_in: "2026-09-17T00:00:00.000Z", time_out: "2026-09-17T09:00:00.000Z", total_hours: 9, late_minutes: 0, undertime_minutes: 0 },
    // An Absent record written by the nightly close.
    { id: "log-absent", employee_id: "u-emp", employee_name: "Emma Employee", log_date: "2026-09-16", status: "Absent",
      time_in: null, time_out: null, total_hours: 0, late_minutes: 0, undertime_minutes: 0 },
    { id: "log-far", employee_id: "u-far", employee_name: "Fred Far", log_date: "2026-09-18", status: "Late",
      time_in: "2026-09-18T01:40:00.000Z", time_out: "2026-09-18T09:00:00.000Z" },
  );
  rpc.results.attendance_correct_record = fakeCorrection;
});

describe("Correct any record", () => {
  it("corrects an accidental late time in, as Manila time on the record's day", async () => {
    const response = await patch(HR, { log_id: "log-late", type: "time_in", time_in: "07:55", note: "Tapped late by mistake; logbook says 7:55" });
    expect(response.status).toBe(200);
    expect(rpc.calls).toContainEqual({
      fn: "attendance_correct_record",
      args: {
        p_log_id: "log-late", p_employee_id: "u-emp", p_log_date: "2026-09-18", p_type: "time_in",
        p_time_in: "2026-09-17T23:55:00.000Z", p_time_out: null,
        p_reviewer: "u-hr", p_reviewer_name: "Hana HR", p_note: "Tapped late by mistake; logbook says 7:55",
      },
    });
  });

  it("corrects an accidental late time out", async () => {
    const response = await patch(HR, { log_id: "log-late", type: "time_out", time_out: "17:05", note: "Left at 5:05, tapped at 7 by mistake" });
    expect(response.status).toBe(200);
    const call = rpc.calls.find((c) => c.fn === "attendance_correct_record");
    expect(call.args).toMatchObject({ p_type: "time_out", p_time_in: null, p_time_out: "2026-09-18T09:05:00.000Z" });
  });

  it("corrects both time in and time out", async () => {
    const response = await patch(ADMIN, { log_id: "log-late", type: "both", time_in: "08:00", time_out: "17:00", note: "Both taps were wrong" });
    expect(response.status).toBe(200);
    const call = rpc.calls.find((c) => c.fn === "attendance_correct_record");
    expect(call.args).toMatchObject({
      p_type: "both", p_time_in: "2026-09-18T00:00:00.000Z", p_time_out: "2026-09-18T09:00:00.000Z", p_reviewer: "u-admin",
    });
  });

  it("corrects a record that was already tapped On Time", async () => {
    const response = await patch(HR, { log_id: "log-ontime", type: "time_out", time_out: "16:30", note: "Left early with permission" });
    expect(response.status).toBe(200);
    const call = rpc.calls.find((c) => c.fn === "attendance_correct_record");
    expect(call.args).toMatchObject({ p_log_id: "log-ontime", p_log_date: "2026-09-17", p_time_out: "2026-09-17T08:30:00.000Z" });
  });

  it("corrects an Absent record (worked but did not tap)", async () => {
    const response = await patch(HR, { log_id: "log-absent", type: "present", time_in: "08:00", time_out: "17:00", note: "RFID reader was down" });
    expect(response.status).toBe(200);
    const call = rpc.calls.find((c) => c.fn === "attendance_correct_record");
    expect(call.args).toMatchObject({ p_log_id: "log-absent", p_type: "present", p_time_in: "2026-09-16T00:00:00.000Z" });
  });

  it("corrects today's not-yet-tapped day (no record) by employee and date", async () => {
    const response = await patch(HR, { employee_id: "u-emp", log_date: "2026-09-21", type: "present", time_in: "08:00", time_out: "12:00", note: "Card forgotten at home" });
    expect(response.status).toBe(200);
    const call = rpc.calls.find((c) => c.fn === "attendance_correct_record");
    expect(call.args).toMatchObject({ p_log_id: null, p_employee_id: "u-emp", p_log_date: "2026-09-21" });
  });

  it("writes an audit entry with who, old values, new values and the reason", async () => {
    await patch(HR, { log_id: "log-late", type: "time_in", time_in: "07:55", note: "Tapped late by mistake" });
    const entry = table("audit_logs").find((row) => row.action === "record_correct");
    expect(entry).toBeTruthy();
    const metadata = typeof entry.metadata === "string" ? JSON.parse(entry.metadata) : entry.metadata;
    expect(metadata).toMatchObject({
      type: "time_in",
      reason: "Tapped late by mistake",
      old_values: { status: "Late", time_in: "2026-09-18T01:40:00.000Z", late_minutes: 100 },
      new_values: { status: "Corrected", late_minutes: 0 },
    });
  });

  it("validates: time out after time in, a reason, a known type", async () => {
    expect((await patch(HR, { log_id: "log-late", type: "both", time_in: "17:00", time_out: "08:00", note: "Backwards times" })).status).toBe(400);
    expect((await patch(HR, { log_id: "log-late", type: "time_in", time_in: "08:00", note: "" })).status).toBe(400);
    expect((await patch(HR, { log_id: "log-late", type: "time_in", note: "No time given" })).status).toBe(400);
    expect((await patch(HR, { log_id: "log-late", type: "delete", note: "Not a correction type" })).status).toBe(400);
    expect(rpc.calls.filter((c) => c.fn === "attendance_correct_record")).toHaveLength(0);
  });

  it("rejects non-admin roles on the server, whatever the browser shows", async () => {
    for (const who of [
      { userId: "u-emp", role: "employee" },
      { userId: "u-acct", role: "accountant" },
    ]) {
      const response = await patch(who, { log_id: "log-late", type: "time_in", time_in: "08:00", note: "Trying to fix my own day" });
      expect(response.status, who.role).toBe(403);
    }
    expect(rpc.calls.filter((c) => c.fn === "attendance_correct_record")).toHaveLength(0);
  });

  it("keeps an Admin to its own branch, and nobody corrects their own day", async () => {
    expect((await patch(ADMIN, { log_id: "log-far", type: "time_in", time_in: "08:00", note: "Other branch" })).status).toBe(403);
    expect((await patch(ADMIN, { employee_id: "u-admin", log_date: "2026-09-18", type: "present", time_in: "08:00", time_out: "17:00", note: "My own day" })).status).toBe(403);
    expect(rpc.calls.filter((c) => c.fn === "attendance_correct_record")).toHaveLength(0);
  });

  it("passes the database's own message through when it refuses", async () => {
    rpc.results.attendance_correct_record = () => ({
      data: null,
      error: { code: "23514", message: "This day is covered by approved leave. Cancel the leave first to record attendance." },
    });
    const response = await patch(HR, { log_id: "log-late", type: "time_in", time_in: "08:00", note: "On leave that day" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/approved leave/);
  });
});

describe("Individual Employee Attendance page", () => {
  const get = async (who, id, query = "?from=2026-09-01&to=2026-09-30") => {
    const { GET } = await import("@/app/api/attendance/employee/[id]/route");
    return GET(requestAs(who, `/api/attendance/employee/${id}${query}`), { params: Promise.resolve({ id }) });
  };
  const EMP_ID = "11111111-1111-4111-8111-111111111111";
  const FAR_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    table("profiles").push(
      { id: EMP_ID, full_name: "Emma Employee", role: "employee", branch_id: "branch-a", employee_id: "SACS-003", position: "Teacher I", employee_status: "Active", rfid_uid: "0012345678" },
      { id: FAR_ID, full_name: "Fred Far", role: "employee", branch_id: "branch-b", employee_id: "SACS-009" },
    );
    table("branches").push({ id: "branch-a", name: "Main Branch" }, { id: "branch-b", name: "Robinson Branch" });
    table("attendance_logs").push(
      { id: "log-c", employee_id: EMP_ID, employee_name: "Emma Employee", log_date: "2026-09-18", status: "Corrected", archived_duplicate: false,
        time_in: "2026-09-18T00:00:00.000Z", time_out: "2026-09-18T09:00:00.000Z", late_minutes: 0, undertime_minutes: 0 },
    );
    table("attendance_corrections").push(
      { id: "corr-old", log_id: "log-c", employee_id: EMP_ID, log_date: "2026-09-18", status: "approved", correction_type: "time_in",
        original_time_in: "2026-09-18T01:40:00.000Z", corrected_time_in: "2026-09-18T00:00:00.000Z", approved_by_name: "Hana HR",
        reason: "Tapped late by mistake", requested_at: "2026-09-19T01:00:00.000Z" },
    );
  });

  it("returns the header, the masked RFID card, and each day's correction history", async () => {
    const response = await get(HR, EMP_ID);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.employee).toMatchObject({ full_name: "Emma Employee", employee_code: "SACS-003", branch_name: "Main Branch", position: "Teacher I" });
    expect(body.employee.rfid_masked).toMatch(/5678$/);
    expect(body.employee.rfid_masked).not.toContain("00123");
    const day = body.logs.find((row) => row.id === "log-c");
    expect(day.corrections).toHaveLength(1);
    expect(day.last_correction).toMatchObject({ approved_by_name: "Hana HR", reason: "Tapped late by mistake" });
  });

  it("is HR / Admin only, and an Admin only for its own branch", async () => {
    expect((await get({ userId: "u-emp", role: "employee" }, EMP_ID)).status).toBe(403);
    expect((await get({ userId: "u-acct", role: "accountant" }, EMP_ID)).status).toBe(403);
    expect((await get(ADMIN, FAR_ID)).status).toBe(403);
    expect((await get(ADMIN, EMP_ID)).status).toBe(200);
  });
});

describe("Page access", () => {
  it("opens the employee record page for Admin and HR only", async () => {
    const { allowedPagesFor } = await import("@/lib/rbac/menu");
    expect(allowedPagesFor("admin")).toContain("adm-att-employee");
    expect(allowedPagesFor("hr")).toContain("hr-att-employee");
    expect(allowedPagesFor("accountant").some((page) => page.endsWith("att-employee"))).toBe(false);
    expect(allowedPagesFor("employee").some((page) => page.endsWith("att-employee"))).toBe(false);
  });
});
