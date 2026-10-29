/**
 * The final-payslip override (decision 2026-10-29, 20261029040000):
 *
 *   - Super Admin only (payroll_override), and only action "override_final":
 *     the Accountant, HR, the Admin and an Employee are refused by the proxy
 *     and by the route, called directly;
 *   - the Super Admin still has no process_payroll (it cannot generate,
 *     reprocess, read or submit payroll);
 *   - the override log is the Super Admin's; review flags are marked
 *     reviewed by the Accountant (its branch) and HR (run flags), never by
 *     the Super Admin.
 *
 * The database side (payslip, archive, log, flags in one transaction) is
 * scripts/checks/payroll-override-scenarios.sql, run on Postgres.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, rpc } from "./helpers/fake-supabase.js";
import { can } from "@/lib/rbac/permissions";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const IDS = {
  super_admin: "aaaaaaaa-0000-4000-8000-0000000000fa",
  accountant: "aaaaaaaa-0000-4000-8000-0000000000ac",
  hr: "aaaaaaaa-0000-4000-8000-0000000000a1",
  admin: "aaaaaaaa-0000-4000-8000-0000000000ad",
  employee: "aaaaaaaa-0000-4000-8000-0000000000e1",
};
const BRANCH = "bbbbbbbb-0000-4000-8000-00000000000a";
const OTHER_BRANCH = "bbbbbbbb-0000-4000-8000-00000000000b";
const ROLES = Object.keys(IDS);
const OVERRIDE = { action: "override_final", employee_id: IDS.employee, pay_period: "October 1-15, 2026", reason: "Corrected a miscalculated loan deduction after HR dispute" };

let createSessionToken;
let SESSION_COOKIE;

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-payroll-override";
  resetDb();
  for (const role of ROLES) {
    table("profiles").push({ id: IDS[role], role, branch_id: role === "super_admin" || role === "hr" ? null : BRANCH, full_name: `The ${role}` });
  }
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

function token(role) {
  return createSessionToken({
    user_id: IDS[role], role, branch_id: role === "super_admin" || role === "hr" ? null : BRANCH,
    email: `${role}@sacs.test`, full_name: `The ${role}`, session_id: `s-${role}`,
  });
}

function request(role, path, method = "GET", body = null) {
  return new Request(`https://sacs.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token(role)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("the matrix", () => {
  it("payroll_override is the Super Admin's alone", () => {
    expect(can("super_admin", "payroll_override", "update")).toBe(true);
    expect(can("super_admin", "payroll_override", "read")).toBe(true);
    for (const role of ["accountant", "hr", "admin", "employee"]) {
      for (const action of ["create", "read", "update", "delete"]) expect(can(role, "payroll_override", action), `${role} ${action}`).toBe(false);
    }
  });

  it("the Super Admin still has no process_payroll", () => {
    for (const action of ["create", "read", "update", "delete"]) expect(can("super_admin", "process_payroll", action)).toBe(false);
  });
});

describe("a direct override call", () => {
  it("the proxy lets only the Super Admin and the Accountant's PATCH through (the route then decides)", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const status = async (role) => (await proxy(new NextRequest(`https://sacs.test/api/accountant/payroll`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token(role)}` },
      body: JSON.stringify(OVERRIDE),
    }))).status;
    expect(await status("super_admin")).not.toBe(403);
    expect(await status("accountant")).not.toBe(403);
    for (const role of ["hr", "admin", "employee"]) expect(await status(role), role).toBe(403);
  });

  it("the route refuses the Accountant, HR, the Admin and an Employee; nothing reaches the database", async () => {
    const { PATCH } = await import("@/app/api/accountant/payroll/route");
    for (const role of ["accountant", "hr", "admin", "employee"]) {
      const response = await PATCH(request(role, "/api/accountant/payroll", "PATCH", OVERRIDE));
      expect(response.status, role).toBe(403);
    }
    expect(rpc.calls.some((c) => c.fn === "payroll_override_final")).toBe(false);
  });

  it("the route refuses the Super Admin every action but override_final", async () => {
    const { PATCH } = await import("@/app/api/accountant/payroll/route");
    for (const action of ["generate", "cancel_draft", "archive_monthly_item", "process_13th_month", "set_cash_advance_status"]) {
      const response = await PATCH(request("super_admin", "/api/accountant/payroll", "PATCH", { ...OVERRIDE, action }));
      expect(response.status, action).toBe(403);
    }
  });
});

describe("the override log (GET /api/payroll/overrides)", () => {
  beforeEach(() => {
    table("payroll_final_overrides").push({
      id: "o-1", entry_id: "e-1", employee_id: IDS.employee, employee_name: "The employee", branch_id: BRANCH,
      pay_period: OVERRIDE.pay_period, run_status: "approved", reason: OVERRIDE.reason, old_payslip_no: "PS-1", new_payslip_no: "PS-2",
      old_values: { net_pay: 9000 }, new_values: { net_pay: 9500 }, changed_fields: ["net_pay"],
      actor_id: IDS.super_admin, actor_name: "The super_admin", actor_role: "super_admin", created_at: "2026-10-29T08:00:00Z",
    });
    table("payroll_review_flags").push({ id: "f-1", override_id: "o-1", kind: "remittance", status: "open", message: "m", created_at: "2026-10-29T08:00:00Z" });
  });

  it("the Super Admin reads every override with its flags", async () => {
    const { GET } = await import("@/app/api/payroll/overrides/route");
    const response = await GET(request("super_admin", "/api/payroll/overrides"));
    expect(response.status).toBe(200);
    const { overrides } = await response.json();
    expect(overrides).toEqual([expect.objectContaining({
      id: "o-1", reason: OVERRIDE.reason, actor_role: "super_admin", old_values: { net_pay: 9000 }, new_values: { net_pay: 9500 },
      review_flags: [expect.objectContaining({ id: "f-1", kind: "remittance" })],
    })]);
  });

  it("no other role reads it", async () => {
    const { GET } = await import("@/app/api/payroll/overrides/route");
    for (const role of ["accountant", "hr", "admin", "employee"]) {
      expect((await GET(request(role, "/api/payroll/overrides"))).status, role).toBe(403);
    }
  });
});

describe("review flags (GET / PATCH /api/payroll/review-flags)", () => {
  beforeEach(() => {
    const base = { override_id: "o-1", employee_id: IDS.employee, pay_period: OVERRIDE.pay_period, tax_year: 2026, status: "open", message: "m", created_at: "2026-10-29T08:00:00Z" };
    table("payroll_review_flags").push(
      { ...base, id: "aaaaaaaa-0000-4000-8000-0000000f0001", kind: "remittance", branch_id: BRANCH },
      { ...base, id: "aaaaaaaa-0000-4000-8000-0000000f0002", kind: "bir_2316", branch_id: BRANCH },
      { ...base, id: "aaaaaaaa-0000-4000-8000-0000000f0003", kind: "payroll_run", branch_id: BRANCH },
      { ...base, id: "aaaaaaaa-0000-4000-8000-0000000f0004", kind: "tax_annualization", branch_id: OTHER_BRANCH },
    );
  });

  const ids = async (role) => {
    const { GET } = await import("@/app/api/payroll/review-flags/route");
    const response = await GET(request(role, "/api/payroll/review-flags"));
    return response.status === 200 ? (await response.json()).flags.map((f) => f.id.slice(-1)).sort() : response.status;
  };

  it("each role sees the flags it reviews", async () => {
    expect(await ids("accountant")).toEqual(["1", "2"]);
    expect(await ids("hr")).toEqual(["3"]);
    expect(await ids("super_admin")).toEqual(["1", "2", "3", "4"]);
    expect(await ids("admin")).toBe(403);
    expect(await ids("employee")).toBe(403);
  });

  it("the Accountant marks its flag reviewed with a note; the Super Admin cannot", async () => {
    const { PATCH } = await import("@/app/api/payroll/review-flags/route");
    const id = "aaaaaaaa-0000-4000-8000-0000000f0001";
    expect((await PATCH(request("super_admin", "/api/payroll/review-flags", "PATCH", { id, note: "Re-filed the remittance" }))).status).toBe(403);
    expect((await PATCH(request("accountant", "/api/payroll/review-flags", "PATCH", { id, note: "ok" }))).status).toBe(400);
    expect((await PATCH(request("accountant", "/api/payroll/review-flags", "PATCH", { id: "aaaaaaaa-0000-4000-8000-0000000f0003", note: "Run totals checked" }))).status).toBe(404);
    const done = await PATCH(request("accountant", "/api/payroll/review-flags", "PATCH", { id, note: "Re-filed the October remittance" }));
    expect(done.status).toBe(200);
    expect(table("payroll_review_flags").find((f) => f.id === id)).toMatchObject({ status: "reviewed", reviewed_by: IDS.accountant, review_note: "Re-filed the October remittance" });
    expect(table("audit_logs").find((row) => row.action === "review_flag_reviewed")).toMatchObject({ module: "payroll_override" });
    expect((await PATCH(request("accountant", "/api/payroll/review-flags", "PATCH", { id, note: "Again" }))).status).toBe(409);
  });
});
