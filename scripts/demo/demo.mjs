// The demo data scripts (G3), one command line:
//
//   node scripts/demo/demo.mjs export                       local -> demo-data/bundle.json
//   node scripts/demo/demo.mjs counts   --target=production  what demo data is there
//   node scripts/demo/demo.mjs seed     --target=production  load the bundle (refuses if demo data exists)
//   node scripts/demo/demo.mjs snapshot --target=production  demo rows -> demo-data/snapshots/<time>.json
//   node scripts/demo/demo.mjs restore  --target=production --file=<snapshot>   wipe demo rows, load the snapshot
//   node scripts/demo/demo.mjs reset    --target=production  snapshot, wipe, load the original bundle (2 confirmations)
//   node scripts/demo/demo.mjs remove   --target=production  snapshot, then delete is_demo data only, then check zero
//   node scripts/demo/demo.mjs roll-forward --target=production --defense=YYYY-MM-DD
//
// Every PRODUCTION run: the project URL typed back exactly, the counts
// printed, a yes/no; reset asks twice. Nothing without is_demo (or hanging
// off a demo row) is ever touched; a row mixing demo and real people is only
// listed (remove clears its demo reference so the demo account can go).
// Keys come from the environment / gitignored files and are never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, PRODUCTION, readEnvFile } from "./config.mjs";
import { chooseTarget, confirm, database, lit } from "./db.mjs";
import { collect, counts, insertOrder, schema, withoutSeedExclusions } from "./bundle.mjs";
import { buildRoster } from "./roster.mjs";

const [command, ...rest] = process.argv.slice(2);
const arg = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const BUNDLE = join(DATA_DIR, "bundle.json");
const STORAGE_BUCKET = "leave-proofs";
const say = (...m) => console.log(...m);

/** Storage access (service key from the environment of the target): files of the demo people. */
function storageFor(target) {
  const env = target === "production" ? readEnvFile(join(process.cwd(), ".env.live.local")) : null;
  let url; let key;
  if (target === "production") { url = env.NEXT_PUBLIC_SUPABASE_URL; key = env.SUPABASE_SERVICE_ROLE_KEY; }
  else { const s = JSON.parse(JSON.stringify(globalThis.__localSupabase || {})); url = s.url; key = s.serviceKey; }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  return {
    async download(path) { const r = await fetch(`${url}/storage/v1/object/${STORAGE_BUCKET}/${path}`, { headers }); if (!r.ok) throw new Error(`download ${path}: ${r.status}`); return Buffer.from(await r.arrayBuffer()).toString("base64"); },
    async upload(path, base64, mime) { const r = await fetch(`${url}/storage/v1/object/${STORAGE_BUCKET}/${path}`, { method: "POST", headers: { ...headers, "Content-Type": mime, "x-upsert": "true" }, body: Buffer.from(base64, "base64") }); if (!r.ok) throw new Error(`upload ${path}: ${r.status} ${(await r.text()).slice(0, 120)}`); },
    async remove(paths) { if (!paths.length) return; const r = await fetch(`${url}/storage/v1/object/${STORAGE_BUCKET}`, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: paths }) }); if (!r.ok) throw new Error(`remove files: ${r.status}`); },
  };
}

/** Everything demo on `db`, with the login accounts and the leave-proof files. */
async function gather(db, target) {
  const found = await collect(db);
  if (!found.demoIds.length) return { ...found, auth: { users: [], identities: [] }, files: [] };
  const D = found.demoIds.map(lit).join(", ");
  const users = await db.rows(`select * from auth.users where id in (${D})`);
  const identities = await db.rows(`select * from auth.identities where user_id in (${D})`);
  const objects = await db.rows(`select name, metadata->>'mimetype' as mime from storage.objects where bucket_id = '${STORAGE_BUCKET}' and split_part(name, '/', 1) in (${D})`);
  const storage = storageFor(target);
  const files = [];
  for (const o of objects) files.push({ path: o.name, mime: o.mime || "application/pdf", base64: await storage.download(o.name) });
  return { ...found, auth: { users, identities }, files };
}

function writeBundle(file, data) {
  mkdirSync(join(DATA_DIR, "snapshots"), { recursive: true });
  const { meta, ...rest2 } = data;
  writeFileSync(file, JSON.stringify({ created_at: new Date().toISOString(), ...rest2 }));
  return file;
}
const readBundle = (file) => JSON.parse(readFileSync(file, "utf8"));

function printCounts(title, data) {
  const c = counts(data);
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  say(`${title}: ${data.demoIds?.length || 0} demo people, ${data.auth?.users?.length || 0} login accounts, ${data.files?.length || 0} files, ${total} rows`);
  for (const [t, n] of Object.entries(c)) say(`  ${t.padEnd(36)} ${n}`);
  if (Object.keys(data.mixed || {}).length) say("  rows mixing demo and non-demo people (never copied or deleted):", JSON.stringify(data.mixed));
}

/** Insert rows into `table` as they are (triggers off for copied computed rows; generated columns left out). */
async function insertRows(db, table, rows, columns, generated, { triggers = false, settings = "" } = {}) {
  const cols = columns.filter((c) => !generated.includes(c));
  const list = cols.map((c) => `"${c}"`).join(", ");
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
    const body = `insert into ${table} (${list}) overriding system value select ${list} from jsonb_populate_recordset(null::${table}, ${lit(chunk)}) on conflict do nothing;`;
    await db.exec(triggers ? `begin; ${settings} ${body} commit;` : `begin; alter table ${table} disable trigger user; ${body} alter table ${table} enable trigger user; commit;`);
  }
}

/** Load a bundle into `db` (seed / reset / restore). */
async function load(db, bundle) {
  const meta = await schema(db);
  const D = bundle.demoIds;
  // Branches and configuration the rows point at must exist on the target.
  const branchIds = [...new Set(bundle.tables.profiles.map((p) => p.branch_id).filter(Boolean))];
  const haveBranches = await db.rows(`select id from branches where id in (${branchIds.map(lit).join(", ")})`);
  if (haveBranches.length !== branchIds.length) throw new Error("The target is missing a demo branch: nothing loaded.");
  for (const [t, rows] of Object.entries(bundle.tables)) {
    for (const { col, ref, refCol } of meta[t]?.parents || []) {
      if (bundle.tables[ref]?.length) continue;
      const ids = [...new Set(rows.map((r) => r[col]).filter(Boolean))];
      if (!ids.length) continue;
      const key = refCol || meta[ref]?.key || "id";
      const have = await db.rows(`select ${key} as k from ${ref} where ${key} in (${ids.map(lit).join(", ")})`);
      if (have.length !== ids.length) throw new Error(`${t}.${col} points at ${ids.length - have.length} ${ref} row(s) the target does not have: nothing loaded.`);
    }
  }
  // Run numbers and payslip numbers already taken on the target: the demo's move up.
  const runs = bundle.tables.payroll_runs || [];
  for (const run of runs) {
    const [taken] = await db.rows(`select coalesce(max(run_no), 0)::int m from payroll_runs where branch_id = ${lit(run.branch_id)} and period_start = ${lit(run.period_start)} and not (id in (${runs.map((r) => lit(r.id)).join(", ")}))`);
    if (taken.m >= run.run_no) run.run_no = taken.m + run.run_no;
  }
  const payslips = [...new Set(["payroll_records", "payroll_entries", "payroll_run_items"].flatMap((t) => (bundle.tables[t] || []).map((r) => r.payslip_no)).filter(Boolean))];
  const renumber = new Map();
  if (payslips.length) {
    const prefixes = [...new Set(payslips.map((p) => p.replace(/-\d+$/, "")))];
    for (const prefix of prefixes) {
      const [top] = await db.rows(`select coalesce(max((regexp_replace(payslip_no, '^.*-', ''))::int), 0)::int m from payroll_records where payslip_no like ${lit(`${prefix}-%`)}`);
      const mine = payslips.filter((p) => p.startsWith(`${prefix}-`)).sort();
      const clash = top.m > 0;
      mine.forEach((p, i) => { if (clash) renumber.set(p, `${prefix}-${String(top.m + i + 1).padStart(4, "0")}`); });
    }
  }
  const remapText = (row) => {
    if (!renumber.size) return row;
    // One pass, each number looked up once (a chain of replacements could renumber a number twice).
    const text = JSON.stringify(row).replace(/"(PS-\d{6}-\d+)"/g, (match, no) => (renumber.has(no) ? `"${renumber.get(no)}"` : match));
    return JSON.parse(text);
  };

  // 1. Login accounts (the same bcrypt hashes, so the passwords stay as in the credentials file).
  const authCols = await db.rows("select table_name as tbl, column_name as col, is_generated = 'ALWAYS' as gen from information_schema.columns where table_schema = 'auth' and table_name in ('users', 'identities')");
  const colsOf = (name) => authCols.filter((x) => x.tbl === name && !x.gen).map((x) => x.col);
  await insertRows(db, "auth.users", bundle.auth.users, colsOf("users"), [], { triggers: true });
  await insertRows(db, "auth.identities", bundle.auth.identities, colsOf("identities"), [], { triggers: true });
  // 2. Profiles with their triggers ON: the target encrypts the (fake) government numbers with its own key.
  const roster = new Map(buildRoster(Object.fromEntries((await db.rows("select * from branches")).map((b) => [b.code, b]))).map((p) => [p.id, p]));
  const profiles = bundle.tables.profiles.map((p) => {
    const r = roster.get(p.id);
    const row = Object.fromEntries(Object.entries(p).filter(([k]) => !/_enc$|_last4$/.test(k)));
    return { ...row, sss_number: r?.sss_number ?? null, philhealth_number: r?.philhealth_number ?? null, pagibig_number: r?.pagibig_number ?? null, tin_number: r?.tin_number ?? null };
  });
  // A profile points at its PRC ID document (and verifier), which points back: set those after the documents.
  // A licensed teacher arrives unlicensed and is licensed after the PRC documents (profiles_license_guard);
  // the fake PRC number (990 + its last 4) is encrypted with the target's own key.
  const links = profiles.filter((p) => p.prc_id_document_id || p.license_verified_by || p.is_licensed_teacher).map((p) => ({
    id: p.id, doc: p.prc_id_document_id, by: p.license_verified_by, licensed: Boolean(p.is_licensed_teacher), expires: p.license_expires_on,
    last4: p.prc_license_no_last4, at: p.license_verified_at, byName: p.license_verified_by_name }));
  for (const p of profiles) {
    p.prc_id_document_id = null; p.license_verified_by = null; p.license_verified_at = null; p.license_verified_by_name = null;
    p.is_licensed_teacher = false; p.license_expires_on = null;
  }
  const profileCols = [...new Set(profiles.flatMap((p) => Object.keys(p)))];
  // The card UID on a profile is written only inside the RFID registration flow (profiles_rfid_uid_guard).
  await insertRows(db, "profiles", profiles, profileCols, meta.profiles.generated, { triggers: true, settings: "set local sacs.rfid_flow = 'on';" });
  // 3. Everything else as computed (triggers off: nothing recomputed or re-stamped), parents first.
  const names = Object.keys(bundle.tables).filter((t) => t !== "profiles" && bundle.tables[t].length);
  for (const t of insertOrder(meta, names)) {
    if (t === "profiles") continue;
    await insertRows(db, t, bundle.tables[t].map(remapText), meta[t].columns, meta[t].generated);
    say(`  loaded ${t}: ${bundle.tables[t].length}`);
  }
  if (links.length) {
    await db.exec(`begin; alter table profiles disable trigger user;
      ${links.map((l) => `update profiles set prc_id_document_id = ${lit(l.doc)}, license_verified_by = ${lit(l.by)}, license_verified_at = ${lit(l.at)}, license_verified_by_name = ${lit(l.byName)}${l.licensed ? `,
        is_licensed_teacher = true, license_expires_on = ${lit(l.expires)}, prc_license_no_enc = private.encrypt_pii(${lit(`990${l.last4}`)}), prc_license_no_last4 = ${lit(l.last4)}` : ""} where id = ${lit(l.id)};`).join(" ")}
      alter table profiles enable trigger user; commit;`);
  }
  // 4. Leave-proof files.
  const storage = storageFor(db.target);
  for (const f of bundle.files || []) await storage.upload(f.path, f.base64, f.mime);
  if (renumber.size) say(`  ${renumber.size} payslip numbers moved up past the target's own`);
  return { renumbered: renumber.size };
}

/** Delete the demo rows on `db` (children first, triggers off), clear mixed references, drop logins and files. */
async function wipe(db, data) {
  if (!data.demoIds?.length) { say("  nothing demo to delete"); return; }
  const meta = await schema(db);
  const D = data.demoIds.map(lit).join(", ");
  const names = Object.keys(data.tables).filter((t) => data.tables[t].length);
  // Profiles last (other rows point at them); first drop the loops: a profile's
  // PRC ID document and verifier, and the transient rows the bundle skips.
  const order = [...insertOrder(meta, names.filter((t) => t !== "profiles")).reverse(), "profiles"];
  await db.exec(`begin; alter table profiles disable trigger user;
    update profiles set prc_id_document_id = null, license_verified_by = null where id in (${D}) or license_verified_by in (${D});
    alter table profiles enable trigger user;
    delete from hr_queue_claims where claimed_by in (${D});
    delete from notification_channels where user_id in (${D});
    commit;`);
  // Mixed rows keep themselves; only their pointer to a demo person is cleared.
  for (const t of Object.keys(data.mixed || {})) {
    const m = meta[t];
    for (const col of m.person) {
      const nullable = await db.rows(`select is_nullable = 'YES' n from information_schema.columns where table_schema = 'public' and table_name = ${lit(t)} and column_name = ${lit(col)}`);
      if (!nullable[0]?.n) { say(`  ${t}.${col}: mixed rows cannot drop their demo reference (not nullable); left as they are`); continue; }
      const notDemoRow = m.person.filter((c) => c !== col).map((c) => `(${c} is not null and ${c} not in (${D}))`).join(" or ") || "false";
      await db.exec(`begin; alter table ${t} disable trigger user; update ${t} set ${col} = null where ${col} in (${D}) and (${notDemoRow}); alter table ${t} enable trigger user; commit;`);
      say(`  cleared ${t}.${col} on mixed rows`);
    }
  }
  for (const t of order) {
    const rows = data.tables[t] || [];
    if (!rows.length) continue;
    const key = meta[t]?.key || "id";
    let kept = 0;
    for (let i = 0; i < rows.length; i += 1000) {
      const ids = rows.slice(i, i + 1000).map((r) => lit(r[key])).join(", ");
      try {
        await db.exec(`begin; alter table ${t} disable trigger user; delete from ${t} where ${key} in (${ids}); alter table ${t} enable trigger user; commit;`);
      } catch (error) {
        // A non-demo row still points at one of these (e.g. a real account's payslip in a run a demo
        // Accountant processed live): those stay, the rest go one by one.
        await db.exec("rollback;").catch(() => null);
        for (const id of rows.slice(i, i + 1000).map((r) => lit(r[key]))) {
          try { await db.exec(`begin; alter table ${t} disable trigger user; delete from ${t} where ${key} = ${id}; alter table ${t} enable trigger user; commit;`); }
          catch { kept += 1; await db.exec("rollback;").catch(() => null); }
        }
      }
    }
    say(`  deleted ${t}: ${rows.length - kept}${kept ? ` (${kept} kept: a non-demo row still points at them; listed for you)` : ""}`);
  }
  await storageFor(db.target).remove((data.files || []).map((f) => f.path));
  await db.exec(`delete from auth.identities where user_id in (${D}); delete from auth.users where id in (${D});`);
}

async function checkZero(db) {
  const [r] = await db.rows(`select (select count(*) from profiles where is_demo)::int profiles,
    (select count(*) from auth.users where email like '%+%@%' and raw_user_meta_data->>'is_demo' = 'true')::int logins,
    (select count(*) from storage.objects o where bucket_id = '${STORAGE_BUCKET}' and not exists (select 1 from profiles p where p.id::text = split_part(o.name, '/', 1)))::int orphan_files`);
  say(`after: ${r.profiles} demo profiles, ${r.logins} demo login accounts, ${r.orphan_files} files of removed people`);
  return r;
}

async function snapshot(db) {
  const data = await gather(db, db.target);
  const file = join(DATA_DIR, "snapshots", `${db.target}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeBundle(file, data);
  say(`snapshot: ${file}`);
  return { data, file };
}

const commands = {
  async export() {
    const db = database("local");
    globalThis.__localSupabase = (await import("../../e2e/local-env.mjs")).localSupabase();
    const data = await gather(db, "local");
    // Never overwrite a bundle with nothing (after a local remove, build or restore first).
    if (!data.demoIds.length) throw new Error("No demo data on the local stack: the bundle was NOT overwritten.");
    data.tables = withoutSeedExclusions(data.tables);
    printCounts("local demo data", data);
    writeBundle(BUNDLE, data);
    say(`bundle written: ${BUNDLE}`);
  },
  async counts() {
    const db = await chooseTarget(rest);
    if (db.target === "local") globalThis.__localSupabase = (await import("../../e2e/local-env.mjs")).localSupabase();
    printCounts(`${db.target} demo data`, await collect(db, { withRows: false }));
  },
  async seed() {
    const db = await chooseTarget(rest);
    if (db.target === "local") globalThis.__localSupabase = (await import("../../e2e/local-env.mjs")).localSupabase();
    if (!existsSync(BUNDLE)) throw new Error("No bundle: run export first.");
    const bundle = readBundle(BUNDLE);
    const [have] = await db.rows("select count(*)::int n from profiles where is_demo");
    if (have.n) { say(`${have.n} demo profiles already on ${db.target}.`); if (!(await confirm('Demo data exists. Type "add anyway" to load on top:', "add anyway"))) return say("Nothing done."); }
    printCounts(`will CREATE on ${db.target}`, bundle);
    if (!(await confirm(`Load this on ${db.target}? (yes/no)`))) return say("Nothing done.");
    await load(db, bundle);
    printCounts(`now on ${db.target}`, await collect(db, { withRows: false }));
  },
  async snapshot() {
    const db = await chooseTarget(rest);
    if (db.target === "local") globalThis.__localSupabase = (await import("../../e2e/local-env.mjs")).localSupabase();
    await snapshot(db);
  },
  async remove() {
    const db = await chooseTarget(rest);
    if (db.target === "local") globalThis.__localSupabase = (await import("../../e2e/local-env.mjs")).localSupabase();
    const { data } = await snapshot(db);
    printCounts(`will DELETE on ${db.target} (is_demo data only)`, data);
    if (!(await confirm(`Delete all of it on ${db.target}? (yes/no)`))) return say("Nothing deleted (the snapshot is kept).");
    await wipe(db, data);
    await checkZero(db);
    say("Deleted rows stay in the Supabase Pro daily backups for about 7 days.");
  },
  async restore() {
    const db = await chooseTarget(rest);
    if (db.target === "local") globalThis.__localSupabase = (await import("../../e2e/local-env.mjs")).localSupabase();
    const file = arg("file");
    if (!file || !existsSync(file)) throw new Error("--file=<snapshot> is required.");
    const target = readBundle(file);
    const { data } = await snapshot(db);
    printCounts(`will DELETE on ${db.target}`, data);
    printCounts("then LOAD", target);
    if (!(await confirm("Restore this snapshot? (yes/no)"))) return say("Nothing done.");
    await wipe(db, data);
    await load(db, target);
  },
  async reset() {
    const db = await chooseTarget(rest);
    if (db.target === "local") globalThis.__localSupabase = (await import("../../e2e/local-env.mjs")).localSupabase();
    const bundle = readBundle(BUNDLE);
    const { data } = await snapshot(db);
    printCounts(`will DELETE on ${db.target} (your edits included)`, data);
    printCounts("then LOAD the original seed", bundle);
    if (!(await confirm("Reset wipes every edit made to the demo data. Continue? (yes/no)"))) return say("Nothing done.");
    if (!(await confirm('Type "reset demo" to confirm a second time:', "reset demo"))) return say("Nothing done.");
    await wipe(db, data);
    await load(db, bundle);
    printCounts(`now on ${db.target}`, await collect(db, { withRows: false }));
  },
  async "roll-forward"() {
    const db = await chooseTarget(rest);
    const defense = arg("defense");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(defense || ""))) throw new Error("--defense=YYYY-MM-DD is required.");
    const { attendanceSql } = await import("./build-local.mjs");
    const branches = Object.fromEntries((await db.rows("select * from branches")).map((b) => [b.code, b]));
    const people = buildRoster(branches).filter((p) => p.on_payroll);
    const live = await db.rows(`select id, separated_on, archived from profiles where is_demo and id in (${people.map((p) => lit(p.id)).join(", ")})`);
    const active = people.filter((p) => live.some((l) => l.id === p.id && !l.archived)).map((p) => ({ ...p, separated_on: live.find((l) => l.id === p.id).separated_on || p.separated_on }));
    const ids = active.map((p) => lit(p.id)).join(", ");
    // From the day after the last TAPPED day: the nightly job (pg_cron) marks untapped days Absent
    // between the seed and the defense; those automatic Absent days (no tap, never edited by anyone)
    // are replaced. A day someone tapped, corrected or edited by hand is never touched.
    const [last] = await db.rows(`select max(log_date)::text d from attendance_logs where employee_id in (${ids}) and time_in is not null`);
    const from = new Date(Date.parse(`${last.d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
    const [auto] = await db.rows(`select count(*)::int n from attendance_logs where employee_id in (${ids}) and log_date >= ${lit(from)}
      and time_in is null and time_out is null and status = 'Absent' and changed_by is null and leave_request_id is null`);
    const to = new Date(Date.parse(`${defense}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const until = to < today ? to : today;
    if (from > until) return say(`Nothing to add: attendance already reaches ${last.d}.`);
    say(`Will ADD attendance for ${active.length} demo people from ${from} to ${until} (working days, never a future day; nothing existing is changed:`);
    say("passwords, rates, approvals and anything edited by hand stay as they are).");
    say(`It first replaces ${auto.n} automatic Absent day(s) the nightly job made since ${from} (no tap, never edited).`);
    if (!(await confirm("Add it? (yes/no)"))) return say("Nothing done.");
    await db.exec(`begin; alter table attendance_logs disable trigger user;
      delete from attendance_logs where employee_id in (${ids}) and log_date >= ${lit(from)}
        and time_in is null and time_out is null and status = 'Absent' and changed_by is null and leave_request_id is null;
      alter table attendance_logs enable trigger user; commit;`);
    await db.exec(attendanceSql({ people: active, from, to: until, today, nowMinutes: 24 * 60 }));
    await db.exec(`select public.attendance_close_days(${lit(from)}::date, ${lit(until)}::date);`);
    const [n] = await db.rows(`select count(*)::int n from attendance_logs where log_date between ${lit(from)} and ${lit(until)} and employee_id in (${active.map((p) => lit(p.id)).join(", ")})`);
    say(`added: ${n.n} attendance days. The cutoff holding ${until} is left for the live demo to process.`);
  },
};

if (!commands[command]) {
  say(`Commands: ${Object.keys(commands).join(", ")} (add --target=production for the live project ${PRODUCTION.url})`);
  process.exit(1);
}
await commands[command]();
