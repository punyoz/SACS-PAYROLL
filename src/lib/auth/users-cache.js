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
 *
 * TRUSTED FIELDS. A signed-in user can rewrite their OWN user_metadata through
 * Supabase Auth (auth.updateUser), so it cannot be trusted for anything that
 * decides access or money. Before a user list leaves this module, the fields
 * below are replaced with the copy in public.profiles, which only the server
 * can write (20260926070000_revoke_client_table_writes.sql):
 *
 *   role, archived, branch_id, employee_id, basic_salary, rfid_uid
 *
 * Every route keeps reading user.user_metadata.<field> exactly as before and
 * now gets the trusted value. If profiles cannot be read, the whole list
 * fails rather than falling back to the editable copy.
 */

const TRUSTED_PROFILE_COLUMNS = "id,role,archived,branch_id,employee_id,basic_salary,rfid_uid";

/**
 * `user` with its user_metadata's trusted fields taken from its profiles row.
 * Returned unchanged when there is no profile row. A field the row does not
 * carry at all is left as it was.
 *
 * archived is true when EITHER copy says so: an archive whose profile write
 * failed half-way still keeps the account out, and a user flagging only their
 * own metadata can do nothing but lock themselves out.
 */
export function applyTrustedProfile(user, profile) {
  if (!user || !profile) return user;
  const metadata = user.user_metadata || {};
  const trusted = {};

  if (profile.role !== undefined && profile.role !== null && String(profile.role).trim()) {
    trusted.role = String(profile.role);
  }
  if (profile.archived !== undefined && profile.archived !== null) {
    trusted.archived = profile.archived === true || metadata.archived === true;
  }
  if (profile.branch_id !== undefined) trusted.branch_id = profile.branch_id;
  if (profile.employee_id !== undefined) trusted.employee_id = profile.employee_id;
  if (profile.basic_salary !== undefined && profile.basic_salary !== null) {
    const salary = Number(profile.basic_salary);
    if (Number.isFinite(salary)) trusted.basic_salary = salary;
  }
  if (profile.rfid_uid !== undefined) trusted.rfid_uid = profile.rfid_uid;

  return { ...user, user_metadata: { ...metadata, ...trusted } };
}

/**
 * supabase.auth.admin.getUserById() with the trusted fields overlaid, in the
 * same `{ data: { user }, error }` shape. Use it wherever a decision (role,
 * branch, archived, salary, card) is made about a single account; the raw
 * getUserById() hands back the metadata the account holder can edit.
 */
export async function getTrustedUserById(supabase, id) {
  const result = await supabase.auth.admin.getUserById(id);
  if (result.error || !result.data?.user) return result;

  const profile = await supabase
    .from("profiles")
    .select(TRUSTED_PROFILE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (profile.error) return { data: { user: null }, error: profile.error };

  return { ...result, data: { ...result.data, user: applyTrustedProfile(result.data.user, profile.data) } };
}

/** Overlay every user in `users` with its profiles row. */
async function withTrustedProfiles(supabase, users) {
  const result = await supabase.from("profiles").select(TRUSTED_PROFILE_COLUMNS);
  if (result.error) return { users: [], error: result.error };

  const byId = new Map((result.data || []).map((row) => [String(row.id), row]));
  return {
    users: users.map((user) => applyTrustedProfile(user, byId.get(String(user.id)))),
    error: null,
  };
}

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
      .then(async (listed) => {
        if (listed.error) return listed;

        // Trusted fields come from profiles, never from the editable metadata.
        const overlaid = await withTrustedProfiles(supabase, listed.data?.users || []);
        if (overlaid.error) {
          return { data: { users: [] }, error: overlaid.error };
        }
        const result = { ...listed, data: { ...(listed.data || {}), users: overlaid.users } };

        // Only cache when nothing invalidated while this request was in flight;
        // otherwise this result is already stale and must not be stored.
        if (startedAt === generation) {
          cached = {
            users: result.data.users,
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
