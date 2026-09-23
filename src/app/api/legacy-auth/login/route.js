import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeText, normalizeRoleEmail } from "@/lib/auth/normalize";
import { attachPendingLogin } from "@/lib/auth/pending-login";
import { mustChangePassword } from "@/lib/auth/password-policy";
import { friendlyLoginError, SERVICE_UNAVAILABLE_MESSAGE } from "@/lib/auth/login-errors";
import { resolveLoginProfile } from "@/lib/auth/resolve-profile-claims";
import { recordCodeSent } from "@/lib/auth/otp-throttle";
import { requiresLoginOtp } from "@/lib/auth/otp-policy";
import { completeLogin } from "@/lib/auth/complete-login";
import { sanitizeError } from "@/lib/api-error";
import {
  checkLoginAllowed,
  clientAddressFrom,
  recordFailedLogin,
  recordSuccessfulLogin,
} from "@/lib/auth/login-throttle";

/**
 * POST /api/legacy-auth/login - step 1 of 2 (password), or the whole sign-in.
 *
 * How this ends depends on the account's role, and on nothing else. The
 * password is checked the same way for everyone; then
 * src/lib/auth/otp-policy.js decides:
 *
 *   Employee / Accountant  -> two-factor. A correct password does NOT issue
 *       the session cookie. It issues a short-lived, signed "pending login"
 *       cookie (src/lib/auth/pending-login.js) and emails a one-time code via
 *       Supabase's own Email OTP (supabase.auth.signInWithOtp), the same
 *       sender the password-reset flow uses. The browser goes to the
 *       verify-code screen and POST /api/legacy-auth/verify-login-otp is
 *       step 2.
 *
 *   Super Admin / Admin / HR -> single-factor, at the operator's request. No
 *       code is emailed and no pending cookie is set; the sign-in finishes
 *       here via completeLogin(). See otp-policy.js for why, and for the
 *       one-line change that puts a role back behind the second factor.
 *
 * Either way the session cookie is minted in exactly one function,
 * src/lib/auth/complete-login.js, so the two paths cannot drift apart. This
 * route never calls attachSession() itself.
 *
 * Everything through "credentials are genuine" is unchanged from the
 * single-factor version: same throttle, same friendly error mapping, same
 * archived/role checks.
 */

const roleRoutes = {
  super_admin: "/super-admin",
  admin: "/admin",
  accountant: "/accountant",
  employee: "/employee",
  hr: "/hr",
};

const ADMIN_USERNAME = normalizeText(process.env.SEED_ADMIN_USERNAME, "sacsadmin").toLowerCase();
const ADMIN_EMAIL = normalizeText(process.env.SEED_ADMIN_EMAIL, "admin@example.com");
const HR_USERNAME = normalizeText(process.env.SEED_HR_USERNAME, "sacshr").toLowerCase();
const HR_EMAIL = normalizeText(process.env.SEED_HR_EMAIL, "hr@example.com");
const SUPER_ADMIN_USERNAME = normalizeText(process.env.SEED_SUPER_ADMIN_USERNAME, "sacssuperadmin").toLowerCase();
const SUPER_ADMIN_EMAIL = normalizeText(process.env.SEED_SUPER_ADMIN_EMAIL, "superadmin@example.com");

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function resolveLoginEmail(identityInput) {
  const identity = normalizeText(identityInput);

  if (!identity) {
    return "";
  }

  const lowered = identity.toLowerCase();

  if (lowered === SUPER_ADMIN_USERNAME) {
    return normalizeRoleEmail(SUPER_ADMIN_EMAIL);
  }

  if (lowered === ADMIN_USERNAME) {
    return normalizeRoleEmail(ADMIN_EMAIL);
  }

  if (lowered === HR_USERNAME) {
    return normalizeRoleEmail(HR_EMAIL);
  }

  if (lowered.includes("@")) {
    return normalizeRoleEmail(identity);
  }

  return "";
}

/** "tessadelacruz@school.edu" -> "t***@school.edu" — enough for the verify
 * screen to confirm which inbox to check without fully redisplaying an
 * address the caller may have typed as a username, not an email. */
function maskEmail(email) {
  const value = normalizeText(email);
  const at = value.indexOf("@");
  if (at <= 0) return value;
  return `${value[0]}***${value.slice(at)}`;
}

async function handleLogin(request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return NextResponse.json({ error: "Supabase env values are missing." }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const identityInput = body?.employeeId || body?.username;
  const password = body?.password;

  if (!identityInput || !password) {
    return NextResponse.json({ error: "Login identity and password are required." }, { status: 400 });
  }

  const resolvedEmail = resolveLoginEmail(identityInput);
  if (!resolvedEmail) {
    return NextResponse.json({ error: "Use a valid username or email to sign in." }, { status: 400 });
  }

  // Brute-force brake. Keyed on the resolved email rather than the raw input so
  // signing in as "sacsadmin" and as the admin's email address share one budget
  // instead of giving an attacker two.
  const clientAddress = clientAddressFrom(request);
  const throttle = checkLoginAllowed(resolvedEmail, clientAddress);
  if (throttle.blocked) {
    const minutes = Math.max(1, Math.ceil(throttle.retryAfterSeconds / 60));
    return NextResponse.json(
      {
        error: `Too many sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        code: "too_many_attempts",
      },
      { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } },
    );
  }

  const supabase = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase.auth.signInWithPassword({ email: resolvedEmail, password });

  if (error || !data?.user) {
    recordFailedLogin(resolvedEmail, clientAddress);
    // Supabase's own wording is not shown to the user: a wrong address and a
    // wrong password must read identically, or this route becomes a way to
    // test which emails hold accounts (src/lib/auth/login-errors.js).
    const friendly = friendlyLoginError(error);
    return NextResponse.json(
      { error: friendly },
      { status: friendly === SERVICE_UNAVAILABLE_MESSAGE ? 503 : 401 },
    );
  }

  if (data.user.user_metadata?.archived === true) {
    await supabase.auth.signOut();
    recordFailedLogin(resolvedEmail, clientAddress);
    return NextResponse.json(
      { error: "This account has been archived and can no longer sign in." },
      { status: 403 },
    );
  }

  // Check the raw role string directly against the known routable roles —
  // do NOT go through normalizeRole() here, since it silently falls back to
  // "employee" for anything it doesn't recognize. That fallback is fine for
  // display/formatting purposes elsewhere, but here it would let an account
  // whose role has become momentarily unrecognized (e.g. a role renamed or
  // temporarily removed in code) log in *as a different role* instead of
  // being rejected — exactly the bug that once silently reassigned the
  // super_admin account to the employee portal.
  const actualRole = normalizeText(data.user.user_metadata?.role).toLowerCase();

  if (!actualRole || !Object.prototype.hasOwnProperty.call(roleRoutes, actualRole)) {
    await supabase.auth.signOut();
    recordFailedLogin(resolvedEmail, clientAddress);
    return NextResponse.json(
      {
        error: `Could not determine valid role for account. Role is '${actualRole || "unknown"}'.`,
      },
      { status: 403 },
    );
  }

  await supabase.auth.signOut();

  // Credentials were genuine: clear this account's failed-attempt budget so a
  // user who mistyped on the way in is not locked out later. The OTP step has
  // its own, separate throttle (src/lib/auth/otp-throttle.js) — a correct
  // password never grants extra OTP guesses, and a wrong OTP never costs a
  // password-throttle attempt.
  recordSuccessfulLogin(resolvedEmail);

  // Only resolvedFullName is used here (mustChangePassword needs it — see
  // below). Role, branch and the extended profile bundle are re-resolved
  // fresh in verify-login-otp/route.js once the code is confirmed; nothing
  // about *this* step depends on them, so nothing is returned to the browser
  // before the second factor passes.
  const resolved = await resolveLoginProfile({
    url,
    serviceRoleKey: SERVICE_ROLE_KEY,
    user: data.user,
    actualRole,
  });

  // Still on the password HR/Super Admin issued? Computed here because it
  // needs the plaintext password (src/lib/auth/password-policy.js), which is
  // never carried into the pending-login cookie — only the resulting boolean
  // is (see src/lib/auth/pending-login.js's header comment).
  const passwordChangeRequired = mustChangePassword(password, data.user, resolved.resolvedFullName);

  // Roles outside OTP_REQUIRED_ROLES finish here: the password was the whole
  // sign-in for them, so no code is emailed, no pending-login cookie is set,
  // and the session is issued now. Everything after this block -- the OTP
  // send, the pending cookie, the verify round trip -- applies only to the
  // roles src/lib/auth/otp-policy.js still gates. Note this returns BEFORE
  // signInWithOtp is called, so an exempt sign-in never asks Supabase to send
  // anything.
  if (!requiresLoginOtp(actualRole)) {
    return completeLogin({
      userId: data.user.id,
      resolved,
      mustChangePassword: passwordChangeRequired,
    });
  }

  // data.user.email, not resolvedEmail: this is Supabase's own canonical,
  // stored casing for the address signInWithOtp/verifyOtp key off of.
  const accountEmail = normalizeText(data.user.email);

  const { error: otpError } = await supabase.auth.signInWithOtp({
    email: accountEmail,
    options: {
      // The account was just proven to exist and belong to this caller via a
      // correct password — but signInWithOtp is a separate Supabase call that
      // doesn't know that. Without this, an OTP request for an email with no
      // account would silently create one; this app's accounts are always
      // provisioned by HR/Admin, never self-signup.
      shouldCreateUser: false,
    },
  });

  if (otpError) {
    const rateLimited = Number(otpError.status) === 429
      || String(otpError.code || "").toLowerCase().includes("rate_limit");
    return NextResponse.json(
      {
        error: rateLimited
          ? "Too many verification codes requested. Please wait a few minutes and try again."
          : "Unable to send your verification code right now. Please try again.",
      },
      { status: rateLimited ? 429 : 503 },
    );
  }

  recordCodeSent(data.user.id);

  const response = NextResponse.json({
    success: true,
    otp_required: true,
    masked_email: maskEmail(accountEmail),
  });

  // The ONLY cookie this route issues. No sacs-session cookie exists past
  // this point until verify-login-otp/route.js confirms the code.
  return attachPendingLogin(response, {
    user_id: data.user.id,
    email: accountEmail,
    must_change_password: passwordChangeRequired,
  });
}

/**
 * Sign-in never returns an unhandled rejection. Without this, a network fault
 * reaching Supabase surfaced as a bare Next.js 500 and the login screen showed
 * no usable message at all.
 */
export async function POST(request) {
  try {
    return await handleLogin(request);
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeError(error, "Unable to sign in right now. Please try again.") },
      { status: 500 },
    );
  }
}
