import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!projectUrl) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL in .env.local");
  process.exit(1);
}

const roleAccounts = [
  {
    role: "admin",
    email: process.env.SEED_ADMIN_EMAIL || "bncs.admin@gmail.com",
    password: process.env.SEED_ADMIN_PASSWORD || "Admin@12345",
    full_name: "System Admin",
    employee_id: "",
  },
  {
    role: "accountant",
    email: process.env.SEED_ACCOUNTANT_EMAIL || "bncs.accountant@gmail.com",
    password: process.env.SEED_ACCOUNTANT_PASSWORD || "Accountant@12345",
    full_name: "Payroll Accountant",
    employee_id: process.env.SEED_ACCOUNTANT_EMPLOYEE_ID || "BNCS-ACCT-001",
  },
  {
    role: "employee",
    email: process.env.SEED_EMPLOYEE_EMAIL || "bncs.employee@gmail.com",
    password: process.env.SEED_EMPLOYEE_PASSWORD || "Employee@12345",
    full_name: "Default Employee",
    employee_id: process.env.SEED_EMPLOYEE_LOGIN_ID || "BNCS-EMP-001",
  },
];

const adminClient = serviceRoleKey
  ? createClient(projectUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

const anonClient = anonKey
  ? createClient(projectUrl, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

if (!adminClient && !anonClient) {
  console.error("Missing credentials. Add SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local");
  process.exit(1);
}

function buildProfile(account, userId) {
  return {
    id: userId,
    email: account.email,
    role: account.role,
    full_name: account.full_name,
  };
}

async function runAdminSeed() {
  const supabase = adminClient;

  async function ensureUser(account) {
    const list = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (list.error) {
      throw new Error(`Failed to list users: ${list.error.message}`);
    }

    const existing = list.data.users.find((u) => u.email === account.email);

    if (existing) {
      const updated = await supabase.auth.admin.updateUserById(existing.id, {
        password: account.password,
        email_confirm: true,
        user_metadata: {
          role: account.role,
          full_name: account.full_name,
          employee_id: account.employee_id,
        },
      });

      if (updated.error) {
        throw new Error(`Failed to update user ${account.email}: ${updated.error.message}`);
      }

      return { id: existing.id, action: "updated" };
    }

    const created = await supabase.auth.admin.createUser({
      email: account.email,
      password: account.password,
      email_confirm: true,
      user_metadata: {
        role: account.role,
        full_name: account.full_name,
        employee_id: account.employee_id,
      },
    });

    if (created.error) {
      throw new Error(`Failed to create user ${account.email}: ${created.error.message}`);
    }

    return { id: created.data.user.id, action: "created" };
  }

  for (const account of roleAccounts) {
    const { id, action } = await ensureUser(account);
    const { error } = await supabase.from("profiles").upsert(buildProfile(account, id), {
      onConflict: "id",
    });

    if (error) {
      throw new Error(`Failed to upsert profile for ${account.email}: ${error.message}`);
    }

    console.log(`${action.toUpperCase()}: ${account.role} -> ${account.email}`);
  }
}

async function runAnonSeed() {
  const supabase = anonClient;

  for (const account of roleAccounts) {
    const signUp = await supabase.auth.signUp({
      email: account.email,
      password: account.password,
      options: {
        data: {
          role: account.role,
          full_name: account.full_name,
          employee_id: account.employee_id,
        },
      },
    });

    const signUpMessage = signUp.error?.message?.toLowerCase() || "";
    const isExistingUser = signUpMessage.includes("already") || signUpMessage.includes("registered");
    const isRateLimited = signUpMessage.includes("rate limit");

    if (signUp.error && !isExistingUser && !isRateLimited) {
      throw new Error(`Failed to sign up ${account.email}: ${signUp.error.message}`);
    }

    const signIn = await supabase.auth.signInWithPassword({
      email: account.email,
      password: account.password,
    });

    if (signIn.error) {
      throw new Error(
        `Account ${account.email} exists but could not sign in with seeded password. ${signIn.error.message}`,
      );
    }

    const userId = signIn.data.user.id;
    const { error } = await supabase.from("profiles").upsert(buildProfile(account, userId), {
      onConflict: "id",
    });

    if (error) {
      throw new Error(`Failed to upsert profile for ${account.email}: ${error.message}`);
    }

    await supabase.auth.signOut();
    const label = isExistingUser || isRateLimited ? "VERIFIED" : "CREATED";
    console.log(`${label}: ${account.role} -> ${account.email}`);
  }
}

async function main() {
  console.log("Seeding role-based auth users...");

  if (adminClient) {
    console.log("Mode: service role key");
    await runAdminSeed();
  } else {
    console.log("Mode: anon fallback");
    await runAnonSeed();
  }

  console.log("Done. Role users are ready for login.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
