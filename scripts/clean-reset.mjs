import dotenv from "dotenv";
import readline from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";
import { confirmationPhrase, isConfirmed, resetRefusal } from "./clean-reset-guard.mjs";

dotenv.config({ path: ".env.local" });

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!projectUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

// Never the live project, and never without a person typing the target
// (scripts/clean-reset-guard.mjs).
const refusal = resetRefusal(projectUrl, process.env);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("clean-reset needs typed confirmation: run it in an interactive terminal.");
  process.exit(1);
}
{
  const phrase = confirmationPhrase(projectUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `This permanently deletes payroll, attendance, leave, transfer and audit rows and every non-seed account on ${projectUrl}.\nType "${phrase}" to continue: `,
  );
  rl.close();
  if (!isConfirmed(answer, projectUrl)) {
    console.error("Not confirmed. Nothing was changed.");
    process.exit(1);
  }
}

const supabase = createClient(projectUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Must list every account scripts/seed-auth-users.mjs creates. Anything absent
// here is treated as "extra" and hard-deleted: its profiles row is removed in
// cleanProfiles() and its auth user in deleteNonSeedAuthUsers().
//
// Super Admin and HR were missing, so a reset destroyed the highest-privilege
// account in the system along with HR — locking the operator out of the roles
// they would need to put it back. Keep this list in step with the seeder.
const SEED_EMAILS = [
  (process.env.SEED_SUPER_ADMIN_EMAIL || "superadmin@example.com").toLowerCase(),
  (process.env.SEED_ADMIN_EMAIL || "admin@example.com").toLowerCase(),
  (process.env.SEED_HR_EMAIL || "hr@example.com").toLowerCase(),
  (process.env.SEED_ACCOUNTANT_EMAIL || "accountant@example.com").toLowerCase(),
  (process.env.SEED_EMPLOYEE_EMAIL || "employee@example.com").toLowerCase(),
];

async function clearTable(table) {
  const { error, count } = await supabase.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (error) throw new Error(`Failed to clear ${table}: ${error.message}`);
  console.log(`  cleared: ${table}`);
}

async function cleanProfiles() {
  // Get seed account IDs from auth
  const { data: { users }, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`Failed to list auth users: ${error.message}`);

  const seedIds = users
    .filter((u) => SEED_EMAILS.includes((u.email || "").toLowerCase()))
    .map((u) => u.id);

  // Delete all profiles not belonging to seed accounts
  if (seedIds.length > 0) {
    const { error: profileErr } = await supabase
      .from("profiles")
      .delete()
      .not("id", "in", `(${seedIds.join(",")})`);
    if (profileErr) throw new Error(`Failed to clean profiles: ${profileErr.message}`);
  } else {
    await clearTable("profiles");
  }
  console.log(`  cleared: profiles (kept ${seedIds.length} seed accounts)`);
}

async function deleteNonSeedAuthUsers() {
  const { data: { users }, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`Failed to list auth users: ${error.message}`);

  const toDelete = users.filter((u) => !SEED_EMAILS.includes((u.email || "").toLowerCase()));

  for (const user of toDelete) {
    const { error: delErr } = await supabase.auth.admin.deleteUser(user.id);
    if (delErr) {
      console.warn(`  warning: could not delete auth user ${user.email}: ${delErr.message}`);
    } else {
      console.log(`  deleted auth user: ${user.email}`);
    }
  }

  if (toDelete.length === 0) {
    console.log("  no extra auth users to delete");
  }
}

async function main() {
  console.log("Starting clean reset...");
  console.log(`Keeping seed accounts: ${SEED_EMAILS.join(", ")}\n`);

  console.log("Clearing data tables...");
  await clearTable("payroll_entries");
  await clearTable("payroll_records");
  await clearTable("attendance_logs");
  await clearTable("audit_logs");
  await clearTable("leave_requests");
  await clearTable("transfer_requests");
  await clearTable("employee_branch_assignments");

  console.log("\nCleaning profiles...");
  await cleanProfiles();

  console.log("\nRemoving non-seed auth users...");
  await deleteNonSeedAuthUsers();

  console.log("\nDone. System is clean. Seed accounts are intact.");
  console.log("Run `node scripts/seed-auth-users.mjs` if passwords need to be reset.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
