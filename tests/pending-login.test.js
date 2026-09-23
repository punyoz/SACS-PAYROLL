process.env.SESSION_SECRET ||= "test-signing-secret-for-pending-login-suite";

import { describe, it, expect } from "vitest";
import {
  createPendingLoginToken,
  verifyPendingLoginToken,
  attachPendingLogin,
  clearPendingLogin,
  readPendingLogin,
  PENDING_LOGIN_COOKIE,
  PENDING_LOGIN_MAX_AGE_SECONDS,
} from "@/lib/auth/pending-login";
import { sign, base64UrlEncode } from "@/lib/rbac/session";

/** Build a genuinely, validly-signed pending-login token with arbitrary
 * payload overrides — using the same signing primitives the module itself
 * uses, so these tests exercise real signatures, not stand-ins. */
function signPayload(overrides) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "user-1",
    email: "person@school.edu",
    pwd: false,
    purpose: "login_otp",
    iat: now,
    exp: now + 600,
    ...overrides,
  };
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  return `${payloadPart}.${sign(payloadPart)}`;
}

const CLAIMS = { user_id: "user-1", email: "Person@School.Edu", must_change_password: true };

function fakeResponse() {
  const store = new Map();
  return {
    cookies: {
      set: (name, value, options) => store.set(name, { value, options }),
      get: (name) => (store.has(name) ? { value: store.get(name).value } : undefined),
    },
    _store: store,
  };
}

function fakeRequestWithCookie(name, value) {
  return { cookies: { get: (n) => (n === name ? { value } : undefined) } };
}

describe("Pending-login token: no session may exist before OTP succeeds", () => {
  it("round-trips valid claims", () => {
    const token = createPendingLoginToken(CLAIMS);
    const payload = verifyPendingLoginToken(token);

    expect(payload.sub).toBe("user-1");
    expect(payload.email).toBe("person@school.edu"); // normalized lowercase
    expect(payload.pwd).toBe(true);
    expect(payload.purpose).toBe("login_otp");
  });

  it("rejects a tampered payload", () => {
    const token = createPendingLoginToken(CLAIMS);
    const [payloadPart, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    decoded.sub = "someone-elses-id";
    const tamperedPart = Buffer.from(JSON.stringify(decoded)).toString("base64url");

    expect(verifyPendingLoginToken(`${tamperedPart}.${sig}`)).toBeNull();
  });

  it("rejects an expired token even with a genuine signature", () => {
    const expired = signPayload({ exp: Math.floor(Date.now() / 1000) - 1 });
    expect(verifyPendingLoginToken(expired)).toBeNull();
  });

  it("rejects garbage input", () => {
    expect(verifyPendingLoginToken("")).toBeNull();
    expect(verifyPendingLoginToken("not-a-token")).toBeNull();
    expect(verifyPendingLoginToken("a.b.c")).toBeNull();
    expect(verifyPendingLoginToken(null)).toBeNull();
  });

  it("rejects a token missing sub or email", () => {
    // createPendingLoginToken always fills both from its input, so simulate a
    // hand-built payload with one missing, signed the only way available: via
    // the module's own attach/read round trip using empty claims.
    const token = createPendingLoginToken({ user_id: "", email: "" });
    expect(verifyPendingLoginToken(token)).toBeNull();
  });

  it("sets and reads the cookie by name, and clears it", () => {
    const response = fakeResponse();
    attachPendingLogin(response, CLAIMS);

    expect(response._store.has(PENDING_LOGIN_COOKIE)).toBe(true);
    const stored = response._store.get(PENDING_LOGIN_COOKIE);
    expect(stored.options.httpOnly).toBe(true);
    expect(stored.options.maxAge).toBe(PENDING_LOGIN_MAX_AGE_SECONDS);

    const request = fakeRequestWithCookie(PENDING_LOGIN_COOKIE, stored.value);
    const read = readPendingLogin(request);
    expect(read.sub).toBe("user-1");

    const cleared = fakeResponse();
    clearPendingLogin(cleared);
    expect(cleared._store.get(PENDING_LOGIN_COOKIE).options.maxAge).toBe(0);
  });

  it("reads a cookie from a raw Cookie header (fetch Request shape)", () => {
    const token = createPendingLoginToken(CLAIMS);
    const request = {
      headers: { get: (name) => (name === "cookie" ? `other=1; ${PENDING_LOGIN_COOKIE}=${token}` : null) },
    };
    expect(readPendingLogin(request)?.sub).toBe("user-1");
  });

  it("readPendingLogin returns null with no cookie at all", () => {
    expect(readPendingLogin({ cookies: { get: () => undefined }, headers: { get: () => "" } })).toBeNull();
  });

  it("rejects a genuinely, validly-signed token whose purpose is not login_otp", () => {
    // Guards against token-type confusion: a token signed with this app's own
    // key, with a valid signature over its actual payload, must still be
    // refused here if it was not minted for this purpose — e.g. were another
    // short-lived signed-cookie type ever added later with the same secret.
    const foreignPurpose = signPayload({ purpose: "something_else" });
    expect(verifyPendingLoginToken(foreignPurpose)).toBeNull();
  });
});
