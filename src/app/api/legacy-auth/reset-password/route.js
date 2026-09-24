import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { listUsersCached, invalidateUsersCache } from "@/lib/auth/users-cache";
import { validateNewPassword } from "@/lib/auth/password-policy";
import { describeOtpError, OTP_CODE_ERROR } from "@/lib/auth/otp-errors";
import {
  checkResendAllowed,
  checkVerifyAllowed,
  recordCodeSent,
  recordVerifyFailure,
  resetVerifyAttempts,
} from "@/lib/auth/otp-throttle";
import {
  attachPasswordOtpState,
  canResetPassword,
  clearPasswordOtpState,
  findUserByIdentity,
  passwordChangedMarker,
  readPasswordOtpState,
  resetThrottleKey,
  PASSWORD_OTP_RESEND_MS,
  PASSWORD_OTP_RESEND_SECONDS,
} from "@/lib/auth/password-otp";

/**
 * POST /api/legacy-auth/reset-password: the login page's "Forgot Password?"
 * dialog, in three steps.
 *
 *   { action: "send",   identity }                  email a 6-digit OTP
 *   { action: "verify", code }                      check it
 *   { action: "reset",  password, confirm_password } set the new password
 *
 * Uses the sign-in OTP system (see src/lib/auth/password-otp.js): Supabase's
 * email OTP, the otp-throttle counters, and a signed step cookie. The new
 * password can only be set after the code has checked out. The link-based
 * reset (resetPasswordForEmail + the /reset-password recovery page) has been
 * removed.
 *
 * ENUMERATION
 * "send" answers every identity the same way -- found or not, Employee or
 * Admin -- including the 60-second cooldown, which is keyed on what was typed.
 * Only Employee and Accountant accounts are ever sent a code. The one
 * difference that can show is a Supabase mail failure or its hourly cap,
 * which only happens when a real email was attempted; those are reported
 * because a user needs to know the email did not go out.
 */

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GENERIC_SENT =
  "If the account exists, an OTP has been sent to its registered email address. "
  + "Admin, HR and Super Admin accounts: contact the administrator.";

const START_AGAIN = "Your OTP has expired or was not requested. Request a new OTP.";
const LOCKED_OUT = "Too many incorrect attempts. Request a new OTP.";

function clients() {
  if (!projectUrl || !anonKey || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  return {
    admin: createClient(projectUrl, serviceRoleKey, options),
    anon: () => createClient(projectUrl, anonKey, options),
  };
}

function fail(error, status, code, headers) {
  return NextResponse.json({ error, code }, { status, headers });
}

async function resolveUser(admin, identity) {
  const { data, error } = await listUsersCached(admin);
  if (error) throw new Error(error.message);
  return findUserByIdentity(data?.users, identity);
}

async function handleSend(body) {
  const identity = normalizeText(body.identity);
  if (!identity) return fail("Enter your Employee ID or email address.", 400, "identity_required");

  const key = resetThrottleKey(identity);
  const cooldown = checkResendAllowed(key, Date.now(), PASSWORD_OTP_RESEND_MS);
  if (!cooldown.allowed) {
    return fail(
      `Please wait ${cooldown.retryAfterSeconds} seconds before requesting another OTP.`,
      429,
      "otp_cooldown",
      { "Retry-After": String(cooldown.retryAfterSeconds) },
    );
  }

  const { admin, anon } = clients();
  const user = await resolveUser(admin, identity);

  if (canResetPassword(user)) {
    const { error } = await anon().auth.signInWithOtp({
      email: user.email,
      options: { shouldCreateUser: false },
    });
    if (error) {
      const described = describeOtpError(error, "send");
      return fail(described.error, described.status, described.code,
        described.retryAfter ? { "Retry-After": String(described.retryAfter) } : undefined);
    }
  }

  // Recorded for every identity, found or not, so the cooldown and the reply
  // are the same either way. Also resets the wrong-code count.
  recordCodeSent(key);

  return attachPasswordOtpState(
    NextResponse.json({ success: true, message: GENERIC_SENT, resend_after: PASSWORD_OTP_RESEND_SECONDS }),
    "reset",
    { stage: "otp", idn: identity },
  );
}

async function handleVerify(request, body) {
  const state = readPasswordOtpState(request, "reset");
  if (!state || state.stage !== "otp" || !state.idn) {
    return clearPasswordOtpState(fail(START_AGAIN, 400, "otp_expired"), "reset");
  }

  const key = resetThrottleKey(state.idn);
  if (!checkVerifyAllowed(key).allowed) {
    return clearPasswordOtpState(fail(LOCKED_OUT, 429, "otp_locked_out"), "reset");
  }

  const code = normalizeText(body.code).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return fail("Enter the 6-digit OTP from your email.", 400, "otp_format");

  const wrongCode = () => {
    if (!recordVerifyFailure(key).allowed) {
      return clearPasswordOtpState(fail(LOCKED_OUT, 429, "otp_locked_out"), "reset");
    }
    return fail(OTP_CODE_ERROR, 400, "otp_invalid");
  };

  const { admin, anon } = clients();
  const user = await resolveUser(admin, state.idn);
  // No code was ever sent to an ineligible identity: same answer as a wrong code.
  if (!canResetPassword(user)) return wrongCode();

  const verifier = anon();
  const { data, error } = await verifier.auth.verifyOtp({ email: user.email, token: code, type: "email" });
  if (error || !data?.user || data.user.id !== user.id) {
    const described = describeOtpError(error, "verify");
    if (described.code === "otp_invalid") return wrongCode();
    return fail(described.error, described.status, described.code);
  }

  // verifyOtp signed the user in and used up the code; that session is never
  // used, so end it.
  await verifier.auth.signOut({ scope: "local" }).catch(() => {});
  resetVerifyAttempts(key);

  return attachPasswordOtpState(
    NextResponse.json({ success: true, verified: true, message: "OTP verified. Choose your new password." }),
    "reset",
    { stage: "verified", sub: user.id, pca: passwordChangedMarker(data.user) },
  );
}

async function handleReset(request, body) {
  const state = readPasswordOtpState(request, "reset");
  if (!state || state.stage !== "verified" || !state.sub) {
    return clearPasswordOtpState(
      fail("Your verification has expired. Request a new OTP.", 400, "grant_expired"),
      "reset",
    );
  }

  const password = normalizeText(body.password);
  const confirm = body.confirm_password === undefined ? password : normalizeText(body.confirm_password);
  if (!password) return fail("Enter a new password.", 400, "password_required");
  if (password !== confirm) return fail("New passwords do not match.", 400, "password_mismatch");

  const { admin, anon } = clients();
  const { data: userData, error: userError } = await admin.auth.admin.getUserById(state.sub);
  const user = userData?.user;
  if (userError || !canResetPassword(user)) {
    return clearPasswordOtpState(fail("This account cannot be reset here. Contact the administrator.", 403, "not_allowed"), "reset");
  }
  // The password has changed since this grant was issued: it was already used.
  if (passwordChangedMarker(user) !== state.pca) {
    return clearPasswordOtpState(fail("This reset has already been used. Request a new OTP.", 400, "grant_used"), "reset");
  }

  const policyError = validateNewPassword(password, {
    full_name: user.user_metadata?.full_name,
    date_of_birth: user.user_metadata?.date_of_birth,
  });
  if (policyError) return fail(policyError, 400, "password_policy");

  // Must differ from the old password. The admin update below does not check
  // that (Supabase only does for a user's own updateUser), so try it.
  const probe = anon();
  const { data: same } = await probe.auth.signInWithPassword({ email: user.email, password });
  if (same?.user) {
    await probe.auth.signOut({ scope: "local" }).catch(() => {});
    return fail("New password must be different from your current password.", 400, "password_same");
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
    password,
    // Same markers /api/legacy-auth/change-password sets: not a one-time
    // password any more, and the new password_changed_at retires this grant.
    app_metadata: { temp_password_hash: null, password_changed_at: new Date().toISOString() },
  });
  if (updateError) {
    const weak = String(updateError.code || "").toLowerCase() === "weak_password";
    return fail(
      weak ? `Password rejected: ${updateError.message}` : "Your password could not be updated. Please try again.",
      weak ? 400 : 500,
      weak ? "password_policy" : "update_failed",
    );
  }
  invalidateUsersCache();

  return clearPasswordOtpState(
    NextResponse.json({ success: true, message: "Your password has been reset. Sign in with your new password." }),
    "reset",
  );
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action, "send").toLowerCase();

    if (action === "send") return await handleSend(body);
    if (action === "verify") return await handleVerify(request, body);
    if (action === "reset") return await handleReset(request, body);
    return fail("Unknown action.", 400, "unknown_action");
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
