import { describe, it, expect, beforeEach } from "vitest";
import {
  checkVerifyAllowed,
  recordVerifyFailure,
  resetVerifyAttempts,
  checkResendAllowed,
  recordCodeSent,
  resetOtpThrottle,
  OTP_THROTTLE_LIMITS,
} from "@/lib/auth/otp-throttle";

const { MAX_VERIFY_ATTEMPTS, RESEND_COOLDOWN_MS } = OTP_THROTTLE_LIMITS;
const USER = "user-1";

beforeEach(() => {
  resetOtpThrottle();
});

describe("OTP verify attempts", () => {
  it("allows an attempt when nothing has failed yet", () => {
    expect(checkVerifyAllowed(USER)).toEqual({ allowed: true, attemptsLeft: MAX_VERIFY_ATTEMPTS });
  });

  it("counts down remaining attempts on each failure", () => {
    recordVerifyFailure(USER);
    expect(checkVerifyAllowed(USER).attemptsLeft).toBe(MAX_VERIFY_ATTEMPTS - 1);
    recordVerifyFailure(USER);
    expect(checkVerifyAllowed(USER).attemptsLeft).toBe(MAX_VERIFY_ATTEMPTS - 2);
  });

  it("locks out after the configured number of consecutive wrong attempts", () => {
    let result;
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i += 1) {
      result = recordVerifyFailure(USER);
    }
    expect(result.allowed).toBe(false);
    expect(checkVerifyAllowed(USER).allowed).toBe(false);
  });

  it("does not lock out one attempt short of the limit", () => {
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS - 1; i += 1) {
      recordVerifyFailure(USER);
    }
    expect(checkVerifyAllowed(USER).allowed).toBe(true);
  });

  it("a lockout for one pending sign-in does not affect another", () => {
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i += 1) {
      recordVerifyFailure(USER);
    }
    expect(checkVerifyAllowed(USER).allowed).toBe(false);
    expect(checkVerifyAllowed("user-2").allowed).toBe(true);
  });

  it("a correct code (resetVerifyAttempts) clears the counter", () => {
    recordVerifyFailure(USER);
    recordVerifyFailure(USER);
    resetVerifyAttempts(USER);
    expect(checkVerifyAllowed(USER)).toEqual({ allowed: true, attemptsLeft: MAX_VERIFY_ATTEMPTS });
  });
});

describe("Resend cooldown", () => {
  it("allows the first resend immediately", () => {
    expect(checkResendAllowed(USER).allowed).toBe(true);
  });

  it("blocks a resend within the cooldown window", () => {
    const now = Date.now();
    recordCodeSent(USER, now);
    const check = checkResendAllowed(USER, now + 1000);
    expect(check.allowed).toBe(false);
    expect(check.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("allows a resend once the cooldown has fully elapsed", () => {
    const now = Date.now();
    recordCodeSent(USER, now);
    expect(checkResendAllowed(USER, now + RESEND_COOLDOWN_MS + 1).allowed).toBe(true);
  });

  it("resending resets the wrong-attempt counter for that pending sign-in", () => {
    recordVerifyFailure(USER);
    recordVerifyFailure(USER);
    recordVerifyFailure(USER);
    recordCodeSent(USER);
    expect(checkVerifyAllowed(USER)).toEqual({ allowed: true, attemptsLeft: MAX_VERIFY_ATTEMPTS });
  });

  it("one pending sign-in's cooldown does not block another's resend", () => {
    recordCodeSent(USER);
    expect(checkResendAllowed("user-2").allowed).toBe(true);
  });
});
