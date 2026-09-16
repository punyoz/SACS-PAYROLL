/**
 * The guarantees the RBAC work has to hold, stated as tests.
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
  isBranchExemptFor,
  isBranchScoped,
  allowedModules,
  scopeFor,
  assertNoHardDelete,
  ROLE_PERMISSIONS,
  SUPER_ADMIN_ONLY_MODULES,
} = await import("@/lib/rbac/permissions");
const { requirePermission, denyForeignBranch, denyRoleEscalation } = await import("@/lib/rbac/guard");
const { buildMenu } = await import("@/lib/rbac/menu");

const BRANCH_A = "11111111-1111-1111-1111-111111111111";
const BRANCH_B = "22222222-2222-2222-2222-222222222222";

/** A signed session token for the given role, as the login route would issue it. */
function tokenFor(role, { branchId = BRANCH_A, claims = {} } = {}) {
  return createSessionToken({
    user_id: `user-${role}`,
    role,
    branch_id: role === "super_admin" ? null : branchId,
    email: `${role}@sacs.test`,
    full_name: role,
    session_id: `session-${role}`,
    ...claims,
  });
}

/** A Request carrying a genuinely signed session cookie for the given role. */
function requestAs(role, { branchId = BRANCH_A, path = "/api/admin/users", method = "GET", claims = {} } = {}) {
  const request = new Request(`https://sacs.test${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${tokenFor(role, { branchId, claims })}` },
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

async function statusOf(request) {
  return (await middleware(request)).status;
}

/* ══════════════════════════════════════════════════════════════════════════
   1. Admin cannot reach the Super Admin-exclusive modules
   ══════════════════════════════════════════════════════════════════════════ */

describe("Admin is locked out of Super Admin-exclusive modules", () => {
  // The method matters for /branch-management: reading the branch list is a
  // label lookup every portal legitimately needs. It is creating, editing and
  // closing branch records that is Super Admin exclusive.
  const EXCLUSIVE_ROUTES = [
    ["/system-configuration", "/api/admin/config", "system_configuration", "GET"],
    ["/backup-recovery", "/api/admin/backup", "backup_recovery", "GET"],
    ["/roles-permissions", "/api/admin/roles", "roles_permissions", "GET"],
    ["/branch-management", "/api/admin/branches", "branch_management", "POST"],
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
      expect(await statusOf(requestAs("admin", { path: apiPath, method }))).toBe(403);
    },
  );

  it("lets Admin read branch labels but never write a branch record", async () => {
    expect(await statusOf(requestAs("admin", { path: "/api/admin/branches", method: "GET" }))).not.toBe(403);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      expect(await statusOf(requestAs("admin", { path: "/api/admin/branches", method }))).toBe(403);
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

  it("blocks Admin from mutating branch records but lets Super Admin through", async () => {
    expect(await statusOf(requestAs("admin", { path: "/api/admin/branches", method: "POST" }))).toBe(403);
    expect(await statusOf(requestAs("admin", { path: "/api/admin/branches", method: "DELETE" }))).toBe(403);
    expect(await statusOf(requestAs("super_admin", { path: "/api/admin/branches", method: "POST" }))).not.toBe(403);
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
   2. Portal responsibilities: HR runs employees, Admin runs RFID maintenance
   ══════════════════════════════════════════════════════════════════════════ */

describe("Employee management belongs to HR", () => {
  const pagesOf = (role) => buildMenu(role).flatMap((section) => section.items.map((item) => item.page));

  it("removes User Management and Transfer Requests from Admin", async () => {
    for (const moduleName of ["user_management", "transfer_requests", "branch_assignment"]) {
      expect(scopeFor("admin", moduleName)).toBe("none");
    }
    expect(buildMenu("admin").map((section) => section.section)).not.toContain("Management");
    expect(await statusOf(requestAs("admin", { path: "/api/admin/users", method: "POST" }))).toBe(403);
    expect(await statusOf(requestAs("admin", { path: "/api/admin/employees", method: "POST" }))).toBe(403);
    expect(await statusOf(requestAs("admin", { path: "/api/admin/transfer-requests", method: "POST" }))).toBe(403);
  });

  it("removes Transfer Requests from the Super Admin sidebar", () => {
    const pages = pagesOf("super_admin");
    expect(pages).not.toContain("sa-transfer-requests");
    expect(pages).toContain("sa-accounts");
  });

  it("gives HR user management and transfers across every branch", async () => {
    for (const moduleName of ["user_management", "employee_information", "transfer_requests"]) {
      expect(scopeFor("hr", moduleName)).toBe("all");
      expect(can("hr", moduleName, "create")).toBe(true);
      expect(isBranchExemptFor("hr", moduleName)).toBe(true);
    }
    expect(pagesOf("hr")).toEqual(expect.arrayContaining(["hr-employees", "hr-transfers"]));
    expect(await statusOf(requestAs("hr", { path: "/api/admin/employees", method: "POST" }))).not.toBe(403);
    expect(await statusOf(requestAs("hr", { path: "/api/admin/transfer-requests", method: "POST" }))).not.toBe(403);
  });

  it("lets HR act on another branch's employee record", async () => {
    const guard = await requirePermission(requestAs("hr"), "employee_information", "update");
    expect(guard.denied).toBeNull();
    expect(guard.branchExempt).toBe(true);
    expect(denyForeignBranch(guard, BRANCH_B)).toBeNull();
  });

  it("keeps HR branch-scoped everywhere else", async () => {
    const guard = await requirePermission(requestAs("hr"), "attendance", "read");
    expect(guard.branchExempt).toBe(false);
    expect(denyForeignBranch(guard, BRANCH_B)?.status).toBe(403);
  });

  it("gives Admin the System Maintenance screen for its own branch", async () => {
    expect(scopeFor("admin", "system_maintenance")).toBe("branch");
    expect(can("admin", "system_maintenance", "update")).toBe(true);
    expect(pagesOf("admin")).toContain("adm-maintenance");
    expect(await statusOf(requestAs("admin", { path: "/api/admin/system", method: "PATCH" }))).not.toBe(403);

    const guard = await requirePermission(requestAs("admin"), "system_maintenance", "update");
    expect(denyForeignBranch(guard, BRANCH_B)?.status).toBe(403);
    expect(denyForeignBranch(guard, BRANCH_A)).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   3. Branch scoping
   ══════════════════════════════════════════════════════════════════════════ */

describe("Branch scoping", () => {
  it("marks Super Admin branch-exempt and everyone else branch-scoped", () => {
    expect(isBranchExempt("super_admin")).toBe(true);
    for (const role of ["admin", "hr", "accountant", "employee"]) {
      expect(isBranchExempt(role)).toBe(false);
      expect(isBranchScoped(role)).toBe(true);
    }
  });

  it("gives 'all' scope to no branch-scoped role except HR on its employee modules", () => {
    const HR_ALL_BRANCH_MODULES = [
      "user_management",
      "employee_information",
      "employee_info_readonly",
      "branch_assignment",
      "transfer_requests",
    ];
    for (const role of ["admin", "hr", "accountant", "employee"]) {
      for (const [module, entry] of Object.entries(ROLE_PERMISSIONS[role])) {
        const allowed = role === "hr" && HR_ALL_BRANCH_MODULES.includes(module);
        if (!allowed) expect(entry.scope, `${role}.${module}`).not.toBe("all");
      }
    }
  });

  it("pins the Admin guard to the branch in its signed session", async () => {
    const guard = await requirePermission(requestAs("admin"), "attendance", "read");
    expect(guard.denied).toBeNull();
    expect(guard.branchId).toBe(BRANCH_A);
    expect(guard.branchExempt).toBe(false);
  });

  it("refuses an Admin reaching a row in another branch", async () => {
    const guard = await requirePermission(requestAs("admin"), "attendance", "update");
    const denial = denyForeignBranch(guard, BRANCH_B);

    expect(denial).not.toBeNull();
    expect(denial.status).toBe(403);
  });

  it("allows an Admin acting inside its own branch", async () => {
    const guard = await requirePermission(requestAs("admin"), "attendance", "update");
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
    const token = createSessionToken({ user_id: "u", role: "admin", branch_id: null, session_id: "s" });
    const request = new Request("https://sacs.test/api/admin/attendance", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });

    const guard = await requirePermission(request, "attendance", "read");
    expect(guard.denied).not.toBeNull();
    expect(guard.denied.status).toBe(403);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   4. Nobody creates or elevates an account above their ceiling
   ══════════════════════════════════════════════════════════════════════════ */

describe("Role ceiling", () => {
  it("lets HR manage Employee and Accountant accounts only", () => {
    expect(canManageRole("hr", "employee")).toBe(true);
    expect(canManageRole("hr", "accountant")).toBe(true);
    for (const target of ["hr", "admin", "super_admin"]) {
      expect(canManageRole("hr", target)).toBe(false);
    }
  });

  it("gives Admin no account management at all", () => {
    for (const target of ["super_admin", "admin", "hr", "accountant", "employee"]) {
      expect(canManageRole("admin", target)).toBe(false);
    }
  });

  it("returns a 403 when HR tries to create an Admin or HR account", async () => {
    const guard = await requirePermission(
      requestAs("hr", { path: "/api/admin/employees", method: "POST" }),
      "user_management",
      "create",
    );
    expect(denyRoleEscalation(guard, "admin")?.status).toBe(403);
    expect(denyRoleEscalation(guard, "hr")?.status).toBe(403);
    expect(denyRoleEscalation(guard, "super_admin")?.status).toBe(403);
  });

  it("still allows HR to create an Employee", async () => {
    const guard = await requirePermission(
      requestAs("hr", { path: "/api/admin/employees", method: "POST" }),
      "user_management",
      "create",
    );
    expect(denyRoleEscalation(guard, "employee")).toBeNull();
  });

  it("lets Super Admin manage every role (it creates the Admin and HR logins)", () => {
    for (const target of ["super_admin", "admin", "hr", "accountant", "employee"]) {
      expect(canManageRole("super_admin", target)).toBe(true);
    }
  });

  it("gives Accountant and Employee no path to creating accounts", () => {
    expect(canManageRole("accountant", "employee")).toBe(false);
    expect(canManageRole("employee", "employee")).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5. No role can hard delete an account
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
    const token = createSessionToken({ user_id: "u", role: "employee", branch_id: BRANCH_A, session_id: "s" });
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

  it("rejects a token whose password-change claim was lifted", () => {
    const token = createSessionToken({
      user_id: "u", role: "employee", branch_id: BRANCH_A, session_id: "s", must_change_password: true,
    });
    const [payload, signature] = token.split(".");
    const lifted = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), pwd: false }),
      "utf8",
    ).toString("base64url");

    expect(verifySessionToken(`${lifted}.${signature}`)).toBeNull();
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

  it("turns an unauthenticated API call away with 401", async () => {
    expect(await statusOf(anonymousRequest("/api/admin/users"))).toBe(401);
  });

  it("fails closed on an API path nobody mapped", async () => {
    expect(await statusOf(requestAs("super_admin", { path: "/api/something/new" }))).toBe(403);
  });

  it("keeps a signed-in Admin out of the Super Admin portal", async () => {
    const response = await middleware(requestAs("admin", { path: "/super-admin" }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/admin");
  });

  it("treats a cookie with no session id (issued before single sign-in) as expired", async () => {
    const token = createSessionToken({ user_id: "u", role: "admin", branch_id: BRANCH_A });
    const request = new Request("https://sacs.test/api/admin/attendance", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    request.nextUrl = new URL(request.url);

    const response = await middleware(request);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("session_expired");

    const portal = new Request("https://sacs.test/admin", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    portal.nextUrl = new URL(portal.url);
    const redirect = await middleware(portal);
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toContain("/login?reason=session_expired");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Default passwords must be replaced before anything else
   ══════════════════════════════════════════════════════════════════════════ */

describe("Mandatory password change", () => {
  const mustChange = { must_change_password: true };

  it("blocks every other API while the issued password is unchanged", async () => {
    for (const [path, method] of [
      ["/api/employee/payslips", "GET"],
      ["/api/employee/stats", "GET"],
      ["/api/legacy-auth/update-profile", "POST"],
    ]) {
      const response = await middleware(requestAs("employee", { path, method, claims: mustChange }));
      expect(response.status, path).toBe(403);
      expect((await response.json()).code).toBe("password_change_required");
    }
  });

  it("still allows the change itself and the session lookups the screen needs", async () => {
    for (const [path, method] of [
      ["/api/legacy-auth/change-password", "POST"],
      ["/api/legacy-auth/session", "GET"],
      ["/api/rbac/me", "GET"],
    ]) {
      expect(await statusOf(requestAs("employee", { path, method, claims: mustChange })), path).not.toBe(403);
    }
  });

  it("lets the portal page itself load so the change screen can render", async () => {
    expect((await middleware(requestAs("employee", { path: "/employee", claims: mustChange }))).status).toBe(200);
  });

  it("does not restrict an account whose password was already changed", async () => {
    expect(await statusOf(requestAs("employee", { path: "/api/employee/payslips" }))).not.toBe(403);
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

  const seedRow = (role, moduleName) => {
    const match = new RegExp(
      String.raw`\('${role}',\s*'${moduleName}',\s*'(\w+)',\s*(true|false),\s*(true|false),\s*(true|false),\s*(true|false)\)`,
    ).exec(sql);
    if (!match) return null;
    const [, scope, c, r, u, d] = match;
    const actions = [["create", c], ["read", r], ["update", u], ["delete", d]]
      .filter(([, flag]) => flag === "true")
      .map(([action]) => action);
    return { scope, actions };
  };

  it("seeds every role/module pair the JS matrix defines, with the same scope and actions", () => {
    for (const [role, modules] of Object.entries(ROLE_PERMISSIONS)) {
      for (const [moduleName, entry] of Object.entries(modules)) {
        const row = seedRow(role, moduleName);
        expect(row, `${role}/${moduleName} missing from role_permissions seed`).not.toBeNull();
        expect(row.scope, `${role}/${moduleName} scope`).toBe(entry.scope);
        expect(row.actions, `${role}/${moduleName} actions`).toEqual(
          ["create", "read", "update", "delete"].filter((action) => entry.actions.includes(action)),
        );
      }
    }
  });

  it("agrees with the JS matrix on the Super Admin-exclusive modules", () => {
    for (const moduleName of SUPER_ADMIN_ONLY_MODULES) {
      expect(seedRow("admin", moduleName), `admin/${moduleName} should be seeded with no access`)
        .toEqual({ scope: "none", actions: [] });
    }
  });
});
