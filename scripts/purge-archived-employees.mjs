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

  const profileDeleteResult = await supabase
    .from("profiles")
    .delete()
    .in("id", archivedIds);

  if (profileDeleteResult.error) {
    throw new Error(`Failed to delete archived profiles: ${profileDeleteResult.error.message}`);
  }

  let deletedUsers = 0;
  for (const userId of archivedIds) {
    const deleteResult = await supabase.auth.admin.deleteUser(userId);
    if (deleteResult.error) {
      throw new Error(`Failed to delete archived auth user ${userId}: ${deleteResult.error.message}`);
    }
    deletedUsers += 1;
  }

  console.log(`Deleted archived profiles: ${archivedIds.length}`);
  console.log(`Deleted archived auth users: ${deletedUsers}`);
  console.log("Archived employee purge complete.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
