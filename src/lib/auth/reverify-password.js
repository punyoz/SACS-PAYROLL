/**
 * Re-check the signed-in user's own password before a sensitive action (the
 * Super Admin's full data backup, 2026-11-08), without creating or changing
 * any session -- the same check as the RFID Terminal unlock
 * (src/app/api/admin/attendance/verify-password/route.js): a throwaway
 * client signs in with the password and signs straight out again.
 *
 * The account checked is always the one in the signed session cookie; the
 * caller passes only the typed password, never an email. The password is
 * never logged or stored.
 *
 * Wrong passwords lock the check for LOCKOUT_MS after MAX_ATTEMPTS
 * (process-local, best effort; Supabase Auth's own throttling applies too).
 */

import { createClient } from "@supabase/supabase-js";

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const attempts = new Map(); // `${purpose}:${userId}` -> { count, lockedUntil }

export function passwordLockout(userId, purpose = "default") {
  const key = `${purpose}:${userId}`;
  const entry = attempts.get(key);
  if (!entry) return { locked: false };
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return { locked: true, retryAfterMs: entry.lockedUntil - Date.now() };
  if (entry.lockedUntil) attempts.delete(key);
  return { locked: false };
}

/**
 * @returns {Promise<{ valid: boolean, locked?: boolean, retryAfterMs?: number, error?: string }>}
 */
export async function reverifyPassword(guard, password, purpose = "default") {
  const userId = String(guard?.userId || "");
  const email = String(guard?.session?.email || "").trim().toLowerCase();
  const key = `${purpose}:${userId}`;
  const lockout = passwordLockout(userId, purpose);
  if (lockout.locked) return { valid: false, locked: true, retryAfterMs: lockout.retryAfterMs };
  if (!email || !userId) return { valid: false, error: "Unable to identify your account. Please sign in again." };
  const typed = String(password ?? "");
  if (!typed.trim()) return { valid: false, error: "Enter your password." };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Missing Supabase environment variables.");
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: typed });
  if (!error && data?.user) await client.auth.signOut().catch(() => {});

  const valid = !error && data?.user?.id === userId;
  if (valid) {
    attempts.delete(key);
  } else {
    const entry = attempts.get(key) || { count: 0, lockedUntil: null };
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = Date.now() + LOCKOUT_MS;
    attempts.set(key, entry);
  }
  return { valid };
}
