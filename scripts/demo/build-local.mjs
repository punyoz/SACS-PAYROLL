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
import crypto from "node:crypto";
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

/** The "Demo seed" actor (decision 6): flagged demo, banned (no login), archived, no branch. */
async function ensureSeedActor(branchCodes, { assignTo = null } = {}) {
  const s = SEED_ACTOR;
  await localAuthAdmin.upsertUser({ id: s.id, email: "demo-seed@invalid.example", password: `${crypto.randomUUID()}Aa1!`, user_metadata: { role: "accountant", full_name: s.name, branch_id: assignTo ? branchCodes[assignTo].id : null, is_demo: true } });
  await local.exec(`update auth.users set banned_until = '2099-01-01' where id = ${lit(s.id)};
    insert into profiles (id, email, full_name, first_name, last_name, role, branch_id, employee_type, employee_status, archived, is_demo)
    values (${lit(s.id)}, 'demo-seed@invalid.example', ${lit(s.name)}, 'Demo', 'Seed', 'accountant', ${lit(assignTo ? branchCodes[assignTo].id : null)}, 'Non-Teaching', 'Active', ${assignTo ? "false" : "true"}, true)
    on conflict (id) do update set branch_id = excluded.branch_id, archived = excluded.archived, is_demo = true;`);
  return { id: s.id, role: "accountant", full: s.name, email: "demo-seed@invalid.example", branch_id: assignTo ? branchCodes[assignTo].id : null, tag: "demo-seed" };
}

/** Every cutoff label from `fromKey` up to (not including) the one holding `untilKey`. */
export async function cutoffs(fromKey, untilKey) {
  const { periodForDateKey, nextPeriod } = await import("../../src/lib/payroll/periods.js");
  const out = [];
  let p = periodForDateKey(fromKey);
  const stop = periodForDateKey(untilKey).start_key;
  while (p.start_key < stop) { out.push(p); p = nextPeriod(p.start_key); }
  return out;
}

/**
 * One branch, one cutoff, through the real flow: the Accountant(s) process
 * ("Process payroll for all"; an Accountant's own payslip by the other
 * Accountant, or self-processed when the branch has one), submit the run,
 * and HR decides (never an HR whose own payslip is in the run).
 */
/** The run submission; Branch 4's "Demo seed" processor is not an employee (acknowledged, dropped at export). */
function submitBody(branch, label, accountants) {
  const seed = accountants.find((a) => a.id === SEED_ACTOR.id);
  return { action: "submit", branch_id: branch.id, period: label,
    ...(seed ? { acknowledge_exclusions: true, exclusion_notes: { [seed.id]: "Demo seed actor: not an employee (processes Branch 4's history only)." } } : {}) };
}

async function processCutoff({ branch, label, accountants, people, approver, mode = "approve", rejectFirst = false }) {
  const entries = people.map((p) => ({ employee_id: p.id }));
  for (const acc of accountants) {
    const res = await as(acc).post("/api/accountant/payroll", { action: "batch_submit", pay_period: label, entries });
    ok(`${branch.code} ${label} batch by ${acc.tag}`, res);
  }
  const done = await local.rows(`select count(*)::int n from payroll_entries where pay_period = ${lit(label)} and branch_id = ${lit(branch.id)} and status <> 'draft'`);
  if (done[0].n < people.length) throw new Error(`${branch.code} ${label}: ${done[0].n} of ${people.length} payslips processed`);
  if (mode === "process") return;
  ok(`${branch.code} ${label} submit`, await as(accountants[0]).patch("/api/accountant/payroll-runs", submitBody(branch, label, accountants)));
  if (mode === "submit") return;
  const [run] = await local.rows(`select id from payroll_runs where branch_id = ${lit(branch.id)} and period_label = ${lit(label)} order by run_no desc limit 1`);
  if (rejectFirst) {
    ok(`${branch.code} ${label} reject`, await as(approver).patch("/api/hr/payroll-runs", { action: "reject", run_id: run.id, remarks: "Please recheck the late and undertime minutes before resubmitting." }));
    // The Accountant reprocesses and resubmits.
    for (const acc of accountants) ok(`${branch.code} ${label} reprocess`, await as(acc).post("/api/accountant/payroll", { action: "batch_submit", pay_period: label, entries }));
    ok(`${branch.code} ${label} resubmit`, await as(accountants[0]).patch("/api/accountant/payroll-runs", submitBody(branch, label, accountants)));
  }
  if (mode === "reject") {
    ok(`${branch.code} ${label} reject`, await as(approver).patch("/api/hr/payroll-runs", { action: "reject", run_id: run.id, remarks: "Two attendance corrections are still pending; please wait for HR, then resubmit." }));
    return;
  }
  const approved = await as(approver).patch("/api/hr/payroll-runs", { action: "approve", run_ids: [run.id] });
  ok(`${branch.code} ${label} approve`, approved);
  if (!approved.data?.approved) throw new Error(`${branch.code} ${label} not approved: ${JSON.stringify(approved.data).slice(0, 300)}`);
}

async function stagePayroll({ history = false } = {}) {
  const { roster, branchCodes, by } = await context();
  const today = manilaToday();
  const list = await cutoffs(HISTORY_FROM, today);
  const last = list.at(-1);        // the latest finished cutoff: submitted, waiting for HR
  const beforeLast = list.at(-2);  // rejected once, fixed, approved (history shows both)
  const from = args.find((a) => a.startsWith("--from="))?.split("=")[1] || HISTORY_FROM;
  // The "payroll" stage alone: the history before October (loans and incentives are filed after it);
  // "close" processes the rest.
  const to = args.find((a) => a.startsWith("--to="))?.split("=")[1] || (history ? addDays(beforeLast.start_key, -1) : today);
  const seed = await ensureSeedActor(branchCodes, { assignTo: BRANCHES.at(-1).code });
  try {
    for (const [bi, branch] of BRANCHES.entries()) {
      const b = branchCodes[branch.code];
      const people = roster.filter((p) => p.on_payroll && p.branch_code === branch.code);
      let accountants = roster.filter((p) => p.role === "accountant" && p.branch_code === branch.code);
      if (!accountants.length) accountants = [seed];
      // Never an HR whose own payslip is in the run: HR One's home is Branch 1.
      const approver = branch.hrHome === 1 ? by("hr2") : by("hr1");
      for (const period of list) {
        if (period.start_key < from || period.start_key > to) continue;
        // A separated person is paid through Final Pay from the cutoff holding the separation date.
        const staff = people.filter((p) => (p.date_hired || "") <= period.end_key && (!p.separated_on || p.separated_on > period.end_key));
        if (!staff.length) continue;
        const isLast = period.label === last.label;
        const isBeforeLast = period.label === beforeLast.label;
        if (accountants[0] === seed && isLast) continue; // Branch 4: nobody processes the latest cutoffs
        const mode = isLast ? (bi === 1 ? "reject" : "submit") : "approve";
        // Idempotent: a cutoff already at (or past) its target state is left alone.
        const [existing] = await local.rows(`select status from payroll_runs where branch_id = ${lit(b.id)} and period_label = ${lit(period.label)} order by run_no desc limit 1`);
        if (existing && (existing.status === "approved" || existing.status === { submit: "pending", reject: "rejected" }[mode])) continue;
        await processCutoff({ branch: b, label: period.label, accountants, people: staff, approver, mode, rejectFirst: isBeforeLast && bi === 0 });
        log(`  ${branch.code} ${period.label}: ${mode}${isBeforeLast && bi === 0 ? " (rejected once, fixed)" : ""}`);
      }
    }
  } finally {
    await ensureSeedActor(branchCodes); // back to no branch, archived
  }
}

const failures = [];
/** Run one demo step; a failure is logged and the build carries on (reported at the end). */
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
async function step(name, fn) {
  if (only.length && !only.some((o) => name.includes(o))) return null;
  try { const out = await fn(); log(`  ✓ ${name}${out ? ` (${out})` : ""}`); return out; } catch (error) { failures.push(`${name}: ${error.message}`); log(`  ✗ ${name}: ${String(error.message).slice(0, 260)}`); return null; }
}
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** The weekday on or after a date key. */
const weekday = (key) => { let k = key; while ([0, 6].includes(new Date(`${k}T00:00:00Z`).getUTCDay())) k = addDays(k, 1); return k; };
const PROOF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64")}`;

/**
 * Everything else the pages need (G6/G7), through the real routes as the
 * right person: leave in every state (HR's and the Accountant's too), past
 * decided leave, corrections, overtime, blocked taps, duplicate taps (audit
 * log only), loans / cash advances / incentives in every state, the Admins'
 * requests, tenure grants, salary changes, announcements, separations.
 */
async function stageFlows() {
  const { roster, branchCodes, by } = await context();
  const today = manilaToday();
  const B = (code) => branchCodes[code];
  const acc = { "BR-001": by("acc-b1-1"), "BR-002": by("acc-b2-1"), "BR-003": by("acc-b3-1") };
  const hrFor = (p) => (p.tag === "hr1" ? by("hr2") : by("hr1"));

  await step("past leave (approved / rejected / cancelled)", async () => {
    const rows = [
      ["emp1", "2026-10-06", "2026-10-07", "approved", "Vacation Leave", "paid"], ["emp2", "2026-10-20", "2026-10-20", "approved", "Sick Leave", "paid"],
      ["emp9", "2026-10-13", "2026-10-14", "approved", "Vacation Leave", "paid"], ["emp10", "2026-10-27", "2026-10-27", "approved", "Leave Without Pay", "unpaid"],
      ["emp17", "2026-11-04", "2026-11-05", "approved", "Sick Leave", "paid"], ["emp22", "2026-10-08", "2026-10-08", "approved", "Vacation Leave", "paid"],
      ["hr1", "2026-10-22", "2026-10-22", "approved", "Vacation Leave", "paid"], ["acc-b2-2", "2026-10-29", "2026-10-29", "approved", "Sick Leave", "paid"],
      ["emp3", "2026-10-09", "2026-10-09", "rejected", "Vacation Leave", "paid"], ["emp18", "2026-10-16", "2026-10-16", "cancelled", "Vacation Leave", "paid"],
    ];
    const sql = rows.map(([tag, start, end, status, type, pay]) => {
      const p = by(tag); const d = hrFor(p); const cancelled = status === "cancelled";
      return `insert into leave_requests (id, employee_id, employee_name, position, leave_type, start_date, end_date, reason, status, submitted_at, decided_at, updated_at, pay_status, decided_by, decided_by_name, decision_reason, cancelled_at, cancelled_by, cancelled_by_name)
        values (gen_random_uuid(), ${lit(p.id)}, ${lit(p.full)}, ${lit(p.position)}, ${lit(type)}, ${lit(start)}, ${lit(end)}, 'Demo leave', ${lit(status)}, ${lit(`${addDays(start, -10)}T01:00:00Z`)},
          ${cancelled ? "null" : lit(`${addDays(start, -8)}T02:00:00Z`)}, now(), ${lit(pay)}, ${cancelled ? "null" : lit(d.id)}, ${cancelled ? "null" : lit(d.full)},
          ${status === "rejected" ? lit("Too many staff on leave that week") : "null"}, ${cancelled ? lit(`${addDays(start, -5)}T02:00:00Z`) : "null"}, ${cancelled ? lit(p.id) : "null"}, ${cancelled ? lit(p.full) : "null"});`;
    }).join("\n");
    await local.exec(sql);
    return `${rows.length} rows`;
  });

  const start = weekday(addDays(today, 9));
  const filed = {};
  const filers = [["emp1", 0, true], ["emp2", 1, false], ["emp9", 2, true], ["emp10", 3, false], ["emp11", 4, false], ["emp12", 5, true], ["emp20", 6, false], ["emp23", 7, true],
    ["acc-b1-2", 8, false], ["acc-b3-1", 9, false], ["hr1", 10, false], ["hr2", 11, true], ["emp4", 12, false], ["emp13", 13, false]];
  for (const [tag, offset, proof] of filers) {
    const day = weekday(addDays(start, offset));
    filed[tag] = await step(`leave filed by ${tag}`, async () => ok(`leave ${tag}`, await as(by(tag)).post("/api/me/leave-requests", {
      leave_type: offset % 3 === 1 ? "Sick Leave" : "Vacation Leave", start_date: day, end_date: day, reason: `Demo: ${offset % 2 ? "family errand" : "medical check-up"}`,
      ...(proof ? { proof_url: PROOF } : {}) })).request.id);
  }
  await step("Admin leave recommendations", async () => {
    ok("endorse", await as(by("adm-b1-1")).post("/api/admin/branch-oversight", { action: "file", kind: "leave_endorsement", ref_id: filed.emp1, decision: "endorse", note: "Covered by a co-teacher." }));
    ok("not endorse", await as(by("adm-b1-2")).post("/api/admin/branch-oversight", { action: "file", kind: "leave_endorsement", ref_id: filed.emp2, decision: "not_endorse", note: "Exam week; please reschedule." }));
    ok("endorse b2", await as(by("adm-b2-1")).post("/api/admin/branch-oversight", { action: "file", kind: "leave_endorsement", ref_id: filed.emp9, decision: "endorse", note: "OK with the branch." }));
  });
  await step("HR decides leave (the other HR for an HR's own)", async () => {
    ok("approve emp9", await as(by("hr1")).patch("/api/hr/leave-requests", { id: filed.emp9, action: "approve" }));
    ok("reject emp10", await as(by("hr2")).patch("/api/hr/leave-requests", { id: filed.emp10, action: "reject", reason: "Overlaps the branch's exam schedule" }));
    ok("approve acc-b3-1", await as(by("hr1")).patch("/api/hr/leave-requests", { id: filed["acc-b3-1"], action: "approve" }));
    ok("approve hr1 by hr2", await as(by("hr2")).patch("/api/hr/leave-requests", { id: filed.hr1, action: "approve" }));
    ok("cancel own emp11", await as(by("emp11")).patch("/api/me/leave-requests", { id: filed.emp11, action: "cancel" }));
  });

  await step("attendance corrections (pending / approved / rejected)", async () => {
    const incomplete = await local.rows(`select a.id, a.employee_id from attendance_logs a join profiles p on p.id = a.employee_id where p.is_demo and a.status = 'Incomplete' and a.log_date < ${lit(today)} order by a.log_date, a.employee_id limit 6`);
    let filedCount = 0;
    for (const row of incomplete) {
      const person = roster.find((p) => p.id === row.employee_id);
      const res = await as(person).post("/api/me/attendance/corrections", { log_id: row.id, corrected_time: "17:05", reason: "Forgot to tap out; left at 5:05 PM." });
      if (res.status < 300) filedCount += 1; else log(`    correction for ${person.tag}: ${res.status} ${JSON.stringify(res.data).slice(0, 160)}`);
    }
    const list = (await as(by("sa1")).get("/api/attendance/corrections?status=pending")).data?.corrections
      || (await as(by("hr1")).get("/api/attendance/corrections?status=pending")).data?.corrections || [];
    const mine = list.filter((c) => roster.some((p) => p.id === c.employee_id));
    for (const [i, c] of mine.entries()) {
      const reviewer = c.employee_id === by("hr1").id ? by("hr2") : by("hr1");
      if (i < 2) ok("approve correction", await as(reviewer).patch("/api/attendance/corrections", { correction_id: c.id, decision: "approve", note: "Confirmed with the guard's logbook." }));
      else if (i === 2) ok("reject correction", await as(reviewer).patch("/api/attendance/corrections", { correction_id: c.id, decision: "reject", resolution: "incomplete", note: "No proof of the time out." }));
    }
    return `${filedCount} filed, ${mine.length} pending before review`;
  });

  await step("overtime decisions", async () => {
    const ot = await local.rows(`select a.id, a.employee_id from attendance_logs a join profiles p on p.id = a.employee_id where p.is_demo and a.log_date >= '2026-10-01' and (a.time_out at time zone 'Asia/Manila')::time >= '19:00' order by a.log_date, a.employee_id limit 6`);
    let n = 0;
    for (const [i, row] of ot.entries()) {
      if (i === 5) break; // one stays pending
      const reviewer = row.employee_id === by("hr1").id ? by("hr2") : by("hr1");
      ok("overtime", await as(reviewer).patch("/api/attendance/overtime", { log_id: row.id, decision: i === 3 ? "reject" : "approve", approved_minutes: i === 3 ? 0 : 120, note: i === 3 ? "Not requested in advance." : "Approved: event preparation." }));
      n += 1;
    }
    return `${n} decided of ${ot.length}`;
  });

  await step("blocked taps + duplicate taps (audit log only)", async () => {
    const picks = [by("emp5"), by("emp14"), by("emp19"), by("emp24")];
    await local.exec(picks.map((p, i) => `insert into attendance_blocked_taps (employee_id, employee_name, branch_id, log_date, attempted_at, reason, rfid_code, source)
      values (${lit(p.id)}, ${lit(p.full)}, ${lit(p.branch_id)}, ${lit(addDays(today, -1 - i))}, ${lit(`${addDays(today, -1 - i)}T00:05:00Z`)}, ${lit(i % 2 ? "Tap more than 3 hours before the shift." : "On approved leave: tap refused.")}, ${lit(`••••${p.rfid_uid.slice(-4)}`)}, 'rfid');`).join("\n")
      + "\n" + picks.slice(0, 3).map((p, i) => `insert into audit_logs (module, action, entity_type, entity_id, description, status, source, branch_id, is_system_event, metadata)
      values ('attendance', 'rfid_duplicate_tap', 'employee', ${lit(p.employee_id)}, ${lit(`Duplicate RFID tap for ${p.full} 3 s after the one recorded at 7:5${i} AM (window 5 s); not counted.`)}, 'success', 'api', ${lit(p.branch_id)}, false,
        ${lit({ employee_id: p.id, duplicate: true, duplicate_window_seconds: 5, seconds_since: 3, date_key: addDays(today, -2 - i), demo: true })});`).join("\n"));
  });

  await step("loans granted in October (history: approved, deducted from October 16-31)", async () => {
    const plan = [["BR-001", "emp3", "salary_loan", 12000, 4], ["BR-001", "emp6", "cash_advance", 3000, 1], ["BR-001", "hr1", "salary_loan", 8000, 4], ["BR-002", "emp12", "cash_advance", 2500, 1], ["BR-002", "acc-b2-2", "emergency_loan", 4000, 2], ["BR-003", "emp19", "salary_loan", 6000, 2]];
    const sql = plan.map(([code, tag, type, principal, n]) => {
      const p = by(tag); const a = acc[code]; const d = hrFor(p);
      return `insert into payroll_loans (employee_id, branch_id, loan_type, description, date_granted, principal, interest_pct, number_of_payrolls, amortization, start_period, remaining_balance, status, final_pay_authorized, created_by, created_by_name, created_at, approval_status, decided_by, decided_by_name, decided_at, decision_note)
        values (${lit(p.id)}, ${lit(p.branch_id)}, ${lit(type)}, ${lit(`Demo ${type.replace(/_/g, " ")}`)}, '2026-10-05', ${principal}, 0, ${n}, ${Math.round((principal / n) * 100) / 100}, '2026-10-16', ${principal}, 'active', true,
          ${lit(a.id)}, ${lit(a.full)}, '2026-10-05T02:00:00Z', 'approved', ${lit(d.id)}, ${lit(d.full)}, '2026-10-06T03:00:00Z', 'Approved.');`;
    }).join("\n");
    await local.exec(sql);
    return `${plan.length} loans`;
  });
  await step("loans and cash advances (Accountant files)", async () => {
    const plan = [["BR-001", "emp3", "salary_loan", 12000, 4], ["BR-001", "emp4", "emergency_loan", 5000, 2], ["BR-001", "emp6", "cash_advance", 3000, 1], ["BR-001", "hr1", "salary_loan", 8000, 4],
      ["BR-002", "emp11", "salary_loan", 10000, 4], ["BR-002", "emp12", "cash_advance", 2500, 1], ["BR-002", "acc-b2-2", "emergency_loan", 4000, 2], ["BR-003", "emp19", "salary_loan", 6000, 2], ["BR-003", "emp21", "cash_advance", 2000, 1]];
    let n = 0;
    for (const [code, tag, type, principal, count] of plan) {
      const res = await as(acc[code]).post("/api/accountant/loans", { action: "create_loan", employee_id: by(tag).id, loan_type: type, principal, interest_pct: 0, number_of_payrolls: count,
        amortization: Math.round((principal / count) * 100) / 100, date_granted: today, start_period: "2026-11-16", description: `Demo ${type.replace(/_/g, " ")}`, final_pay_authorized: true });
      if (res.status < 300) n += 1; else log(`    loan ${tag}: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    return `${n} of ${plan.length}`;
  });
  await step("incentives and overload (Accountant files)", async () => {
    const plan = [["BR-001", "emp1", "incentive", 1500, null, "Perfect attendance award"], ["BR-001", "emp2", "overload", null, 6, "Extra class: Grade 6 Science"], ["BR-001", "emp5", "incentive", 800, null, "Event coordinator"],
      ["BR-002", "emp9", "incentive", 1200, null, "Recognition day host"], ["BR-002", "emp10", "overload", null, 4, "Extra class: Grade 4 Math"], ["BR-003", "emp20", "incentive", 1000, null, "Science fair adviser"], ["BR-003", "emp21", "overload", null, 3, "Remedial reading"]];
    let n = 0;
    for (const [code, tag, kind, amount, hours, description] of plan) {
      const res = await as(acc[code]).post("/api/accountant/payroll", { action: "add_monthly_item", employee_id: by(tag).id, item_date: "2026-10-12", kind, description, ...(amount ? { amount } : { hours }) });
      if (res.status < 300) n += 1; else log(`    item ${tag}: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    return `${n} of ${plan.length}`;
  });
  await step("HR decides loans and incentives (one of each stays pending)", async () => {
    const data = (await as(by("hr1")).get("/api/hr/adjustment-approvals?status=pending")).data || {};
    const rows = data.items || [...(data.loans || []).map((x) => ({ ...x, kind: "loan" })), ...(data.incentives || []).map((x) => ({ ...x, kind: "incentive" }))];
    const groups = { loan: rows.filter((r) => (r.kind || r.item_kind) === "loan" || r.loan_type), incentive: rows.filter((r) => !((r.kind || r.item_kind) === "loan" || r.loan_type)) };
    let n = 0;
    for (const [kind, list] of Object.entries(groups)) {
      for (const [i, r] of list.entries()) {
        if (i === list.length - 1) break;
        const decider = r.employee_id === by("hr1").id ? by("hr2") : by("hr1");
        ok(`${kind} decision`, await as(decider).patch("/api/hr/adjustment-approvals", { kind, id: r.id, decision: i === 2 ? "reject" : "approve", note: i === 2 ? "Not within this year's limit." : "Approved." }));
        n += 1;
      }
    }
    return `${n} decided of ${rows.length}`;
  });

  await step("Admin requests (flag, incidents, schedule, RFID issues, overtime, incentive)", async () => {
    const flagLog = (await local.rows(`select a.id from attendance_logs a where a.employee_id = ${lit(by("emp5").id)} and a.status = 'Late' order by a.log_date desc limit 1`))[0];
    const file = async (who, body) => ok(body.kind, await as(who).post("/api/admin/branch-oversight", { action: "file", ...body }));
    if (flagLog) await file(by("adm-b1-1"), { kind: "attendance_flag", ref_id: flagLog.id, note: "Late three times this week; please check." });
    await file(by("adm-b1-1"), { kind: "incident_report", employee_id: by("emp8").id, note: "Did not report for two days without notice.", details: { incident_type: "no_show", incident_date: weekday(addDays(today, -3)) } });
    await file(by("adm-b2-1"), { kind: "incident_report", employee_id: by("emp16").id, note: "Repeated tardiness this month.", details: { incident_type: "tardiness", incident_date: weekday(addDays(today, -4)) } });
    await file(by("adm-b1-1"), { kind: "schedule_request", employee_id: by("emp2").id, note: "Requested by the teacher.", details: { request_type: "schedule", effective_from: addDays(today, 14), requested: "Move to 7:00 AM - 4:00 PM for the morning shift" } });
    await file(by("adm-b3-1"), { kind: "schedule_request", employee_id: by("emp20").id, note: "Extra section.", details: { request_type: "class_load", effective_from: addDays(today, 14), requested: "Add one Grade 5 section" } });
    await file(by("adm-b2-1"), { kind: "rfid_issue", employee_id: by("emp12").id, note: "Card does not read at the gate.", details: { issue_type: "broken_card", device: "Main gate reader" } });
    await file(by("adm-b3-1"), { kind: "rfid_issue", note: "Reader beeps but records nothing.", details: { issue_type: "reader_fault", device: "Robinson lobby reader" } });
    await file(by("adm-b1-1"), { kind: "overtime_confirmation", employee_id: by("emp1").id, decision: "endorse", note: "Stayed for the PTA meeting.", details: { work_type: "overtime", work_date: weekday(addDays(today, -6)), hours: 2 } });
    await file(by("adm-b2-1"), { kind: "overtime_confirmation", employee_id: by("emp10").id, decision: "not_endorse", note: "Not asked to stay.", details: { work_type: "substitute", work_date: weekday(addDays(today, -5)), hours: 3, covered_for: "Andrea Ilagan" } });
    await file(by("adm-b1-2"), { kind: "incentive_endorsement", employee_id: by("emp6").id, note: "Coached the quiz bee winners.", details: { kind: "incentive", item_date: addDays(today, -2), amount: 1000, description: "Quiz bee coach" } });
    const reqs = (await as(by("hr1")).get("/api/hr/branch-requests?status=pending")).data?.requests || [];
    const rfid = reqs.find((r) => r.kind === "rfid_issue");
    if (rfid) ok("resolve rfid", await as(by("hr1")).patch("/api/hr/branch-requests", { id: rfid.id, decision: "resolve", note: "Replacement card issued." }));
    const sched = reqs.find((r) => r.kind === "schedule_request");
    if (sched) ok("approve schedule", await as(by("hr2")).patch("/api/hr/branch-requests", { id: sched.id, decision: "approve", note: "Approved from next month." }));
  });

  await step("tenure grants", async () => {
    for (const tag of ["emp4", "emp1", "emp9"]) { const r = await as(by("hr1")).post("/api/hr/tenure-protection", { action: "grant", employee_id: by(tag).id, effective_from: today, notes: "Over 5 years of service" }); if (r.status !== 409) ok(`grant ${tag}`, r); }
  });
  await step("salary changes (HR Two changes HR One's)", async () => {
    ok("emp6", await as(by("hr1")).post("/api/hr/salary-changes", { employee_id: by("emp6").id, new_salary: 23500, effective_date: "2026-12-01", reason: "Performance review", note: "Demo" }));
    ok("hr1 by hr2", await as(by("hr2")).post("/api/hr/salary-changes", { employee_id: by("hr1").id, new_salary: 36500, effective_date: "2026-12-01", reason: "Contract renewal", note: "Demo" }));
  });

  await step("announcements (25+)", async () => {
    const long = "Please read carefully. ".repeat(12) + "Thank you for your cooperation, and see the HR office for questions.";
    const posts = [];
    for (let i = 1; i <= 9; i += 1) posts.push([by(i % 2 ? "hr1" : "hr2"), "all", i % 3 === 0 ? "meeting" : "general", `School notice ${i}`, i % 4 === 0 ? long : `Demo school-wide notice number ${i}.`]);
    for (const [tag, code] of [["adm-b1-1", "BR-001"], ["adm-b1-2", "BR-001"], ["adm-b2-1", "BR-002"], ["adm-b2-2", "BR-002"], ["adm-b3-1", "BR-003"]]) {
      for (let i = 1; i <= 2; i += 1) posts.push([by(tag), B(code).id, i === 2 ? "schedule_change" : "general", `${B(code).name}: update ${i}`, i === 2 ? long : "Branch reminder for this week."]);
    }
    posts.push([by("hr1"), B("BR-004").id, "general", "Pinugay Branch: welcome", "A branch notice for Pinugay staff."]);
    for (let i = 1; i <= 5; i += 1) posts.push([by(i % 2 ? "sa1" : "sa2"), "all", i === 3 ? "holiday" : "general", `System notice ${i}`, i === 1 ? long : "Scheduled maintenance tonight from 10 PM."]);
    for (const [who, audience, category, title, body] of posts) ok(title, await as(who).post("/api/announcements", { title, body, category, audience }));
    return `${posts.length} posted`;
  });

  await step("separations (Final Pay)", async () => {
    for (const tag of ["emp7", "emp15"]) {
      const p = by(tag);
      ok(`separate ${tag}`, await as(by("hr1")).patch("/api/hr/employees", { id: p.id, action: "separate", effective: p.separated_on, reason: p.separation_reason, note: "Demo separation" }));
    }
  });
  log(failures.length ? `flows: ${failures.length} step(s) failed` : "flows: all steps passed");
}

/** What the first empty-page audit found missing (G8 → seed fixes). */
async function stageExtras() {
  const { roster, branchCodes, by } = await context();
  const today = manilaToday();
  const B = (code) => branchCodes[code];
  await step("a replaced card in Branch 1", async () => {
    const [card] = await local.rows(`select id from rfid_cards where employee_id = ${lit(by("emp2").id)} and status = 'active'`);
    ok("replace", await as(by("hr1")).patch("/api/rfid/cards", { action: "replace", card_id: card.id, new_uid: "9990000903", reason: "Cracked card", lost: false }));
  });
  await step("RFID issues in Branch 1 (pending and resolved)", async () => {
    for (const note of ["Card reads twice at the gate.", "Faculty room reader is slow."]) ok("rfid", await as(by("adm-b1-1")).post("/api/admin/branch-oversight", { action: "file", kind: "rfid_issue", employee_id: by("emp3").id, note, details: { issue_type: note.includes("reader") ? "reader_fault" : "broken_card", device: "Main gate reader" } }));
    const reqs = (await as(by("hr2")).get("/api/hr/branch-requests?status=pending")).data?.requests || [];
    const one = reqs.find((r) => r.kind === "rfid_issue" && r.branch_id === B("BR-001").id);
    if (one) ok("resolve", await as(by("hr2")).patch("/api/hr/branch-requests", { id: one.id, decision: "resolve", note: "Reader cleaned and tested." }));
  });
  await step("HR transfers (Branch 2 → 1, and into Branch 4)", async () => {
    ok("emp16", await as(by("hr1")).post("/api/admin/transfer-requests", { employee_id: by("emp16").id, to_branch_id: B("BR-001").id, remarks: "Needed in the Main Branch for the new section." }));
    ok("emp13", await as(by("hr2")).post("/api/admin/transfer-requests", { employee_id: by("emp13").id, to_branch_id: B("BR-004").id, remarks: "Moving to Pinugay (closer to home)." }));
  });
  await step("My Requests for the audit accounts + pending items in Branch 3", async () => {
    const loan = (who, tag, type, principal, n) => as(by(who)).post("/api/accountant/loans", { action: "create_loan", employee_id: by(tag).id, loan_type: type, principal, interest_pct: 0, number_of_payrolls: n, amortization: Math.round((principal / n) * 100) / 100, date_granted: today, start_period: "2026-11-16", description: `Demo ${type.replace(/_/g, " ")}`, final_pay_authorized: true });
    ok("acc-b1-1 loan (by the other Accountant)", await loan("acc-b1-2", "acc-b1-1", "salary_loan", 9000, 3));
    ok("acc-b1-1 cash advance", await loan("acc-b1-2", "acc-b1-1", "cash_advance", 2000, 1));
    ok("emp1 loan", await loan("acc-b1-1", "emp1", "emergency_loan", 4000, 2));
    ok("emp1 cash advance", await loan("acc-b1-1", "emp1", "cash_advance", 1500, 1));
    ok("emp20 loan (pending)", await loan("acc-b3-1", "emp20", "salary_loan", 7000, 4));
    ok("acc-b1-1 incentive", await as(by("acc-b1-2")).post("/api/accountant/payroll", { action: "add_monthly_item", employee_id: by("acc-b1-1").id, item_date: "2026-10-14", kind: "incentive", description: "Year-end audit support", amount: 1000 }));
    ok("emp18 incentive (pending)", await as(by("acc-b3-1")).post("/api/accountant/payroll", { action: "add_monthly_item", employee_id: by("emp18").id, item_date: "2026-10-14", kind: "incentive", description: "Reading program", amount: 700 }));
    const data = (await as(by("hr1")).get("/api/hr/adjustment-approvals?status=pending")).data || {};
    const rows = data.items || [...(data.loans || []).map((x) => ({ ...x, kind: "loan" })), ...(data.incentives || []).map((x) => ({ ...x, kind: "incentive" }))];
    for (const r of rows.filter((x) => [by("acc-b1-1").id, by("emp1").id].includes(x.employee_id))) {
      const kind = (r.kind || r.item_kind) === "loan" || r.loan_type ? "loan" : "incentive";
      ok("approve", await as(by("hr2")).patch("/api/hr/adjustment-approvals", { kind, id: r.id, decision: "approve", note: "Approved." }));
    }
  });
  await step("cash advances on the older Cash Advances page (history, read-only)", async () => {
    // That page is the history from before cash advances moved to Loans (read-only); two old entries, never deducted again.
    const rows = [["acc-b1-1", "emp5", "on_hold", "Waiting for the signed promissory note"], ["acc-b3-1", "emp18", "on_hold", "Waiting for the employee's signature"]];
    await local.exec(`begin; set local session_replication_role = replica;
      ${rows.map(([who, tag, status, reason]) => `insert into payroll_cash_advances (employee_id, branch_id, date_granted, principal, installment_amount, deduct_on, start_date, status, description, status_reason, status_changed_by, status_changed_by_name, status_changed_at, created_by, created_by_name, created_at)
        values (${lit(by(tag).id)}, ${lit(by(tag).branch_id)}, '2026-03-02', 1000, 500, 'second', '2026-03-16', ${lit(status)}, 'Demo cash advance (before Loans)', ${lit(reason)}, ${lit(by(who).id)}, ${lit(by(who).full)}, '2026-03-05T02:00:00Z', ${lit(by(who).id)}, ${lit(by(who).full)}, '2026-03-02T02:00:00Z');`).join(" ")}
      commit;`);
  });
  await step("AWOL confirmed (payroll on hold)", async () => {
    const cases = (await as(by("hr1")).get("/api/hr/awol-cases")).data?.cases || [];
    const c = cases.find((x) => x.employee_id === by("emp8").id);
    if (!c) return "no case";
    ok("confirm", await as(by("hr1")).patch("/api/hr/awol-cases", { case_id: c.id, action: "confirm", note: "Could not be reached for three days." }));
  });
  await step("holiday duty (Bonifacio Day)", async () => {
    ok("assign", await as(by("hr1")).post("/api/holiday-duty", { action: "assign", holiday_date: "2026-11-30", employee_ids: [by("emp1").id, by("emp2").id, by("emp9").id, by("emp19").id], note: "School event" }));
  });
  await step("BIR alphalist file (2026)", async () => {
    for (const who of ["acc-b1-1", "acc-b3-1"]) { const r = await as(by(who)).get("/api/payroll/bir-forms?year=2026&format=xlsx"); if (r.status >= 300) throw new Error(`${who}: ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`); }
  });
  await step("a separation in Branch 3 (Final Pay)", async () => {
    const p = by("emp21");
    ok("separate", await as(by("hr2")).patch("/api/hr/employees", { id: p.id, action: "separate", effective: today, reason: "Resigned", note: "Demo separation" }));
    ok("final pay", await as(by("acc-b3-1")).post("/api/accountant/final-pay", { employee_id: p.id, release_on: addDays(today, 14) }));
  });
  await step("draft payslips in the current cutoff (the cutoff stays open to process live)", async () => {
    const { periodForDateKey } = await import("../../src/lib/payroll/periods.js");
    const label = periodForDateKey(today).label;
    for (const [who, tags] of [["acc-b1-1", ["emp1", "emp2"]], ["acc-b2-1", ["emp9", "emp10"]], ["acc-b3-1", ["emp17", "emp18"]]]) {
      for (const tag of tags) ok(`${tag} draft`, await as(by(who)).post("/api/accountant/payroll", { action: "save_draft", employee_id: by(tag).id, pay_period: label }));
    }
  });
  log(failures.length ? `extras: ${failures.length} step(s) failed` : "extras: all steps passed");
}

/** The second audit's gaps (G8 → seed). */
async function stageExtras2() {
  const { by } = await context();
  const today = manilaToday();
  await step("payroll corrections (one approved, one pending, one rejected)", async () => {
    const entries = await local.rows(`select e.id, e.employee_id from payroll_entries e join payroll_runs r on r.id = e.run_id where r.status = 'approved' and e.pay_period = 'September 16-30, 2026'
      and e.employee_id in (${["emp3", "emp4", "emp11", "emp19"].map((t) => lit(by(t).id)).join(", ")})`);
    const accOf = (id) => ({ [by("emp3").id]: by("acc-b1-1"), [by("emp4").id]: by("acc-b1-1"), [by("emp11").id]: by("acc-b2-1"), [by("emp19").id]: by("acc-b3-1") }[id]);
    const ids = [];
    for (const [i, e] of entries.entries()) {
      const res = ok("file", await as(accOf(e.employee_id)).post("/api/payroll/corrections", { entry_id: e.id, kind: i % 2 ? "overpayment" : "underpayment", amount: 250 + i * 50, payrolls: 1, reason: i % 2 ? "Overtime counted twice" : "Holiday premium was missed" }));
      ids.push(res.correction?.id || res.id);
    }
    if (ids[0]) ok("approve", await as(by("hr1")).patch("/api/payroll/corrections", { id: ids[0], action: "approve", note: "Checked against the timesheet." }));
    if (ids[1]) ok("reject", await as(by("hr2")).patch("/api/payroll/corrections", { id: ids[1], action: "reject", note: "The overtime was approved separately; no recovery." }));
    return `${ids.length} filed`;
  });
  await step("holiday worked without an assignment (for HR's review)", async () => {
    await local.exec(["emp3", "emp19"].map((t) => `insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out)
      select id, full_name, employee_type, branch_id, date '2026-11-02', timestamptz '2026-11-02 07:55+08', timestamptz '2026-11-02 12:05+08' from profiles where id = ${lit(by(t).id)}
      on conflict do nothing;`).join("\n"));
  });
  await step("Branch Requests and AWOL cases decided", async () => {
    const reqs = (await as(by("hr1")).get("/api/hr/branch-requests?status=pending")).data?.requests || [];
    for (const r of reqs.filter((x) => ["attendance_flag", "incentive_endorsement", "incident_report"].includes(x.kind)).slice(0, 3)) {
      ok(r.kind, await as(by("hr1")).patch("/api/hr/branch-requests", { id: r.id, decision: r.kind === "incentive_endorsement" ? "approve" : "resolve", note: "Handled by HR." }));
    }
    const opened = await as(by("hr2")).post("/api/hr/awol-cases", { employee_id: by("emp24").id, first_absent_on: "2026-10-26", last_present_on: "2026-10-23", notes: "Absent for three days without notice." });
    const id = opened.data?.case?.id || opened.data?.id;
    if (id) ok("close", await as(by("hr2")).patch("/api/hr/awol-cases", { case_id: id, action: "close", outcome: "returned", returned_on: "2026-10-29", note: "Returned with a medical certificate." }));
    return opened.status;
  });
  await step("Branch 3's latest run rejected (Payroll Monitoring › Rejected by HR)", async () => {
    const [run] = await local.rows(`select r.id from payroll_runs r join branches b on b.id = r.branch_id where b.code = 'BR-003' and r.status = 'pending' limit 1`);
    if (run) ok("reject", await as(by("hr1")).patch("/api/hr/payroll-runs", { action: "reject", run_id: run.id, remarks: "Please recheck one undertime entry before resubmitting." }));
  });
  await step("HR One's own requests (filed by the Branch 1 Accountant, decided by HR Two)", async () => {
    ok("cash advance", await as(by("acc-b1-1")).post("/api/accountant/loans", { action: "create_loan", employee_id: by("hr1").id, loan_type: "cash_advance", principal: 2500, interest_pct: 0, number_of_payrolls: 1, amortization: 2500, date_granted: today, start_period: "2026-11-16", description: "Demo cash advance", final_pay_authorized: true }));
    ok("incentive", await as(by("acc-b1-1")).post("/api/accountant/payroll", { action: "add_monthly_item", employee_id: by("hr1").id, item_date: "2026-10-14", kind: "incentive", description: "Training facilitator", amount: 1200 }));
    const data = (await as(by("hr2")).get("/api/hr/adjustment-approvals?status=pending")).data || {};
    const rows = data.items || [...(data.loans || []).map((x) => ({ ...x, kind: "loan" })), ...(data.incentives || []).map((x) => ({ ...x, kind: "incentive" }))];
    for (const r of rows.filter((x) => x.employee_id === by("hr1").id)) {
      ok("approve", await as(by("hr2")).patch("/api/hr/adjustment-approvals", { kind: (r.kind || r.item_kind) === "loan" || r.loan_type ? "loan" : "incentive", id: r.id, decision: "approve", note: "Approved." }));
    }
  });
  log(failures.length ? `extras2: ${failures.length} step(s) failed` : "extras2: all steps passed");
}

/** The third audit's gaps: waiting items next to the decided ones (G8 → seed). */
async function stageExtras3() {
  const { roster, by, branchCodes } = await context();
  const today = manilaToday();
  await step("a correction left waiting for HR", async () => {
    const [row] = await local.rows(`select a.id, a.employee_id from attendance_logs a join profiles p on p.id = a.employee_id where p.is_demo and a.status = 'Incomplete' and a.log_date < ${lit(today)} order by a.log_date desc limit 1`);
    if (!row) return "no Incomplete day left";
    ok("file", await as(roster.find((p) => p.id === row.employee_id)).post("/api/me/attendance/corrections", { log_id: row.id, corrected_time: "16:58", reason: "The reader was offline when I left." }));
  });
  await step("an AWOL case waiting (flagged)", async () => {
    ok("open", await as(by("hr1")).post("/api/hr/awol-cases", { employee_id: by("emp14").id, first_absent_on: weekday(addDays(today, -4)), last_present_on: weekday(addDays(today, -7)), notes: "Absent three days in a row without notice." }));
  });
  await step("Branch Requests waiting in every section", async () => {
    const flagLog = (await local.rows(`select a.id from attendance_logs a where a.employee_id = ${lit(by("emp2").id)} and a.status in ('Late', 'Undertime') order by a.log_date desc limit 1`))[0];
    const file = async (who, body) => ok(body.kind, await as(who).post("/api/admin/branch-oversight", { action: "file", ...body }));
    if (flagLog) await file(by("adm-b1-2"), { kind: "attendance_flag", ref_id: flagLog.id, note: "Left early twice; please check." });
    await file(by("adm-b2-2"), { kind: "schedule_request", employee_id: by("emp11").id, note: "For the afternoon section.", details: { request_type: "schedule", effective_from: addDays(today, 21), requested: "Move to 9:00 AM - 6:00 PM" } });
    await file(by("adm-b2-2"), { kind: "incentive_endorsement", employee_id: by("emp12").id, note: "Led the clean-up drive.", details: { kind: "incentive", item_date: addDays(today, -1), amount: 500, description: "Clean-up drive lead" } });
    await file(by("adm-b3-1"), { kind: "incident_report", employee_id: by("emp19").id, note: "Left the campus without notice.", details: { incident_type: "misconduct", incident_date: weekday(addDays(today, -2)) } });
    await file(by("adm-b1-2"), { kind: "overtime_confirmation", employee_id: by("emp4").id, decision: "endorse", note: "Stayed for the school program.", details: { work_type: "overtime", work_date: weekday(addDays(today, -3)), hours: 1.5 } });
  });
  await step("Branch 3 resubmits its rejected run (waiting for HR again)", async () => {
    const { periodForDateKey } = await import("../../src/lib/payroll/periods.js");
    const [run] = await local.rows(`select r.period_label from payroll_runs r join branches b on b.id = r.branch_id where b.code = 'BR-003' and r.status = 'rejected' order by r.period_start desc limit 1`);
    if (!run) return "nothing rejected";
    const people = roster.filter((p) => p.on_payroll && p.branch_code === "BR-003" && (!p.separated_on || p.separated_on > periodForDateKey(today).start_key));
    ok("reprocess", await as(by("acc-b3-1")).post("/api/accountant/payroll", { action: "batch_submit", pay_period: run.period_label, entries: people.map((p) => ({ employee_id: p.id })) }));
    ok("resubmit", await as(by("acc-b3-1")).patch("/api/accountant/payroll-runs", { action: "submit", branch_id: branchCodes["BR-003"].id, period: run.period_label }));
  });
  await step("Branch 1's older cash advance on hold (shown on the history page)", async () => {
    await local.exec(`begin; set local session_replication_role = replica; update payroll_cash_advances set status = 'on_hold', status_reason = 'Waiting for the signed promissory note' where employee_id = ${lit(by("emp5").id)}; commit;`);
  });
  log(failures.length ? `extras3: ${failures.length} step(s) failed` : "extras3: all steps passed");
}

/** After the flows: October (one rejected then approved; the latest submitted / rejected), 13th month, final pay. */
async function stageClose() {
  const { by } = await context();
  failures.length = 0;
  await stagePayroll();
  await step("13th month (2026)", async () => {
    for (const tag of ["acc-b1-1", "acc-b2-1", "acc-b3-1"]) { const r = await as(by(tag)).patch("/api/accountant/payroll", { action: "process_13th_month", year: 2026 }); if (r.data?.code === "thirteenth_month_window") return "December only (rule kept); separated staff got theirs in Final Pay"; ok(`13th ${tag}`, r); }
  });
  await step("final pay", async () => {
    ok("emp7", await as(by("acc-b1-1")).post("/api/accountant/final-pay", { employee_id: by("emp7").id, release_on: addDays(manilaToday(), 10) }));
    ok("emp15", await as(by("acc-b2-1")).post("/api/accountant/final-pay", { employee_id: by("emp15").id, release_on: addDays(manilaToday(), 12) }));
  });
  log(failures.length ? `close: ${failures.length} step(s) failed` : "close: all steps passed");
}

const stages = { base: stageBase, cards: stageCards, attendance: stageAttendance, payroll: () => stagePayroll({ history: true }), flows: stageFlows, close: stageClose, extras: stageExtras, extras2: stageExtras2, extras3: stageExtras3 };

if (String(process.argv[1] || "").split("\\").join("/").endsWith("scripts/demo/build-local.mjs")) {
  const order = stage === "all" ? Object.keys(stages) : stage.split(",");
  for (const name of order) {
    if (!stages[name]) throw new Error(`Unknown stage ${name}`);
    log(`== stage ${name}`);
    await stages[name]();
  }
  log("done");
}

export { SEED_ACTOR, stableId };
