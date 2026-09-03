/**
 * Server-side session for RBAC.
 *
 * WHY THIS EXISTS
 * The portals identify the signed-in user from `sacs-auth-context` in
 * localStorage (see public/legacy/js/app.js). That is fine for rendering a
 * name in the topbar, but it is user-editable, so it can never be the basis
 * for an authorization decision — anyone could set role:"super_admin" and
 * call an API route directly.
 *
 * This module issues a parallel, tamper-evident session: an HttpOnly cookie
 * holding {user id, role, branch_id}, signed with HMAC-SHA256 and verified in
 * constant time. The login route sets it; src/lib/rbac/guard.js reads it. The
 * localStorage context stays exactly as it is for display purposes.
 *
 * The signing key is SESSION_SECRET when set, otherwise SUPABASE_SERVICE_ROLE_KEY
 * (already required by every API route, and never exposed to the browser).
 */

import crypto from "node:crypto";

export const SESSION_COOKIE = "sacs-session";

/** 8 hours — a payroll shift plus overtime, re-issued on each login. */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

function signingKey() {
  const key = process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("Missing SESSION_SECRET or SUPABASE_SERVICE_ROLE_KEY for session signing.");
  }
  return key;
}

function base64UrlEncode(input) {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input) {
  return Buffer.from(String(input), "base64url").toString("utf8");
}

function sign(payloadPart) {
  return crypto.createHmac("sha256", signingKey()).update(payloadPart).digest("base64url");
}

/** Timing-safe compare that tolerates unequal lengths. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Build a signed session token.
 * @param {{ user_id: string, role: string, branch_id?: string|null,
 *           email?: string, full_name?: string }} claims
 */
export function createSessionToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(claims.user_id || ""),
    role: String(claims.role || "").toLowerCase(),
    branch_id: claims.branch_id ? String(claims.branch_id) : null,
    email: String(claims.email || ""),
    full_name: String(claims.full_name || ""),
    iat: now,
    exp: now + SESSION_MAX_AGE_SECONDS,
  };

  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  return `${payloadPart}.${sign(payloadPart)}`;
}

/**
 * Verify a token and return its claims, or null when it is missing, tampered
 * with, malformed, or expired.
 */
export function verifySessionToken(token) {
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

  if (!payload?.sub || !payload?.role) return null;
  if (Number(payload.exp || 0) <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}

/** Cookie attributes used for both setting and clearing the session. */
export function sessionCookieOptions(maxAge = SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

/** Attach a fresh session cookie to a NextResponse. */
export function attachSession(response, claims) {
  response.cookies.set(SESSION_COOKIE, createSessionToken(claims), sessionCookieOptions());
  return response;
}

/** Expire the session cookie on a NextResponse. */
export function clearSession(response) {
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return response;
}

/**
 * Read the verified session off an incoming Request, or null.
 * Works with both the Next.js Request (cookies.get) and a plain fetch Request
 * (Cookie header), so route handlers and tests can share one code path.
 */
export function readSession(request) {
  let raw = "";

  if (request?.cookies?.get) {
    raw = request.cookies.get(SESSION_COOKIE)?.value || "";
  }

  if (!raw) {
    const header = request?.headers?.get?.("cookie") || "";
    const match = header
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    if (match) raw = decodeURIComponent(match.slice(SESSION_COOKIE.length + 1));
  }

  return verifySessionToken(raw);
}
