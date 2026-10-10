/**
 * Database backup for the Free plan (no Supabase backups to restore from).
 *
 *   npm run db:backup
 *
 * Writes backups/<YYYY-MM-DD_HHmm>/ with the three files Supabase's own
 * backup guide uses (docs/backup-and-restore.md):
 *
 *   roles.sql    database roles
 *   schema.sql   tables, functions, triggers, RLS policies
 *   data.sql     every row, incl. auth.users (COPY format)
 *   history.sql  the migration history (supabase_migrations), schema + data
 *   manifest.json  sizes and SHA-256 of each file, to check a copy later
 *
 * Needs Docker Desktop running (the Supabase CLI runs pg_dump in a
 * container) and SUPABASE_DB_URL in .env.local: the Session pooler
 * connection string from Dashboard → Connect, with the database password.
 * Read-only: it never writes to the database.
 *
 * The dump holds names, salaries, password hashes and the encrypted ID
 * numbers. Store it like payroll records: an encrypted drive or a
 * restricted folder, never e-mail or chat. The encryption key for the ID
 * numbers is NOT in the dump (see docs/backup-and-restore.md).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const dbUrl = String(process.env.SUPABASE_DB_URL || "").trim();
if (!/^postgres(ql)?:\/\//.test(dbUrl)) {
  console.error("Set SUPABASE_DB_URL in .env.local: Dashboard → Connect → Session pooler connection string, with the database password.");
  process.exit(1);
}

const isWindows = process.platform === "win32";
const npx = isWindows ? "npx.cmd" : "npx";

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: ["ignore", "inherit", "pipe"], shell: isWindows, encoding: "utf8" });
  if (result.status !== 0) {
    // The CLI's stderr can echo the connection string: hide the password.
    const stderr = String(result.stderr || "").replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, "$1***@");
    console.error(`${label} failed.\n${stderr}`);
    process.exit(1);
  }
}

const docker = spawnSync("docker", ["info"], { stdio: "ignore", shell: isWindows });
if (docker.status !== 0) {
  console.error("Docker is not running. Start Docker Desktop (the Supabase CLI runs pg_dump in a container) and try again.");
  process.exit(1);
}

const stamp = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date()).replace(", ", "_").replace(":", "");
const dir = path.join("backups", stamp);
mkdirSync(dir, { recursive: true });

// On Windows the URL goes through cmd.exe: quote it so & and % survive.
const url = isWindows ? `"${dbUrl}"` : dbUrl;
const dump = (args, file, label) => {
  console.log(`- ${label}`);
  run(npx, ["--yes", "supabase", "db", "dump", "--db-url", url, "-f", path.join(dir, file), ...args], label);
};

console.log(`Backing up to ${dir}`);
dump(["--role-only"], "roles.sql", "roles");
dump([], "schema.sql", "schema");
dump(["--use-copy", "--data-only", "-x", "storage.buckets_vectors", "-x", "storage.vector_indexes"], "data.sql", "data");
dump(["--schema", "supabase_migrations"], "history_schema.sql", "migration history (schema)");
dump(["--use-copy", "--data-only", "--schema", "supabase_migrations"], "history_data.sql", "migration history (data)");

const files = ["roles.sql", "schema.sql", "data.sql", "history_schema.sql", "history_data.sql"].map((name) => {
  const full = path.join(dir, name);
  return {
    name,
    bytes: statSync(full).size,
    sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
  };
});
const empty = files.filter((f) => f.bytes === 0 && f.name !== "roles.sql");
if (empty.length) {
  console.error(`Backup incomplete: ${empty.map((f) => f.name).join(", ")} is empty.`);
  process.exit(1);
}

writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify({
  created_at: new Date().toISOString(),
  project_host: dbUrl.replace(/^.*@/, "").replace(/\/.*$/, ""),
  files,
  reminder: "The ID-number encryption key (pii_encryption_key) is not in this backup; it is in the school's password manager.",
}, null, 2)}\n`);

console.log(`\nDone: ${dir}`);
for (const f of files) console.log(`  ${f.name.padEnd(20)} ${(f.bytes / 1024).toFixed(0).padStart(7)} KB`);
console.log("\nCopy this folder to the school's encrypted backup location, then test a restore (docs/backup-and-restore.md).");
