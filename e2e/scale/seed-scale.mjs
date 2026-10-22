// Loads the scale dataset (e2e/scale/seed-scale.sql) into the LOCAL stack.
// Refuses anything but the local Supabase container.
//
//   node e2e/scale/seed-scale.mjs           on top of the current local data
//   node e2e/scale/seed-scale.mjs --reset   fresh db reset + E2E seed first
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localSupabase } from "../local-env.mjs";
import { seed } from "../seed-e2e.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = "supabase_db_SACS-PAYROLL";

localSupabase(); // throws unless the local stack is running
if (process.argv.includes("--reset")) await seed({ reset: true });

for (const file of ["payslip-template.json", "run-item-breakdown-template.json", "seed-scale.sql"]) {
  execSync(`docker cp "${join(here, file)}" ${CONTAINER}:/tmp/${file}`);
}
const started = Date.now();
const out = execSync(`docker exec ${CONTAINER} psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/seed-scale.sql`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
console.log(out.split("\n").filter((l) => /\||database_size|rows\)|MB|GB/.test(l)).join("\n"));
console.log(`[scale] loaded in ${Math.round((Date.now() - started) / 1000)} s`);
