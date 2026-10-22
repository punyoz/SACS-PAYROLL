// Before the suite: confirm the local stack, reset it (unless E2E_RESET=0),
// seed the test accounts and fixtures, and drop stale saved sign-ins.
import { rmSync } from "node:fs";
import { seed } from "./seed-e2e.mjs";
import { localSupabase } from "./local-env.mjs";
import { AUTH_DIR } from "./support/auth.mjs";

export default async function globalSetup() {
  localSupabase();
  await seed({ reset: process.env.E2E_RESET !== "0" });
  rmSync(AUTH_DIR, { recursive: true, force: true });
}
