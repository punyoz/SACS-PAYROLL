/**
 * An Employee (SCOPE_SELF on employee_information, attendance and
 * leave_approval) must not list colleagues through the Admin / HR list
 * routes: those filter by branch, which is wider than "own record".
 * Found by the 2026-10-14 health check (an Employee read the whole branch's
 * employee records, attendance and leave). Employees reach their own data
 * through /api/employee/* and /api/attendance/*.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-a";
const ME = "11111111-1111-4111-8111-111111111111";
const COLLEAGUE = "22222222-2222-4222-8222-222222222222";

const ROUTES = [
  ["@/app/api/admin/employees/route", "/api/admin/employees"],
  ["@/app/api/hr/employees/route", "/api/hr/employees"],
  ["@/app/api/admin/attendance/route", "/api/admin/attendance"],
  ["@/app/api/hr/attendance/route", "/api/hr/attendance"],
  ["@/app/api/hr/leave-requests/route", "/api/hr/leave-requests"],
];

describe("Admin / HR list routes refuse self-scoped callers", () => {
  let createSessionToken;
  let SESSION_COOKIE;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-self-scope";
    resetDb();
    users.push(
      { id: ME, email: "me@sacs.test", user_metadata: { role: "employee", full_name: "Me", branch_id: BRANCH, basic_salary: 20000 } },
      { id: COLLEAGUE, email: "them@sacs.test", user_metadata: { role: "employee", full_name: "Colleague", branch_id: BRANCH, basic_salary: 30000 } },
    );
    table("profiles").push(
      { id: ME, full_name: "Me", branch_id: BRANCH, role: "employee", archived: false },
      { id: COLLEAGUE, full_name: "Colleague", branch_id: BRANCH, role: "employee", archived: false },
    );
    table("leave_requests").push({ id: "lr-1", employee_id: COLLEAGUE, branch_id: BRANCH, employee_name: "Colleague", status: "pending_admin" });
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  const as = (role, path) => new Request(`https://sacs.test${path}`, {
    headers: {
      cookie: `${SESSION_COOKIE}=${createSessionToken({ user_id: role === "employee" ? ME : `u-${role}`, role, branch_id: BRANCH, email: `${role}@sacs.test`, full_name: role, session_id: "s" })}`,
    },
  });

  it.each(ROUTES)("%s: an Employee gets 403, not the branch's rows", async (modulePath, path) => {
    const { GET } = await import(modulePath);
    const response = await GET(as("employee", path));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain("Colleague");
  });

  // 2026-10-20: leave is HR's alone; the Admin's branch list is refused too.
  it("a branch-scoped Admin is refused (leave is HR's)", async () => {
    table("profiles").push({ id: "u-admin", branch_id: BRANCH, role: "admin" });
    const { GET } = await import("@/app/api/hr/leave-requests/route");
    const response = await GET(as("admin", "/api/hr/leave-requests"));
    expect(response.status).toBe(403);
  });
});
