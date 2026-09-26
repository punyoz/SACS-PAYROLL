/**
 * Sign-in sessions and the Super Admin's Security settings.
 *
 *   - Changing someone's role or branch ends their current sign-in
 *     (revokeActiveSession -> "session_revoked"), because the cookie still
 *     carries the old role.
 *   - Session Timeout is an idle timeout: activity renews the cookie up to
 *     8 hours after sign-in; background polls do not count.
 *   - Max Login Attempts, Password Minimum Length and Force Password Expiry
 *     are enforced, not just saved.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

beforeEach(() => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-sessions";
  resetDb();
});

/* ── Session cookie times ───────────────────────────────────────────────── */

describe("sessionTimes", () => {
  it("expires after the idle timeout, never later than 8 hours after sign-in", async () => {
    const { sessionTimes, SESSION_MAX_AGE_SECONDS } = await import("@/lib/rbac/session");
    const now = Math.floor(Date.now() / 1000);

    const fresh = sessionTimes({ idle_seconds: 3600 });
    expect(fresh.exp - fresh.now).toBe(3600);

    const late = sessionTimes({ idle_seconds: 3600, login_at: now - SESSION_MAX_AGE_SECONDS + 600 });
    expect(late.exp).toBe(late.loginAt + SESSION_MAX_AGE_SECONDS);
    expect(late.exp - late.now).toBeLessThanOrEqual(600);

    expect(sessionTimes({}).idle).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it("carries sign-in time and idle timeout through a re-issue", async () => {
    const { createSessionToken, verifySessionToken, reissueSession } = await import("@/lib/rbac/session");
    const { NextResponse } = await import("next/server");
    const loginAt = Math.floor(Date.now() / 1000) - 1000;
    const session = verifySessionToken(createSessionToken({ user_id: "u1", role: "admin", session_id: "s1", login_at: loginAt, idle_seconds: 1800 }));
    expect(session).toMatchObject({ lat: loginAt, idl: 1800 });

    const response = reissueSession(NextResponse.json({}), session, { must_change_password: false });
    const renewed = verifySessionToken(response.cookies.get("sacs-session").value);
    expect(renewed).toMatchObject({ lat: loginAt, idl: 1800, sid: "s1" });
  });
});

/* ── Proxy: revocation and renewal ──────────────────────────────────────── */

describe("proxy", () => {
  async function call(path, { idle = 3600, sessionId = "s1", headers = {} } = {}) {
    const { createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session");
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const token = createSessionToken({ user_id: "u1", role: "admin", branch_id: "b1", session_id: sessionId, idle_seconds: idle });
    return proxy(new NextRequest(`https://sacs.test${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}`, ...headers } }));
  }

  beforeEach(() => {
    users.push({ id: "u1", email: "a@sacs.test", app_metadata: { session_id: "s1" }, user_metadata: { role: "admin" } });
    table("profiles").push({ id: "u1", role: "admin", branch_id: "b1", archived: false });
    table("system_config").push({ section: "security", key: "session", value: "30" });
  });

  it("signs out a session whose account was changed by an administrator", async () => {
    const { revokeActiveSession } = await import("@/lib/auth/active-session");
    expect(await revokeActiveSession("u1")).toBe(true);
    expect(users[0].app_metadata.session_id).toMatch(/^revoked:/);

    const response = await call("/api/rbac/me");
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("session_revoked");
  });

  it("renews the cookie to the configured idle timeout on activity", async () => {
    const { verifySessionToken } = await import("@/lib/rbac/session");
    const response = await call("/api/rbac/me");
    const renewed = verifySessionToken(response.cookies.get("sacs-session")?.value);
    expect(renewed.idl).toBe(30 * 60);
    expect(renewed.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(30 * 60);
  });

  it("does not let the heartbeat or a background poll keep an idle session alive", async () => {
    expect((await call("/api/legacy-auth/session")).cookies.get("sacs-session")).toBeUndefined();
    expect((await call("/api/rbac/me", { headers: { "x-sacs-background": "1" } })).cookies.get("sacs-session")).toBeUndefined();
    // The kiosk's explicit keep-alive does.
    expect((await call("/api/legacy-auth/session", { headers: { "x-sacs-activity": "1" } })).cookies.get("sacs-session")).toBeDefined();
  });

  it("leaves change-password to issue its own cookie", async () => {
    expect((await call("/api/legacy-auth/change-password")).cookies.get("sacs-session")).toBeUndefined();
  });
});

/* ── Security settings ──────────────────────────────────────────────────── */

describe("security settings", () => {
  it("uses the saved values within the form's ranges, and the old behaviour otherwise", async () => {
    const { normalizeSecuritySettings, DEFAULT_SECURITY_SETTINGS } = await import("@/lib/auth/security-settings");
    expect(normalizeSecuritySettings({ session: "60", login_attempts: "3", pw_min: "12", pw_expiry: "90" }))
      .toEqual({ session: 60, login_attempts: 3, pw_min: 12, pw_expiry: 90 });
    expect(normalizeSecuritySettings({ session: "1", login_attempts: "abc", pw_min: "", pw_expiry: "-4" }))
      .toEqual(DEFAULT_SECURITY_SETTINGS);
  });

  it("expires a password older than the configured days", async () => {
    const { isPasswordExpired } = await import("@/lib/auth/security-settings");
    const now = Date.parse("2026-09-26T00:00:00Z");
    const changed = (iso) => ({ app_metadata: { password_changed_at: iso }, created_at: "2026-01-01T00:00:00Z" });
    expect(isPasswordExpired(changed("2026-06-01T00:00:00Z"), 90, now)).toBe(true);
    expect(isPasswordExpired(changed("2026-09-01T00:00:00Z"), 90, now)).toBe(false);
    expect(isPasswordExpired(changed("2020-01-01T00:00:00Z"), 0, now)).toBe(false);
    expect(isPasswordExpired({ created_at: "2026-01-01T00:00:00Z" }, 30, now)).toBe(true);
  });

  it("locks an account after the configured number of wrong passwords", async () => {
    const { checkLoginAllowed, recordFailedLogin, resetLoginThrottle } = await import("@/lib/auth/login-throttle");
    resetLoginThrottle();
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      expect(checkLoginAllowed("x@sacs.test", "1.1.1.1", now, { identityMaxAttempts: 3 }).blocked).toBe(false);
      recordFailedLogin("x@sacs.test", "1.1.1.1", now);
    }
    expect(checkLoginAllowed("x@sacs.test", "1.1.1.1", now, { identityMaxAttempts: 3 }).blocked).toBe(true);
  });

  it("enforces the configured minimum password length", async () => {
    const { validateNewPassword } = await import("@/lib/auth/password-policy");
    expect(validateNewPassword("Abcdef1!x", { minLength: 12 })).toMatch(/at least 12 characters/);
    expect(validateNewPassword("Abcdef1!xyz#", { minLength: 12 })).toBeNull();
    expect(validateNewPassword("Abcde1!", {})).toMatch(/at least 8 characters/);
  });

  it("login reads the settings for the lockout and the password expiry", async () => {
    const { readFileSync } = await import("node:fs");
    const login = readFileSync("src/app/api/legacy-auth/login/route.js", "utf8");
    expect(login).toMatch(/identityMaxAttempts: security\.login_attempts/);
    expect(login).toMatch(/isPasswordExpired\(data\.user, security\.pw_expiry\)/);
  });
});
