// LOCAL ONLY. Builds the whole demo dataset on the local Supabase stack
// through the real app (routes, guards, triggers, payroll engine), so the
// bundle copied to production holds exactly what the system itself computed.
//
//   node scripts/demo/build-local.mjs [--no-reset] [--stage=base|attendance|flows|payroll|all]
//
// Needs: Docker + the local stack, the local app on :3101
// (node e2e/attendance/prod-server.mjs), SUPABASE_ACCESS_TOKEN (read-only
// reads of production's configuration so local computes like production).
import { execSync } from "node:child_process";
import { BRANCHES, HISTORY_FROM, SEED_ACTOR } from "./config.mjs";
import { database, lit } from "./db.mjs";
import { as, localAuthAdmin, ok } from "./local-api.mjs";
import { buildRoster, saveCredentials, saveRosterCsv, stableId } from "./roster.mjs";

const args = process.argv.slice(2);
const stage = (args.find((a) => a.startsWith("--stage=")) || "--stage=all").split("=")[1];
const local = database("local");
const prod = database("production");
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

/** Configuration copied from production (same ids), so local computes like production. */
const MIRROR = [
  ["attendance_holidays", "true"],
  ["employee_positions", "true"],
  ["payroll_rate_configs", "true"],
  ["payroll_tax_brackets", "true"],
  ["payroll_sss_msc_brackets", "true"],
  ["payroll_schedule_settings", "true"],
  ["payroll_subsidy_settings", "true"],
  ["school_break_periods", "true"],
  ["system_config", "true"],
  ["tenure_protection_policies", "true"],
  ["work_schedules", "true"],
  ["work_schedule_assignments", "employee_id is null"],
  ["payroll_window_enforcement", "true"],
];

/**
 * The profile row for one roster person, with plain (fake) government numbers:
 * the database encrypts them with its own key on insert, so the same SQL runs
 * locally and on production. Columns without a value keep the table default.
 */
export function profileInsert(p) {
  const values = {
    id: p.id, email: p.email, full_name: p.full, first_name: p.first, middle_name: p.middle, last_name: p.last, role: p.role,
    employee_id: p.employee_id, branch_id: p.branch_id, employee_type: p.employee_type, position: p.position, basic_salary: p.basic_salary,
    date_hired: p.date_hired, employee_status: "Active", archived: false, is_demo: true, cp_number: p.cp_number,
    address: p.on_payroll ? "Demo Street, Antipolo City, Rizal" : null,
    sss_number: p.sss_number, philhealth_number: p.philhealth_number, pagibig_number: p.pagibig_number, tin_number: p.tin_number,
  };
  const cols = Object.keys(values).filter((k) => values[k] !== null && values[k] !== undefined);
  return `insert into profiles (${cols.join(", ")}) values (${cols.map((k) => (k === "role" ? `${lit(values[k])}::user_role` : lit(values[k]))).join(", ")})
    on conflict (id) do update set full_name = excluded.full_name, is_demo = true;`;
}

export async function loadBranches() {
  const codes = BRANCHES.map((b) => b.code);
  const rows = await prod.rows(`select * from branches where code in (${codes.map(lit).join(",")})`);
  if (rows.length !== codes.length) throw new Error(`Production branches ${codes.join(", ")} not all found.`);
  return rows;
}

async function stageBase() {
  if (!args.includes("--no-reset")) {
    log("resetting the local database (migrations + seed)…");
    execSync("npx supabase db reset", { stdio: "ignore" });
  }
  const branches = await loadBranches();
  log("mirroring production configuration into local…");
  const sql = ["begin;", "set local session_replication_role = replica;"];
  sql.push(`insert into branches select * from jsonb_populate_recordset(null::branches, ${lit(branches)}) on conflict (id) do update set name = excluded.name, code = excluded.code, location = excluded.location, status = excluded.status;`);
  for (const [table, where] of MIRROR) {
    const rows = await prod.rows(`select * from ${table} where ${where}`);
    sql.push(`delete from ${table} where ${where};`);
    if (rows.length) sql.push(`insert into ${table} select * from jsonb_populate_recordset(null::${table}, ${lit(rows)});`);
    log(`  ${table}: ${rows.length}`);
  }
  // Build on any date: the processing window switch OFF locally (production's own switch is not touched).
  sql.push("update payroll_window_enforcement set enforced = false, expires_on = null, reason = 'Local demo build', changed_by = null, changed_by_name = 'Demo seed';");
  sql.push("commit;");
  await local.exec(sql.join("\n"));

  const branchCodes = Object.fromEntries(branches.map((b) => [b.code, b]));
  const roster = buildRoster(branchCodes);
  saveCredentials(roster);
  saveRosterCsv(roster, branchCodes);

  log(`creating ${roster.length} accounts…`);
  for (const p of roster) {
    await localAuthAdmin.upsertUser({ id: p.id, email: p.email, password: p.password, user_metadata: {
      role: p.role, full_name: p.full, branch_id: p.branch_id, employee_id: p.employee_id, employee_type: p.employee_type || null,
      position: p.position || null, basic_salary: p.basic_salary || null, employee_status: "Active", is_demo: true } });
  }
  const profileSql = roster.map((p) => profileInsert(p));
  // Demo positions the roster uses (created by Demo HR 1; removed with the demo).
  const hr1 = roster.find((p) => p.tag === "hr1");
  const positions = [...new Set(roster.map((p) => p.position).filter(Boolean))];
  const posSql = positions.map((name) => `insert into employee_positions (name, created_by, created_by_name)
    select ${lit(name)}, ${lit(hr1.id)}, ${lit(hr1.full)} where not exists (select 1 from employee_positions where lower(name) = lower(${lit(name)}));`);
  await local.exec(["begin;", ...profileSql, ...posSql, "commit;"].join("\n"));
  log("profiles and positions written");
  return { roster, branchCodes };
}

export async function context() {
  const branches = await loadBranches();
  const branchCodes = Object.fromEntries(branches.map((b) => [b.code, b]));
  const roster = buildRoster(branchCodes);
  const by = (tag) => roster.find((p) => p.tag === tag);
  return { roster, branchCodes, by, payroll: roster.filter((p) => p.on_payroll) };
}

async function stageCards() {
  const { roster, by } = await context();
  const hr = by("hr1");
  log("registering RFID cards through HR…");
  for (const p of roster.filter((x) => x.on_payroll)) {
    const res = await as(hr).post("/api/rfid/cards", { action: "register", employee_id: p.id, uid: p.rfid_uid, reason: "Demo card issued" });
    if (res.status !== 200 && res.status !== 201 && !/already/i.test(JSON.stringify(res.data))) ok(`card for ${p.tag}`, res);
  }
  const cards = await local.rows("select id, employee_id, uid from rfid_cards where status = 'active'");
  const card = (tag) => cards.find((c) => c.employee_id === by(tag).id);
  // Every status: inactive, lost, replaced (the replacement stays active).
  ok("deactivate", await as(hr).patch("/api/rfid/cards", { action: "deactivate", card_id: card("emp5").id, reason: "Card kept by the office while on leave" }));
  ok("reactivate", await as(hr).patch("/api/rfid/cards", { action: "reactivate", card_id: card("emp5").id, reason: "Back from leave" }));
  ok("deactivate 2", await as(hr).patch("/api/rfid/cards", { action: "deactivate", card_id: card("emp21").id, reason: "Separated employee: card returned" }));
  ok("replace (lost)", await as(hr).patch("/api/rfid/cards", { action: "replace", card_id: card("emp3").id, new_uid: "9990000901", reason: "Reported lost at the canteen", lost: true }));
  ok("replace (damaged)", await as(hr).patch("/api/rfid/cards", { action: "replace", card_id: card("emp12").id, new_uid: "9990000902", reason: "Damaged card", lost: false }));
  ok("mark lost", await as(hr).patch("/api/rfid/cards", { action: "mark_lost", card_id: card("emp17").id, reason: "Lost; replacement not yet issued" }));
  log("cards done");
}

/** Manila "today" (YYYY-MM-DD). */
export function manilaToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

/**
 * Attendance from HISTORY_FROM (or the hire date) up to TODAY, never later.
 * Only tap times are written; the real status engine labels each day and
 * the database's own day-closing adds Absent / Holiday days.
 */
export function attendanceSql({ people, from, to, today, nowMinutes }) {
  // Each person's last working day: the roster's separation date, or "to".
  const until = people.map((p) => `(${lit(p.id)}::uuid, ${lit(p.separated_on || to)}::date)`).join(", ");
  // h: a stable 0-99 per person per day, so a rebuild is identical.
  return `
with days as (
  select p.id, p.full_name, p.employee_type, p.branch_id, d::date as log_date,
         (get_byte(decode(md5(p.id::text || d::date::text), 'hex'), 0) * 100 / 256) as h,
         (get_byte(decode(md5(d::date::text || p.id::text), 'hex'), 1) % 30) as m
  from profiles p
  join (values ${until}) u(id, last_day) on u.id = p.id
  cross join generate_series(${lit(from)}::date, ${lit(to)}::date, interval '1 day') d
  where d::date >= coalesce(p.date_hired, ${lit(from)}::date) and d::date <= u.last_day
    and extract(isodow from d) < 6
    and not exists (select 1 from attendance_holidays x where x.holiday_date = d::date and x.day_part = 'whole' and public.attendance_holiday_applies(x.branch_ids, p.branch_id))
    and not exists (select 1 from attendance_logs a where a.employee_id = p.id and a.log_date = d::date and not a.archived_duplicate)
), taps as (
  select *,
    case when h < 3 then null                                   -- absent (the day-closing marks it)
         when h < 10 then time '08:12' + m * interval '1 minute' -- late (not charged)
         when h < 14 then time '07:50' + (m % 10) * interval '1 minute'
         when h < 16 then time '13:30'                            -- half day (under 4 hours)
         when h < 31 then time '07:15' + (m % 29) * interval '1 minute' -- early bird
         else time '07:46' + (m % 19) * interval '1 minute' end as t_in,
    case when h < 3 then null
         when h >= 10 and h < 14 then time '15:30' + m * interval '1 minute' -- undertime
         when h >= 31 and h < 33 then time '19:00' + m * interval '1 minute' -- overtime
         else time '17:00' + (m % 15) * interval '1 minute' end as t_out
  from days
)
insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out)
select id, full_name, employee_type, branch_id, log_date,
  (log_date + t_in) at time zone 'Asia/Manila',
  case
    when log_date = ${lit(today)}::date and (h < 60 or ${nowMinutes} < 17 * 60) then null -- today: tapped in only
    when log_date >= ${lit(from)}::date and log_date < ${lit(today)}::date and log_date >= date_trunc('month', ${lit(today)}::date) and h between 96 and 97 then null -- Incomplete (current cutoff)
    else (log_date + t_out) at time zone 'Asia/Manila' end
from taps
where t_in is not null
  and not (log_date = ${lit(today)}::date and h >= 85) -- today: some have not tapped yet
  and not (log_date = ${lit(today)}::date and (extract(hour from t_in) * 60 + extract(minute from t_in)) > ${nowMinutes});`;
}

async function stageAttendance() {
  const { payroll } = await context();
  const today = manilaToday();
  const now = new Date(Date.now() + 8 * 3600e3);
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  log(`attendance ${HISTORY_FROM} → ${today} for ${payroll.length} people…`);
  await local.exec(attendanceSql({ people: payroll, from: HISTORY_FROM, to: today, today, nowMinutes }));
  // The nightly job's work, up to yesterday: Absent / Holiday days.
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
  await local.exec(`select public.attendance_close_days(${lit(HISTORY_FROM)}::date, ${lit(yesterday)}::date);`);
  const counts = await local.rows(`select status, count(*)::int n from attendance_logs a join profiles p on p.id = a.employee_id where p.is_demo group by 1 order by 2 desc`);
  log("attendance statuses:", counts.map((c) => `${c.status} ${c.n}`).join(", "));
}

const stages = { base: stageBase, cards: stageCards, attendance: stageAttendance };

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` || process.argv[1].endsWith("build-local.mjs")) {
  const order = stage === "all" ? Object.keys(stages) : stage.split(",");
  for (const name of order) {
    if (!stages[name]) throw new Error(`Unknown stage ${name}`);
    log(`== stage ${name}`);
    await stages[name]();
  }
  log("done");
}

export { SEED_ACTOR, stableId };
