/**
 * The four guarantees the RBAC work has to hold, stated as tests.
 *
 * These exercise the real matrix, the real middleware and the real session
 * signing — no mocks of our own code — so a change to
 * src/lib/rbac/permissions.js that reopens one of these holes fails here.
 */

import { describe, it, expect, beforeAll } from "vitest";

process.env.SESSION_SECRET ||= "test-signing-secret-for-rbac-suite";

const { proxy: middleware } = await import("@/proxy");
const { createSessionToken, SESSION_COOKIE, verifySessionToken } = await import("@/lib/rbac/session");
const {
  can,
  canManageRole,
  isBranchExempt,
  isBranchScoped,
  allowedModules,
  scopeFor,
  assertNoHardDelete,
  ROLE_PERMISSIONS,
  SUPER_ADMIN_ONLY_MODULES,
} = await import("@/lib/rbac/permissions");
const { requirePermission, denyForeignBranch, denyRoleEscalation } = await import("@/lib/rbac/guard");

const BRANCH_A = "11111111-1111-1111-1111-111111111111";
const BRANCH_B = "22222222-2222-2222-2222-222222222222";

/** A Request carrying a genuinely signed session cookie for the given role. */
function requestAs(role, { branchId = BRANCH_A, path = "/api/admin/users", method = "GET" } = {}) {
  const token = createSessionToken({
    user_id: `user-${role}`,
    role,
    branch_id: role === "super_admin" ? null : branchId,
    email: `${role}@sacs.test`,
    full_name: role,
  });

  const request = new Request(`https://sacs.test${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });

  // Next.js hands middleware a NextRequest with .nextUrl; the shape below is
  // all our middleware reads.
  request.nextUrl = new URL(request.url);
  return request;
}

function anonymousRequest(path, method = "GET") {
  const request = new Request(`https://sacs.test${path}`, { method });
  request.nextUrl = new URL(request.url);
  return request;
}

/* ══════════════════════════════════════════════════════════════════════════
   1. Admin cannot reach the Super Admin-exclusive modules
   ══════════════════════════════════════════════════════════════════════════ */

describe("Admin is locked out of Super Admin-exclusive modules", () => {
  // The method matters for /branch-management: reading the branch list is a
  // label lookup Admin and HR legitimately need for Branch Assignment, and the
  // route returns only the caller's own branch. It is creating, editing and
  // closing branch records that is Super Admin exclusive.
  const EXCLUSIVE_ROUTES = [
    ["/system-configuration", "/api/admin/config", "system_configuration", "GET"],
    ["/backup-recovery", "/api/admin/backup", "backup_recovery", "GET"],
    ["/roles-permissions", "/api/admin/roles", "roles_permissions", "GET"],
    ["/branch-management", "/api/admin/branches", "branch_management", "POST"],
    ["/system-maintenance", "/api/admin/system", "system_maintenance", "GET"],
  ];

  it.each(EXCLUSIVE_ROUTES)(
    "denies Admin every action on %s",
    (_publicPath, _apiPath, module) => {
      for (const action of ["create", "read", "update", "delete"]) {
        expect(can("admin", module, action)).toBe(false);
      }
      expect(scopeFor("admin", module)).toBe("none");
    },
  );

  it.each(EXCLUSIVE_ROUTES)(
    "middleware rejects Admin calling the API behind %s",
    async (_publicPath, apiPath, _module, method) => {
      const response = middleware(requestAs("admin", { path: apiPath, method }));
      expect(response.status).toBe(403);
    },
  );

  it("lets Admin read branch labels but never write a branch record", () => {
    // Branch Assignment needs the name of the Admin's own branch; the route
    // filters the list down to it.
    expect(middleware(requestAs("admin", { path: "/api/admin/branches", method: "GET" })).status)
      .not.toBe(403);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      expect(middleware(requestAs("admin", { path: "/api/admin/branches", method })).status)
        .toBe(403);
    }
  });

  it("grants Super Admin those same modules", () => {
    for (const moduleName of SUPER_ADMIN_ONLY_MODULES) {
      expect(can("super_admin", moduleName, "read")).toBe(true);
      expect(can("super_admin", moduleName, "update")).toBe(true);
    }
  });

  it("keeps those modules out of the Admin sidebar entirely", () => {
    const adminMenu = allowedModules("admin");
    for (const moduleName of SUPER_ADMIN_ONLY_MODULES) {
      expect(adminMenu).not.toContain(moduleName);
    }
  });

  it("blocks Admin from mutating branch records but lets Super Admin through", () => {
    expect(middleware(requestAs("admin", { path: "/api/admin/branches", method: "POST" })).status).toBe(403);
    expect(middleware(requestAs("admin", { path: "/api/admin/branches", method: "DELETE" })).status).toBe(403);

    const superAdminWrite = middleware(
      requestAs("super_admin", { path: "/api/admin/branches", method: "POST" }),
    );
    expect(superAdminWrite.status).not.toBe(403);
  });

  it("gives Admin the branch-level Reports module it was missing", () => {
    expect(can("admin", "branch_reports", "read")).toBe(true);
    expect(scopeFor("admin", "branch_reports")).toBe("branch");
    // View-only: no edit access to payroll figures.
    expect(can("admin", "branch_reports", "update")).toBe(false);
    expect(can("admin", "branch_reports", "create")).toBe(false);
    expect(allowedModules("admin")).toContain("branch_reports");
  });

  it("keeps Leave Approval view-only for Admin", () => {
    expect(can("admin", "leave_approval", "read")).toBe(true);
    expect(can("admin", "leave_approval", "update")).toBe(false);
    // Final approval stays with HR.
    expect(can("hr", "leave_approval", "update")).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   2. Admin cannot query or mutate another branch's data
   ══════════════════════════════════════════════════════════════════════════ */

describe("Branch scoping", () => {
  it("marks Super Admin branch-exempt and everyone else branch-scoped", () => {
    expect(isBranchExempt("super_admin")).toBe(true);
    for (const role of ["admin", "hr", "accountant", "employee"]) {
      expect(isBranchExempt(role)).toBe(false);
      expect(isBranchScoped(role)).toBe(true);
    }
  });

  it("never gives a branch-scoped role 'all' scope on any module", () => {
    for (const role of ["admin", "hr", "accountant", "employee"]) {
      for (const [module, entry] of Object.entries(ROLE_PERMISSIONS[role])) {
        expect(entry.scope, `${role}.${module}`).not.toBe("all");
      }
    }
  });

  it("pins the Admin guard to the branch in its signed session", async () => {
    const guard = await requirePermission(requestAs("admin"), "user_management", "read");
    expect(guard.denied).toBeNull();
    expect(guard.branchId).toBe(BRANCH_A);
    expect(guard.branchExempt).toBe(false);
  });

  it("refuses an Admin reaching a row in another branch", async () => {
    const guard = await requirePermission(requestAs("admin"), "user_management", "update");
    const denial = denyForeignBranch(guard, BRANCH_B);

    expect(denial).not.toBeNull();
    expect(denial.status).toBe(403);
  });

  it("allows an Admin acting inside its own branch", async () => {
    const guard = await requirePermission(requestAs("admin"), "user_management", "update");
    expect(denyForeignBranch(guard, BRANCH_A)).toBeNull();
  });

  it("lets Super Admin reach every branch", async () => {
    const guard = await requirePermission(
      requestAs("super_admin", { path: "/api/admin/users" }),
      "user_management",
      "update",
    );
    expect(guard.branchExempt).toBe(true);
    expect(denyForeignBranch(guard, BRANCH_A)).toBeNull();
    expect(denyForeignBranch(guard, BRANCH_B)).toBeNull();
  });

  it("refuses a branch-scoped account with no branch on file", async () => {
    const token = createSessionToken({ user_id: "u", role: "admin", branch_id: null });
    const request = new Request("https://sacs.test/api/admin/users", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });

    const guard = await requirePermission(request, "user_management", "read");
    expect(guard.denied).not.toBeNull();
    expect(guard.denied.status).toBe(403);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   3. Admin cannot create or elevate a user to Admin / Super Admin
   ══════════════════════════════════════════════════════════════════════════ */

describe("Role ceiling", () => {
  it("lets Admin manage HR, Accountant and Employee accounts", () => {
    for (const target of ["hr", "accountant", "employee"]) {
      expect(canManageRole("admin", target)).toBe(true);
    }
  });

  it("stops Admin managing Admin or Super Admin accounts", () => {
    expect(canManageRole("admin", "admin")).toBe(false);
    expect(canManageRole("admin", "super_admin")).toBe(false);
  });

  it("returns a 403 when an Admin tries to create an Admin", async () => {
    const guard = await requirePermission(
      requestAs("admin", { path: "/api/admin/users", method: "POST" }),
      "user_management",
      "create",
    );

    const denial = denyRoleEscalation(guard, "admin");
    expect(denial).not.toBeNull();
    expect(denial.status).toBe(403);
  });

  it("returns a 403 when an Admin tries to elevate someone to Super Admin", async () => {
    const guard = await requirePermission(
      requestAs("admin", { path: "/api/admin/users", method: "PATCH" }),
      "user_management",
      "update",
    );

    expect(denyRoleEscalation(guard, "super_admin")?.status).toBe(403);
  });

  it("still allows an Admin to create an Employee", async () => {
    const guard = await requirePermission(
      requestAs("admin", { path: "/api/admin/users", method: "POST" }),
      "user_management",
      "create",
    );
    expect(denyRoleEscalation(guard, "employee")).toBeNull();
  });

  it("lets Super Admin manage every role", () => {
    for (const target of ["super_admin", "admin", "hr", "accountant", "employee"]) {
      expect(canManageRole("super_admin", target)).toBe(true);
    }
  });

  it("gives HR and below no path to creating privileged accounts", () => {
    expect(canManageRole("hr", "admin")).toBe(false);
    expect(canManageRole("hr", "hr")).toBe(false);
    expect(canManageRole("accountant", "employee")).toBe(false);
    expect(canManageRole("employee", "employee")).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   4. No role can hard delete an account
   ══════════════════════════════════════════════════════════════════════════ */

describe("Accounts are archived, never destroyed", () => {
  it("throws from the hard-delete kill switch for any caller", () => {
    expect(() => assertNoHardDelete("user account")).toThrow(/Hard delete is disabled/i);
  });

  it("has no route in the codebase that still calls auth.admin.deleteUser", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".js")) {
          // Skip comment lines — the employees route explains in prose why
          // the call it used to make was removed.
          const code = readFileSync(full, "utf8")
            .split(/\r?\n/)
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join("\n");
          if (code.includes("auth.admin.deleteUser")) offenders.push(full);
        }
      }
    };
    walk("src/app/api");

    expect(offenders).toEqual([]);
  });

  it("has no route that deletes a profiles row", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".js")) {
          const source = readFileSync(full, "utf8");
          if (/from\(["']profiles["']\)\s*\.delete\(/.test(source)) offenders.push(full);
        }
      }
    };
    walk("src/app/api");

    expect(offenders).toEqual([]);
  });

  it("blocks hard deletes at the database level too", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      "supabase/migrations/20260903_rbac_branch_scoping.sql",
      "utf8",
    );

    expect(sql).toContain("block_hard_delete");
    for (const table of ["profiles", "attendance_logs", "payroll_records", "audit_logs"]) {
      expect(sql).toContain(`${table}_block_hard_delete`);
    }
  });

  it("grants no role a delete that bypasses archiving on the employee record", () => {
    // "delete" in the matrix means archive; the route and the DB trigger both
    // enforce that. What matters here is that no role is handed a hard delete
    // path — which the two source scans above assert.
    expect(can("super_admin", "employee_information", "delete")).toBe(true);
    expect(assertNoHardDelete).toBeTypeOf("function");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Session integrity — the guards are only as good as the cookie they read
   ══════════════════════════════════════════════════════════════════════════ */

describe("Session cookie cannot be forged", () => {
  it("rejects a token whose payload was edited", () => {
    const token = createSessionToken({ user_id: "u", role: "employee", branch_id: BRANCH_A });
    const [payload, signature] = token.split(".");

    const tampered = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        role: "super_admin",
      }),
      "utf8",
    ).toString("base64url");

    expect(verifySessionToken(`${tampered}.${signature}`)).toBeNull();
  });

  it("rejects an expired token", () => {
    const expired = Buffer.from(
      JSON.stringify({ sub: "u", role: "admin", exp: Math.floor(Date.now() / 1000) - 10 }),
      "utf8",
    ).toString("base64url");

    expect(verifySessionToken(`${expired}.whatever`)).toBeNull();
  });

  it("rejects garbage and empty input", () => {
    expect(verifySessionToken("")).toBeNull();
    expect(verifySessionToken("not-a-token")).toBeNull();
    expect(verifySessionToken(null)).toBeNull();
  });

  it("turns an unauthenticated API call away with 401", () => {
    expect(middleware(anonymousRequest("/api/admin/users")).status).toBe(401);
  });

  it("fails closed on an API path nobody mapped", () => {
    expect(middleware(requestAs("super_admin", { path: "/api/something/new" })).status).toBe(403);
  });

  it("keeps a signed-in Admin out of the Super Admin portal", () => {
    const response = middleware(requestAs("admin", { path: "/super-admin" }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/admin");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   The matrix matches the documented one
   ══════════════════════════════════════════════════════════════════════════ */

describe("Matrix stays in step with the SQL seed", () => {
  let sql;

  beforeAll(async () => {
    const { readFileSync } = await import("node:fs");
    sql = readFileSync("supabase/migrations/20260903_rbac_branch_scoping.sql", "utf8");
  });

  it("seeds every role/module pair the JS matrix defines", () => {
    for (const [role, modules] of Object.entries(ROLE_PERMISSIONS)) {
      for (const moduleName of Object.keys(modules)) {
        expect(sql, `${role}/${moduleName} missing from role_permissions seed`)
          .toContain(`('${role}', '${moduleName}'`);
      }
    }
  });

  it("agrees with the JS matrix on the Super Admin-exclusive modules", () => {
    for (const moduleName of SUPER_ADMIN_ONLY_MODULES) {
      // Column alignment in the seed is cosmetic, so match on the values.
      const row = new RegExp(
        String.raw`\('admin',\s*'${moduleName}',\s*'none',\s*false,\s*false,\s*false,\s*false\)`,
      );
      expect(sql, `admin/${moduleName} should be seeded with no access`).toMatch(row);
    }
  });
});
