/**
 * Pending-login state: password verified, OTP not yet verified.
 *
 * WHY THIS EXISTS
 * Login is now two factors. A correct password alone must never issue the
 * real session cookie (src/lib/rbac/session.js) — that only happens after the
 * emailed one-time code is also verified. Something still has to carry the
 * caller from "password checked" to "OTP checked" across two separate
 * requests, without trusting anything the browser could edit (a bare user id
 * in the request body, a query string, etc. — exactly the mistake
 * session.js's own header comment warns about for localStorage).
 *
 * This is that carrier: a second, short-lived, signed HttpOnly cookie, using
 * the exact same HMAC-SHA256 scheme as the real session (sign/safeEqual/
 * base64Url* are imported from session.js, not reimplemented) but with its
 * own cookie name, its own lifetime, and a `purpose` field the verifier
 * checks — so this token can never be mistaken for, or swapped in for, a real
 * session token even if something tried to read one cookie as the other.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY
 * Only `sub` (user id) and `email` (needed to call supabase.auth.verifyOtp)
 * plus the precomputed `must_change_password` boolean. Role, branch_id, and
 * the extended profile fields (bank details, government IDs, ...) are re-read
 * fresh from `profiles` at the moment OTP verification succeeds
 * (src/app/api/legacy-auth/verify-login-otp/route.js), rather than carried
 * through this cookie for up to 10 minutes. must_change_password is the one
 * exception: it can only be computed from the plaintext password (see
 * src/lib/auth/password-policy.js's mustChangePassword), which this module
 * never stores — so it is computed once, at password-check time, and only
 * the resulting boolean (not a secret) rides along.
 */

import {
  sign,
  safeEqual,
  base64UrlEncode,
  base64UrlDecode,
} from "@/lib/rbac/session";

export const PENDING_LOGIN_COOKIE = "sacs-pending-login";
export const PENDING_LOGIN_PURPOSE = "login_otp";

/** 10 minutes — matches the OTP expiry this flow is documented to use. */
export const PENDING_LOGIN_MAX_AGE_SECONDS = 10 * 60;

/**
 * @param {{ user_id: string, email: string, must_change_password?: boolean }} claims
 */
export function createPendingLoginToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(claims.user_id || ""),
    email: String(claims.email || "").trim().toLowerCase(),
    pwd: Boolean(claims.must_change_password),
    purpose: PENDING_LOGIN_PURPOSE,
    iat: now,
    exp: now + PENDING_LOGIN_MAX_AGE_SECONDS,
  };

  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  return `${payloadPart}.${sign(payloadPart)}`;
}

/**
 * Verify a token and return its claims, or null when missing, tampered with,
 * malformed, expired, or not actually a pending-login token.
 */
export function verifyPendingLoginToken(token) {
  const raw = String(token || "");
  if (!raw) return null;

  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;

  const payloadPart = raw.slice(0, dot);
  const signaturePart = raw.slice(dot + 1);

  let expected;
  try {
    expected = sign(payloadPart);
  } catch {
    return null;
  }
  if (!safeEqual(signaturePart, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadPart));
  } catch {
    return null;
  }

  if (!payload?.sub || !payload?.email) return null;
  if (payload.purpose !== PENDING_LOGIN_PURPOSE) return null; // token-confusion guard
  if (Number(payload.exp || 0) <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}

function cookieOptions(maxAge = PENDING_LOGIN_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

/** Attach a fresh pending-login cookie to a NextResponse. */
export function attachPendingLogin(response, claims) {
  response.cookies.set(PENDING_LOGIN_COOKIE, createPendingLoginToken(claims), cookieOptions());
  return response;
}

/** Expire the pending-login cookie on a NextResponse. */
export function clearPendingLogin(response) {
  response.cookies.set(PENDING_LOGIN_COOKIE, "", cookieOptions(0));
  return response;
}

/** Read the verified pending-login claims off an incoming Request, or null. */
export function readPendingLogin(request) {
  let raw = "";

  if (request?.cookies?.get) {
    raw = request.cookies.get(PENDING_LOGIN_COOKIE)?.value || "";
  }

  if (!raw) {
    const header = request?.headers?.get?.("cookie") || "";
    const match = header
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${PENDING_LOGIN_COOKIE}=`));
    if (match) raw = decodeURIComponent(match.slice(PENDING_LOGIN_COOKIE.length + 1));
  }

  return verifyPendingLoginToken(raw);
}
