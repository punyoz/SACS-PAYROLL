/**
 * Login attempt throttling.
 *
 * /api/legacy-auth/login previously accepted unlimited password attempts, so
 * any account — including Super Admin — could be brute-forced at whatever rate
 * the network allowed. This is the missing brake.
 *
 * Two independent counters, because they stop different attacks:
 *
 *   - per identity : many passwords against one account (credential guessing)
 *   - per client IP: many accounts from one source (spraying, enumeration)
 *
 * Either one tripping blocks the attempt. A successful sign-in clears the
 * identity counter so a legitimate user who mistyped twice is not punished
 * afterwards.
 *
 * Deliberately in-memory. This runs per server instance, so on a multi-instance
 * deployment an attacker spread across instances gets proportionally more
 * attempts — it raises the cost sharply without adding a Redis dependency to a
 * single-school deployment. If this ever runs at scale, move the counters into
 * Postgres or a shared cache; the exported surface can stay identical.
 */

/** Attempts allowed per identity before a lockout, and how long it lasts. */
const IDENTITY_MAX_ATTEMPTS = 5;
const IDENTITY_WINDOW_MS = 15 * 60 * 1000;
const IDENTITY_LOCKOUT_MS = 15 * 60 * 1000;

/** Wider net for one source address hammering many accounts. */
const IP_MAX_ATTEMPTS = 30;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_LOCKOUT_MS = 15 * 60 * 1000;

/** Stop the maps growing without bound on a long-running process. */
const MAX_TRACKED_KEYS = 10_000;

const identityBuckets = new Map();
const ipBuckets = new Map();

function sweep(buckets, now) {
  for (const [key, entry] of buckets) {
    if (entry.expiresAt <= now) buckets.delete(key);
  }
  if (buckets.size <= MAX_TRACKED_KEYS) return;
  // Still oversized after expiry: drop the oldest entries first.
  const sorted = [...buckets.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [key] of sorted.slice(0, buckets.size - MAX_TRACKED_KEYS)) {
    buckets.delete(key);
  }
}

function inspect(buckets, key, { maxAttempts, windowMs, lockoutMs }, now) {
  const entry = buckets.get(key);

  if (!entry || entry.expiresAt <= now) {
    return { blocked: false, retryAfterSeconds: 0, entry: null };
  }

  if (entry.lockedUntil && entry.lockedUntil > now) {
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
      entry,
    };
  }

  if (entry.count >= maxAttempts) {
    entry.lockedUntil = now + lockoutMs;
    entry.expiresAt = Math.max(entry.expiresAt, entry.lockedUntil);
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil(lockoutMs / 1000),
      entry,
    };
  }

  return { blocked: false, retryAfterSeconds: 0, entry };
}

/** Best-effort client address. Falls back to a shared bucket when unknown. */
export function clientAddressFrom(request) {
  const headers = request?.headers;
  if (!headers?.get) return "unknown";

  const forwarded = headers.get("x-forwarded-for") || "";
  const first = forwarded.split(",")[0]?.trim();
  return first || headers.get("x-real-ip") || "unknown";
}

/**
 * Ask whether this attempt may proceed. Call before verifying the password.
 *
 * @returns {{ blocked: boolean, retryAfterSeconds: number, scope: "identity"|"ip"|"" }}
 */
export function checkLoginAllowed(identity, address, now = Date.now()) {
  const identityKey = String(identity || "").trim().toLowerCase();
  const ipKey = String(address || "unknown");

  const byIdentity = inspect(
    identityBuckets,
    identityKey,
    { maxAttempts: IDENTITY_MAX_ATTEMPTS, windowMs: IDENTITY_WINDOW_MS, lockoutMs: IDENTITY_LOCKOUT_MS },
    now,
  );
  if (byIdentity.blocked) {
    return { blocked: true, retryAfterSeconds: byIdentity.retryAfterSeconds, scope: "identity" };
  }

  const byIp = inspect(
    ipBuckets,
    ipKey,
    { maxAttempts: IP_MAX_ATTEMPTS, windowMs: IP_WINDOW_MS, lockoutMs: IP_LOCKOUT_MS },
    now,
  );
  if (byIp.blocked) {
    return { blocked: true, retryAfterSeconds: byIp.retryAfterSeconds, scope: "ip" };
  }

  return { blocked: false, retryAfterSeconds: 0, scope: "" };
}

function bump(buckets, key, windowMs, now) {
  const entry = buckets.get(key);
  if (!entry || entry.expiresAt <= now) {
    buckets.set(key, { count: 1, expiresAt: now + windowMs, lockedUntil: 0 });
    return;
  }
  entry.count += 1;
}

/** Record a failed attempt. Call whenever sign-in did not succeed. */
export function recordFailedLogin(identity, address, now = Date.now()) {
  const identityKey = String(identity || "").trim().toLowerCase();
  const ipKey = String(address || "unknown");

  bump(identityBuckets, identityKey, IDENTITY_WINDOW_MS, now);
  bump(ipBuckets, ipKey, IP_WINDOW_MS, now);

  sweep(identityBuckets, now);
  sweep(ipBuckets, now);
}

/**
 * Clear an identity's counter after a genuine sign-in. The IP counter is left
 * alone: one valid account must not reset the budget for an address that is
 * working through a list of others.
 */
export function recordSuccessfulLogin(identity) {
  identityBuckets.delete(String(identity || "").trim().toLowerCase());
}

/** Test seam — drops all counters. */
export function resetLoginThrottle() {
  identityBuckets.clear();
  ipBuckets.clear();
}

export const LOGIN_THROTTLE_LIMITS = Object.freeze({
  IDENTITY_MAX_ATTEMPTS,
  IDENTITY_LOCKOUT_MS,
  IP_MAX_ATTEMPTS,
  IP_LOCKOUT_MS,
});
