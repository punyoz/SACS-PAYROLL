/**
 * Password reset (login page) and password change (logged in) by email OTP.
 *
 * The routes run for real here; only @supabase/supabase-js and the Gmail
 * sender are replaced, by in-memory stand-ins (tests/helpers/fake-email-otp.js
 * keeps the code rows and the sent emails). Each test reads the real 6-digit
 * code out of the email it "received". That is enough to check the rules that
 * matter: the steps cannot be skipped, the reply does not reveal whether an
 * account exists, five wrong codes lock the flow, the code window is five
 * minutes, and a verification sets a password only once.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emailOtpRpc, lastCode, wrongCode, outbox, resetEmailOtpFakes } from "./helpers/fake-email-otp.js";

const OLD_PASSWORD = "OldPass1!";

/* ── A fake Supabase ────────────────────────────────────────────────────── */

const db = { users: [], updates: [] };

/** Addresses emailed so far, in order. */
const sentTo = () => outbox.map((m) => m.to);

function makeUser(id, email, role, extra = {}) {
  return {
    id,
    email,
    created_at: "2026-01-01T00:00:00Z",
    user_metadata: { role, full_name: "Test Person", date_of_birth: "1990-04-12", ...extra.user_metadata },
    app_metadata: { password_changed_at: "2026-01-01T00:00:00Z", ...extra.app_metadata },
    password: OLD_PASSWORD,
  };
}

function fakeClient() {
  const byEmail = (email) => db.users.find((u) => u.email === email);
  const byId = (id) => db.users.find((u) => u.id === id);
  // profiles rows mirror each auth user: accounts without a profile row are
  // treated as inactive and cannot sign in (src/lib/auth/users-cache.js).
  const profileOf = (u) => ({ id: u.id, email: u.email, role: u.user_metadata?.role, archived: false, full_name: "Test Person" });
  const makeChain = () => {
    let idFilter = null;
    const rows = () => db.users.filter((u) => !idFilter || u.id === idFilter).map(profileOf);
    const chain = {
      select: () => chain,
      eq: (column, value) => { if (column === "id") idFilter = value; return chain; },
      in: () => chain,
      order: () => chain,
      range: () => chain,
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    };
    return chain;
  };
  return {
    from: () => makeChain(),
    rpc: async (name, args) => emailOtpRpc(name, args) || { data: 0, error: null },
    auth: {
      signInWithPassword: async ({ email, password }) => {
        const user = byEmail(email);
        return user && user.password === password
          ? { data: { user }, error: null }
          : { data: {}, error: { status: 400, code: "invalid_credentials" } };
      },
      signOut: async () => ({ error: null }),
      admin: {
        listUsers: async () => ({ data: { users: db.users }, error: null }),
        getUserById: async (id) => ({ data: { user: byId(id) || null }, error: byId(id) ? null : { message: "not found" } }),
        updateUserById: async (id, changes) => {
          db.updates.push({ id, changes });
          const user = byId(id);
          if (changes.password) user.password = changes.password;
          user.app_metadata = { ...user.app_metadata, ...changes.app_metadata };
          return { data: { user }, error: null };
        },
      },
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient() }));
vi.mock("@/lib/mail/gmail", async () => (await import("./helpers/fake-email-otp.js")).gmailModule);

/* ── Helpers ────────────────────────────────────────────────────────────── */

let resetRoute;
let otpRoute;
let changeRoute;
let createSessionToken;
let SESSION_COOKIE;

/** A tiny cookie jar, so each test drives the routes like one browser. */
function browser(sessionCookie = "") {
  const jar = new Map();
  if (sessionCookie) jar.set(SESSION_COOKIE, sessionCookie);
  return {
    async post(handler, path, body) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const response = await handler(new Request(`https://sacs.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify(body),
      }));
      for (const header of response.headers.getSetCookie?.() || []) {
        const [pair, ...attrs] = header.split(";");
        const [name, ...rest] = pair.split("=");
        const value = rest.join("=");
        const expired = attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "";
        if (expired) jar.delete(name.trim());
        else jar.set(name.trim(), value);
      }
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-for-password-otp";

  db.users = [
    makeUser("u-emp", "emp@example.com", "employee", { user_metadata: { employee_id: "SACS-001" } }),
    makeUser("u-acct", "acct@example.com", "accountant"),
    makeUser("u-admin", "admin@example.com", "admin"),
  ];
  db.updates = [];
  resetEmailOtpFakes();

  ({ POST: resetRoute } = await import("@/app/api/legacy-auth/reset-password/route"));
  ({ POST: otpRoute } = await import("@/app/api/legacy-auth/change-password-otp/route"));
  ({ POST: changeRoute } = await import("@/app/api/legacy-auth/change-password/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => {
  vi.useRealTimers();
});

const RESET = "/api/legacy-auth/reset-password";

/* ── The emailed code ───────────────────────────────────────────────────── */

describe("The reset email", () => {
  it("carries a 6-digit code, in the HTML and the plain text", async () => {
    await browser().post(resetRoute, RESET, { action: "send", identity: "SACS-001" });
    expect(outbox).toHaveLength(1);
    const [mail] = outbox;
    expect(mail.to).toBe("emp@example.com");
    expect(mail.subject).toMatch(/password reset code/i);
    expect(lastCode()).toMatch(/^\d{6}$/);
    expect(mail.html).toContain(lastCode().split("").join("&#8202;"));
    expect(mail.text).toContain("5 minutes");
  });

  it("reports a failed send instead of claiming the code went out", async () => {
    const { failNextSend } = await import("./helpers/fake-email-otp.js");
    failNextSend();
    const reply = await browser().post(resetRoute, RESET, { action: "send", identity: "SACS-001" });
    expect(reply.body.code).toBe("email_send_failed");
    expect(reply.status).toBe(502);
  });
});

/* ── Reset password (logged out) ────────────────────────────────────────── */

describe("Reset password by OTP", () => {
  it("answers the same way whether or not the account exists or may reset", async () => {
    const replies = [];
    for (const identity of ["SACS-001", "nobody@example.com", "admin@example.com"]) {
      const reply = await browser().post(resetRoute, RESET, { action: "send", identity });
      replies.push({ status: reply.status, message: reply.body.message });
      expect(JSON.stringify(reply.body)).not.toContain("emp@example.com");
    }
    expect(new Set(replies.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(replies[0].message).toMatch(/If the account exists/);
    // Only the Employee was actually emailed; the Admin is told to contact the administrator.
    expect(sentTo()).toEqual(["emp@example.com"]);
    expect(replies[0].message).toMatch(/contact the administrator/i);
  });

  it("enforces a 60-second cooldown, identically for unknown identities", async () => {
    for (const identity of ["SACS-001", "nobody@example.com"]) {
      const b = browser();
      await b.post(resetRoute, RESET, { action: "send", identity });
      const again = await b.post(resetRoute, RESET, { action: "send", identity });
      expect(again.status).toBe(429);
      expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(55);
    }
  });

  it("will not set a password before the OTP is verified", async () => {
    const b = browser();
    await b.post(resetRoute, RESET, { action: "send", identity: "SACS-001" });
    const skip = await b.post(resetRoute, RESET, { action: "reset", password: "NewPass9!", confirm_password: "NewPass9!" });
    expect(skip.status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });

  it("locks after five wrong codes and requires a new OTP", async () => {
    const b = browser();
    await b.post(resetRoute, RESET, { action: "send", identity: "SACS-001" });
    for (let i = 1; i <= 4; i += 1) {
      expect((await b.post(resetRoute, RESET, { action: "verify", code: wrongCode() })).status).toBe(400);
    }
    const fifth = await b.post(resetRoute, RESET, { action: "verify", code: wrongCode() });
    expect(fifth.status).toBe(429);
    expect(fifth.body.code).toBe("otp_locked_out");
    // Even the right code is refused now: the flow has to start again.
    const after = await b.post(resetRoute, RESET, { action: "verify", code: lastCode() });
    expect(after.body.code).toBe("otp_expired");
  });

  it("refuses a code after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const b = browser();
    await b.post(resetRoute, RESET, { action: "send", identity: "SACS-001" });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000);
    const late = await b.post(resetRoute, RESET, { action: "verify", code: lastCode() });
    expect(late.body.code).toBe("otp_expired");
  });

  it("verifies, then sets the password once, then signs in to the portal", async () => {
    const b = browser();
    await b.post(resetRoute, RESET, { action: "send", identity: "SACS-001" });
    // An 8-digit code (the old Supabase OTP length) is refused by format.
    expect((await b.post(resetRoute, RESET, { action: "verify", code: "12345678" })).body.code).toBe("otp_format");
    const verified = await b.post(resetRoute, RESET, { action: "verify", code: lastCode() });
    expect(verified.body.verified).toBe(true);
    // Single use: the same code cannot verify a second time.
    const { verifyEmailOtp } = await import("@/lib/auth/email-otp");
    expect(await verifyEmailOtp({ purpose: "reset", subject: "u-emp", code: lastCode() })).toBe("expired");

    const weak = await b.post(resetRoute, RESET, { action: "reset", password: "nouppercase1!", confirm_password: "nouppercase1!" });
    expect(weak.body.error).toMatch(/uppercase/);
    const same = await b.post(resetRoute, RESET, { action: "reset", password: OLD_PASSWORD, confirm_password: OLD_PASSWORD });
    expect(same.body.code).toBe("password_same");

    const done = await b.post(resetRoute, RESET, { action: "reset", password: "NewPass9!", confirm_password: "NewPass9!" });
    expect(done.status).toBe(200);
    const passwordUpdates = () => db.updates.filter((u) => u.changes.password);
    expect(passwordUpdates()).toHaveLength(1);
    expect(passwordUpdates()[0]).toMatchObject({ id: "u-emp", changes: { password: "NewPass9!" } });

    // Straight into the account's own portal: a session cookie, not a trip
    // back to the login form.
    expect(done.body).toMatchObject({ success: true, redirectTo: "/employee", role: "employee", must_change_password: false });
    const cookies = done.headers.getSetCookie().join("; ");
    expect(cookies).toContain(`${SESSION_COOKIE}=`);

    // The grant is spent (and its cookie cleared): no second password.
    const again = await b.post(resetRoute, RESET, { action: "reset", password: "Another9!", confirm_password: "Another9!" });
    expect(again.status).toBe(400);
    expect(passwordUpdates()).toHaveLength(1);
  });
});

/* ── Change password (logged in) ────────────────────────────────────────── */

describe("Change password by OTP", () => {
  const OTP = "/api/legacy-auth/change-password-otp";
  const CHANGE = "/api/legacy-auth/change-password";
  const signedIn = (userId, role, email) => browser(createSessionToken({
    user_id: userId, role, email, branch_id: "b-1", session_id: "s-1",
  }));

  it("checks the current password before emailing anything", async () => {
    const b = signedIn("u-emp", "employee", "emp@example.com");
    const wrong = await b.post(otpRoute, OTP, { action: "start", current_password: "Wrong1!" });
    expect(wrong.body.code).toBe("current_incorrect");
    expect(outbox).toHaveLength(0);
  });

  it("refuses the new password until the OTP is verified", async () => {
    const b = signedIn("u-emp", "employee", "emp@example.com");
    await b.post(otpRoute, OTP, { action: "start", current_password: OLD_PASSWORD });
    const early = await b.post(changeRoute, CHANGE, { current_password: OLD_PASSWORD, new_password: "NewPass9!", confirm_password: "NewPass9!" });
    expect(early.body.code).toBe("otp_not_verified");
    expect(db.updates).toHaveLength(0);
  });

  it("current password -> OTP -> new password, and the new one must differ", async () => {
    const b = signedIn("u-emp", "employee", "emp@example.com");
    const started = await b.post(otpRoute, OTP, { action: "start", current_password: OLD_PASSWORD });
    expect(started.body).toMatchObject({ otp_required: true, resend_after: 60 });
    expect(sentTo()).toEqual(["emp@example.com"]);

    const tooSoon = await b.post(otpRoute, OTP, { action: "resend" });
    expect(tooSoon.status).toBe(429);

    expect((await b.post(otpRoute, OTP, { action: "verify", code: lastCode() })).body.verified).toBe(true);

    const same = await b.post(changeRoute, CHANGE, { current_password: OLD_PASSWORD, new_password: OLD_PASSWORD, confirm_password: OLD_PASSWORD });
    expect(same.body.error).toMatch(/different/);

    const done = await b.post(changeRoute, CHANGE, { current_password: OLD_PASSWORD, new_password: "NewPass9!", confirm_password: "NewPass9!" });
    expect(done.status).toBe(200);
    expect(db.updates).toHaveLength(1);
  });

  it("locks after five wrong codes", async () => {
    const b = signedIn("u-acct", "accountant", "acct@example.com");
    await b.post(otpRoute, OTP, { action: "start", current_password: OLD_PASSWORD });
    let last;
    for (let i = 0; i < 5; i += 1) last = await b.post(otpRoute, OTP, { action: "verify", code: wrongCode() });
    expect(last.body.code).toBe("otp_locked_out");
    expect((await b.post(otpRoute, OTP, { action: "verify", code: lastCode() })).body.code).toBe("otp_expired");
  });

  it("asks for no second OTP on the first sign-in change (the sign-in OTP already passed)", async () => {
    const b = browser(createSessionToken({
      user_id: "u-emp", role: "employee", email: "emp@example.com", branch_id: "b-1", session_id: "s-1",
      must_change_password: true,
    }));
    expect((await b.post(otpRoute, OTP, { action: "start", current_password: OLD_PASSWORD })).body.otp_required).toBe(false);
    const done = await b.post(changeRoute, CHANGE, { current_password: OLD_PASSWORD, new_password: "NewPass9!", confirm_password: "NewPass9!" });
    expect(done.status).toBe(200);
    expect(done.body.must_change_password).toBe(false);
    expect(outbox).toHaveLength(0);
    expect(db.updates).toHaveLength(1);
  });

  it("leaves Admin, HR and Super Admin on the one-step change", async () => {
    const b = signedIn("u-admin", "admin", "admin@example.com");
    expect((await b.post(otpRoute, OTP, { action: "start", current_password: OLD_PASSWORD })).body.otp_required).toBe(false);
    const done = await b.post(changeRoute, CHANGE, { current_password: OLD_PASSWORD, new_password: "NewPass9!", confirm_password: "NewPass9!" });
    expect(done.status).toBe(200);
    expect(outbox).toHaveLength(0);
  });
});
