/**
 * Role separation (2026-10-20, the user's instruction):
 *   - payroll is processed and submitted by the Accountant only; HR approves
 *     or rejects; the Super Admin does neither and cannot view payroll runs;
 *   - managing employees (attendance, schedules, leave, AWOL, transfers,
 *     Tenure Pay Protection, licenses) is HR's alone;
 *   - subsidy approvals are HR's alone (the Admin and Super Admin have none);
 *   - the Super Admin keeps system functions, the Admin its branch oversight
 *     and the RFID device (its terminal taps need rfid_devices, not attendance).
 * The proxy refuses every one of these before a route runs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetDb, table } from "./helpers/fake-supabase.js";
import { can, canManageRole } from "@/lib/rbac/permissions";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

// branch_assignment is not here: the Super Admin keeps it to move Admin login
// accounts, and the route refuses it for anyone else (tested below).
const EMPLOYEE_MANAGEMENT = [
  "attendance_corrections", "work_schedules", "leave_approval", "awol_cases", "transfer_requests",
  "tenure_protection", "teacher_license",
];
const PAYROLL = ["process_payroll", "payroll_records", "payslips", "payroll_monitoring", "payroll_reports", "loans", "payroll_run_approval", "payroll_approvals"];

describe("the matrix", () => {
  it("only the Accountant processes payroll; only HR approves it", () => {
    for (const role of ["super_admin", "admin", "hr", "employee"]) {
      for (const action of ["create", "update"]) expect(can(role, "process_payroll", action), `${role} ${action}`).toBe(false);
    }
    expect(can("accountant", "process_payroll", "create")).toBe(true);
    expect(can("hr", "payroll_run_approval", "update")).toBe(true);
    for (const role of ["super_admin", "admin", "accountant", "employee"]) expect(can(role, "payroll_run_approval", "update"), role).toBe(false);
  });

  it("the Super Admin and the Admin reach no payroll module", () => {
    for (const role of ["super_admin", "admin"]) {
      for (const mod of PAYROLL) expect(can(role, mod, "read"), `${role} ${mod}`).toBe(false);
    }
  });

  it("employee management is HR's alone (the Admin and the Super Admin change nothing)", () => {
    for (const mod of EMPLOYEE_MANAGEMENT) {
      for (const role of ["super_admin", "admin"]) {
        for (const action of ["create", "update", "delete"]) expect(can(role, mod, action), `${role} ${mod} ${action}`).toBe(false);
      }
    }
    for (const mod of ["attendance", "attendance_corrections", "work_schedules", "leave_approval", "awol_cases", "transfer_requests", "tenure_protection"]) {
      expect(can("hr", mod, "update"), `hr ${mod}`).toBe(true);
    }
    // The Super Admin's read-only attendance / employee list (backups, the rate picker) writes nothing.
    expect(can("super_admin", "attendance", "update")).toBe(false);
    expect(can("super_admin", "employee_information", "update")).toBe(false);
    expect(can("admin", "attendance", "read")).toBe(false);
  });

  it("subsidy approvals: HR decides, the Accountant requests, the Admin and the Super Admin have none", () => {
    expect(can("hr", "payroll_approvals", "update")).toBe(true);
    expect(can("accountant", "payroll_approvals", "create")).toBe(true);
    expect(can("accountant", "payroll_approvals", "update")).toBe(false);
    for (const role of ["super_admin", "admin"]) expect(can(role, "payroll_approvals", "read"), role).toBe(false);
  });

  it("the Super Admin keeps system functions and the staff login accounts only", () => {
    for (const mod of ["system_configuration", "branch_management", "roles_permissions", "audit_logs", "backup_recovery", "system_maintenance", "rfid_devices"]) {
      expect(can("super_admin", mod, "update"), mod).toBe(true);
    }
    expect(canManageRole("super_admin", "hr")).toBe(true);
    expect(canManageRole("super_admin", "employee")).toBe(false);
    expect(canManageRole("super_admin", "accountant")).toBe(false);
  });

  it("the Admin and the Super Admin run the RFID device", () => {
    expect(can("admin", "rfid_devices", "update")).toBe(true);
    expect(can("super_admin", "rfid_devices", "update")).toBe(true);
  });
});

describe("sidebars", () => {
  const nav = (file) => readFileSync(file, "utf8");

  it("the Super Admin has no Attendance, Tenure or payslip-override page", () => {
    const portal = nav("src/app/super-admin/super-admin-portal.jsx");
    expect(portal).not.toMatch(/id: "sa-attendance"/);
    expect(portal).not.toMatch(/id: "sa-tenure"/);
    const config = nav("src/app/super-admin/config-page.jsx");
    expect(config).not.toMatch(/OverrideSection/);
    expect(config).not.toMatch(/WorkSchedulesPanel/);
  });

  // 2026-10-20 redesign: the Admin's pages are branch oversight (read-only
  // attendance, recommendations and reports to HR); none manages employees,
  // payroll, subsidy approvals or system settings.
  it("no Admin page uses an employee-management, payroll or system module", () => {
    const portal = nav("src/app/admin/admin-portal.jsx");
    const modules = [...portal.matchAll(/module: "(\w+)"/g)].map((m) => m[1]);
    for (const forbidden of ["attendance", "work_schedules", "payroll_approvals", "tenure_protection", "user_management", "process_payroll",
      "payroll_run_approval", "leave_approval", "awol_cases", "transfer_requests", "system_configuration", "audit_logs"]) {
      expect(modules, forbidden).not.toContain(forbidden);
    }
    for (const id of ["adm-approvals", "adm-tenure", "adm-audit-logs"]) expect(portal).not.toMatch(new RegExp(`id: "${id}"`));
  });

  it("HR's Subsidy Approvals sits under Payroll, not Leave", () => {
    const portal = nav("src/app/hr/hr-portal.jsx");
    const leave = portal.slice(portal.indexOf('section: "Leave"'), portal.indexOf('section: "Payroll"'));
    const payroll = portal.slice(portal.indexOf('section: "Payroll"'), portal.indexOf('section: "Reports"'));
    expect(leave).not.toMatch(/payroll_approvals/);
    expect(payroll).toMatch(/id: "hr-subsidy-approvals", label: "Subsidy Approvals"/);
  });
});

describe("the proxy refuses before any route runs", () => {
  let createSessionToken;
  let SESSION_COOKIE;
  let proxy;
  let NextRequest;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-role-separation";
    resetDb();
    table("profiles").push(
      { id: "u-sa", role: "super_admin", branch_id: null },
      { id: "u-admin", role: "admin", branch_id: "branch-a" },
    );
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
    ({ proxy } = await import("@/proxy"));
    ({ NextRequest } = await import("next/server"));
  });

  const call = (who, path, method = "GET", body = null, headers = {}) => {
    const token = createSessionToken({ user_id: who.id, role: who.role, branch_id: who.branch ?? null, email: `${who.role}@sacs.test`, full_name: who.role, session_id: `s-${who.id}` });
    return proxy(new NextRequest(`https://sacs.test${path}`, {
      method,
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}`, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }));
  };
  const SA = { id: "u-sa", role: "super_admin" };
  const ADMIN = { id: "u-admin", role: "admin", branch: "branch-a" };

  it("the Super Admin cannot process, generate, override or submit payroll, nor open Payroll Approval", async () => {
    expect((await call(SA, "/api/accountant/payroll", "POST", { action: "batch_submit" })).status).toBe(403);
    expect((await call(SA, "/api/accountant/payroll", "PATCH", { action: "generate" })).status).toBe(403);
    expect((await call(SA, "/api/accountant/payroll", "PATCH", { action: "override_final" })).status).toBe(403);
    expect((await call(SA, "/api/accountant/payroll-runs", "PATCH", { action: "submit" })).status).toBe(403);
    expect((await call(SA, "/api/hr/payroll-runs")).status).toBe(403);
  });

  it("the Admin and the Super Admin cannot reach subsidy approvals", async () => {
    for (const who of [SA, ADMIN]) {
      expect((await call(who, "/api/admin/approvals")).status).toBe(403);
      expect((await call(who, "/api/admin/approvals", "PATCH", { action: "decide_adjustment" })).status).toBe(403);
    }
  });

  it("the Admin and the Super Admin cannot manage employees", async () => {
    for (const who of [SA, ADMIN]) {
      expect((await call(who, "/api/hr/tenure-protection", "POST", { action: "grant" })).status).toBe(403);
      expect((await call(who, "/api/admin/work-schedules", "POST", { action: "assign" })).status).toBe(403);
      expect((await call(who, "/api/hr/leave-requests", "PATCH", {})).status).toBe(403);
      expect((await call(who, "/api/hr/awol-cases", "PATCH", {})).status).toBe(403);
      expect((await call(who, "/api/attendance/corrections", "PATCH", {})).status).toBe(403);
      expect((await call(who, "/api/admin/attendance", "POST", { rfid_code: "1", manual_entry: true })).status).toBe(403);
    }
  });

  it("the Super Admin moves an Admin account to a branch, never an employee", async () => {
    const { users } = await import("./helpers/fake-supabase.js");
    users.push({ id: "u-emp", email: "emp@sacs.test", user_metadata: { role: "employee", full_name: "Emma", branch_id: "branch-a" } });
    table("branches").push({ id: "branch-b", name: "Annex", status: "active" });
    const { POST } = await import("@/app/api/admin/branch-employees/route");
    const token = createSessionToken({ user_id: "u-sa", role: "super_admin", branch_id: null, email: "sa@sacs.test", full_name: "Sam", session_id: "s-sa" });
    const response = await POST(new Request("https://sacs.test/api/admin/branch-employees", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ user_id: "u-emp", branch_id: "branch-b" }),
    }));
    expect(response.status).toBe(403);
  });

  it("an RFID Terminal tap (the kiosk header) still reaches the route for the Admin", async () => {
    const response = await call(ADMIN, "/api/admin/attendance", "POST", { rfid_code: "1234567890" }, { "x-sacs-kiosk": "1" });
    expect(response.status).not.toBe(403);
  });
});

describe("the database follows the same rules", () => {
  const sql = readFileSync("supabase/migrations/20261020010000_role_separation.sql", "utf8");

  it("payroll runs are started and submitted by the Accountant only", () => {
    expect(sql).toMatch(/v_actor\.role <> 'accountant'/);
    expect(sql).not.toMatch(/'accountant', 'super_admin'/);
  });

  it("Tenure Pay Protection grants and settings are HR's", () => {
    expect(sql).toMatch(/v_role <> 'hr'/);
    expect(sql).not.toMatch(/'hr', 'admin', 'super_admin'/);
  });

  it("subsidy adjustments carry an HR decision", () => {
    expect(sql).toMatch(/decided_by_role = 'hr'/);
  });
});
