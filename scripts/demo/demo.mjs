// The demo data scripts (G3), one command line:
//
//   node scripts/demo/demo.mjs export                       local -> demo-data/bundle.json
//   node scripts/demo/demo.mjs counts   --target=production  what demo data is there
//   node scripts/demo/demo.mjs seed     --target=production  load the bundle (refuses if demo data exists)
//   node scripts/demo/demo.mjs snapshot --target=production  demo rows -> demo-data/snapshots/<time>.json
//   node scripts/demo/demo.mjs restore  --target=production --file=<snapshot>   wipe demo rows, load the snapshot
//   node scripts/demo/demo.mjs reset    --target=production  snapshot, wipe, load the original bundle (2 confirmations)
//   node scripts/demo/demo.mjs plan     --target=production [--file=<bundle>]  what a reset would do; nothing stays
//                                     changed (the wipe is tried and rolled back: a few seconds of table locks)
//   node scripts/demo/demo.mjs remove   --target=production  snapshot, then delete is_demo data only, then check zero
//   node scripts/demo/demo.mjs roll-forward --target=production --defense=YYYY-MM-DD
//
// Every PRODUCTION run: the project URL typed back exactly, the counts
// printed, a yes/no; reset asks twice. Nothing without is_demo (or hanging
// off a demo row) is ever touched; a row mixing demo and real people is only
// listed (remove, reset and restore clear its demo reference so the demo account can go).
// Keys come from the environment / gitignored files and are never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, PRODUCTION, readEnvFile } from "./config.mjs";
import { chooseTarget, confirm, database, lit } from "./db.mjs";
import { collect, counts, demoFilter, describeFit, fitBundleToTarget, insertOrder, schema, withoutSeedExclusions } from "./bundle.mjs";
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
  // Batches of at most 400 rows and about 700 KB (the Management API refuses large requests).
  const shaped = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  const batches = [];
  let current = []; let size = 0;
  for (const row of shaped) {
    const bytes = JSON.stringify(row).length;
    if (current.length && (current.length >= 400 || size + bytes > 700_000)) { batches.push(current); current = []; size = 0; }
    current.push(row); size += bytes;
  }
  if (current.length) batches.push(current);
  for (const chunk of batches) {
    const body = `insert into ${table} (${list}) overriding system value select ${list} from jsonb_populate_recordset(null::${table}, ${lit(chunk)}) on conflict do nothing;`;
    await db.exec(triggers ? `begin; ${settings} ${body} commit;` : `begin; alter table ${table} disable trigger user; ${body} alter table ${table} enable trigger user; commit;`);
  }
}

/**
 * The wipe (reset / restore / remove) cannot delete a demo row that a
 * non-demo row still needs: one it points at through any foreign key (a chain
 * through other demo rows ends at a direct pointer into a demo row), or a demo
 * person it names in a NOT NULL column (the wipe would fail, or delete that
 * row with the person). Refused before any prompt; the dry run is the exact
 * backstop, this names the rows plainly.
 */
async function refuseNeededRows(db, meta, goingAway) {
  const listOf = (ids) => (ids.length ? ids.map(lit).join(", ") : lit("00000000-0000-0000-0000-000000000000"));
  const idsOf = (t) => (goingAway?.[t] || []).map((r) => String(r[meta[t]?.key || "id"]));
  const kept = [];
  const chunks = (ids) => Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) => ids.slice(i * 500, i * 500 + 500));
  for (const [t, m] of Object.entries(meta)) {
    if (!m.key) continue;
    const mine = new Set(idsOf(t));
    for (const { col, ref } of m.parents || []) {
      const ids = idsOf(ref);
      for (const part of chunks(ids)) {
        const rows = await db.rows(`select ${col}::text k, ${m.key}::text id from ${t} where ${col}::text in (${listOf(part)})`);
        [...new Set(rows.filter((r) => !mine.has(r.id)).map((r) => r.k))].forEach((k) => kept.push(`${ref} ${k} (a ${t} row that is not demo points at it: the wipe would fail, or delete or change that row)`));
      }
    }
  }
  // Mixed rows (a demo person and a non-demo one): the wipe empties the demo
  // person's column, which a NOT NULL column refuses, so the row and the person stay.
  const demoPeople = idsOf("profiles");
  const required = await db.rows("select table_name t, column_name c from information_schema.columns where table_schema = 'public' and is_nullable = 'NO'");
  for (const [t, m] of Object.entries(meta)) {
    if (!m.key || !demoPeople.length) continue;
    const mine = new Set(idsOf(t));
    for (const col of m.person.filter((c) => required.some((r) => r.t === t && r.c === c))) {
      for (const part of chunks(demoPeople)) {
        const rows = await db.rows(`select ${m.key}::text id, ${col}::text k from ${t} where ${col}::text in (${listOf(part)})`);
        rows.filter((r) => !mine.has(r.id)).forEach((r) => kept.push(`profiles ${r.k} (${t} ${r.id}, not demo, names this demo person in ${col} (NOT NULL): the wipe would fail, or delete that row with the person)`));
      }
    }
  }
  if (kept.length) throw new Error(`${kept.length} demo row(s) are still needed by non-demo rows, so the wipe could not delete them; this is refused:\n  ${kept.slice(0, 20).join("\n  ")}\nNothing changed.`);
}

/**
 * Everything a load decides, read-only, BEFORE any prompt (seed / reset /
 * restore print its notes with the counts): the bundle fitted to the target
 * (fitBundleToTarget), the checks that stop a load, the run numbers and the
 * payslip numbers it moves up. `goingAway` = the demo rows a reset / restore
 * wipes first (their runs and payslip numbers do not count as the target's).
 */
async function planLoad(db, source, { goingAway = null, snapshotFile = null } = {}) {
  const meta = await schema(db);
  const bundle = { ...source, tables: { ...source.tables } };
  const listOf = (ids) => (ids.length ? ids.map(lit).join(", ") : lit("00000000-0000-0000-0000-000000000000"));
  const idsOf = (t) => (goingAway?.[t] || []).map((r) => String(r[meta[t]?.key || "id"]));
  if (goingAway) await refuseNeededRows(db, meta, goingAway);
  // A bundle person whose id is a NON-demo profile on the target: the insert
  // would be skipped and the demo rows would attach to that real person.
  const people = (bundle.tables.profiles || []).map((p) => String(p.id));
  if (people.length) {
    const real = await db.rows(`select id::text id, full_name from profiles where id::text in (${listOf(people)}) and (${demoFilter()}) is not true and id::text not in (${listOf(idsOf("profiles"))})`);
    if (real.length) throw new Error(`${real.length} demo person id(s) belong to non-demo profiles on the target (${real.slice(0, 5).map((r) => r.full_name || r.id).join(", ")}): nothing loaded.`);
  }
  const bundleRunIds = (bundle.tables.payroll_runs || []).map((r) => r.id);
  const notTheBundles = listOf([...bundleRunIds, ...idsOf("payroll_runs")]);
  // A run with a bundle run's id already on the target (not wiped first): the
  // insert would keep the target's run and attach the bundle's items to it.
  // Fine only for the demo's own run (a resumed seed); refused when a
  // non-demo person handled it (reviewed, submitted, processed).
  if (bundleRunIds.length) {
    const people = new Set([...(bundle.demoIds || []), ...idsOf("profiles")].map(String));
    const cols = meta.payroll_runs?.person || [];
    const same = await db.rows(`select id::text id${cols.map((c) => `, ${c}::text ${c}`).join("")} from payroll_runs where id::text in (${listOf(bundleRunIds.map(String))}) and id::text not in (${listOf(idsOf("payroll_runs"))})`);
    const handled = goingAway ? same : same.filter((r) => cols.some((c) => r[c] && !people.has(r[c])));
    if (handled.length) throw new Error(`${handled.length} run(s) with a demo run's id are already on the target and ${goingAway ? "are not demo rows the wipe deletes" : "were handled by a non-demo person"} (${handled.slice(0, 5).map((r) => r.id).join(", ")}): nothing loaded.`);
  }
  const fit = fitBundleToTarget(bundle.tables, {
    rateIds: new Set((await db.rows("select id from payroll_rate_configs")).map((r) => r.id)),
    targetRuns: await db.rows(`select branch_id, period_start::text, status from payroll_runs where id not in (${notTheBundles})`),
  });
  bundle.tables = fit.tables;
  // Branches and configuration the rows point at must exist on the target.
  const branchIds = [...new Set(bundle.tables.profiles.map((p) => p.branch_id).filter(Boolean))];
  const haveBranches = await db.rows(`select id from branches where id in (${branchIds.map(lit).join(", ")})`);
  if (haveBranches.length !== branchIds.length) throw new Error("The target is missing a demo branch: nothing loaded.");
  for (const [t, rows] of Object.entries(bundle.tables)) {
    for (const { col, ref, refCol } of meta[t]?.parents || []) {
      const key = refCol || meta[ref]?.key || "id";
      // Parents the bundle carries are loaded with it; the others must be on the target.
      const carried = new Set((bundle.tables[ref] || []).map((r) => String(r[key])));
      const ids = [...new Set(rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && !carried.has(String(v))))];
      if (!ids.length) continue;
      // Rows the wipe deletes first do not count as the target's.
      const have = await db.rows(`select ${key} as k from ${ref} where ${key} in (${ids.map(lit).join(", ")}) and ${key}::text not in (${listOf((goingAway?.[ref] || []).map((r) => String(r[key])))})`);
      if (have.length !== ids.length) throw new Error(`${t}.${col} points at ${ids.length - have.length} ${ref} row(s) the target does not have: nothing loaded.`);
    }
  }
  // Leave-proof files only in demo people's folders.
  const D = new Set(bundle.demoIds || []);
  const foreign = (bundle.files || []).filter((f) => !D.has(String(f.path).split("/")[0]));
  if (foreign.length) throw new Error(`${foreign.length} file(s) outside the demo people's folders (${foreign[0].path}): nothing loaded.`);
  // Run numbers already taken on the target: the demo's move up.
  const runs = (bundle.tables.payroll_runs || []).map((r) => ({ ...r }));
  bundle.tables.payroll_runs = runs;
  for (const run of runs) {
    // A branch and period has at most one run that is not approved, and it is
    // the latest (ensure_payroll_run): never stack a demo run on the target's
    // open one, or an open demo run on any target run (2026-11-15: Main
    // Branch, October 16-31, 2026 ended up with two Pending runs).
    const [open] = await db.rows(`select count(*)::int n, count(*) filter (where status <> 'approved')::int pending from payroll_runs where branch_id = ${lit(run.branch_id)} and period_start = ${lit(run.period_start)} and id not in (${notTheBundles})`);
    if (open.n > 0 && (open.pending > 0 || run.status !== "approved")) {
      throw new Error(`The target already has a payroll run for branch ${run.branch_id}, ${run.period_label}${open.pending ? " that is not approved" : ""}; a demo run there would make two runs open at once: nothing loaded.`);
    }
    // Every demo run of the branch and period moves up by the same amount (no two land on one number).
    const [taken] = await db.rows(`select coalesce(max(run_no), 0)::int m from payroll_runs where branch_id = ${lit(run.branch_id)} and period_start = ${lit(run.period_start)} and id not in (${notTheBundles})`);
    if (taken.m > 0) run.run_no = taken.m + run.run_no;
  }
  // Payslip numbers already taken on the target: the demo's move up.
  const payslips = [...new Set(["payroll_records", "payroll_entries", "payroll_run_items"].flatMap((t) => (bundle.tables[t] || []).map((r) => r.payslip_no)).filter(Boolean))];
  const renumber = new Map();
  if (payslips.length) {
    const prefixes = [...new Set(payslips.map((p) => p.replace(/-\d+$/, "")))];
    for (const prefix of prefixes) {
      const [top] = await db.rows(`select coalesce(max((regexp_replace(payslip_no, '^.*-', ''))::int), 0)::int m from payroll_records where payslip_no like ${lit(`${prefix}-%`)} and id::text not in (${listOf(idsOf("payroll_records"))})`);
      const mine = payslips.filter((p) => p.startsWith(`${prefix}-`)).sort();
      const clash = top.m > 0;
      mine.forEach((p, i) => { if (clash) renumber.set(p, `${prefix}-${String(top.m + i + 1).padStart(4, "0")}`); });
    }
  }
  const notes = describeFit(fit, renumber);
  if (renumber.size) notes.push(`${renumber.size} payslip numbers move up past the target's own`);
  return { meta, bundle, renumber, notes, source, recheck: Boolean(goingAway), goingAway, snapshotFile };
}

/** What a plan decided, to compare a plan made before the wipe with one made after it. */
const decisions = (plan) => JSON.stringify({
  notes: plan.notes,
  runs: (plan.bundle.tables.payroll_runs || []).map((r) => [r.id, r.run_no]),
  renumber: [...plan.renumber],
});

/** Print a plan's notes (before the prompts). */
function printPlan(plan) {
  if (!plan.notes.length) return say("Fitted to the target: nothing to change.");
  say("Fitted to the target:");
  plan.notes.forEach((n) => say(`  ${n}`));
}

/** Wipe and load after a snapshot: any failure says how to put the demo data back. */
async function afterSnapshot(db, snapFile, run) {
  try {
    await run();
  } catch (error) {
    const hint = `node scripts/demo/demo.mjs restore --target=${db.target} --file=${snapFile}`;
    if (error.nothingDeleted) error.message = `${error.message}\nThe demo data is as it was (snapshot kept: ${snapFile}).`;
    else if (!String(error.message).includes(hint)) error.message = `${error.message}\nThe demo data may be deleted (the wipe is all or nothing) or partly loaded. Restore it: ${hint}`;
    throw error;
  }
}

/** The demo rows a reset / restore wipes first (`data` from snapshot()). */
const goingAwayOf = (data) => data.tables || {};

/** Load a planned bundle into `db` (seed / reset / restore). */
async function load(db, planned) {
  let plan = planned;
  if (!planned.recheck) {
    // No wipe (seed): plan again right before the first insert; the target may
    // have changed while the prompts waited (a run opened, payslip numbers taken).
    plan = await planLoad(db, planned.source);
    if (decisions(plan) !== decisions(planned)) throw new Error(`The target changed since the plan was shown: nothing loaded. Run the command again to see the new plan.\nShown: ${decisions(planned).slice(0, 400)}\nNow:   ${decisions(plan).slice(0, 400)}`);
  } else {
    // After a wipe, before the first insert. The demo rows are already gone,
    // so any stop here says how to put them back.
    const restore = planned.snapshotFile ? `Restore it: node scripts/demo/demo.mjs restore --target=${db.target} --file=${planned.snapshotFile}` : "Restore the snapshot taken before the wipe.";
    const stop = (why) => new Error(`${why}\nNothing loaded; the demo rows were already deleted. ${restore}`);
    // 1. The wipe must have deleted every demo row it was meant to (it keeps
    //    one that a non-demo row still points at, directly or through another row).
    const meta = await schema(db);
    const left = [];
    for (const [t, rows] of Object.entries(planned.goingAway || {})) {
      const key = meta[t]?.key;
      if (!key || !rows.length) continue;
      const ids = rows.map((r) => String(r[key]));
      for (let i = 0; i < ids.length; i += 500) {
        const found = await db.rows(`select ${key}::text k from ${t} where ${key}::text in (${ids.slice(i, i + 500).map(lit).join(", ")})`);
        found.forEach((r) => left.push(`${t} ${r.k}`));
      }
    }
    if (left.length) throw stop(`${left.length} demo row(s) are still there after the wipe (added while the prompts waited?):\n  ${left.slice(0, 20).join("\n  ")}`);
    // 2. Plan again against the target as it now is; any difference stops the load.
    try {
      plan = await planLoad(db, planned.source);
    } catch (error) {
      throw stop(`After the wipe the load can no longer be planned: ${error.message}`);
    }
    if (decisions(plan) !== decisions(planned)) throw stop(`After the wipe the target is not what the plan expected (runs, run numbers or payslip numbers differ).\nShown: ${decisions(planned).slice(0, 400)}\nNow:   ${decisions(plan).slice(0, 400)}`);
  }
  const { meta, bundle, renumber } = plan;
  const remapText = (row) => {
    if (!renumber.size) return row;
    // One pass, each number looked up once (a chain of replacements could renumber a number twice).
    const text = JSON.stringify(row).replace(/"(PS-\d{6}-\d+)"/g, (match, no) => (renumber.has(no) ? `"${renumber.get(no)}"` : match));
    return JSON.parse(text);
  };

  // 0. No RFID cards (defense reset, 2026-11-12): the cards are registered live
  // with Register many cards. Only Lost cards are kept (those numbers stay
  // blocked); attendance history does not depend on a card.
  bundle.tables = withoutCards(bundle.tables);
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
  // Rows came with their own ids: move every id counter past the highest id,
  // or the next new row collides (2026-11-13: HR corrections failed with
  // "A record for this day was just created" on a fresh local seed).
  await db.exec(`do $$ declare r record; begin
    for r in select c.relname t, a.attname col, pg_get_serial_sequence('public.' || c.relname, a.attname) s
             from pg_class c join pg_attribute a on a.attrelid = c.oid join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
               and pg_get_serial_sequence('public.' || c.relname, a.attname) is not null loop
      execute format('select setval(%L, greatest((select coalesce(max(%I), 0) from public.%I), (select last_value from %s)))', r.s, r.col, r.t, r.s);
    end loop; end $$;`);
  return { renumbered: renumber.size };
}

/**
 * The wipe as ONE SQL transaction body (no begin / commit): drop the
 * profiles' PRC loops and the transient rows, clear the demo person on mixed
 * rows (nullable columns only), delete the demo rows children first, then
 * the logins. Nothing is kept on purpose: if any row cannot be deleted or
 * changed (a non-demo row still needs it, a CHECK, a NOT NULL column), the
 * whole transaction fails and nothing is deleted.
 */
async function wipeSql(db, data) {
  const meta = await schema(db);
  const D = data.demoIds.map(lit).join(", ");
  const names = Object.keys(data.tables).filter((t) => data.tables[t].length);
  const order = [...insertOrder(meta, names.filter((t) => t !== "profiles")).reverse(), "profiles"];
  const nullable = new Set((await db.rows("select table_name t, column_name c from information_schema.columns where table_schema = 'public' and is_nullable = 'YES'")).map((r) => `${r.t}.${r.c}`));
  // Bounded: a lock that does not come within 5 s, or a statement over 45 s,
  // fails the whole wipe (rolled back) instead of holding live tables.
  const sql = [`set local lock_timeout = '5s'; set local statement_timeout = '45s'; set local idle_in_transaction_session_timeout = '15s';
    select pg_advisory_xact_lock(${WIPE_LOCK});
    alter table profiles disable trigger user;
    update profiles set prc_id_document_id = null, license_verified_by = null where id in (${D});
    update profiles set license_verified_by = null where license_verified_by in (${D}) and id not in (${D});
    alter table profiles enable trigger user;
    delete from hr_queue_claims where claimed_by in (${D});
    delete from notification_channels where user_id in (${D});`];
  // Mixed rows keep themselves; only their pointer to a demo person is cleared (a NOT NULL one makes the wipe fail).
  for (const t of Object.keys(data.mixed || {})) {
    const m = meta[t];
    for (const col of m.person.filter((c) => nullable.has(`${t}.${c}`))) {
      const notDemoRow = m.person.filter((c) => c !== col).map((c) => `(${c} is not null and ${c} not in (${D}))`).join(" or ") || "false";
      sql.push(`alter table ${t} disable trigger user; update ${t} set ${col} = null where ${col} in (${D}) and (${notDemoRow}); alter table ${t} enable trigger user;`);
    }
  }
  for (const t of order) {
    const rows = data.tables[t] || [];
    if (!rows.length) continue;
    const key = meta[t]?.key || "id";
    sql.push(`alter table ${t} disable trigger user; delete from ${t} where ${key} in (${rows.map((r) => lit(r[key])).join(", ")}); alter table ${t} enable trigger user;`);
  }
  sql.push(`delete from auth.identities where user_id in (${D}); delete from auth.users where id in (${D});`);
  const body = sql.join("\n");
  // One request. Measured 2026-11-16: the Management API takes 3,000 KB and refuses 5,000 KB.
  if (body.length > 2_500_000) throw new Error(`The wipe is too large to send in one request (${Math.round(body.length / 1024)} KB; the limit used is 2,500 KB). Nothing changed; the wipe must be split before it can run.`);
  return body;
}

/** Held by the wipe transaction until it commits or rolls back (pg_advisory_xact_lock). */
const WIPE_LOCK = 734211907;

/**
 * After a failed request: wait until the wipe transaction has ended (its lock
 * is free again), then count the demo people. The wipe is one transaction, so
 * all of them still there = nothing deleted, none left = committed. A lock
 * still held after about 3 minutes, a partial count, or no answer = unknown.
 */
async function wipeOutcome(db, data) {
  try {
    let ended = false;
    for (let i = 0; i < 36 && !ended; i += 1) {
      const [lock] = await db.rows(`select case when pg_try_advisory_lock(${WIPE_LOCK}) then pg_advisory_unlock(${WIPE_LOCK}) else false end as free`);
      ended = lock.free === true;
      if (!ended) await new Promise((r) => setTimeout(r, 5000));
    }
    if (!ended) return "unknown";
    const [left] = await db.rows(`select count(*)::int n from profiles where id in (${data.demoIds.map(lit).join(", ")})`);
    if (left.n === data.demoIds.length) return "nothing";
    if (left.n === 0) return "committed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The wipe run and rolled back (before any prompt): whether it can finish,
 * exactly, with the database's reason when it cannot. Returns the SQL, which
 * the real wipe then runs unchanged. Nothing stays changed (it ends in
 * rollback); it locks the demo tables for a few seconds.
 */
async function dryRunWipe(db, data) {
  if (!data.demoIds?.length) return null;
  const sql = await wipeSql(db, data);
  try {
    await db.exec(`begin;\n${sql}\nrollback;`, { retry: false });
  } catch (error) {
    const refusal = new Error(error.refused
      ? `The wipe could not finish, so this is refused before anything is deleted (tried and rolled back; the database said):\n  ${String(error.message).slice(0, 600)}`
      : `The wipe could not be tried (no clear answer from the database), so this is refused; nothing was deleted (the trial ends in rollback):\n  ${String(error.message).slice(0, 600)}`);
    refusal.nothingDeleted = true;
    throw refusal;
  }
  return sql;
}

/** Delete the demo rows in one transaction (all or nothing) with the SQL the dry run tried, then their leave-proof files. */
async function wipe(db, data, sql) {
  if (!data.demoIds?.length) { say("  nothing demo to delete"); return; }
  try {
    // Never resent: after a lost answer the commit may already have happened.
    await db.exec(`begin;\n${sql}\ncommit;`, { retry: false });
  } catch (error) {
    let outcome = await wipeOutcome(db, data);
    // Everyone still there proves "nothing deleted" only when the database itself
    // answered with its error; after a lost or early-failed request the wipe may
    // not have started yet and could still run.
    if (outcome === "nothing" && !error.refused) outcome = "unknown";
    if (outcome !== "committed") {
      const failed = new Error(outcome === "nothing"
        ? `The wipe failed and nothing was deleted (checked: every demo person is still there).\n  ${String(error.message).slice(0, 600)}`
        : `The wipe's outcome is unknown (no clear answer, and the check could not settle it). Check with: node scripts/demo/demo.mjs counts --target=${db.target}\n  ${String(error.message).slice(0, 600)}`);
      failed.nothingDeleted = outcome === "nothing";
      throw failed;
    }
    say("  the answer was lost, but the wipe committed (checked: no demo person left)");
  }
  for (const t of Object.keys(data.tables).filter((x) => data.tables[x].length)) say(`  deleted ${t}: ${data.tables[t].length}`);
  // Files after the commit: a failure here leaves files of people already removed (the next load replaces them).
  try {
    await storageFor(db.target).remove((data.files || []).map((f) => f.path));
  } catch (error) {
    throw new Error(`The demo rows were deleted, but their leave-proof files were not removed: ${error.message}`);
  }
}

async function checkZero(db) {
  const [r] = await db.rows(`select (select count(*) from profiles where ${demoFilter()})::int profiles,
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

/** The bundle's tables without card numbers: Lost cards (and their history) only, no card number on any profile. */
export function withoutCards(tables) {
  const kept = (tables.rfid_cards || []).filter((c) => c.status === "lost");
  const ids = new Set(kept.map((c) => c.id));
  return {
    ...tables,
    rfid_cards: kept.map((c) => (c.replaces_card_id && !ids.has(c.replaces_card_id) ? { ...c, replaces_card_id: null } : c)),
    rfid_card_events: (tables.rfid_card_events || []).filter((e) => ids.has(e.card_id)),
    profiles: (tables.profiles || []).map((p) => ({ ...p, rfid_uid: null })),
  };
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
    printCounts(`will CREATE on ${db.target}`, bundle);
    const plan = await planLoad(db, bundle);
    printPlan(plan);
    const [have] = await db.rows(`select count(*)::int n from profiles where ${demoFilter()}`);
    if (have.n) { say(`${have.n} demo profiles already on ${db.target}.`); if (process.env.DEMO_RESUME === "1") say("Resuming an interrupted seed (DEMO_RESUME=1): rows already there are skipped."); else if (!(await confirm('Demo data exists. Type "add anyway" to load on top:', "add anyway"))) return say("Nothing done."); }
    if (!(await confirm(`Load this on ${db.target}? (yes/no)`))) return say("Nothing done.");
    await load(db, plan);
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
    const { data, file: snapFile } = await snapshot(db);
    printCounts(`will DELETE on ${db.target} (is_demo data only)`, data);
    if (data.demoIds.length) await refuseNeededRows(db, await schema(db), goingAwayOf(data));
    const wipeBody = await dryRunWipe(db, data);
    if (!(await confirm(`Delete all of it on ${db.target}? (yes/no)`))) return say("Nothing deleted (the snapshot is kept).");
    await afterSnapshot(db, snapFile, () => wipe(db, data, wipeBody));
    await checkZero(db);
    say("Deleted rows stay in the Supabase Pro daily backups for about 7 days.");
  },
  async restore() {
    const db = await chooseTarget(rest);
    if (db.target === "local") globalThis.__localSupabase = (await import("../../e2e/local-env.mjs")).localSupabase();
    const file = arg("file");
    if (!file || !existsSync(file)) throw new Error("--file=<snapshot> is required.");
    const target = readBundle(file);
    const { data, file: snapFile } = await snapshot(db);
    printCounts(`will DELETE on ${db.target}`, data);
    printCounts("then LOAD", target);
    const plan = await planLoad(db, target, { goingAway: goingAwayOf(data), snapshotFile: snapFile });
    const wipeBody = await dryRunWipe(db, data);
    printPlan(plan);
    if (!(await confirm("Restore this snapshot? (yes/no)"))) return say("Nothing done.");
    await afterSnapshot(db, snapFile, async () => { await wipe(db, data, wipeBody); await load(db, plan); });
  },
  async plan() {
    // READ-ONLY: what a reset with this bundle would do on the target (nothing is written or deleted).
    const db = await chooseTarget(rest);
    const bundle = readBundle(arg("file") || BUNDLE);
    const data = await collect(db);
    const D = data.demoIds.map(lit).join(", ") || "null";
    const [logins] = await db.rows(`select count(*)::int n from auth.users where id::text in (${D})`);
    const [files] = await db.rows(`select count(*)::int n from storage.objects where bucket_id = '${STORAGE_BUCKET}' and split_part(name, '/', 1) in (${D})`);
    printCounts(`would DELETE on ${db.target}`, { ...data, auth: { users: Array(logins.n).fill(0), identities: [] }, files: Array(files.n).fill(0) });
    printCounts("then LOAD", bundle);
    printPlan(await planLoad(db, bundle, { goingAway: goingAwayOf(data) }));
    // The wipe is tried and rolled back: whether a reset could finish, exactly.
    // It locks the demo tables for a few seconds (bounded by lock_timeout).
    if (data.demoIds.length) {
      say("Trying the wipe and rolling it back (locks the demo tables for a few seconds)...");
      const body = await dryRunWipe(db, { ...data, files: [] });
      say(`The wipe (${Math.round(body.length / 1024)} KB in one request) was tried and rolled back: it can finish.`);
    } else say("No demo data on the target: nothing to wipe.");
    say("Nothing was changed (plan only).");
  },
  async reset() {
    const db = await chooseTarget(rest);
    if (db.target === "local") globalThis.__localSupabase = (await import("../../e2e/local-env.mjs")).localSupabase();
    const bundle = readBundle(BUNDLE);
    const { data, file: snapFile } = await snapshot(db);
    printCounts(`will DELETE on ${db.target} (your edits included)`, data);
    printCounts("then LOAD the original seed", bundle);
    const plan = await planLoad(db, bundle, { goingAway: goingAwayOf(data), snapshotFile: snapFile });
    const wipeBody = await dryRunWipe(db, data);
    printPlan(plan);
    if (!(await confirm("Reset wipes every edit made to the demo data. Continue? (yes/no)"))) return say("Nothing done.");
    if (!(await confirm('Type "reset demo" to confirm a second time:', "reset demo"))) return say("Nothing done.");
    await afterSnapshot(db, snapFile, async () => { await wipe(db, data, wipeBody); await load(db, plan); });
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
    const manilaNow = new Date(Date.now() + 8 * 3600e3);
    const today = manilaNow.toISOString().slice(0, 10);
    const until = to < today ? to : today;
    if (from > until) return say(`Nothing to add: attendance already reaches ${last.d}.`);
    // An evening run (from 20:00 Manila, after the last overtime tap-out at 19:29): today is a
    // finished day like the others (tapped in and out; the few absent are marked by the nightly
    // job). Earlier in the day, today looks live: some tapped in only, some not yet.
    const dayOver = until < today || manilaNow.getUTCHours() >= 20;
    const asOf = dayOver ? new Date(Date.parse(`${until}T00:00:00Z`) + 864e5).toISOString().slice(0, 10) : today;
    say(`Will ADD attendance for ${active.length} demo people from ${from} to ${until} (working days, never a future day; nothing existing is changed:`);
    say(dayOver ? `${until} is treated as a finished day (taps in and out).` : `It is before 20:00 Manila: ${until} is filled as a day in progress (some tapped in only, some not yet). Run it from 20:00 for a finished day.`);
    say("passwords, rates, approvals and anything edited by hand stay as they are).");
    say(`It first replaces ${auto.n} automatic Absent day(s) the nightly job made since ${from} (no tap, never edited).`);
    if (!(await confirm("Add it? (yes/no)"))) return say("Nothing done.");
    await db.exec(`begin; alter table attendance_logs disable trigger user;
      delete from attendance_logs where employee_id in (${ids}) and log_date >= ${lit(from)}
        and time_in is null and time_out is null and status = 'Absent' and changed_by is null and leave_request_id is null;
      alter table attendance_logs enable trigger user; commit;`);
    await db.exec(attendanceSql({ people: active, from, to: until, today: asOf, nowMinutes: 24 * 60 }));
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
