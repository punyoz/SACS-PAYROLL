/**
 * One active sign-in per account.
 *
 * Every successful login mints a new session id, stores it in the account's
 * app_metadata (server-controlled: no browser can write it) and puts the same
 * id in the signed session cookie. A request whose cookie carries any other id
 * belongs to a sign-in that has since been replaced by a newer one on another
 * device or browser, and src/proxy.js turns it away.
 *
 * Lookups are cached per account for a few seconds so a page load's burst of
 * API calls costs one Supabase round trip, not one per call. Only a MATCH is
 * ever answered from the cache: a cookie that disagrees with the cached id is
 * re-checked against Supabase before it is rejected. The cache cannot be shared
 * with the login route (the proxy runs as a separate bundle), so without that
 * re-check a fresh sign-in could be refused for a few seconds by a cache still
 * holding the previous id. A replaced sign-in is therefore noticed within
 * CACHE_TTL_MS, and a new one is never turned away.
 */

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const CACHE_TTL_MS = 5_000;
const cache = new Map(); // user id -> { sessionId, archived, at }

let client = null;

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!client) {
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

export function newSessionId() {
  return crypto.randomUUID();
}

/**
 * Make `sessionId` the account's only valid sign-in. Throws when it cannot be
 * recorded — a login must not issue a cookie that the check below cannot honour.
 */
export async function registerActiveSession(userId, sessionId) {
  const supabase = getAdminClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { session_id: sessionId, session_started_at: new Date().toISOString() },
  });
  if (error) throw new Error(error.message);

  cache.set(userId, { sessionId, archived: false, at: Date.now() });
}

/**
 * @returns {Promise<"current" | "replaced" | "archived" | "unknown">}
 *   "unknown" means the account could not be looked up right now (network
 *   trouble, Supabase not configured). Callers let those requests through:
 *   signing every user out during a brief outage would be worse than a few
 *   seconds without the duplicate-login check.
 */
async function fetchEntry(supabase, userId) {
  try {
    // profiles.archived is read alongside: user_metadata.archived is the copy
    // the account holder can edit, so it alone could be switched back off.
    const [{ data, error }, profileResult] = await Promise.all([
      supabase.auth.admin.getUserById(userId),
      supabase.from("profiles").select("archived").eq("id", userId).maybeSingle(),
    ]);
    if (error || !data?.user) return null;
    const profileArchived = !profileResult?.error && profileResult?.data?.archived === true;
    const entry = {
      sessionId: String(data.user.app_metadata?.session_id || ""),
      archived: data.user.user_metadata?.archived === true || profileArchived,
      at: Date.now(),
    };
    cache.set(userId, entry);
    return entry;
  } catch {
    return null;
  }
}

/** Prefix of a session id that was ended on purpose (revokeActiveSession). */
const REVOKED_PREFIX = "revoked:";

function judge(entry, sessionId) {
  if (entry.archived) return "archived";
  if (!entry.sessionId) return "unknown";
  if (entry.sessionId.startsWith(REVOKED_PREFIX)) return "revoked";
  return entry.sessionId === String(sessionId || "") ? "current" : "replaced";
}

/**
 * End the account's current sign-in, e.g. after an administrator changed its
 * role or branch. The session cookie carries the role and branch it was
 * issued with, so without this a demoted Admin kept Admin access until the
 * cookie expired. The next request from that browser is answered with
 * "session_revoked" (src/proxy.js) and the portal signs out; signing in again
 * picks up the new role and branch.
 *
 * Never throws: the change itself has already been saved, and a failure here
 * only means the old cookie lives until it expires, as it always did.
 *
 * @returns {Promise<boolean>} whether the sign-in was ended.
 */
export async function revokeActiveSession(userId) {
  const supabase = getAdminClient();
  if (!supabase || !userId) return false;
  try {
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: { session_id: `${REVOKED_PREFIX}${new Date().toISOString()}` },
    });
    cache.delete(userId);
    return !error;
  } catch {
    return false;
  }
}

export async function checkActiveSession(userId, sessionId) {
  const supabase = getAdminClient();
  if (!supabase || !userId) return "unknown";

  const cached = cache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && judge(cached, sessionId) === "current") {
    return "current";
  }

  const fresh = await fetchEntry(supabase, userId);
  if (!fresh) return "unknown";
  return judge(fresh, sessionId);
}
