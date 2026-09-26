/**
 * Super Admin → System Configuration → Security, as the server enforces it.
 *
 * These four fields were saved to system_config (section "security") but
 * nothing read them, so changing them did nothing. They now drive:
 *
 *   session         idle timeout, minutes: a signed-in browser with no
 *                   activity for this long is signed out (src/proxy.js renews
 *                   the cookie on activity; background polls do not count).
 *                   Never longer than the 8-hour limit since sign-in.
 *   login_attempts  wrong passwords allowed per account before a 15-minute
 *                   lockout (src/lib/auth/login-throttle.js).
 *   pw_min          minimum length of a password a person chooses
 *                   (src/lib/auth/password-policy.js).
 *   pw_expiry       days before a password must be replaced (0 = never); an
 *                   older one sends the account to the change-password screen
 *                   at sign-in, like an issued default password.
 *
 * A missing, unreadable or out-of-range value falls back to the behaviour the
 * app had before these were enforced, so a bad setting can never lock
 * everyone out. The ranges are the ones the Super Admin form allows.
 */

import { createClient } from "@supabase/supabase-js";

export const SECURITY_SECTION = "security";

/** Before these settings were enforced: 8 h sessions, 5 attempts, 8 characters, no expiry. */
export const DEFAULT_SECURITY_SETTINGS = Object.freeze({
  session: 480,
  login_attempts: 5,
  pw_min: 8,
  pw_expiry: 0,
});

const RANGES = Object.freeze({
  session: [5, 480],
  login_attempts: [3, 20],
  pw_min: [6, 32],
  pw_expiry: [0, 365],
});

const CACHE_TTL_MS = 60_000;
let cached = null; // { settings, at }
let client = null;

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!client) client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

/** Clean one { key: value } map of raw system_config strings. */
export function normalizeSecuritySettings(raw = {}) {
  const settings = { ...DEFAULT_SECURITY_SETTINGS };
  Object.entries(RANGES).forEach(([key, [min, max]]) => {
    const value = raw?.[key];
    if (value === undefined || value === null || String(value).trim() === "") return;
    const n = Number(value);
    if (Number.isInteger(n) && n >= min && n <= max) settings[key] = n;
  });
  return settings;
}

/**
 * The current settings, cached for a minute. Never throws.
 * @param {object} [supabase] a service-role client; one is created when omitted.
 */
export async function loadSecuritySettings(supabase) {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.settings;

  const db = supabase || getAdminClient();
  if (!db) return { ...DEFAULT_SECURITY_SETTINGS };

  try {
    const result = await db
      .from("system_config")
      .select("key,value")
      .eq("section", SECURITY_SECTION);
    if (result.error) throw result.error;
    const raw = Object.fromEntries((result.data || []).map((row) => [row.key, row.value]));
    const settings = normalizeSecuritySettings(raw);
    cached = { settings, at: Date.now() };
    return settings;
  } catch {
    return { ...DEFAULT_SECURITY_SETTINGS };
  }
}

/** Forget the cached settings (after the Super Admin saves them). */
export function invalidateSecuritySettings() {
  cached = null;
}

/**
 * True when the account's password is older than `expiryDays` (0 = never).
 * The age runs from the last change (app_metadata.password_changed_at, set by
 * every change and reset), or from account creation when it was never changed.
 */
export function isPasswordExpired(user, expiryDays, now = Date.now()) {
  const days = Number(expiryDays) || 0;
  if (days <= 0) return false;
  const since = Date.parse(user?.app_metadata?.password_changed_at || user?.created_at || "");
  if (!Number.isFinite(since)) return false;
  return now - since > days * 24 * 60 * 60 * 1000;
}
