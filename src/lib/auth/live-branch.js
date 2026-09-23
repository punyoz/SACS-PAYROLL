/**
 * The caller's branch, read fresh from profiles on every request.
 *
 * WHY THIS EXISTS
 * The signed sacs-session cookie carries a branch_id stamped at sign-in
 * (src/lib/rbac/session.js) and stays valid for eight hours. Every guarded API
 * route scopes its queries by that value via guard.branchId, and those routes
 * hold the service-role key -- which bypasses RLS entirely, so the database's
 * own current_branch_id() helper (which DOES read profiles live) never runs
 * for them.
 *
 * The result: moving an Admin from one branch to another updated profiles
 * correctly and changed nothing they could see. Their cookie still named the
 * old branch, so they kept reading the old branch's employees, attendance and
 * payroll until the cookie expired or they signed in again.
 *
 * This module closes that gap by making profiles authoritative for branch on
 * the service-role path too -- the same correction
 * supabase/migrations/20260923045144_role_helper_reads_profiles.sql made for
 * role inside RLS. A reassignment now takes effect on the caller's next
 * request, with no sign-out.
 *
 * CACHING
 * The guard runs on every API call, and one page load fires a burst of them,
 * so the lookup is cached per account for a few seconds -- the same shape and
 * the same reasoning as src/lib/auth/active-session.js. A reassignment is
 * therefore picked up within CACHE_TTL_MS rather than instantly, which is the
 * intended trade: seconds, not a re-login.
 */

import { createClient } from "@supabase/supabase-js";

const CACHE_TTL_MS = 5_000;
const cache = new Map(); // user id -> { branchId, at }

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

/** Test seam, and the hook a write path uses after changing someone's branch. */
export function invalidateBranchCache(userId) {
  if (userId) cache.delete(String(userId));
  else cache.clear();
}

/**
 * The branch this account belongs to right now.
 *
 * @param {string} userId
 * @param {string|null} fallbackBranchId
 *        the cookie's copy, used only when profiles cannot be reached.
 * @returns {Promise<string|null>}
 *
 * On a lookup failure the fallback is returned rather than null or a throw.
 * Two reasons: null would sign a branch-scoped caller out of their own data
 * during a brief Supabase outage (the guard refuses a scoped role with no
 * branch), and the fallback cannot widen access -- it is the branch this
 * account was already authorised for when it signed in. The worst case is
 * that a reassignment takes effect late, which is the behaviour this module
 * replaces, not a regression past it.
 */
export async function resolveCurrentBranchId(userId, fallbackBranchId = null) {
  const id = String(userId || "");
  if (!id) return fallbackBranchId;

  const cached = cache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.branchId;
  }

  const supabase = getAdminClient();
  if (!supabase) return fallbackBranchId;

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("branch_id")
      .eq("id", id)
      .maybeSingle();

    // A missing row is not a lookup failure: the account genuinely has no
    // profile, so it has no branch. Only an error falls back.
    if (error) return fallbackBranchId;

    const branchId = data?.branch_id ? String(data.branch_id) : null;
    cache.set(id, { branchId, at: Date.now() });
    return branchId;
  } catch {
    return fallbackBranchId;
  }
}
