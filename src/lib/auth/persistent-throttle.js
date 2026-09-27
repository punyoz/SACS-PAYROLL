/**
 * Attempt counters shared by every server instance.
 *
 * src/lib/auth/login-throttle.js and otp-throttle.js count in process memory.
 * That is instant, but on Vercel each serverless instance has its own memory
 * and a cold start wipes it, so the "5 attempts" budget was really 5 per
 * instance per warm period. These helpers keep the same counters in Postgres
 * (public.auth_throttle, 20260927030000_auth_throttle.sql), so the budget is
 * one budget no matter which instance answers.
 *
 * The routes call these alongside the in-memory counters, not instead of
 * them. Every helper fails open (allowed / no-op) when the database cannot be
 * reached: the in-memory counters still apply then, and signing everyone out
 * of the login screen during a database blip would be worse.
 */

import { getCachedServiceClient as getAdminClient } from "@/lib/supabase/admin";

/** Password sign-in: per account and per client address (login-throttle.js). */
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_LOCKOUT_SECONDS = 15 * 60;
export const LOGIN_IP_MAX_ATTEMPTS = 30;
export const LOGIN_IDENTITY_MAX_ATTEMPTS = 5;

/** Emailed codes: wrong guesses per code sent (otp-throttle.js). */
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_WINDOW_SECONDS = 15 * 60;
export const OTP_LOCKOUT_SECONDS = 15 * 60;

const normalizeKey = (value) => String(value || "").trim().toLowerCase();

export const loginIdentityKey = (identity) => `login:id:${normalizeKey(identity)}`;
export const loginAddressKey = (address) => `login:ip:${normalizeKey(address) || "unknown"}`;
export const otpKey = (key) => `otp:${normalizeKey(key)}`;

/**
 * Seconds until `key` may try again (0 = allowed now).
 * @returns {Promise<number>}
 */
export async function persistentRetryAfter(key, maxAttempts, lockoutSeconds) {
  const supabase = getAdminClient();
  if (!supabase) return 0;
  try {
    const { data, error } = await supabase.rpc("auth_throttle_check", {
      p_key: key,
      p_max: maxAttempts,
      p_lockout_seconds: lockoutSeconds,
    });
    if (error) return 0;
    const seconds = Number(data);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
  } catch {
    return 0;
  }
}

/** Count one failed attempt against each key. */
export async function persistentFailure(keys, windowSeconds) {
  const supabase = getAdminClient();
  if (!supabase) return;
  await Promise.all((Array.isArray(keys) ? keys : [keys]).map(async (key) => {
    try {
      await supabase.rpc("auth_throttle_fail", { p_key: key, p_window_seconds: windowSeconds });
    } catch {
      // fail open; the in-memory counter still counted it
    }
  }));
}

/** Forget a key (a genuine sign-in, a verified code, a freshly sent code). */
export async function persistentClear(key) {
  const supabase = getAdminClient();
  if (!supabase) return;
  try {
    await supabase.rpc("auth_throttle_clear", { p_key: key });
  } catch {
    // fail open
  }
}

/**
 * Password sign-in gate for one account + client address.
 * @returns {Promise<number>} seconds to wait, 0 when allowed
 */
export async function loginRetryAfter(identity, address, identityMaxAttempts = LOGIN_IDENTITY_MAX_ATTEMPTS) {
  const max = Number.isInteger(identityMaxAttempts) && identityMaxAttempts > 0
    ? identityMaxAttempts
    : LOGIN_IDENTITY_MAX_ATTEMPTS;
  const [byIdentity, byAddress] = await Promise.all([
    persistentRetryAfter(loginIdentityKey(identity), max, LOGIN_LOCKOUT_SECONDS),
    persistentRetryAfter(loginAddressKey(address), LOGIN_IP_MAX_ATTEMPTS, LOGIN_LOCKOUT_SECONDS),
  ]);
  return Math.max(byIdentity, byAddress);
}

export function recordLoginFailure(identity, address) {
  return persistentFailure([loginIdentityKey(identity), loginAddressKey(address)], LOGIN_WINDOW_SECONDS);
}

export function recordLoginSuccess(identity) {
  return persistentClear(loginIdentityKey(identity));
}

/** Emailed-code gate. `key` is the same key the in-memory counter uses. */
export async function otpAllowed(key) {
  return (await persistentRetryAfter(otpKey(key), OTP_MAX_ATTEMPTS, OTP_LOCKOUT_SECONDS)) === 0;
}

/** Count a wrong code; resolves to whether another guess is still allowed. */
export async function otpFailure(key) {
  await persistentFailure(otpKey(key), OTP_WINDOW_SECONDS);
  return otpAllowed(key);
}

export function otpReset(key) {
  return persistentClear(otpKey(key));
}
