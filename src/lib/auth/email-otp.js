/**
 * Emailed one-time codes: generate, store (hashed), email, verify.
 *
 * Replaces Supabase Auth's email OTP (signInWithOtp / verifyOtp) for sign-in,
 * password reset and password change. The flow:
 *
 *   sendEmailOtp()    a random 6-digit code; its HMAC goes to
 *                     public.auth_email_otps with a 5-minute expiry
 *                     (20261007020000_email_otp_codes.sql); the code itself
 *                     only ever exists in the email (src/lib/mail/gmail.js).
 *   verifyEmailOtp()  the typed code's HMAC is compared in the database, under
 *                     a row lock: single-use, 5 wrong guesses at most, then a
 *                     new code must be requested.
 *
 * Each flow has its own row ("login:<user id>", "reset:<user id>",
 * "pwchange:<user id>"), so a sign-in code cannot be spent on a password reset
 * and the other way round. Sending again replaces the row, which retires the
 * previous code; the database also refuses a resend within 60 seconds of a
 * still-usable code.
 *
 * The HMAC key is the session signing key (src/lib/rbac/session.js), so a
 * copy of the table alone cannot be brute-forced back into codes offline.
 *
 * The routes keep their existing attempt counters (otp-throttle.js,
 * persistent-throttle.js) alongside this; the limits agree.
 */

import crypto from "node:crypto";
import { sign } from "@/lib/rbac/session";
import { getServiceClient } from "@/lib/supabase/admin";
import { sendMail, MailNotConfiguredError } from "@/lib/mail/gmail";
import { buildOtpEmail } from "@/lib/mail/otp-email";

export const EMAIL_OTP_LENGTH = 6;
export const EMAIL_OTP_TTL_SECONDS = 5 * 60;
export const EMAIL_OTP_RESEND_SECONDS = 60;
export const EMAIL_OTP_MAX_ATTEMPTS = 5;

/** One answer for a wrong, expired or already-used code. */
export const OTP_CODE_ERROR = "The OTP is incorrect or has expired. Check the code or request a new one.";

export const OTP_FORMAT_ERROR = `Enter the ${EMAIL_OTP_LENGTH}-digit code from your email.`;

const PURPOSES = new Set(["login", "reset", "pwchange"]);

function otpRowKey(purpose, subject) {
  if (!PURPOSES.has(purpose)) throw new Error(`Unknown OTP purpose: ${purpose}`);
  const id = String(subject || "").trim();
  if (!id) throw new Error("An OTP needs an account id.");
  return `${purpose}:${id}`;
}

/** A uniformly random code, leading zeros kept. */
export function generateOtpCode() {
  return String(crypto.randomInt(0, 10 ** EMAIL_OTP_LENGTH)).padStart(EMAIL_OTP_LENGTH, "0");
}

/** Bound to the row key, so the same digits hash differently per flow/account. */
export function hashOtpCode(rowKey, code) {
  return sign(`email-otp:${rowKey}:${code}`);
}

/** Strips spaces; true when what is left is exactly 6 digits. */
export function normalizeOtpInput(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

export function isOtpFormat(code) {
  return new RegExp(`^\\d{${EMAIL_OTP_LENGTH}}$`).test(String(code || ""));
}

/**
 * Generate, store and email a code.
 *
 * @param {{ purpose: "login"|"reset"|"pwchange", subject: string, email: string, name?: string }} input
 *   `subject` is the account's user id.
 * @returns {Promise<
 *   { ok: true } |
 *   { ok: false, status: number, code: string, error: string, retryAfter: number }
 * >}
 */
export async function sendEmailOtp({ purpose, subject, email, name }) {
  const rowKey = otpRowKey(purpose, subject);
  const code = generateOtpCode();
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc("auth_email_otp_issue", {
    p_key: rowKey,
    p_hash: hashOtpCode(rowKey, code),
    p_ttl_seconds: EMAIL_OTP_TTL_SECONDS,
    p_cooldown_seconds: EMAIL_OTP_RESEND_SECONDS,
    p_max_attempts: EMAIL_OTP_MAX_ATTEMPTS,
  });
  if (error) {
    console.error("[email-otp] could not store a code:", error.message);
    return {
      ok: false,
      status: 503,
      code: "otp_store_failed",
      retryAfter: 0,
      error: "Unable to send a verification code right now. Please try again.",
    };
  }

  const wait = Number(data) || 0;
  if (wait > 0) {
    return {
      ok: false,
      status: 429,
      code: "otp_cooldown",
      retryAfter: wait,
      error: `Please wait ${wait} second${wait === 1 ? "" : "s"} before requesting another code.`,
    };
  }

  try {
    const message = buildOtpEmail({ code, purpose, minutes: EMAIL_OTP_TTL_SECONDS / 60, name });
    await sendMail({ to: email, ...message });
  } catch (sendError) {
    // A code nobody received must not hold the resend cooldown.
    await supabase.rpc("auth_email_otp_discard", { p_key: rowKey }).then(() => {}, () => {});
    const notConfigured = sendError instanceof MailNotConfiguredError;
    console.error("[email-otp] send failed:", notConfigured ? sendError.message : sendError?.code || sendError?.message);
    return {
      ok: false,
      status: notConfigured ? 503 : 502,
      code: "email_send_failed",
      retryAfter: 0,
      error: "We couldn't send the code email right now. Please try again in a few minutes or contact the administrator.",
    };
  }

  return { ok: true };
}

/**
 * Check a code. Never throws for a wrong code; throws only when the database
 * cannot be reached (the routes turn that into a 500).
 * @returns {Promise<"ok"|"invalid"|"locked"|"expired">}
 */
export async function verifyEmailOtp({ purpose, subject, code }) {
  const rowKey = otpRowKey(purpose, subject);
  const typed = normalizeOtpInput(code);
  if (!isOtpFormat(typed)) return "invalid";

  const { data, error } = await getServiceClient().rpc("auth_email_otp_verify", {
    p_key: rowKey,
    p_hash: hashOtpCode(rowKey, typed),
    p_max_attempts: EMAIL_OTP_MAX_ATTEMPTS,
  });
  if (error) throw new Error(`Unable to verify the code: ${error.message}`);

  const result = String(data || "");
  return ["ok", "invalid", "locked", "expired"].includes(result) ? result : "invalid";
}
