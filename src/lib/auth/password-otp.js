/**
 * Password reset (logged out) and password change (logged in) by email OTP.
 *
 * Built on the sign-in OTP system rather than beside it:
 *   - the code      Supabase Auth's email OTP, the one sign-in uses
 *                   (signInWithOtp to send, verifyOtp to check). Supabase
 *                   generates it, stores only its hash, expires it and
 *                   consumes it on first successful use; the custom SMTP
 *                   (Brevo) delivers it.
 *   - the throttle  src/lib/auth/otp-throttle.js: at most 5 wrong codes per
 *                   code sent, then the flow locks until a new OTP is
 *                   requested; 60 s between sends.
 *   - the carrier   a short-lived signed HttpOnly cookie, the same HMAC
 *                   scheme as src/lib/auth/pending-login.js and the session.
 *
 * TWO STAGES, ONE COOKIE PER FLOW
 *   "otp"       a code was sent. Lives exactly PASSWORD_OTP_TTL_SECONDS
 *               (5 minutes) from the send, so an older code is refused here
 *               even if the Supabase expiry were set longer.
 *   "verified"  the code checked out. Carries the account id and its
 *               password_changed_at marker, and lives
 *               PASSWORD_GRANT_TTL_SECONDS. Changing the password moves the
 *               marker, so a grant can set a password once and never again.
 * Only the "verified" stage lets a new password be set.
 *
 * WHAT THE RESET COOKIE DOES NOT CARRY
 * The email address, or whether the account exists. It carries only what the
 * user typed (Employee ID or email), re-resolved on every request, so the
 * browser learns nothing about an account before proving it can read that
 * account's inbox.
 */

import { sign, safeEqual, base64UrlEncode, base64UrlDecode } from "@/lib/rbac/session";
import { normalizeText } from "@/lib/auth/normalize";
import { requiresLoginOtp } from "@/lib/auth/otp-policy";

export const PASSWORD_OTP_TTL_SECONDS = 5 * 60;
export const PASSWORD_GRANT_TTL_SECONDS = 10 * 60;
export const PASSWORD_OTP_RESEND_SECONDS = 60;
export const PASSWORD_OTP_RESEND_MS = PASSWORD_OTP_RESEND_SECONDS * 1000;

const FLOWS = {
  reset: { cookie: "sacs-pw-reset", purpose: "password_reset_otp" },
  change: { cookie: "sacs-pw-change", purpose: "password_change_otp" },
};

function flowConfig(flow) {
  const config = FLOWS[flow];
  if (!config) throw new Error(`Unknown password OTP flow: ${flow}`);
  return config;
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

/**
 * Set the flow's cookie.
 * @param {"reset"|"change"} flow
 * @param {{ stage: "otp"|"verified", sub?: string, idn?: string, pca?: string }} claims
 */
export function attachPasswordOtpState(response, flow, claims) {
  const { cookie, purpose } = flowConfig(flow);
  const now = Math.floor(Date.now() / 1000);
  const ttl = claims.stage === "verified" ? PASSWORD_GRANT_TTL_SECONDS : PASSWORD_OTP_TTL_SECONDS;
  const payload = {
    purpose,
    stage: claims.stage,
    sub: String(claims.sub || ""),
    idn: String(claims.idn || ""),
    pca: String(claims.pca || ""),
    iat: now,
    exp: now + ttl,
  };
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  response.cookies.set(cookie, `${payloadPart}.${sign(payloadPart)}`, cookieOptions(ttl));
  return response;
}

export function clearPasswordOtpState(response, flow) {
  response.cookies.set(flowConfig(flow).cookie, "", cookieOptions(0));
  return response;
}

/** The flow's verified claims, or null when missing, tampered with or expired. */
export function readPasswordOtpState(request, flow) {
  const { cookie, purpose } = flowConfig(flow);
  let raw = request?.cookies?.get?.(cookie)?.value || "";
  if (!raw) {
    const header = request?.headers?.get?.("cookie") || "";
    const match = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookie}=`));
    if (match) raw = decodeURIComponent(match.slice(cookie.length + 1));
  }

  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadPart = raw.slice(0, dot);

  let expected;
  try {
    expected = sign(payloadPart);
  } catch {
    return null;
  }
  if (!safeEqual(raw.slice(dot + 1), expected)) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadPart));
  } catch {
    return null;
  }
  if (payload?.purpose !== purpose) return null;
  if (payload.stage !== "otp" && payload.stage !== "verified") return null;
  if (Number(payload.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** Changes whenever the password does; binds a "verified" grant to one use. */
export function passwordChangedMarker(user) {
  return String(user?.app_metadata?.password_changed_at || user?.created_at || "");
}

/** Throttle key for a reset, by what the user typed. */
export function resetThrottleKey(identity) {
  return `reset:${normalizeText(identity).toLowerCase()}`;
}

/**
 * Employee ID or email -> auth user, matching the way reset has always
 * matched: user_metadata.employee_id, the full email, or the email without
 * the legacy "sacs." prefix.
 */
export function findUserByIdentity(users, identity) {
  const lower = normalizeText(identity).toLowerCase();
  if (!lower) return null;
  return (users || []).find((u) => {
    const empId = normalizeText(u.user_metadata?.employee_id).toLowerCase();
    const email = normalizeText(u.email).toLowerCase();
    return empId === lower || email === lower || email.replace(/^sacs\./, "") === lower;
  }) || null;
}

/** Only active Employee / Accountant accounts may reset on the login page. */
export function canResetPassword(user) {
  if (!user?.email) return false;
  if (user.user_metadata?.archived === true) return false;
  return requiresLoginOtp(normalizeText(user.user_metadata?.role));
}

/** "tessa@school.edu" -> "t***@school.edu". */
export function maskEmail(email) {
  const value = normalizeText(email);
  const at = value.indexOf("@");
  return at > 0 ? `${value[0]}***${value.slice(at)}` : value;
}
