/**
 * The guard decides from the account as it is NOW (2026-11-21): role, branch
 * and archived are read from profiles on every request, never from the
 * sign-in cookie. A change takes effect on the very next request.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, resetDb, setMissingTables, table } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
process.env.SESSION_SECRET = "test-secret-live-account";

const { createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session");
const { requirePermission } = await import("@/lib/rbac/guard");

const NORTH = "b-north";
const SOUTH = "b-south";

function asAdmin() {
  const token = createSessionToken({ user_id: "u-ada", role: "admin", branch_id: NORTH, email: "ada@sacs.test", full_name: "Ada", session_id: "s-1" });
  return new Request("https://sacs.test/api/admin/branch-oversight", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
}
const profile = () => table("profiles").find((p) => p.id === "u-ada");

beforeEach(() => {
  resetDb();
  table("profiles").push({ id: "u-ada", role: "admin", branch_id: NORTH, archived: false });
});

describe("requirePermission reads the account live", () => {
  it("allows the Admin while the profile still says Admin", async () => {
    const guard = await requirePermission(asAdmin(), "branch_oversight", "read");
    expect(guard.denied).toBeNull();
    expect(guard.branchId).toBe(NORTH);
  });

  it("Admin → HR: the very next request is refused, though the cookie still says Admin", async () => {
    await requirePermission(asAdmin(), "branch_oversight", "read"); // warm any cache
    profile().role = "hr";
    const guard = await requirePermission(asAdmin(), "branch_oversight", "read");
    expect(guard.denied?.status).toBe(401);
    expect((await guard.denied.json()).error).toMatch(/role was changed/);
  });

  it("archived (deactivated / offboarded after final pay): the very next request is refused", async () => {
    await requirePermission(asAdmin(), "branch_oversight", "read");
    profile().archived = true;
    const guard = await requirePermission(asAdmin(), "branch_oversight", "read");
    expect(guard.denied?.status).toBe(401);
  });

  it("an account whose profile is gone is refused", async () => {
    const request = asAdmin();
    table("profiles").length = 0;
    // Real sessions always have a profile; drop the test setup's stand-in.
    globalThis.__signedInProfiles?.delete("u-ada");
    const guard = await requirePermission(request, "branch_oversight", "read");
    expect(guard.denied?.status).toBe(401);
  });

  it("profiles cannot be read: refused (503), never decided from the cookie", async () => {
    delete db.profiles;
    setMissingTables(["profiles"]);
    const guard = await requirePermission(asAdmin(), "branch_oversight", "read");
    expect(guard.denied?.status).toBe(503);
  });

  it("branch move: the very next request is scoped to the new branch", async () => {
    await requirePermission(asAdmin(), "branch_oversight", "read");
    profile().branch_id = SOUTH;
    const guard = await requirePermission(asAdmin(), "branch_oversight", "read");
    expect(guard.denied).toBeNull();
    expect(guard.branchId).toBe(SOUTH);
  });

  it("branch removed: a branch-scoped Admin is refused rather than left unscoped", async () => {
    profile().branch_id = null;
    const guard = await requirePermission(asAdmin(), "branch_oversight", "read");
    expect(guard.denied?.status).toBe(403);
  });
});

describe("a separated (offboarded) account keeps only its own payslips and profile", () => {
  const HR = { user_id: "u-hana", role: "hr", branch_id: null, email: "hana@sacs.test", full_name: "Hana", session_id: "s-2" };
  const as = (path, who = HR) => new Request(`https://sacs.test${path}`, { headers: { cookie: `${SESSION_COOKIE}=${createSessionToken(who)}` } });
  const hana = () => table("profiles").find((p) => p.id === "u-hana");

  beforeEach(() => {
    table("profiles").push({ id: "u-hana", role: "hr", branch_id: null, archived: false, employee_status: "Active" });
  });

  it("before separation HR reaches its HR pages", async () => {
    expect((await requirePermission(as("/api/hr/employees"), "employee_information", "read")).denied).toBeNull();
  });

  it("offboarded HR: the next HR request is refused, My Payslips (final pay included) and My Profile still work", async () => {
    await requirePermission(as("/api/hr/employees"), "employee_information", "read");
    hana().employee_status = "Separated";
    const hrPage = await requirePermission(as("/api/hr/employees"), "employee_information", "read");
    expect(hrPage.denied?.status).toBe(403);
    expect((await hrPage.denied.json()).error).toMatch(/separated/);
    const myPayslips = await requirePermission(as("/api/me/payslips"), "payslips", "read");
    expect(myPayslips.denied).toBeNull();
    expect(myPayslips.myAccount).toBe(true);
    expect((await requirePermission(as("/api/legacy-auth/update-profile"), "profile", "read")).denied).toBeNull();
    expect((await requirePermission(as("/api/legacy-auth/update-profile"), "profile", "update")).denied).toBeNull();
  });

  it("offboarded: own timesheet, attendance and leave are read-only (2026-11-22); filing and every role permission are refused", async () => {
    hana().employee_status = "Separated";
    // User decision 2026-11-22: they keep Timesheet and Leave as READ-ONLY until archived.
    expect((await requirePermission(as("/api/me/timesheet"), "timesheet", "read")).denied).toBeNull();
    expect((await requirePermission(as("/api/me/leave-requests"), "leave_approval", "read")).denied).toBeNull();
    expect((await requirePermission(as("/api/me/leave-requests"), "leave_approval", "create")).denied?.status).toBe(403);
    expect((await requirePermission(as("/api/me/overtime-requests"), "leave_approval", "create")).denied?.status).toBe(403);
    expect((await requirePermission(as("/api/me/attendance/corrections"), "attendance_corrections", "create")).denied?.status).toBe(403);
    // HR's own leave pages (every branch) are a role permission: refused.
    expect((await requirePermission(as("/api/hr/leave-requests"), "leave_approval", "read")).denied?.status).toBe(403);
    expect((await requirePermission(as("/api/hr/payroll-approval"), "payroll_approvals", "update")).denied?.status).toBe(403);
    // An Accountant, an Admin and a Super Admin lose theirs the same way.
    for (const role of ["accountant", "admin", "super_admin"]) {
      table("profiles").push({ id: `u-${role}`, role, branch_id: role === "super_admin" ? null : NORTH, archived: false, employee_status: "Separated" });
      const who = { user_id: `u-${role}`, role, branch_id: role === "super_admin" ? null : NORTH, email: `${role}@sacs.test`, full_name: role, session_id: "s-3" };
      expect((await requirePermission(as("/api/admin/branch-oversight", who), "branch_oversight", "read")).denied?.status, role).toBe(403);
    }
  });

  it("an offboarded employee still opens its own payslips", async () => {
    table("profiles").push({ id: "u-eli", role: "employee", branch_id: NORTH, archived: false, employee_status: "Separated" });
    const eli = { user_id: "u-eli", role: "employee", branch_id: NORTH, email: "eli@sacs.test", full_name: "Eli", session_id: "s-4" };
    expect((await requirePermission(as("/api/employee/payslips", eli), "payslips", "read")).denied).toBeNull();
  });

  it("archived after final pay: nothing at all", async () => {
    Object.assign(hana(), { employee_status: "Separated", archived: true });
    expect((await requirePermission(as("/api/me/payslips"), "payslips", "read")).denied?.status).toBe(401);
  });
});
