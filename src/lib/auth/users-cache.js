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

/**
 * Bumped by every invalidation. A listUsers() call records the generation it
 * started in and refuses to populate the cache if that number has moved on
 * while it was in flight.
 *
 * Without it, clearing `cached`/`inFlight` did not stop an already-running
 * request from resolving afterwards and writing its pre-mutation result back
 * into the cache — so creating a user could leave that user missing from every
 * read for the next full TTL, which is exactly what invalidation exists to
 * prevent.
 */
let generation = 0;

/** Drop the cache — call after any auth user is created, updated, or deleted. */
export function invalidateUsersCache() {
  cached = null;
  inFlight = null;
  generation += 1;
}

/** Same contract as supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }). */
export async function listUsersCached(supabase) {
  if (cached && cached.expiresAt > Date.now()) {
    return { data: { users: cached.users }, error: null };
  }

  if (!inFlight) {
    const startedAt = generation;

    const request = supabase.auth.admin
      .listUsers({ page: 1, perPage: 1000 })
      .then((result) => {
        // Only cache when nothing invalidated while this request was in flight;
        // otherwise this result is already stale and must not be stored.
        if (!result.error && startedAt === generation) {
          cached = {
            users: result.data?.users || [],
            expiresAt: Date.now() + TTL_MS,
          };
        }
        return result;
      })
      .finally(() => {
        // Clear only if this is still the current request. An invalidation may
        // have already nulled it and a newer request taken its place, which
        // this one must not wipe out.
        if (inFlight === request) inFlight = null;
      });

    inFlight = request;
  }

  return inFlight;
}
