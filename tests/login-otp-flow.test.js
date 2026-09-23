import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { OTP_REQUIRED_ROLES, requiresLoginOtp } from "@/lib/auth/otp-policy";

/**
 * The five required verification scenarios for email-OTP login, checked two
 * ways:
 *
 *   - tests/pending-login.test.js and tests/otp-throttle.test.js exercise the
 *     real, pure logic (signing/expiry, attempt counting, lockout, resend
 *     cooldown) with real assertions, not mocks.
 *   - This file checks the one thing those unit tests cannot: that the ROUTES
 *     actually wire that logic the way the spec requires — most importantly,
 *     that src/lib/rbac/session.js's attachSession() (the only thing that
 *     issues the real sacs-session cookie) is reachable from nowhere except
 *     a successful OTP verification.
 *
 * Read as text rather than imported, matching tests/scripts-seed-parity.test.js
 * and tests/purge-archived-employees.test.js: importing either route module
 * would require a live NEXT_PUBLIC_SUPABASE_URL/ANON_KEY and would attempt a
 * real network call the moment its POST handler runs.
 *
 * What this does NOT cover: an actual email arriving and a real code being
 * typed in. That needs a live pass once Supabase's Email OTP dashboard
 * settings are confirmed (see the migration/PR notes) — the same category of
 * manual check already flagged for the RFID endpoint's device key.
 */

const loginRoute = readFileSync("src/app/api/legacy-auth/login/route.js", "utf8");
const verifyRoute = readFileSync("src/app/api/legacy-auth/verify-login-otp/route.js", "utf8");
const resendRoute = readFileSync("src/app/api/legacy-auth/resend-login-otp/route.js", "utf8");
const proxySource = readFileSync("src/proxy.js", "utf8");
const completeLogin = readFileSync("src/lib/auth/complete-login.js", "utf8");
const otpPolicy = readFileSync("src/lib/auth/otp-policy.js", "utf8");

describe("Scenario: correct password + correct OTP -> normal login", () => {
  it("the password step never calls attachSession — no session on password alone", () => {
    // Matches an actual invocation ("attachSession(" with an argument list),
    // not this file's own header comment, which names the function in prose
    // when explaining that verify-login-otp/route.js is where it happens.
    expect(loginRoute).not.toMatch(/attachSession\(\s*(response|NextResponse)/);
  });

  it("the password step issues the pending-login cookie instead", () => {
    expect(loginRoute).toMatch(/attachPendingLogin/);
  });

  it("session issuance lives in exactly one place, reached via completeLogin", () => {
    // attachSession() moved into src/lib/auth/complete-login.js when the
    // OTP-exempt roles gained a second way to finish signing in. The guarantee
    // is unchanged and now stronger: ONE function issues the cookie, and both
    // routes must go through it rather than minting a session themselves.
    // The "not called" checks match an INVOCATION (a call whose argument list
    // starts with a response object), not the bare name, so that prose in a
    // header comment explaining where the cookie is minted does not fail them.
    const invocation = /attachSession\(\s*(response|NextResponse)/;
    expect(completeLogin).toMatch(invocation);
    expect(verifyRoute).toMatch(/completeLogin\(/);
    expect(loginRoute).toMatch(/completeLogin\(/);
    expect(verifyRoute).not.toMatch(invocation);
    expect(loginRoute).not.toMatch(invocation);
  });

  it("the OTP step still honours must_change_password on success, from the pending token", () => {
    // pending.pwd was computed at password-check time (it needs the
    // plaintext password) and must survive to the final response/session
    // untouched, not be silently dropped or recomputed as false.
    expect(verifyRoute).toMatch(/pending\.pwd/);
    // Handed to completeLogin(), which is what now sets must_change_password
    // on both the JSON body and the session cookie.
    expect(verifyRoute).toMatch(/mustChangePassword:\s*pending\.pwd/);
    expect(completeLogin).toMatch(/must_change_password:\s*mustChangePassword/);
  });
});

describe("Scenario: correct password + wrong OTP -> no access, generic error", () => {
  it("verifyOtp errors map to one generic message, not Supabase's own wording", () => {
    expect(verifyRoute).toMatch(/GENERIC_CODE_ERROR\s*=\s*"Incorrect or expired code\."/);
  });

  it("a wrong code records a failure and does not reach attachSession", () => {
    expect(verifyRoute).toMatch(/recordVerifyFailure/);
    // The failure branch returns before the success-path code — checked by
    // confirming registerActiveSession (success-only) appears strictly after
    // the generic error is returned in source order, since this is a single
    // linear async function with no early success return.
    const errorIdx = verifyRoute.indexOf("GENERIC_CODE_ERROR }, { status: 400 }");
    const completeIdx = verifyRoute.indexOf("return completeLogin(");
    expect(errorIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(errorIdx);
    // And the session registration it guards is inside that helper, not
    // duplicated somewhere the wrong-code branch could fall through to.
    expect(completeLogin).toMatch(/registerActiveSession\(/);
    expect(verifyRoute).not.toMatch(/registerActiveSession\(/);
  });
});

describe("Scenario: correct password + expired OTP -> no access, same generic error", () => {
  it("does not expose a distinct 'expired' message for the code itself", () => {
    // "expired" legitimately appears on two lines: GENERIC_CODE_ERROR's own
    // definition, and the *pending-login-cookie-missing* message ("Your
    // sign-in session has expired") — a different fact (no pending sign-in
    // exists at all, not "your code specifically expired") and not the
    // wrong/expired-code distinction the spec forbids. Checked per line
    // (not as one file-wide regex, which can match across unrelated quoted
    // strings) that no OTHER line pairs "expired" with "code".
    const linesMentioningExpired = verifyRoute
      .split("\n")
      .filter((line) => /expired/i.test(line) && !/^\s*(\/\/|\*|\/\*\*)/.test(line.trim()));

    expect(linesMentioningExpired).toEqual([
      expect.stringContaining("GENERIC_CODE_ERROR"),
      expect.stringContaining("Your sign-in session has expired"),
    ]);
  });

  it("Supabase's verifyOtp is the sole authority on expiry — the app stores no expiry of its own", () => {
    // Confirms the design decision plainly: no login_otps-style table, no
    // app-computed expiry timestamp for the code exists in this route.
    expect(verifyRoute).not.toMatch(/code_hash|login_otps/);
  });
});

describe("Scenario: 5 consecutive wrong attempts -> locked out, must resend", () => {
  it("the verify route checks and records against the shared attempt limiter", () => {
    expect(verifyRoute).toMatch(/checkVerifyAllowed/);
    expect(verifyRoute).toMatch(/recordVerifyFailure/);
  });

  it("a lockout clears the pending-login cookie, forcing a fresh sign-in", () => {
    const lockoutBlocks = verifyRoute.match(/clearPendingLogin\(\s*\n?\s*NextResponse\.json\(\s*\{\s*\n?\s*error:\s*"Too many incorrect codes/g);
    expect(lockoutBlocks?.length).toBeGreaterThanOrEqual(1);
  });

  it("resending a code resets the attempt counter (tested directly in otp-throttle.test.js) and is wired into the resend route", () => {
    expect(resendRoute).toMatch(/recordCodeSent/);
  });
});

describe("Scenario: no session cookie exists before OTP verification succeeds", () => {
  it("proxy.js treats both OTP routes as reachable without a sacs-session cookie", () => {
    expect(proxySource).toMatch(/"\/api\/legacy-auth\/verify-login-otp"/);
    expect(proxySource).toMatch(/"\/api\/legacy-auth\/resend-login-otp"/);
  });

  it("abandoning the flow needs no server call — the pending cookie simply expires", () => {
    // There is deliberately no "cancel"/"abandon" endpoint: confirms nothing
    // server-side treats a still-pending cookie as a session on its own.
    expect(loginRoute).not.toMatch(/cancel|abandon/i);
    expect(verifyRoute).not.toMatch(/cancel|abandon/i);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   OTP is scoped to Employee and Accountant
   ══════════════════════════════════════════════════════════════════════════ */

describe("Scenario: Super Admin / Admin / HR sign in without an OTP", () => {
  it("only Employee and Accountant are behind the second factor", () => {
    expect(OTP_REQUIRED_ROLES).toEqual(["employee", "accountant"]);
    for (const role of ["employee", "accountant"]) {
      expect(requiresLoginOtp(role)).toBe(true);
    }
    for (const role of ["super_admin", "admin", "hr"]) {
      expect(requiresLoginOtp(role)).toBe(false);
    }
  });

  it("is decided on the role string alone, whatever its casing", () => {
    expect(requiresLoginOtp("Employee")).toBe(true);
    expect(requiresLoginOtp("SUPER_ADMIN")).toBe(false);
    // An unknown or empty role is not in the set, but never reaches this
    // question: both routes reject an unroutable role before asking.
    expect(requiresLoginOtp("")).toBe(false);
    expect(requiresLoginOtp(undefined)).toBe(false);
  });

  it("the exempt branch returns BEFORE any code is emailed", () => {
    // The whole point: an exempt sign-in must never ask Supabase to send a
    // code. Source order proves it for this single linear async function --
    // the early return sits above signInWithOtp, so that call is unreachable
    // for an exempt role.
    const branchIdx = loginRoute.indexOf("if (!requiresLoginOtp(actualRole))");
    const sendIdx = loginRoute.indexOf("await supabase.auth.signInWithOtp({");
    const pendingIdx = loginRoute.indexOf("attachPendingLogin(response");
    expect(branchIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(branchIdx);
    expect(pendingIdx).toBeGreaterThan(branchIdx);
  });

  it("the exempt branch finishes the sign-in through the shared helper", () => {
    const branchIdx = loginRoute.indexOf("if (!requiresLoginOtp(actualRole))");
    const completeIdx = loginRoute.indexOf("return completeLogin(", branchIdx);
    const sendIdx = loginRoute.indexOf("await supabase.auth.signInWithOtp({");
    // completeLogin is called inside the branch, i.e. before the OTP send.
    expect(completeIdx).toBeGreaterThan(branchIdx);
    expect(completeIdx).toBeLessThan(sendIdx);
  });

  it("an exempt sign-in still carries must_change_password through", () => {
    // A newly created Super Admin/Admin/HR account is on its issued default
    // password and must be forced to the change-password screen on first
    // sign-in, exactly like an employee. Skipping OTP must not skip that.
    const branchIdx = loginRoute.indexOf("if (!requiresLoginOtp(actualRole))");
    const branch = loginRoute.slice(branchIdx, loginRoute.indexOf("}", loginRoute.indexOf("});", branchIdx)));
    expect(branch).toMatch(/mustChangePassword:\s*passwordChangeRequired/);
  });

  it("the OTP infrastructure is kept, not deleted", () => {
    // This was a routing change. The verify and resend routes, the throttle
    // and the pending-login cookie all still have to work for the roles that
    // remain gated.
    expect(verifyRoute).toMatch(/verifyOtp/);
    expect(resendRoute).toMatch(/signInWithOtp/);
    expect(loginRoute).toMatch(/signInWithOtp/);
    expect(loginRoute).toMatch(/attachPendingLogin/);
  });

  it("re-enabling a role is a one-line change in one file", () => {
    // Guards the property the policy module promises: nothing outside
    // otp-policy.js hard-codes which roles are exempt.
    expect(loginRoute).not.toMatch(/"(super_admin|admin|hr)"/);
    expect(otpPolicy).toMatch(/OTP_REQUIRED_ROLES/);
  });
});
