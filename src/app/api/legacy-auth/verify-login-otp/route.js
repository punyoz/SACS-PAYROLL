import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeText } from "@/lib/auth/normalize";
import { readPendingLogin, clearPendingLogin } from "@/lib/auth/pending-login";
import { resolveLoginProfile } from "@/lib/auth/resolve-profile-claims";
import { completeLogin, ROLE_ROUTES as roleRoutes } from "@/lib/auth/complete-login";
import { checkVerifyAllowed, recordVerifyFailure, resetVerifyAttempts } from "@/lib/auth/otp-throttle";
import { sanitizeError } from "@/lib/api-error";

/**
 * POST /api/legacy-auth/verify-login-otp — step 2 of 2 (code).
 *
 * Reached only by the roles src/lib/auth/otp-policy.js still gates -- today
 * Employee and Accountant. Everything the pre-2FA login route used to do
 * after "credentials are genuine" happens here instead, gated on the emailed
 * code also checking out: fetch the full profile, then hand off to
 * completeLogin() to register the active session and issue the signed
 * sacs-session cookie. The exempt roles reach that same helper straight from
 * the login route, so both paths end identically.
 *
 * The caller is identified from the signed pending-login cookie
 * (src/lib/auth/pending-login.js) set by POST /api/legacy-auth/login — never
 * from anything in the request body, which the browser could edit.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Never distinguish wrong-code from expired-code, or "used" from either —
 * all three collapse to this one message (see requirement 2.6). */
const GENERIC_CODE_ERROR = "Incorrect or expired code.";

async function handleVerify(request) {
  if (!url || !anonKey) {
    return NextResponse.json({ error: "Supabase env values are missing." }, { status: 500 });
  }

  const pending = readPendingLogin(request);
  if (!pending) {
    return NextResponse.json(
      { error: "Your sign-in session has expired. Please sign in again.", code: "pending_login_expired" },
      { status: 401 },
    );
  }

  // Independent of Supabase's own per-IP throttle on /auth/v1/verify — this
  // caps wrong-code guesses against THIS pending sign-in specifically, which
  // a generic IP-wide limit does not (src/lib/auth/otp-throttle.js).
  const gate = checkVerifyAllowed(pending.sub);
  if (!gate.allowed) {
    return clearPendingLogin(
      NextResponse.json(
        {
          error: "Too many incorrect codes. Please sign in again to request a new one.",
          code: "otp_locked_out",
        },
        { status: 429 },
      ),
    );
  }

  const body = await request.json().catch(() => ({}));
  const code = normalizeText(body?.code).replace(/\s+/g, "");

  if (!code) {
    return NextResponse.json({ error: "Enter the code from your email." }, { status: 400 });
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.verifyOtp({
    email: pending.email,
    token: code,
    type: "email",
  });

  if (error || !data?.user) {
    const result = recordVerifyFailure(pending.sub);
    if (!result.allowed) {
      return clearPendingLogin(
        NextResponse.json(
          {
            error: "Too many incorrect codes. Please sign in again to request a new one.",
            code: "otp_locked_out",
          },
          { status: 429 },
        ),
      );
    }
    return NextResponse.json({ error: GENERIC_CODE_ERROR }, { status: 400 });
  }

  // verifyOtp() handed back a real Supabase session — discarded immediately,
  // exactly as the password step already discards signInWithPassword's.
  // Authorization runs on the signed sacs-session cookie alone (see
  // src/lib/rbac/session.js), never on a Supabase session the browser holds.
  await supabase.auth.signOut();
  resetVerifyAttempts(pending.sub);

  // Check the raw role string, not resolvedRole's normalized fallback — same
  // reasoning as the password step: an unrecognized role must reject, not
  // silently become "employee".
  const actualRole = normalizeText(data.user.user_metadata?.role).toLowerCase();
  if (!actualRole || !Object.prototype.hasOwnProperty.call(roleRoutes, actualRole)) {
    return clearPendingLogin(
      NextResponse.json(
        { error: `Could not determine valid role for account. Role is '${actualRole || "unknown"}'.` },
        { status: 403 },
      ),
    );
  }

  if (data.user.user_metadata?.archived === true) {
    return clearPendingLogin(
      NextResponse.json(
        { error: "This account has been archived and can no longer sign in." },
        { status: 403 },
      ),
    );
  }

  const resolved = await resolveLoginProfile({
    url,
    serviceRoleKey,
    user: data.user,
    actualRole,
  });

  // Both factors are now verified, so the sign-in finishes exactly as it does
  // for a role that skipped the code (src/lib/auth/complete-login.js): this
  // becomes the account's only valid session and the cookie is issued.
  // Registering it is deliberately NOT done at the password step -- doing it
  // there would let anyone who merely knows the password (but not the code)
  // sign the real user out of their other browser, without ever getting in.
  return completeLogin({
    userId: data.user.id,
    resolved,
    mustChangePassword: pending.pwd,
    // Retires the pending-login cookie in the same response that sets the
    // session cookie.
    decorate: clearPendingLogin,
  });
}

export async function POST(request) {
  try {
    return await handleVerify(request);
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeError(error, "Unable to verify your code right now. Please try again.") },
      { status: 500 },
    );
  }
}
