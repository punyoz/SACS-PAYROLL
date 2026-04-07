import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!projectUrl || !anonKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(projectUrl, anonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function main() {
  const { error: healthError } = await supabase.auth.getSession();

  if (healthError) {
    throw new Error(`Supabase auth endpoint unreachable: ${healthError.message}`);
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .select("id", { head: true, count: "exact" });

  if (profileError) {
    console.log("Auth endpoint: OK");
    console.log(`Profiles table check: ${profileError.message}`);
    process.exit(0);
  }

  console.log("Auth endpoint: OK");
  console.log("Profiles table check: OK");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
