/**
 * Shared short-lived cache for supabase.auth.admin.listUsers().
 *
 * Employee data (role, employee_id, salary, rfid_uid, ...) lives in each auth
 * user's user_metadata, so nearly every API route needs the full user list.
 * Each listUsers() call is a network round trip that returns every user, and a
 * single dashboard load fans out to several routes that each repeated it —
 * that repetition is what made those pages slow to load.
 *
 * listUsersCached() returns the exact same `{ data: { users }, error }` shape
 * listUsers() does, so call sites keep working unchanged.
 *
 * Failures are never cached, concurrent callers share one in-flight request,
 * and any route that creates/updates/deletes a user calls
 * invalidateUsersCache() so the very next read reflects the change.
 */

const TTL_MS = 10_000;

let cached = null;   // { users, expiresAt }
let inFlight = null; // de-dupes concurrent callers

/** Drop the cache — call after any auth user is created, updated, or deleted. */
export function invalidateUsersCache() {
  cached = null;
  inFlight = null;
}

/** Same contract as supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }). */
export async function listUsersCached(supabase) {
  if (cached && cached.expiresAt > Date.now()) {
    return { data: { users: cached.users }, error: null };
  }

  if (!inFlight) {
    inFlight = supabase.auth.admin
      .listUsers({ page: 1, perPage: 1000 })
      .then((result) => {
        if (!result.error) {
          cached = {
            users: result.data?.users || [],
            expiresAt: Date.now() + TTL_MS,
          };
        }
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}
