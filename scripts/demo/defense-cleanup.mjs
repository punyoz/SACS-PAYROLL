// After the defense (NOT run by the build): remove ONLY the rows the defense
// script added (listed in defense_data_rows, batch defense-2026-11).
//
//   node scripts/demo/defense-cleanup.mjs --target=production            what would go (default: nothing written)
//   node scripts/demo/defense-cleanup.mjs --target=production --apply    snapshot, then delete in one transaction
//
// Kept on purpose (they changed EXISTING rows, which are not deleted): the
// hire dates, the corrected attendance days (their before-values stay in
// attendance_logs_history), and salaries already applied to the profile.
// A salary change removed here no longer applies to payslips not yet made.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chooseTarget, confirm, lit } from "./db.mjs";

const argv = process.argv.slice(2);
const db = await chooseTarget(argv);
const BATCH = "defense-2026-11";
const tagged = await db.rows(`select table_name, row_id from defense_data_rows where batch = ${lit(BATCH)} order by table_name`);
const byTable = tagged.reduce((m, r) => m.set(r.table_name, [...(m.get(r.table_name) || []), r.row_id]), new Map());
for (const [t, ids] of byTable) console.log(`  ${t.padEnd(28)} ${ids.length}`);
if (!argv.includes("--apply") || !tagged.length) { console.log(tagged.length ? "Nothing deleted (add --apply)." : "Nothing tagged."); process.exit(0); }

const snap = {};
for (const [t, ids] of byTable) snap[t] = await db.rows(`select * from ${t} where id::text in (${ids.map(lit).join(", ")})`);
mkdirSync(join(homedir(), "sacs-snapshots"), { recursive: true });
const file = join(homedir(), "sacs-snapshots", `defense-cleanup-${db.target}-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(snap));
console.log(`Snapshot: ${file}`);
if (!(await confirm(`Type yes to delete ${tagged.length} tagged rows on ${db.target}:`))) process.exit(1);
// Children first: a correction / split points at its parent row.
const order = ["audit_logs", "attendance_corrections", "leave_requests", "employee_salary_changes", ...[...byTable.keys()]];
const tables = [...new Set(order)].filter((t) => byTable.has(t));
await db.exec(`begin;
  ${tables.map((t) => `alter table public.${t} disable trigger user; delete from public.${t} where id::text in (${byTable.get(t).map(lit).join(", ")}); alter table public.${t} enable trigger user;`).join("\n  ")}
  delete from defense_data_rows where batch = ${lit(BATCH)};
  commit;`);
console.log("Deleted the tagged rows.");
