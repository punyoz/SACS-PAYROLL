/**
 * Login-OTP throttling: attempts per code, and a resend cooldown.
 *
 * WHY THIS EXISTS
 * supabase.auth.verifyOtp() is itself rate-limited by Supabase (a per-IP
 * throttle on its /auth/v1/verify endpoint), but that is not the same
 * guarantee as "this specific code is invalidated after 5 wrong tries" — it
 * is a general abuse brake, not a per-code attempt counter the app can rely
 * on or surface a specific message from. This is that counter, enforced
 * app-side before ever calling Supabase, mirroring src/lib/auth/login-throttle.js.
 *
 * Two independent jobs, one module because they share a lifecycle (both are
 * reset when a fresh code is requested):
 *
 *   - verify attempts : caps wrong-code guesses against one pending sign-in
 *   - resend cooldown : stops "Resend code" from being hammered
 *
 * Deliberately in-memory and process-local — same trade-off login-throttle.js
 * documents: raises the cost of an attack sharply without a Redis dependency,
 * at the cost of the counters resetting on a redeploy or being per-instance
 * on a multi-instance deployment.
 */

/** Wrong-code attempts allowed against one pending sign-in before it must be
 * abandoned (the user has to sign in again, which requests a fresh code). */
const MAX_VERIFY_ATTEMPTS = 5;

/** Minimum gap between "Resend code" presses, per pending sign-in. */
const RESEND_COOLDOWN_MS = 45 * 1000;

/** Stop the maps growing without bound on a long-running process. */
const MAX_TRACKED_KEYS = 10_000;

const verifyAttempts = new Map(); // key -> { count, lockedOut }
const lastResendAt = new Map(); // key -> timestamp ms

function sweep(map, isStale) {
  for (const [key, value] of map) {
    if (isStale(value)) map.delete(key);
  }
  if (map.size <= MAX_TRACKED_KEYS) return;
  const entries = [...map.entries()];
  for (const [key] of entries.slice(0, map.size - MAX_TRACKED_KEYS)) {
    map.delete(key);
  }
}

function normalizeKey(userId) {
  return String(userId || "").trim();
}

/**
 * Ask whether this pending sign-in may still try a code. Call before
 * verifyOtp(). A locked-out key must sign in again to get a usable state —
 * recordVerifySuccess/resetVerifyAttempts are the only ways to clear it.
 */
export function checkVerifyAllowed(userId) {
  const key = normalizeKey(userId);
  const entry = verifyAttempts.get(key);
  if (!entry) return { allowed: true, attemptsLeft: MAX_VERIFY_ATTEMPTS };
  if (entry.count >= MAX_VERIFY_ATTEMPTS) return { allowed: false, attemptsLeft: 0 };
  return { allowed: true, attemptsLeft: MAX_VERIFY_ATTEMPTS - entry.count };
}

/** Record a wrong code. Returns the same shape as checkVerifyAllowed(). */
export function recordVerifyFailure(userId) {
  const key = normalizeKey(userId);
  const entry = verifyAttempts.get(key) || { count: 0 };
  entry.count += 1;
  verifyAttempts.set(key, entry);
  sweep(verifyAttempts, () => false); // count-based, not time-based; size cap only

  if (entry.count >= MAX_VERIFY_ATTEMPTS) return { allowed: false, attemptsLeft: 0 };
  return { allowed: true, attemptsLeft: MAX_VERIFY_ATTEMPTS - entry.count };
}

/** A correct code was entered: this pending sign-in's attempt budget no
 * longer matters (the pending cookie is about to be replaced by a real
 * session either way), but clear it so nothing lingers. */
export function resetVerifyAttempts(userId) {
  verifyAttempts.delete(normalizeKey(userId));
}

/**
 * Ask whether "Resend code" may fire right now. `cooldownMs` defaults to the
 * sign-in cooldown; the password reset/change flows pass their own 60 s.
 * @returns {{ allowed: boolean, retryAfterSeconds: number }}
 */
export function checkResendAllowed(userId, now = Date.now(), cooldownMs = RESEND_COOLDOWN_MS) {
  const key = normalizeKey(userId);
  const last = lastResendAt.get(key);
  if (!last) return { allowed: true, retryAfterSeconds: 0 };

  const elapsed = now - last;
  if (elapsed >= cooldownMs) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.ceil((cooldownMs - elapsed) / 1000) };
}

/**
 * Record that a code was (re)sent: starts the resend cooldown and resets the
 * verify-attempt counter, since a fresh code makes the old attempt count
 * against nothing.
 */
export function recordCodeSent(userId, now = Date.now()) {
  const key = normalizeKey(userId);
  lastResendAt.set(key, now);
  verifyAttempts.delete(key);
  sweep(lastResendAt, (ts) => now - ts > RESEND_COOLDOWN_MS * 10);
}

/**
 * Key for the change-password OTP's counters, kept apart from the pending
 * sign-in's (which key on the bare user id) so a wrong code in one flow never
 * costs an attempt in the other.
 */
export function passwordChangeThrottleKey(userId) {
  return `pwchange:${String(userId || "").trim()}`;
}

/** Test seam — drops all counters. */
export function resetOtpThrottle() {
  verifyAttempts.clear();
  lastResendAt.clear();
}

export const OTP_THROTTLE_LIMITS = Object.freeze({
  MAX_VERIFY_ATTEMPTS,
  RESEND_COOLDOWN_MS,
});
