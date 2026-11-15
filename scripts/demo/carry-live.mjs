// Changes made on LIVE since the bundle was exported, carried across a demo
// reset (2026-11-15). Three commands:
//
//   node scripts/demo/carry-live.mjs local
//       LOCAL, before export: replays the demo-only live changes through the
//       real routes as the same demo person, so the next bundle has them
//       (Andrea's Dec 1-7 leave; Demo HR One's "Grade School" schedule).
//   node scripts/demo/carry-live.mjs capture --target=production
//       READ-ONLY, right before the reset: saves what the reset would lose
//       although it is not demo data: audit entries a demo person wrote about
//       a real account, the demo references of mixed rows (a real HR's
//       decision on a demo request, a demo HR's salary change of a real
//       account), and the attendance those rows created.
//       -> demo-data/carry/<time>.json
//   node scripts/demo/carry-live.mjs apply --target=production --file=<capture> [--dry-run]
//       Right AFTER the reset: puts those back (insert if missing; a demo
//       reference only where the reset cleared it). Same confirmations as demo.mjs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";
import { chooseTarget, confirm, lit } from "./db.mjs";
import { collect } from "./bundle.mjs";

const [command, ...rest] = process.argv.slice(2);
const arg = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const say = (...m) => console.log(...m);

const commands = {
  async local() {
    const db = await chooseTarget(["--target=local"]);
    const { context } = await import("./build-local.mjs");
    const { as, ok } = await import("./local-api.mjs");
    const { by } = await context();
    const andrea = by("emp1");
    // Live 2026-11-13: Andrea files Vacation Leave Dec 1-7; Demo HR One approves (split over the balance).
    const [had] = await db.rows(`select count(*)::int n from leave_requests where employee_id = ${lit(andrea.id)} and start_date = '2026-12-01'`);
    if (!had.n) {
      const filed = ok("leave", await as(andrea).post("/api/me/leave-requests", { leave_type: "Vacation Leave", start_date: "2026-12-01", end_date: "2026-12-07", reason: "Live check of the over-balance split (demo)." }));
      ok("approve", await as(by("hr1")).patch("/api/hr/leave-requests", { id: filed.request.id, action: "approve" }));
      say("  Andrea: Vacation Leave Dec 1-7 filed and approved by Demo HR One");
    }
    // Live 2026-11-15: Demo HR One creates "Grade School" from Nov 16 and assigns the Grade School level.
    const [sched] = await db.rows("select schedule_key from work_schedules where name = 'Grade School' and not archived limit 1");
    if (!sched) {
      const saved = ok("schedule", await as(by("hr1")).post("/api/admin/work-schedules", {
        action: "save_schedule", name: "Grade School", work_start: "07:00", work_end: "15:00", grace_minutes: 15, work_hours: 8, working_days: [1, 2, 3, 4, 5], effective_from: "2026-11-16", note: null }));
      const [row] = await db.rows("select schedule_key from work_schedules where name = 'Grade School' and not archived limit 1");
      ok("assign", await as(by("hr1")).post("/api/admin/work-schedules", { action: "assign", target: "level", level: "grade_school", schedule_key: row?.schedule_key || saved?.schedule?.schedule_key, effective_from: "2026-11-16", note: null }));
      say("  Demo HR One: Grade School schedule from Nov 16, assigned to the Grade School level");
    }
  },

  async capture() {
    const db = await chooseTarget(rest);
    const found = await collect(db);
    const demo = new Set(found.demoIds);
    const D = found.demoIds.map(lit).join(", ");
    // Audit entries a demo person wrote about someone who is not demo (deleted with the demo rows).
    const realPeople = new Set((await db.rows(`select id from profiles where id not in (${D})`)).map((r) => r.id));
    const audit = (found.tables.audit_logs || []).filter((r) => {
      const about = [r.entity_id, r.metadata?.employee_id, r.metadata?.user_id].map((v) => String(v || ""));
      return about.some((id) => realPeople.has(id)) && !about.some((id) => demo.has(id));
    });
    // Mixed rows: their demo person columns (the reset clears them).
    const meta = found.meta;
    const refs = [];
    for (const t of Object.keys(found.mixed || {})) {
      const cols = meta[t].person;
      // Mixed only: a demo person AND a real one (the same test as collect()).
      const real = cols.map((c) => `(${c} is not null and ${c} not in (${D}))`).join(" or ");
      const rows = await db.rows(`select ${meta[t].key} k, ${cols.join(", ")} from ${t} where (${cols.map((c) => `${c} in (${D})`).join(" or ")}) and (${real})`);
      for (const r of rows) for (const c of cols) if (demo.has(r[c])) refs.push({ table: t, key: meta[t].key, id: r.k, column: c, value: r[c] });
    }
    // Attendance rows a mixed leave created for a demo person (deleted with the demo rows).
    const leaveIds = refs.filter((r) => r.table === "leave_requests").map((r) => lit(r.id));
    const attendance = leaveIds.length ? await db.rows(`select * from attendance_logs where leave_request_id in (${leaveIds.join(", ")})`) : [];
    mkdirSync(join(DATA_DIR, "carry"), { recursive: true });
    const file = join(DATA_DIR, "carry", `${db.target}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ captured_at: new Date().toISOString(), audit, refs, attendance }, null, 1));
    say(`captured: ${audit.length} audit entries about real accounts, ${refs.length} demo references on mixed rows, ${attendance.length} attendance rows -> ${file}`);
    audit.forEach((r) => say(`  audit ${String(r.created_at).slice(0, 16)} ${r.actor_name}: ${String(r.description).slice(0, 110)}`));
    refs.forEach((r) => say(`  ref ${r.table}.${r.column} on ${r.id}`));
  },

  async apply() {
    const file = arg("file");
    if (!file) throw new Error("--file=<capture> is required.");
    const data = JSON.parse(readFileSync(file, "utf8"));
    const dry = rest.includes("--dry-run");
    const db = dry ? null : await chooseTarget(rest);
    const insert = (t, row) => `insert into ${t} select * from jsonb_populate_record(null::${t}, ${lit(row)}) on conflict do nothing;`;
    const sql = [
      ...data.audit.map((r) => insert("audit_logs", r)),
      ...data.attendance.map((r) => insert("attendance_logs", r)),
      // Only where the reset cleared it, and only to a person who exists again.
      ...data.refs.map((r) => `update ${r.table} set ${r.column} = ${lit(r.value)} where ${r.key} = ${lit(r.id)} and ${r.column} is null and exists (select 1 from profiles where id = ${lit(r.value)});`),
    ];
    say(`${data.audit.length} audit entries, ${data.attendance.length} attendance rows, ${data.refs.length} references to put back.`);
    if (dry) { say(sql.join("\n")); return; }
    if (!(await confirm(`Apply on ${db.target}? (yes/no)`))) return say("Nothing done.");
    // Triggers off: the rows come back exactly as they were (no new audit entries, no recomputation).
    for (const t of ["audit_logs", "attendance_logs", ...new Set(data.refs.map((r) => r.table))]) await db.exec(`alter table ${t} disable trigger user;`);
    try { await db.exec(`begin;\n${sql.join("\n")}\ncommit;`); } finally {
      for (const t of ["audit_logs", "attendance_logs", ...new Set(data.refs.map((r) => r.table))]) await db.exec(`alter table ${t} enable trigger user;`);
    }
    say("applied.");
  },
};

if (!commands[command]) {
  say(`Commands: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
await commands[command]();
