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
  auth: { persistSession: false, autoRefreshToken: false },
});

const SEED_EMAILS = [
  (process.env.SEED_ADMIN_EMAIL || "admin@example.com").toLowerCase(),
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
  await clearTable("salary_approvals");
  await clearTable("payroll_records");
  await clearTable("attendance_logs");
  await clearTable("audit_logs");
  await clearTable("leave_requests");

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
