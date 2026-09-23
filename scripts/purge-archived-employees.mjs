/**
 * Reconciles the soft-delete state of archived employee accounts.
 *
 * ORIGINAL BEHAVIOUR (removed)
 * This script used to hard-delete the profiles row and the auth.users row of
 * every employee account marked archived, freeing the account entirely. That
 * is no longer possible: supabase/migrations/20260903010000_rbac_branch_scoping.sql
 * added a block_hard_delete trigger on profiles that raises on every DELETE,
 * including one arriving through the profiles_id_fkey ON DELETE CASCADE from
 * auth.users — so deleting the auth user would itself fail, cascading into the
 * same blocked delete on profiles. The trigger exists so payroll and
 * attendance history never loses the employee row its foreign keys point at.
 *
 * WHAT THIS DOES NOW
 * The soft-delete flag this script cleans up already exists on the schema —
 * profiles.archived (boolean, default false) — and the normal archive path
 * (the DELETE handler in src/app/api/admin/employees/route.js) already writes
 * it at the moment an employee is archived. This script is the reconciliation
 * pass for accounts that fell out of step with that: an employee whose
 * auth.users.user_metadata.archived is true but whose profiles row was never
 * updated to match, most likely because it predates that DELETE handler or
 * because profiles.archived (see 20260913010000_backfill_missing_profiles.sql) did
 * not exist yet when the account was archived.
 *
 * user_metadata.archived is treated as authoritative here, the same way
 * src/app/api/legacy-auth/login/route.js already treats it as authoritative
 * when refusing an archived account's sign-in — this script brings profiles
 * into agreement with it, never the other way around.
 *
 * Idempotent: an account whose profiles row already reads archived=true and
 * employee_status='Inactive' is left untouched (no row is written and no
 * updated_at is bumped), so re-running this against an already-consistent
 * database is a no-op.
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!projectUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(projectUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function listAllUsers() {
  const users = [];
  let page = 1;
  const perPage = 1000;

  while (true) {
    const result = await supabase.auth.admin.listUsers({ page, perPage });
    if (result.error) {
      throw new Error(`Failed to list users: ${result.error.message}`);
    }

    const pageUsers = result.data.users || [];
    users.push(...pageUsers);

    if (pageUsers.length < perPage) {
      break;
    }

    page += 1;
  }

  return users;
}

/** The soft-delete shape the archive path writes. Kept in one place so both
 * the "does this row already match" check and the update payload agree. */
const ARCHIVED_PROFILE_FIELDS = { archived: true, employee_status: "Inactive" };

function isAlreadyArchived(profileRow) {
  if (!profileRow) return false; // no profile row yet: nothing to skip
  return ARCHIVED_PROFILE_FIELDS.archived === profileRow.archived
    && ARCHIVED_PROFILE_FIELDS.employee_status === profileRow.employee_status;
}

async function main() {
  console.log("Finding archived employee accounts...");

  const users = await listAllUsers();
  const archivedEmployees = users.filter((user) => {
    const metadata = user.user_metadata || {};
    const role = String(metadata.role || "").toLowerCase();
    return role === "employee" && metadata.archived === true;
  });

  if (!archivedEmployees.length) {
    console.log("No archived employee accounts found.");
    return;
  }

  const archivedIds = archivedEmployees.map((user) => user.id);
  console.log(`Archived employee accounts found: ${archivedIds.length}`);

  const profilesResult = await supabase
    .from("profiles")
    .select("id, archived, employee_status")
    .in("id", archivedIds);
  if (profilesResult.error) {
    throw new Error(`Failed to read profile records: ${profilesResult.error.message}`);
  }

  const profileById = new Map((profilesResult.data || []).map((row) => [row.id, row]));
  const idsNeedingSync = archivedIds.filter((id) => !isAlreadyArchived(profileById.get(id)));

  if (!idsNeedingSync.length) {
    console.log("All archived employee profiles already reflect archived = true. Nothing to do.");
    return;
  }

  // One batched UPDATE, not a DELETE: this is the soft-delete equivalent of
  // what the old hard-delete used to do, and it is what block_hard_delete's
  // own error message asks callers to do instead ("Archive the record
  // instead (set archived = true / status inactive)").
  const syncResult = await supabase
    .from("profiles")
    .update({ ...ARCHIVED_PROFILE_FIELDS, updated_at: new Date().toISOString() })
    .in("id", idsNeedingSync);
  if (syncResult.error) {
    throw new Error(`Failed to sync archived profile records: ${syncResult.error.message}`);
  }

  const alreadyInSync = archivedIds.length - idsNeedingSync.length;
  console.log(`Profiles already in sync: ${alreadyInSync}`);
  console.log(`Profiles synced to archived: ${idsNeedingSync.length}`);
  console.log("Archived employee reconciliation complete. No rows were deleted.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
