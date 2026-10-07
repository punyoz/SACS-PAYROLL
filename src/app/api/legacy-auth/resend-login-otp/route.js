import { NextResponse } from "next/server";
import { attachPendingLogin, readPendingLogin } from "@/lib/auth/pending-login";
import { checkResendAllowed, recordCodeSent } from "@/lib/auth/otp-throttle";
import { sanitizeError } from "@/lib/api-error";
import { otpReset } from "@/lib/auth/persistent-throttle";
import { sendEmailOtp, EMAIL_OTP_RESEND_SECONDS } from "@/lib/auth/email-otp";

/**
 * POST /api/legacy-auth/resend-login-otp
 *
 * Requests a fresh code for the sign-in already mid-flight, identified the
 * same way verify-login-otp is: the signed pending-login cookie, never a
 * client-supplied email. The new code replaces the old one in
 * public.auth_email_otps (src/lib/auth/email-otp.js), so the old code stops
 * working the moment this succeeds. At most one send per 60 seconds, checked
 * here and again in the database.
 */

async function handleResend(request) {
  const pending = readPendingLogin(request);
  if (!pending) {
    return NextResponse.json(
      { error: "Your sign-in session has expired. Please sign in again.", code: "pending_login_expired" },
      { status: 401 },
    );
  }

  const throttle = checkResendAllowed(pending.sub);
  if (!throttle.allowed) {
    return NextResponse.json(
      { error: `Please wait ${throttle.retryAfterSeconds}s before requesting another code.`, code: "otp_cooldown" },
      { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } },
    );
  }

  const sent = await sendEmailOtp({ purpose: "login", subject: pending.sub, email: pending.email });
  if (!sent.ok) {
    return NextResponse.json(
      { error: sent.error, code: sent.code },
      {
        status: sent.status,
        headers: sent.retryAfter ? { "Retry-After": String(sent.retryAfter) } : undefined,
      },
    );
  }

  // Starts the resend cooldown and resets the wrong-attempt counter — a fresh
  // code makes whatever was guessed against the old one moot.
  recordCodeSent(pending.sub);
  await otpReset(pending.sub);

  // Fresh 10-minute window to match the fresh code, without disturbing which
  // account or must_change_password state this pending sign-in belongs to.
  return attachPendingLogin(
    NextResponse.json({ success: true, message: "A new code has been sent.", resend_after: EMAIL_OTP_RESEND_SECONDS }),
    { user_id: pending.sub, email: pending.email, must_change_password: pending.pwd },
  );
}

export async function POST(request) {
  try {
    return await handleResend(request);
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeError(error, "Unable to send a new code right now. Please try again.") },
      { status: 500 },
    );
  }
}
