/**
 * Unit-test setup (vitest.config.mjs setupFiles). Since 2026-11-21 the guard
 * reads the caller's role, branch and archived from profiles on every request
 * (readLiveAccount). Sign-in refuses an account with no profile, so every real
 * session has one; most route tests mint a session without seeding it. Here a
 * caller with NO profile row (or a fixture row with no role) answers as the
 * session it signed in with. A row a
 * test does seed (a changed role, an archive, a branch move) always wins.
 */
import { vi } from "vitest";

const signed = (globalThis.__signedInProfiles ??= new Map());

vi.mock("@/lib/rbac/session", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createSessionToken(claims) {
      signed.set(String(claims?.user_id || ""), {
        role: String(claims?.role || "").toLowerCase(),
        branchId: claims?.branch_id ? String(claims.branch_id) : null,
        archived: false,
      });
      return real.createSessionToken(claims);
    },
  };
});

vi.mock("@/lib/auth/live-branch", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    async readLiveAccount(userId) {
      const live = await real.readLiveAccount(userId);
      const session = signed.get(String(userId));
      if (!session || !live) return live;
      if (live.missing) return session;
      // A fixture row seeded without a role (only id/branch): the role it signed in with.
      if (!live.role) return { ...live, role: session.role };
      return live;
    },
  };
});
