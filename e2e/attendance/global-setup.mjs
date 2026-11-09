// Before the fast attendance run: check the LOCAL stack, then seed the fixed
// attendance data set ONCE (e2e/attendance/seed.sql). Sign-ins happen in the
// "setup" project (auth.setup.mjs), after the server is up.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalUrl, localSupabase } from "../local-env.mjs";
import { psql } from "../support/db.mjs";

export default async function globalSetup() {
  const local = localSupabase();
  assertLocalUrl(local.url);
  if (process.env.E2E_SEED === "0") return;
  psql(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "seed.sql"), "utf8"));
  console.log("[attendance] seeded the fixed attendance data set (local)");
}
