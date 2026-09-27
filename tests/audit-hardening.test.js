/**
 * Regression tests for the 2026-09-27 audit fixes: the leave-proof XSS
 * (validateProofUrl), branch scoping for records with no branch
 * (denyForeignBranch), audit-entry attribution (actorColumns), centavo
 * rounding (roundPeso) and cross-site API refusal (src/proxy.js).
 */

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";

process.env.SESSION_SECRET ||= "test-signing-secret-for-audit-hardening";

const { validateProofUrl, PROOF_MAX_BYTES } = await import("@/lib/leave-requests/proof");
const { denyForeignBranch } = await import("@/lib/rbac/guard");
const { actorColumns } = await import("@/lib/audit/store");
const { roundPeso } = await import("@/lib/payroll/money");
const { proxy } = await import("@/proxy");

const BRANCH_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";

describe("validateProofUrl", () => {
  it("accepts no proof, and the PDF / PNG / JPEG data URLs the portal sends", () => {
    expect(validateProofUrl("")).toEqual({ ok: true, value: "" });
    expect(validateProofUrl(undefined)).toEqual({ ok: true, value: "" });
    for (const mime of ["application/pdf", "image/png", "image/jpeg"]) {
      const url = `data:${mime};base64,QUJD`;
      expect(validateProofUrl(url)).toEqual({ ok: true, value: url });
    }
  });

  it("refuses markup, script URLs and other file types", () => {
    const attacks = [
      'x"><img src=x onerror=alert(1)>',
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:image/svg+xml;base64,PHN2Zy8+",
      'data:image/png;base64,QUJD" onmouseover="alert(1)',
      "https://evil.example/proof.pdf",
    ];
    attacks.forEach((value) => expect(validateProofUrl(value).ok, value).toBe(false));
  });

  it("refuses a file over 2 MB", () => {
    const tooBig = "A".repeat(Math.ceil(((PROOF_MAX_BYTES + 10) * 4) / 3));
    expect(validateProofUrl(`data:application/pdf;base64,${tooBig}`).ok).toBe(false);
  });
});

describe("denyForeignBranch with a record that has no branch", () => {
  const branchGuard = { branchExempt: false, branchId: BRANCH_A, scope: "branch" };

  it("refuses a branch-scoped caller (Admin / Accountant)", () => {
    expect(denyForeignBranch(branchGuard, null)?.status).toBe(403);
    expect(denyForeignBranch(branchGuard, "")?.status).toBe(403);
  });

  it("still lets a self-scoped caller reach their own record", () => {
    expect(denyForeignBranch({ branchExempt: false, branchId: null, scope: "self" }, null)).toBeNull();
  });

  it("does not restrict a branch-exempt caller", () => {
    expect(denyForeignBranch({ branchExempt: true, branchId: null, scope: "all" }, null)).toBeNull();
  });
});

describe("actorColumns", () => {
  it("records who acted, from the guard", () => {
    const guard = { userId: USER, role: "hr", session: { full_name: "Ana Cruz", email: "ana@sacs.test" }, clientIp: "203.0.113.9" };
    expect(actorColumns(guard)).toEqual({ actor_id: USER, actor_role: "hr", actor_name: "Ana Cruz", actor_ip: "203.0.113.9" });
  });

  it("writes nulls when there is no guard, and never a non-UUID id", () => {
    expect(actorColumns(undefined).actor_id).toBeNull();
    expect(actorColumns({ userId: "not-a-uuid", role: "admin" }).actor_id).toBeNull();
  });
});

describe("roundPeso", () => {
  it("rounds decimal halves up, which binary floating point used to round down", () => {
    expect(roundPeso(1.005)).toBe(1.01);
    expect(roundPeso(0.285)).toBe(0.29);
    expect(roundPeso(2.675)).toBe(2.68);
    expect(roundPeso(1234567.895)).toBe(1234567.9);
  });

  it("is symmetric for negatives, never -0, and 0 for non-numbers", () => {
    expect(roundPeso(-1.005)).toBe(-1.01);
    expect(Object.is(roundPeso(-0.001), 0)).toBe(true);
    expect(roundPeso("abc")).toBe(0);
    expect(roundPeso(null)).toBe(0);
  });
});

describe("breached-password check", async () => {
  const crypto = await import("node:crypto");
  const { breachCount, breachedPasswordError, BREACHED_PASSWORD_MESSAGE } = await import("@/lib/auth/breached-password");

  const sha1 = (value) => crypto.createHash("sha1").update(value).digest("hex").toUpperCase();

  /** A stand-in for the range API that knows one breached password. */
  function fakeRangeApi(breached, count = 42) {
    const hash = sha1(breached);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const prefix = url.slice(-5);
      const lines = ["0018A45C4D1DEF81644B54AB7F969B88D65:0"]; // padding row
      if (prefix === hash.slice(0, 5)) lines.push(`${hash.slice(5)}:${count}`);
      return { ok: true, text: async () => lines.join("\r\n") };
    };
    return { fetchImpl, calls };
  }

  it("refuses a breached password, sending only the 5-character hash prefix", async () => {
    const api = fakeRangeApi("Password123!");
    expect(await breachCount("Password123!", { fetchImpl: api.fetchImpl, force: true })).toBe(42);
    expect(await breachedPasswordError("Password123!", { fetchImpl: api.fetchImpl, force: true })).toBe(BREACHED_PASSWORD_MESSAGE);
    expect(api.calls[0]).toBe(`https://api.pwnedpasswords.com/range/${sha1("Password123!").slice(0, 5)}`);
    expect(api.calls[0]).not.toContain("Password123!");
  });

  it("allows a password that is not in the list, or only matches a padding row", async () => {
    const api = fakeRangeApi("Password123!");
    expect(await breachedPasswordError("Unlisted#Pass2026", { fetchImpl: api.fetchImpl, force: true })).toBeNull();
  });

  it("fails open when the service is unreachable or disabled", async () => {
    const down = async () => { throw new Error("network down"); };
    expect(await breachCount("Password123!", { fetchImpl: down, force: true })).toBe(0);
    // Off under the test runner unless forced, so the suite never calls out.
    const api = fakeRangeApi("Password123!");
    expect(await breachCount("Password123!", { fetchImpl: api.fetchImpl })).toBe(0);
    expect(api.calls).toHaveLength(0);
  });
});

describe("cross-site API requests", () => {
  it("are refused before anything else runs", async () => {
    const request = new NextRequest("http://localhost/api/legacy-auth/login", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    const response = await proxy(request);
    expect(response.status).toBe(403);
  });

  it("same-origin and header-less requests are unaffected", async () => {
    for (const headers of [{ "sec-fetch-site": "same-origin" }, {}]) {
      const response = await proxy(new NextRequest("http://localhost/api/legacy-auth/login", { method: "POST", headers }));
      expect(response.status).not.toBe(403);
    }
  });
});
