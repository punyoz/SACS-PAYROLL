/**
 * POST /api/legacy-auth/change-password-otp: the emailed-code steps of a
 * logged-in password change, for the roles src/lib/auth/otp-policy.js gates
 * (Employee, Accountant).
 *
 *   { action: "start",  current_password }  check it, then email an 8-digit OTP
 *   { action: "resend" }                    another OTP (60 s apart)
 *   { action: "verify", code }              check the OTP
 *
 * After "verify", POST /api/legacy-auth/change-password sets the new password.
 * It refuses to until this flow's cookie says the code checked out (see
 * src/lib/auth/password-otp.js). Other roles get `{ otp_required: false }` and
 * change their password in one step, as before.
 *
 * WHY NOT supabase.auth.reauthenticate()
 * Supabase checks a reauthentication code (the `nonce` passed to updateUser)
 * only when "Secure password change" is on AND the session is more than 24
 * hours old; otherwise it ignores it. This app keeps no Supabase session in
 * the browser, so the code would never be checked. The email OTP that sign-in
 * uses (signInWithOtp / verifyOtp) is always checked.
 *
 * The address comes from the auth user for the session's user id, never from
 * the request body.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { requirePermission } from "@/lib/rbac/guard";
import { requiresLoginOtp } from "@/lib/auth/otp-policy";
import { describeOtpError, OTP_CODE_ERROR } from "@/lib/auth/otp-errors";
import {
  checkResendAllowed,
  checkVerifyAllowed,
  passwordChangeThrottleKey,
  recordCodeSent,
  recordVerifyFailure,
  resetVerifyAttempts,
} from "@/lib/auth/otp-throttle";
import {
  attachPasswordOtpState,
  clearPasswordOtpState,
  maskEmail,
  passwordChangedMarker,
  readPasswordOtpState,
  PASSWORD_OTP_RESEND_MS,
  PASSWORD_OTP_RESEND_SECONDS,
} from "@/lib/auth/password-otp";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const START_AGAIN = "Your OTP has expired. Enter your current password and request a new OTP.";
const LOCKED_OUT = "Too many incorrect attempts. Request a new OTP.";

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

// 400/429, never 401: the portals treat a 401 as "session over".
function fail(error, status, code, headers) {
  return NextResponse.json({ error, code }, { status, headers });
}

async function sendCode(email, key) {
  const cooldown = checkResendAllowed(key, Date.now(), PASSWORD_OTP_RESEND_MS);
  if (!cooldown.allowed) {
    return fail(
      `Please wait ${cooldown.retryAfterSeconds} seconds before requesting another OTP.`,
      429,
      "otp_cooldown",
      { "Retry-After": String(cooldown.retryAfterSeconds) },
    );
  }

  const { error } = await createClient(projectUrl, anonKey, clientOptions).auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  if (error) {
    const described = describeOtpError(error, "send");
    return fail(described.error, described.status, described.code,
      described.retryAfter ? { "Retry-After": String(described.retryAfter) } : undefined);
  }

  // Starts the 60 s cooldown and resets the wrong-code count.
  recordCodeSent(key);
  return null;
}

export async function POST(request) {
  const guard = await requirePermission(request, "profile", "update");
  if (guard.denied) return guard.denied;

  try {
    // First-sign-in change: the sign-in OTP already proved the inbox, so no
    // second code (see /api/legacy-auth/change-password).
    if (!requiresLoginOtp(guard.role) || guard.session?.pwd === true) {
      return NextResponse.json({ success: true, otp_required: false });
    }
    if (!projectUrl || !anonKey || !serviceRoleKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action, "start").toLowerCase();
    const key = passwordChangeThrottleKey(guard.userId);

    const admin = createClient(projectUrl, serviceRoleKey, clientOptions);
    const { data: userData, error: userError } = await admin.auth.admin.getUserById(guard.userId);
    const user = userData?.user;
    const email = normalizeText(user?.email);
    if (userError || !email) {
      return fail("Unable to identify your account. Please sign in again.", 400, "no_account");
    }

    if (action === "start") {
      // Step 1: the current password, checked against the account itself.
      const currentPassword = normalizeText(body.current_password);
      if (!currentPassword) return fail("Enter your current password.", 400, "current_required");

      const probe = createClient(projectUrl, anonKey, clientOptions);
      const { data: signIn, error: signInError } = await probe.auth.signInWithPassword({ email, password: currentPassword });
      if (signInError || signIn?.user?.id !== guard.userId) {
        return fail("Current password is incorrect.", 400, "current_incorrect");
      }
      await probe.auth.signOut({ scope: "local" }).catch(() => {});

      const sendFailure = await sendCode(email, key);
      if (sendFailure) return sendFailure;

      return attachPasswordOtpState(
        NextResponse.json({
          success: true,
          otp_required: true,
          resend_after: PASSWORD_OTP_RESEND_SECONDS,
          message: `An OTP has been sent to ${maskEmail(email)}. It expires in 5 minutes.`,
        }),
        "change",
        { stage: "otp", sub: guard.userId },
      );
    }

    const state = readPasswordOtpState(request, "change");
    const inOtpStage = state?.stage === "otp" && state.sub === guard.userId;

    if (action === "resend") {
      if (!inOtpStage) return clearPasswordOtpState(fail(START_AGAIN, 400, "otp_expired"), "change");

      const sendFailure = await sendCode(email, key);
      if (sendFailure) return sendFailure;

      return attachPasswordOtpState(
        NextResponse.json({
          success: true,
          resend_after: PASSWORD_OTP_RESEND_SECONDS,
          message: `A new OTP has been sent to ${maskEmail(email)}.`,
        }),
        "change",
        { stage: "otp", sub: guard.userId },
      );
    }

    if (action === "verify") {
      if (!inOtpStage) return clearPasswordOtpState(fail(START_AGAIN, 400, "otp_expired"), "change");
      if (!checkVerifyAllowed(key).allowed) {
        return clearPasswordOtpState(fail(LOCKED_OUT, 429, "otp_locked_out"), "change");
      }

      const code = normalizeText(body.code).replace(/\s+/g, "");
      if (!/^\d{8}$/.test(code)) return fail("Enter the 8-digit OTP from your email.", 400, "otp_format");

      const verifier = createClient(projectUrl, anonKey, clientOptions);
      const { data, error } = await verifier.auth.verifyOtp({ email, token: code, type: "email" });
      if (error || !data?.user || data.user.id !== guard.userId) {
        const described = describeOtpError(error, "verify");
        if (described.code === "otp_invalid") {
          if (!recordVerifyFailure(key).allowed) {
            return clearPasswordOtpState(fail(LOCKED_OUT, 429, "otp_locked_out"), "change");
          }
          return fail(OTP_CODE_ERROR, 400, "otp_invalid");
        }
        return fail(described.error, described.status, described.code);
      }

      await verifier.auth.signOut({ scope: "local" }).catch(() => {});
      resetVerifyAttempts(key);

      return attachPasswordOtpState(
        NextResponse.json({ success: true, verified: true, message: "OTP verified. Enter your new password." }),
        "change",
        { stage: "verified", sub: guard.userId, pca: passwordChangedMarker(data.user) },
      );
    }

    return fail("Unknown action.", 400, "unknown_action");
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
