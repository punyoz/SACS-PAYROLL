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
