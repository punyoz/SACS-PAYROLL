import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeText } from "@/lib/auth/normalize";
import { readPendingLogin, clearPendingLogin } from "@/lib/auth/pending-login";
import { attachSession } from "@/lib/rbac/session";
import { newSessionId, registerActiveSession } from "@/lib/auth/active-session";
import { resolveLoginProfile, buildProfilePayload } from "@/lib/auth/resolve-profile-claims";
import { checkVerifyAllowed, recordVerifyFailure, resetVerifyAttempts } from "@/lib/auth/otp-throttle";
import { sanitizeError } from "@/lib/api-error";

/**
 * POST /api/legacy-auth/verify-login-otp — step 2 of 2 (code).
 *
 * Everything the pre-2FA login route used to do after "credentials are
 * genuine" happens here instead, gated on the emailed code also checking out:
 * register this as the account's one active session, fetch the full profile,
 * and issue the signed sacs-session cookie. This is the only route in the app
 * that calls attachSession() for a fresh sign-in.
 *
 * The caller is identified from the signed pending-login cookie
 * (src/lib/auth/pending-login.js) set by POST /api/legacy-auth/login — never
 * from anything in the request body, which the browser could edit.
 */

const roleRoutes = {
  super_admin: "/super-admin",
  admin: "/admin",
  accountant: "/accountant",
  employee: "/employee",
  hr: "/hr",
};

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

  // Both factors are now verified: this sign-in becomes the account's only
  // valid one. Deliberately NOT done at the password step — registering it
  // there would let anyone who merely knows the password (but not the code)
  // sign the real user out of their other browser, without ever getting in.
  const sessionId = newSessionId();
  try {
    await registerActiveSession(data.user.id, sessionId);
  } catch {
    return NextResponse.json(
      { error: "Unable to start your session right now. Please try again." },
      { status: 503 },
    );
  }

  const response = NextResponse.json({
    success: true,
    redirectTo: roleRoutes[resolved.resolvedRole],
    role: resolved.resolvedRole,
    must_change_password: pending.pwd,
    profile: buildProfilePayload(resolved, pending.pwd),
  });

  clearPendingLogin(response);

  // The signed HttpOnly session every API guard reads — issued here, and only
  // here, for a fresh sign-in.
  return attachSession(response, {
    user_id: data.user.id,
    role: resolved.resolvedRole,
    branch_id: resolved.resolvedBranchId,
    email: resolved.resolvedEmailOutput,
    full_name: resolved.resolvedFullName,
    session_id: sessionId,
    must_change_password: pending.pwd,
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
