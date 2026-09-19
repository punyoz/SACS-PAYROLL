import { describe, it, expect, beforeEach } from "vitest";
import {
  checkLoginAllowed,
  clientAddressFrom,
  recordFailedLogin,
  recordSuccessfulLogin,
  resetLoginThrottle,
  LOGIN_THROTTLE_LIMITS,
} from "@/lib/auth/login-throttle";

const { IDENTITY_MAX_ATTEMPTS, IDENTITY_LOCKOUT_MS, IP_MAX_ATTEMPTS } = LOGIN_THROTTLE_LIMITS;

const IP = "203.0.113.10";

beforeEach(() => {
  resetLoginThrottle();
});

describe("Login throttling", () => {
  it("allows an attempt when nothing has failed yet", () => {
    expect(checkLoginAllowed("user@example.com", IP).blocked).toBe(false);
  });

  it("allows attempts right up to the identity limit, then blocks", () => {
    for (let i = 0; i < IDENTITY_MAX_ATTEMPTS; i += 1) {
      expect(checkLoginAllowed("user@example.com", IP).blocked, `attempt ${i + 1}`).toBe(false);
      recordFailedLogin("user@example.com", IP);
    }

    const blocked = checkLoginAllowed("user@example.com", IP);
    expect(blocked.blocked).toBe(true);
    expect(blocked.scope).toBe("identity");
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("locks one account without locking another", () => {
    for (let i = 0; i < IDENTITY_MAX_ATTEMPTS; i += 1) {
      recordFailedLogin("victim@example.com", IP);
    }

    expect(checkLoginAllowed("victim@example.com", IP).blocked).toBe(true);
    expect(checkLoginAllowed("bystander@example.com", "198.51.100.7").blocked).toBe(false);
  });

  it("treats the identity case-insensitively", () => {
    for (let i = 0; i < IDENTITY_MAX_ATTEMPTS; i += 1) {
      recordFailedLogin("User@Example.com", IP);
    }
    expect(checkLoginAllowed("user@example.com", IP).blocked).toBe(true);
  });

  it("clears the identity budget after a successful sign-in", () => {
    for (let i = 0; i < IDENTITY_MAX_ATTEMPTS - 1; i += 1) {
      recordFailedLogin("user@example.com", IP);
    }
    recordSuccessfulLogin("user@example.com");

    for (let i = 0; i < IDENTITY_MAX_ATTEMPTS; i += 1) {
      expect(checkLoginAllowed("user@example.com", IP).blocked, `attempt ${i + 1}`).toBe(false);
      recordFailedLogin("user@example.com", IP);
    }
    expect(checkLoginAllowed("user@example.com", IP).blocked).toBe(true);
  });

  it("blocks one address spraying many accounts", () => {
    // Each account stays under its own limit; only the shared IP budget trips.
    for (let i = 0; i < IP_MAX_ATTEMPTS; i += 1) {
      recordFailedLogin(`user${i}@example.com`, IP);
    }

    const blocked = checkLoginAllowed("someone-new@example.com", IP);
    expect(blocked.blocked).toBe(true);
    expect(blocked.scope).toBe("ip");

    // A different source address is unaffected.
    expect(checkLoginAllowed("someone-new@example.com", "198.51.100.7").blocked).toBe(false);
  });

  it("lets an identity back in once the lockout has expired", () => {
    const start = Date.now();
    for (let i = 0; i < IDENTITY_MAX_ATTEMPTS; i += 1) {
      recordFailedLogin("user@example.com", IP, start);
    }
    expect(checkLoginAllowed("user@example.com", IP, start).blocked).toBe(true);

    const afterLockout = start + IDENTITY_LOCKOUT_MS + 1000;
    expect(checkLoginAllowed("user@example.com", IP, afterLockout).blocked).toBe(false);
  });

  it("reads the client address from proxy headers, preferring the first hop", () => {
    const withForwarded = new Request("https://example.test/api/legacy-auth/login", {
      headers: { "x-forwarded-for": "203.0.113.5, 70.41.3.18" },
    });
    expect(clientAddressFrom(withForwarded)).toBe("203.0.113.5");

    const withRealIp = new Request("https://example.test/api/legacy-auth/login", {
      headers: { "x-real-ip": "203.0.113.9" },
    });
    expect(clientAddressFrom(withRealIp)).toBe("203.0.113.9");

    const bare = new Request("https://example.test/api/legacy-auth/login");
    expect(clientAddressFrom(bare)).toBe("unknown");
  });
});
