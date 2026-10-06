/**
 * The RFID kiosk's own session.
 *
 * The terminal (public/legacy/rfid-terminal.html) used to post taps on the
 * unlocking Admin's ordinary sign-in. That sign-in lasts 8 hours at most and
 * is replaced the moment the same Admin signs in anywhere else, and every tap
 * after that was refused with a red light: a kiosk unlocked at 7:00 stopped
 * recording at 15:00, before anyone tapped out.
 *
 * So unlocking the terminal (POST /api/admin/attendance/verify-password,
 * purpose "unlock") also issues this cookie:
 *
 *   - signed with the same HMAC as the session cookie (src/lib/rbac/session.js);
 *   - HttpOnly, and sent only to /api/admin/attendance (its cookie path);
 *   - honoured only for a tap: POST /api/admin/attendance carrying the
 *     "x-sacs-kiosk: 1" header the terminal sends. The portal's manual entry
 *     box never sends it, so it keeps using the ordinary sign-in;
 *   - valid KIOSK_MAX_AGE_SECONDS from unlock, whatever happens to the
 *     Admin's other sign-ins;
 *   - refused at once when the account is archived or is no longer an Admin /
 *     Super Admin (checked live in profiles, kioskRefusal());
 *   - cleared by Exit Terminal (purpose "exit"), which needs the password.
 *     Signing out of the portal leaves it: the kiosk PC is often the
 *     Admin's own desk, and the terminal has its own lock.
 */

import crypto from "node:crypto";
import { base64UrlDecode, base64UrlEncode, safeEqual, sign } from "@/lib/rbac/session";
import { getCachedServiceClient as getAdminClient } from "@/lib/supabase/admin";

export const KIOSK_COOKIE = "sacs-kiosk";
export const KIOSK_PATH = "/api/admin/attendance";
export const KIOSK_HEADER = "x-sacs-kiosk";
/** A school day and then some: unlocked at 6:00, still recording at 22:00. */
export const KIOSK_MAX_AGE_SECONDS = 16 * 60 * 60;

const KIOSK_ROLES = ["admin", "super_admin"];

export function createKioskToken({ user_id: userId, role, branch_id: branchId, email, full_name: fullName }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    kind: "kiosk",
    kid: crypto.randomUUID(),
    sub: String(userId || ""),
    role: String(role || "").toLowerCase(),
    branch_id: branchId ? String(branchId) : null,
    email: String(email || ""),
    full_name: String(fullName || ""),
    iat: now,
    exp: now + KIOSK_MAX_AGE_SECONDS,
  };
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  return `${payloadPart}.${sign(payloadPart)}`;
}

/** Claims of a genuine, unexpired kiosk token, or null. */
export function verifyKioskToken(token) {
  const raw = String(token || "");
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
  if (payload?.kind !== "kiosk" || !payload.sub || !KIOSK_ROLES.includes(payload.role)) return null;
  if (Number(payload.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function kioskCookieOptions(maxAge = KIOSK_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: KIOSK_PATH,
    maxAge,
  };
}

/** Issue the kiosk cookie for a verified session (see the header). */
export function attachKioskSession(response, session) {
  response.cookies.set(KIOSK_COOKIE, createKioskToken({
    user_id: session.sub,
    role: session.role,
    branch_id: session.branch_id,
    email: session.email,
    full_name: session.full_name,
  }), kioskCookieOptions());
  return response;
}

export function clearKioskSession(response) {
  response.cookies.set(KIOSK_COOKIE, "", kioskCookieOptions(0));
  return response;
}

/** True for the one request a kiosk session may make: a tap from the terminal. */
export function isKioskTapRequest(request) {
  const pathname = request?.nextUrl?.pathname || (() => {
    try { return new URL(request.url).pathname; } catch { return ""; }
  })();
  return pathname === KIOSK_PATH
    && String(request?.method || "").toUpperCase() === "POST"
    && request?.headers?.get?.(KIOSK_HEADER) === "1";
}

/** The kiosk claims on a tap request, or null (no / bad cookie, or not a tap). */
export function readKioskSession(request) {
  if (!isKioskTapRequest(request)) return null;
  let raw = request?.cookies?.get?.(KIOSK_COOKIE)?.value || "";
  if (!raw) {
    const header = request?.headers?.get?.("cookie") || "";
    const match = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${KIOSK_COOKIE}=`));
    if (match) raw = decodeURIComponent(match.slice(KIOSK_COOKIE.length + 1));
  }
  return verifyKioskToken(raw);
}

const CACHE_TTL_MS = 5_000;
const cache = new Map(); // user id -> { role, archived, at }

/**
 * Why a kiosk session must be refused now, or null when it may tap.
 * Read live from profiles: archiving the account, or changing its role away
 * from Admin / Super Admin, stops the kiosk within a few seconds. A database
 * that cannot be reached lets the tap through, as the ordinary session check
 * does (src/lib/auth/active-session.js).
 */
export async function kioskRefusal(kiosk) {
  const cached = cache.get(kiosk.sub);
  let entry = cached && Date.now() - cached.at < CACHE_TTL_MS ? cached : null;
  if (!entry) {
    const supabase = getAdminClient();
    if (!supabase) return null;
    try {
      const result = await supabase.from("profiles").select("role,archived").eq("id", kiosk.sub).maybeSingle();
      if (result.error) return null;
      entry = { role: String(result.data?.role || "").toLowerCase(), archived: !result.data || result.data.archived === true, at: Date.now() };
      cache.set(kiosk.sub, entry);
    } catch {
      return null;
    }
  }
  if (entry.archived) return "account_archived";
  if (!KIOSK_ROLES.includes(entry.role) || entry.role !== kiosk.role) return "kiosk_revoked";
  return null;
}
