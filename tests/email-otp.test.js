/**
 * src/lib/auth/email-otp.js: the emailed 6-digit code, against an in-memory
 * twin of the database functions (tests/helpers/fake-email-otp.js) and a
 * captured Gmail outbox. src/lib/mail/gmail.js's own configuration check runs
 * for real at the end (no network: it refuses before connecting).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emailOtpRpc, lastCode, wrongCode, outbox, resetEmailOtpFakes, failNextSend } from "./helpers/fake-email-otp.js";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async (name, args) => emailOtpRpc(name, args) || { data: null, error: { message: "unknown rpc" } } }),
}));
vi.mock("@/lib/mail/gmail", async () => (await import("./helpers/fake-email-otp.js")).gmailModule);

let otp;

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-for-email-otp";
  resetEmailOtpFakes();
  otp = await import("@/lib/auth/email-otp");
});

afterEach(() => {
  vi.useRealTimers();
});

const send = (purpose = "login", subject = "u-1") => otp.sendEmailOtp({ purpose, subject, email: "a@example.com", name: "Ana" });

describe("generateOtpCode", () => {
  it("is always six digits, leading zeros kept", () => {
    for (let i = 0; i < 500; i += 1) expect(otp.generateOtpCode()).toMatch(/^\d{6}$/);
  });
});

describe("hashOtpCode", () => {
  it("never stores the code itself, and differs per flow and account", () => {
    const hash = otp.hashOtpCode("login:u-1", "123456");
    expect(hash).not.toContain("123456");
    expect(otp.hashOtpCode("reset:u-1", "123456")).not.toBe(hash);
    expect(otp.hashOtpCode("login:u-2", "123456")).not.toBe(hash);
  });
});

describe("sendEmailOtp / verifyEmailOtp", () => {
  it("emails a code that verifies once", async () => {
    expect(await send()).toEqual({ ok: true });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: "a@example.com", subject: expect.stringMatching(/sign-in code/) });
    const code = lastCode();
    expect(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code })).toBe("ok");
    expect(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code })).toBe("expired");
  });

  it("accepts the code typed with spaces", async () => {
    await send();
    const spaced = `${lastCode().slice(0, 3)} ${lastCode().slice(3)}`;
    expect(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code: spaced })).toBe("ok");
  });

  it("a code for one flow does not work in another", async () => {
    await send("login");
    expect(await otp.verifyEmailOtp({ purpose: "reset", subject: "u-1", code: lastCode() })).toBe("expired");
    expect(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code: lastCode() })).toBe("ok");
  });

  it("locks after five wrong codes; even the right one is refused then", async () => {
    await send();
    const outcomes = [];
    for (let i = 0; i < 5; i += 1) outcomes.push(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code: wrongCode() }));
    expect(outcomes).toEqual(["invalid", "invalid", "invalid", "invalid", "locked"]);
    expect(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code: lastCode() })).toBe("locked");
  });

  it("expires after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await send();
    vi.setSystemTime(Date.now() + otp.EMAIL_OTP_TTL_SECONDS * 1000 + 1);
    expect(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code: lastCode() })).toBe("expired");
  });

  it("refuses a resend within 60 seconds, then replaces the old code", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await send();
    const first = lastCode();
    const early = await send();
    expect(early).toMatchObject({ ok: false, status: 429, code: "otp_cooldown" });
    expect(early.retryAfter).toBeGreaterThan(55);
    expect(outbox).toHaveLength(1);

    vi.setSystemTime(Date.now() + otp.EMAIL_OTP_RESEND_SECONDS * 1000);
    expect(await send()).toEqual({ ok: true });
    const second = lastCode();
    if (second !== first) {
      expect(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code: first })).toBe("invalid");
    }
    expect(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code: second })).toBe("ok");
  });

  it("a locked code can be replaced at once, without waiting out the cooldown", async () => {
    await send();
    for (let i = 0; i < 5; i += 1) await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code: wrongCode() });
    expect(await send()).toEqual({ ok: true });
  });

  it("a failed send keeps no code and holds no cooldown", async () => {
    failNextSend();
    expect(await send()).toMatchObject({ ok: false, code: "email_send_failed", status: 502 });
    expect(await send()).toEqual({ ok: true });
  });

  it("rejects malformed input without counting an attempt", async () => {
    await send();
    for (const bad of ["", "12345", "1234567", "abcdef", "12345678"]) {
      expect(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code: bad })).toBe("invalid");
    }
    expect(await otp.verifyEmailOtp({ purpose: "login", subject: "u-1", code: lastCode() })).toBe("ok");
  });
});

describe("Gmail configuration", () => {
  it("refuses to send without GMAIL_USER / GMAIL_APP_PASSWORD", async () => {
    const real = await vi.importActual("@/lib/mail/gmail");
    const saved = { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD };
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
    try {
      expect(real.isMailConfigured()).toBe(false);
      await expect(real.sendMail({ to: "a@example.com", subject: "s", html: "h", text: "t" }))
        .rejects.toBeInstanceOf(real.MailNotConfiguredError);
      process.env.GMAIL_USER = "school@gmail.com";
      process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
      expect(real.isMailConfigured()).toBe(true);
    } finally {
      if (saved.user === undefined) delete process.env.GMAIL_USER; else process.env.GMAIL_USER = saved.user;
      if (saved.pass === undefined) delete process.env.GMAIL_APP_PASSWORD; else process.env.GMAIL_APP_PASSWORD = saved.pass;
    }
  });
});

describe("The code email", () => {
  it("escapes the name and attaches the school seal inline", async () => {
    const { buildOtpEmail } = await import("@/lib/mail/otp-email");
    const mail = buildOtpEmail({ code: "042917", purpose: "login", minutes: 5, name: "<b>Ana</b>" });
    expect(mail.html).not.toContain("<b>Ana</b>");
    expect(mail.html).toContain("&lt;b&gt;Ana&lt;/b&gt;");
    expect(mail.text).toContain("042917");
    expect(mail.html).toContain("#1B5E3C");
    expect(mail.html).toContain("#C9A227");
    expect(mail.attachments[0]).toMatchObject({ cid: expect.any(String), filename: "sacs-logo.png" });
    expect(mail.html).toContain(`cid:${mail.attachments[0].cid}`);
  });
});
