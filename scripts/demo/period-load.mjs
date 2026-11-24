// Moving the defense data (scripts/demo/period.mjs build) to live, and back (2026-11-24).
//
//   node scripts/demo/period-load.mjs export                          LOCAL -> demo-data/period-bundle.json
//   DEMO_READ_ONLY=1 node scripts/demo/period-load.mjs plan --target=production
//        READ-ONLY: per person, what is replaced (rows per table now -> after) and the payslip nets; also saves
//        live's current rows of the same scope as demo-data/period-rollback-<time>.json (the rollback bundle)
//   node scripts/demo/period-load.mjs apply --target=production --file=demo-data/period-bundle.json
//   node scripts/demo/period-load.mjs apply --target=production --file=demo-data/period-rollback-<time>.json   (rollback)
//
// apply = ONE transaction: delete the scope's rows on the target, insert the bundle's, apply the record updates.
// The bundle is staged first in private.demo_period_stage (chunks), so one statement moves it all; the
// stage table is dropped at the end. No key or password is printed.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, PRODUCTION } from "./config.mjs";
import { confirm, database, lit } from "./db.mjs";
import * as PLAN from "./period-plan.mjs";
import { SCOPE, scopeWhere } from "./period-scope.mjs";
import { stableId } from "./roster.mjs";

/** The kept approver accounts (renamed with the load). */
const ACTOR_IDS = [stableId("hr1"), stableId("acc-b1-1")];

const [command, ...rest] = process.argv.slice(2);
const target = (rest.find((a) => a.startsWith("--target=")) || "--target=local").split("=")[1];
const file = (rest.find((a) => a.startsWith("--file=")) || "--file=demo-data/period-bundle.json").split("=")[1];
const log = (...m) => console.log(...m);

/** Also replaced for these accounts: their cards (+ events), license changes, subsidy balances. Children first. */
const EXTRA = [
  ["rfid_card_events", "employee_id in S"],
  ["rfid_cards", "employee_id in S"],
  ["employee_license_changes", "employee_id in S"],
  ["payroll_subsidy_balances", "employee_id in S"],
];
/** --only=nov16 (2026-11-26): the Nov 16-30 payslips and their lines only (a recompute moved to live). */
const ONLY = (rest.find((a) => a.startsWith("--only=")) || "").split("=")[1] || "";
const NOV16 = [
  ["payroll_loan_payments", "employee_id in S and pay_period = 'November 16-30, 2026'"],
  ["tenure_protection_applications", "employee_id in S and pay_period = 'November 16-30, 2026'"],
  ["payroll_deductions", "employee_id in S and period_start = '2026-11-16'"],
  ["payroll_incentives", "employee_id in S and period_start = '2026-11-16'"],
  ["payroll_review_flags", "employee_id in S and pay_period = 'November 16-30, 2026'"],
  ["payroll_entries", "employee_id in S and pay_period = 'November 16-30, 2026'"],
  ["payroll_records", "employee_id in S and period_start = '2026-11-16'"],
  ["early_bird_winners", "period_start = '2026-11-16'"],
  ["incentive_recommendations", "employee_id in S and period_start = '2026-11-16'"],
];
const ALL = ONLY === "nov16" ? NOV16 : [...SCOPE, ...EXTRA];
/** Each table once: for inserts, parents first (the reverse of its FIRST place in the delete order). */
const INSERT_ORDER = [...new Set(ALL.map(([t]) => t))].reverse().map((t) => [t]);
/** Profile columns the build sets (PII as plain numbers: the target's own trigger encrypts them). */
const PROFILE_COLS = ["first_name", "middle_name", "last_name", "full_name", "branch_id", "employee_id", "position", "basic_salary", "date_hired", "employee_type",
  "employment_status", "employee_status", "payroll_hold", "payroll_hold_reason", "cp_number", "address", "emergency_contact_name", "emergency_contact_relationship",
  "emergency_contact_address", "emergency_contact_number", "separation_reason", "separated_on", "rfid_uid", "on_payroll"];

/** The accounts on payroll on `db` (the same rule as the build), their branches, and anyone else paid in the replaced runs. */
async function scopeOf(db) {
  const ids = (await db.rows("select id from profiles where not archived and on_payroll and lower(role::text) in ('employee','accountant','hr') order by id")).map((r) => r.id);
  const branches = (await db.rows("select id from branches where code in ('BR-001','BR-003') order by code")).map((r) => r.id);
  const paid = (await db.rows(`select distinct employee_id from payroll_entries where run_id in (select id from payroll_runs where branch_id in (${branches.map(lit).join(", ")}) and period_start >= ${lit(PLAN.FROM)})`)).map((r) => r.employee_id);
  return { ids, branches, paid, from: PLAN.FROM };
}

async function collect(db, scope) {
  const tables = {};
  for (const [t, w] of ALL) {
    const rows = await db.rows(`select * from public.${t} where ${scopeWhere(w, scope)}`);
    const seen = new Map((tables[t] || []).map((r) => [r.id, r]));
    for (const r of rows) seen.set(r.id, r);
    tables[t] = [...seen.values()];
  }
  return tables;
}

async function exportBundle() {
  const db = database("local");
  const scope = await scopeOf(db);
  const tables = await collect(db, scope);
  const people = PLAN.PEOPLE.map((p, i) => ({ ...p, n: i + 1 }));
  const profiles = await db.rows(`select id, ${PROFILE_COLS.join(", ")} from profiles where id in (${scope.ids.map(lit).join(", ")})`);
  // Plain government numbers from the plan (the local copy holds only its own encryption).
  const byCode = Object.fromEntries((await db.rows(`select id, employee_id, full_name, lower(role::text) as role from profiles where id in (${scope.ids.map(lit).join(", ")})`)).map((r) => [r.id, r]));
  for (const pr of profiles) {
    const p = people.find((x) => (x.code || x.match.code) === pr.employee_id || (x.match.name && byCode[pr.id].role === x.match.role && (x.match.name === byCode[pr.id].full_name)));
    if (p && !/^(marisol|carlo|liza|ramon|nestor)$/.test(p.key)) Object.assign(pr, PLAN.govNumbers(p.n));
  }
  // License changes go in with the plain number (the target encrypts it).
  for (const r of tables.employee_license_changes) {
    const p = people.find((x) => x.licensed && profiles.find((pr) => pr.id === r.employee_id && pr.employee_id === x.match.code));
    if (p) r.prc_license_no = p.licensed.no;
    delete r.prc_license_no_enc; delete r.prc_license_no_last4;
  }
  const salary = await db.rows(`select id, effective_date from employee_salary_changes where employee_id in (${scope.ids.map(lit).join(", ")})`);
  const rates = await db.rows(`select * from payroll_rate_configs where note = ${lit(PLAN.DEMO_NOTE)}`);
  const config = await db.rows("select section, key, value from system_config where section = 'early_bird' and key = 'incentive_amount'");
  const audit = await db.rows(`select * from audit_logs where created_at >= (select min(created_at) from payroll_runs where period_start >= ${lit(PLAN.FROM)}) - interval '30 minutes'`);
  const actors = await db.rows(`select id, first_name, middle_name, last_name, full_name from profiles where id in (${ACTOR_IDS.map(lit).join(", ")})`);
  const bundle = ONLY ? { made_at: new Date().toISOString(), kind: "build", scope_rule: ONLY, tables, records: {} }
    : { made_at: new Date().toISOString(), kind: "build", scope_rule: "on payroll, Oct 1 to today", tables, records: { profiles, salary, rates, config, audit, actors } };
  const out = join(DATA_DIR, ONLY ? `period-${ONLY}-bundle.json` : "period-bundle.json");
  writeFileSync(out, JSON.stringify(bundle));
  log(`bundle written: ${out}`);
  for (const [t, rows] of Object.entries(tables)) if (rows.length) log(`  ${t.padEnd(32)} ${rows.length}`);
  log(`  profiles ${profiles.length}, salary dates ${salary.length}, rate rows ${rates.length}, audit entries ${audit.length}`);
}

/** Per person: rows now on the target vs in the bundle, and the payslip nets per period. */
async function plan() {
  if (target !== "production") throw new Error("plan reads the target named with --target=production");
  const db = database(target);
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  const scope = await scopeOf(db);
  const live = await collect(db, scope);
  // The rollback bundle: live's rows of the same scope, its profiles and records, as they are now.
  const profiles = await db.rows(`select id, ${PROFILE_COLS.join(", ")} from profiles where id in (${scope.ids.map(lit).join(", ")})`);
  const salary = await db.rows(`select id, effective_date from employee_salary_changes where employee_id in (${scope.ids.map(lit).join(", ")})`);
  const config = await db.rows("select section, key, value from system_config where section = 'early_bird' and key = 'incentive_amount'");
  const actors = await db.rows(`select id, first_name, middle_name, last_name, full_name from profiles where id in (${ACTOR_IDS.map(lit).join(", ")})`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rb = join(DATA_DIR, `period-rollback-${stamp}.json`);
  writeFileSync(rb, JSON.stringify({ made_at: new Date().toISOString(), kind: "rollback", tables: live,
    records: { profiles, salary, rates_remove: (bundle.records.rates || []).map((r) => r.id), config, actors, audit_remove: (bundle.records.audit || []).map((a) => a.id) } }));
  const names = Object.fromEntries((await db.rows(`select id, full_name, employee_id from profiles where id in (${scope.ids.map(lit).join(", ")})`)).map((r) => [r.id, r]));
  const newNames = Object.fromEntries((bundle.records.profiles || []).map((p) => [p.id, p.full_name]));
  log(`Target: ${target}. Scope: ${scope.ids.length} accounts on payroll, ${scope.branches.length} branches, from ${scope.from}.`);
  const missing = (bundle.records.profiles || []).filter((p) => !scope.ids.includes(p.id));
  if (!ONLY && (missing.length || (bundle.records.profiles || []).length !== scope.ids.length)) log(`  DIFFERENCE: the accounts on payroll differ from the bundle's (${missing.length} not on the target).`);
  log("\nRows per table (target now -> after):");
  for (const [t] of ALL) {
    const a = live[t]?.length || 0, b = bundle.tables[t]?.length || 0;
    if (a || b) log(`  ${t.padEnd(32)} ${String(a).padStart(5)} -> ${b}`);
  }
  const personCol = (t) => (t === "notifications" ? "recipient_id" : t === "substitutions" ? "substitute_id" : "employee_id");
  log("\nPer person (rows now -> after: attendance, taps, leave, overtime, payslips) and payslip nets after:");
  for (const id of scope.ids) {
    const n = (tables, t) => (tables[t] || []).filter((r) => r[personCol(t)] === id).length;
    const nets = (bundle.tables.payroll_entries || []).filter((e) => e.employee_id === id)
      .map((e) => `${String(e.pay_period).replace(", 2026", "").replace("ember", "").replace("ober", "")}: ${e.status === "paid" && e.run_id ? "Paid" : e.run_id ? e.status : "ready"} ₱${Number(e.payroll?.totals?.net_pay || e.net_pay || 0).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`);
    const who = newNames[id] && newNames[id] !== names[id].full_name ? `${names[id].full_name} -> ${newNames[id]}` : names[id].full_name;
    log(`  ${who} (${names[id].employee_id || "no ID yet"})`);
    log(`     ${["attendance_logs", "attendance_taps", "leave_requests", "overtime_requests", "payroll_entries"].map((t) => `${n(live, t)}->${n(bundle.tables, t)}`).join(", ")}`);
    log(`     ${nets.join("; ") || "no payslip"}`);
  }
  log(`\nRecord updates: ${bundle.records.profiles.length} profiles (names, branch, IDs, contacts, government numbers, emergency contacts), ${bundle.records.salary.length} salary-history dates, ` +
    `${(bundle.records.actors || []).map((a) => a.full_name).join(" and ")} (the two approver accounts, renamed), ${(bundle.records.rates || []).length} rate row(s) (${PLAN.DEMO_NOTE}), Early Bird ₱${PLAN.EARLY_BIRD}, ${(bundle.records.audit || []).length} audit entries.`);
  log(`Rollback bundle saved: ${rb}`);
  log("Nothing was changed (plan only).");
}

/** One transaction on the target: stage, delete the scope, insert the bundle, records. */
async function apply() {
  const db = database(target);
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  if (target === "production") {
    console.log(`PRODUCTION. Type the project URL to continue (${PRODUCTION.url}):`);
    if (!(await confirm(">", PRODUCTION.url))) return log("The URL did not match. Nothing was done.");
  }
  const scope = await scopeOf(db);
  const cols = await db.rows("select table_name as t, column_name as c from information_schema.columns where table_schema = 'public' and is_generated = 'NEVER' and coalesce(identity_generation, '') <> 'ALWAYS' order by table_name, ordinal_position");
  const colsOf = (t) => cols.filter((x) => x.t === t).map((x) => x.c);
  // Stage in chunks (a statement per chunk), then one transaction does the rest.
  await db.exec("create table if not exists private.demo_period_stage (tbl text not null, seq int not null, rows jsonb not null); truncate private.demo_period_stage;");
  let seq = 0;
  for (const [t] of INSERT_ORDER) {
    const rows = bundle.tables[t] || [];
    for (let i = 0; i < rows.length; i += 200) {
      seq += 1;
      await db.exec(`insert into private.demo_period_stage values (${lit(t)}, ${seq}, $stage$${JSON.stringify(rows.slice(i, i + 200)).replace(/\$stage\$/g, "")}$stage$::jsonb);`);
    }
  }
  const r = bundle.records;
  const sql = ["begin;"];
  for (const [t] of ALL) sql.push(`alter table public.${t} disable trigger user;`);
  for (const [t, w] of ALL) sql.push(`delete from public.${t} where ${scopeWhere(w, scope)};`);
  // Rate rows first: the payslip lines point at them.
  for (const x of r.rates || []) sql.push(`insert into public.payroll_rate_configs (id, rate_type, scope, scope_ref, value, effective_date, note, created_by, created_by_name, created_at) values (${lit(x.id)}, ${lit(x.rate_type)}, ${lit(x.scope)}, ${x.scope_ref ? lit(x.scope_ref) : "null"}, ${x.value}, ${lit(x.effective_date)}, ${lit(x.note)}, ${x.created_by ? lit(x.created_by) : "null"}, ${lit(x.created_by_name)}, ${lit(x.created_at)}) on conflict (id) do nothing;`);
  const insertOf = (t, order = "") => {
    const c = colsOf(t).filter((x) => Object.prototype.hasOwnProperty.call(bundle.tables[t][0], x) || x === "prc_license_no");
    const list = c.map((x) => `"${x}"`).join(", ");
    return `insert into public.${t} (${list}) select ${list} from jsonb_populate_recordset(null::public.${t}, (select coalesce(jsonb_agg(e order by s.seq), '[]') from private.demo_period_stage s, jsonb_array_elements(s.rows) e where s.tbl = ${lit(t)}))${order};`;
  };
  for (const [t] of INSERT_ORDER) {
    if (!(bundle.tables[t] || []).length || t === "employee_license_changes") continue;
    const c = colsOf(t).filter((x) => Object.prototype.hasOwnProperty.call(bundle.tables[t][0], x) || x === "prc_license_no");
    const list = c.map((x) => `"${x}"`).join(", ");
    sql.push(`insert into public.${t} (${list}) select ${list} from jsonb_populate_recordset(null::public.${t}, (select coalesce(jsonb_agg(e order by s.seq), '[]') from private.demo_period_stage s, jsonb_array_elements(s.rows) e where s.tbl = ${lit(t)}));`);
  }
  for (const [t] of ALL) sql.push(`alter table public.${t} enable trigger user;`);
  // License changes go in with their triggers ON: the trigger encrypts the plain number and updates the profile.
  if ((bundle.tables.employee_license_changes || []).length) sql.push(insertOf("employee_license_changes"));
  // Records.
  // The card number on the profile follows the cards loaded above (only that guard is off; encryption stays on).
  sql.push("alter table public.profiles disable trigger profiles_rfid_uid_guard;");
  for (const p of r.profiles || []) {
    const set = Object.entries(p).filter(([k]) => k !== "id").map(([k, v]) => `"${k}" = ${v === null ? "null" : lit(v)}`);
    sql.push(`update public.profiles set ${set.join(", ")}, updated_at = now() where id = ${lit(p.id)};`);
    sql.push(`update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('full_name', ${lit(p.full_name)}, 'branch_id', ${p.branch_id ? lit(p.branch_id) : "null"}, 'employee_id', ${p.employee_id ? lit(p.employee_id) : "null"}, 'employee_status', ${lit(p.employee_status)}) where id = ${lit(p.id)};`);
  }
  sql.push("alter table public.profiles enable trigger profiles_rfid_uid_guard;");
  for (const a of r.actors || []) {
    sql.push(`update public.profiles set first_name = ${lit(a.first_name)}, middle_name = ${a.middle_name ? lit(a.middle_name) : "null"}, last_name = ${lit(a.last_name)}, full_name = ${lit(a.full_name)}, updated_at = now() where id = ${lit(a.id)};`);
    sql.push(`update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('full_name', ${lit(a.full_name)}) where id = ${lit(a.id)};`);
  }
  sql.push("alter table public.employee_salary_changes disable trigger user;");
  for (const s of r.salary || []) sql.push(`update public.employee_salary_changes set effective_date = ${lit(s.effective_date)} where id = ${lit(s.id)};`);
  sql.push("alter table public.employee_salary_changes enable trigger user;");
  if ((r.rates_remove || []).length) sql.push(`alter table public.payroll_rate_configs disable trigger user; delete from public.payroll_rate_configs where id in (${r.rates_remove.map(lit).join(", ")}); alter table public.payroll_rate_configs enable trigger user;`);
  for (const x of r.config || []) sql.push(`update public.system_config set value = ${lit(x.value)} where section = ${lit(x.section)} and key = ${lit(x.key)};`);
  if ((r.audit || []).length) {
    seq += 1;
    await db.exec(`insert into private.demo_period_stage values ('audit_logs', ${seq}, $stage$${JSON.stringify(r.audit).replace(/\$stage\$/g, "")}$stage$::jsonb);`);
    const list = colsOf("audit_logs").filter((x) => Object.prototype.hasOwnProperty.call(r.audit[0], x)).map((x) => `"${x}"`).join(", ");
    sql.push(`alter table public.audit_logs disable trigger user; insert into public.audit_logs (${list}) select ${list} from jsonb_populate_recordset(null::public.audit_logs, (select jsonb_agg(e) from private.demo_period_stage s, jsonb_array_elements(s.rows) e where s.tbl = 'audit_logs')) on conflict (id) do nothing; alter table public.audit_logs enable trigger user;`);
  }
  if ((r.audit_remove || []).length) sql.push(`alter table public.audit_logs disable trigger user; delete from public.audit_logs where id in (${r.audit_remove.map(lit).join(", ")}); alter table public.audit_logs enable trigger user;`);
  sql.push("drop table private.demo_period_stage;");
  sql.push("commit;");
  await db.exec(sql.join("\n"));
  const after = await collect(db, await scopeOf(db));
  log("applied. Rows now:");
  for (const [t] of ALL) if ((after[t] || []).length || (bundle.tables[t] || []).length) log(`  ${t.padEnd(32)} ${(after[t] || []).length} (bundle ${(bundle.tables[t] || []).length})`);
}

const commands = { export: exportBundle, plan, apply };
if (!commands[command]) { console.log(`Commands: ${Object.keys(commands).join(", ")}`); process.exit(1); }
await commands[command]();
