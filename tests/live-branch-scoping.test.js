/**
 * Branch scoping follows profiles, not the sign-in cookie.
 *
 * THE BUG THIS PINS
 * The signed sacs-session cookie stamps branch_id at sign-in and lives eight
 * hours. Every guarded route scopes by guard.branchId, and those routes hold
 * the service-role key -- which bypasses RLS, so the database's own
 * current_branch_id() (which does read profiles live) never runs for them.
 * Moving an Admin between branches therefore updated profiles correctly and
 * changed nothing they could see until they signed in again.
 *
 * The pure cache/fallback behaviour is asserted against the real module. The
 * wiring is read as text, matching tests/login-otp-flow.test.js, because
 * importing the guard or a route would need live Supabase env values.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolveCurrentBranchId, invalidateBranchCache } from "@/lib/auth/live-branch";

const guardSource = readFileSync("src/lib/rbac/guard.js", "utf8");
const meRoute = readFileSync("src/app/api/rbac/me/route.js", "utf8");
const branchesRoute = readFileSync("src/app/api/admin/branches/route.js", "utf8");
const assignRoute = readFileSync("src/app/api/admin/branch-employees/route.js", "utf8");
const sessionSource = readFileSync("src/lib/rbac/session.js", "utf8");

beforeEach(() => {
  invalidateBranchCache();
});

describe("The guard resolves branch from profiles, not the cookie", () => {
  it("no longer reads branch_id straight off the session", () => {
    // The exact line that caused the bug:
    //   const branchId = branchExempt ? null : (session.branch_id || null);
    expect(guardSource).not.toMatch(/const branchId = branchExempt\s*\?\s*null\s*:\s*\(session\.branch_id/);
    expect(guardSource).toMatch(/resolveCurrentBranchId\(session\.sub/);
  });

  it("keeps the cookie value only as an outage fallback", () => {
    // Passed as the second argument, i.e. used when profiles cannot be read --
    // never as the primary source.
    expect(guardSource).toMatch(/resolveCurrentBranchId\(session\.sub,\s*session\.branch_id \|\| null\)/);
  });

  it("still short-circuits for branch-exempt roles", () => {
    // Super Admin has no branch; it must not gain one from a lookup.
    expect(guardSource).toMatch(/branchExempt\s*\n?\s*\?\s*null/);
  });

  it("the cookie still carries a branch, so old sessions keep a fallback", () => {
    expect(sessionSource).toMatch(/branch_id:/);
  });
});

describe("The browser's branch context matches what the API enforces", () => {
  it("/api/rbac/me serves the live branch", () => {
    expect(meRoute).toMatch(/resolveCurrentBranchId\(session\.sub/);
    expect(meRoute).not.toMatch(/branch_id:\s*session\.branch_id/);
  });

  it("the branch-label list filters on the live branch", () => {
    expect(branchesRoute).toMatch(/resolveCurrentBranchId\(session\.sub/);
    expect(branchesRoute).not.toMatch(/String\(b\.id\) === String\(session\.branch_id/);
  });
});

describe("Reassignment drops the cached lookup immediately", () => {
  it("both the assign and unassign paths invalidate", () => {
    expect(assignRoute).toMatch(/import \{ invalidateBranchCache \}/);
    // Once for assigning to a branch, once for removing from one.
    const hits = assignRoute.match(/invalidateBranchCache\(userId\)/g) || [];
    expect(hits).toHaveLength(2);
  });

  it("each invalidation follows its profiles update, not precedes it", () => {
    for (const update of ["branch_id: branchId", "branch_id: null"]) {
      const updateIdx = assignRoute.indexOf(update);
      expect(updateIdx).toBeGreaterThan(-1);
      const invalidateIdx = assignRoute.indexOf("invalidateBranchCache(userId)", updateIdx);
      expect(invalidateIdx).toBeGreaterThan(updateIdx);
    }
  });
});

describe("resolveCurrentBranchId contract", () => {
  it("returns the fallback when there is no user id", async () => {
    expect(await resolveCurrentBranchId("", "branch-a")).toBe("branch-a");
    expect(await resolveCurrentBranchId(null, null)).toBeNull();
  });

  it("returns the fallback when Supabase is not configured", async () => {
    // No env in the test process, so getAdminClient() yields null. Falling
    // back rather than returning null is deliberate: null would refuse a
    // branch-scoped caller access to their own data during an outage, and the
    // fallback is the branch they were already authorised for.
    expect(await resolveCurrentBranchId("user-1", "branch-a")).toBe("branch-a");
  });

  it("invalidateBranchCache() clears one account or all of them", () => {
    // Pure bookkeeping, safe to call with an unknown id or none at all.
    expect(() => invalidateBranchCache("nobody")).not.toThrow();
    expect(() => invalidateBranchCache()).not.toThrow();
  });
});
