// Part 4 (decisions of 2026-11-12): data for the ORIGINAL defense accounts,
// through the app's own routes only (the same server rules and audit entries
// as the screens), as the right person for each step. Idempotent: every step
// looks at what is already there and skips it, so a second run adds nothing.
//
//   node scripts/demo/defense-accounts.mjs --target=local --setup   (local only: look-alike accounts first)
//   node scripts/demo/defense-accounts.mjs --target=local
//   node scripts/demo/defense-accounts.mjs --target=production --plan   (read only: what it would do)
//   node scripts/demo/defense-accounts.mjs --target=production          (after the user's yes)
//
// Steps
//   1. Hire date, only when empty: the Super Admin (a demo Super Admin), Edit account.
//   2. Basic salary, only when none: Demo HR One, Salary change from 2026-11-01
//      (the earliest the screen allows), the value of the demo account of the same role.
//   3. Nov 1-12: the generated Absent days. A different HR than the owner uses
//      Correct record (time in and out: on time, late, one undertime, one
//      overtime); on two days only the time in, then the employee files a
//      time-out correction request: one approved (by a different HR), one left
//      pending or rejected. One day stays Absent. Any day a rule refuses is skipped and listed.
//   4. One pending leave request each (7+ days ahead, within the 6 paid days).
// Every added row is listed in defense_data_rows (the defense-data tag).
// Nothing dated after today; nothing approved for payroll; no key printed.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chooseTarget, lit } from "./db.mjs";
import { readEnvFile } from "./config.mjs";

const argv = process.argv.slice(2);
const db = await chooseTarget(argv);
const PLAN = argv.includes("--plan");
const BATCH = "defense-2026-11";
const say = (...m) => console.log(...m);
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // Manila

const TARGETS = [
  { code: "SACS-EMP-001", salaryFrom: "DEMO-005", hiredDefault: "2026-09-01" },
  { code: "SACS-HR-001", salaryFrom: "DEMO-001", hiredDefault: "2026-09-01" },
  { code: "SACS-ACCT-001", salaryFrom: "DEMO-003", hiredDefault: "2026-09-01" },
];
// Who corrects whose days (never their own): HR Officer's by Demo HR One.
// Production 2026-11-13: HR Officer cannot sign in (maxxspace.com no longer receives
// mail, so no sign-in code arrives); Demo HR One corrects all three there.
const CORRECTOR = db.target === "production"
  ? { "SACS-EMP-001": "DEMO-001", "SACS-HR-001": "DEMO-001", "SACS-ACCT-001": "DEMO-001" }
  : { "SACS-EMP-001": "SACS-HR-001", "SACS-HR-001": "DEMO-001", "SACS-ACCT-001": "DEMO-001" };
// Nov 1-12 plan, by the order of the account's Absent days (one stays Absent).
const DAY_PLAN = [
  { kind: "both", in: "07:24", out: "16:35", note: "Logbook: on time; card not yet issued (RFID reset)." },
  { kind: "both", in: "07:52", out: "16:40", note: "Logbook: arrived late; card not yet issued." },
  { kind: "absent" },
  { kind: "request", in: "07:28", out: "16:32", decide: "approve", note: "Logbook time in; card not yet issued." },
  { kind: "both", in: "07:20", out: "15:10", note: "Logbook: left early (undertime)." },
  { kind: "both", in: "07:25", out: "18:30", note: "Logbook: stayed for the school event (overtime)." },
  { kind: "request", in: "07:31", out: "16:30", decide: "last", note: "Logbook time in; card not yet issued." },
];
// The last request: pending for two accounts, rejected for one.
const LAST_DECISION = { "SACS-EMP-001": "pending", "SACS-HR-001": "pending", "SACS-ACCT-001": "reject" };

/* ── sessions: the real routes as each person ─────────────────────────── */
const env = db.target === "production" ? readEnvFile(join(process.cwd(), ".env.live.local")) : null;
const local = db.target === "local" ? (await import("../../e2e/local-env.mjs")).localSupabase() : null;
const BASE = db.target === "production" ? "https://sacs-payroll.vercel.app" : (process.env.DEMO_LOCAL_BASE || "http://localhost:3101");
// Production: the live site's own SESSION_SECRET (`vercel env pull` into a file
// outside the repo; .env.live.local may hold an older one). Never printed.
const LIVE_ENV = join(homedir(), "sacs-secrets", "vercel-production.env");
const SECRET = db.target === "production"
  ? (existsSync(LIVE_ENV) ? readEnvFile(LIVE_ENV).SESSION_SECRET : env.SESSION_SECRET)
  : (await import("../../e2e/accounts.mjs")).TEST_SESSION_SECRET;
const auth = db.target === "production" ? { url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY } : { url: local.url, key: local.serviceKey };
const cookies = new Map();

// Production: sessions from live-signin.mjs (the live signing key is not readable).
const LIVE_SESSIONS = join(homedir(), "sacs-secrets", "live-sessions.json");
if (db.target === "production" && existsSync(LIVE_SESSIONS)) {
  for (const [id, value] of Object.entries(JSON.parse(readFileSync(LIVE_SESSIONS, "utf8")))) cookies.set(id, `sacs-session=${encodeURIComponent(value)}`);
}

async function cookieFor(p) {
  if (cookies.has(p.id)) return cookies.get(p.id);
  if (db.target === "production") throw new Error(`No live session for ${p.full_name}: run scripts/demo/live-signin.mjs first.`);
  const sid = randomUUID();
  const res = await fetch(`${auth.url}/auth/v1/admin/users/${p.id}`, { method: "PUT", headers: { apikey: auth.key, Authorization: `Bearer ${auth.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ app_metadata: { session_id: sid, session_started_at: new Date().toISOString() } }) });
  if (!res.ok) throw new Error(`session for ${p.employee_id || p.role}: HTTP ${res.status}`);
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: p.id, role: p.role, branch_id: ["hr", "super_admin"].includes(p.role) ? null : p.branch_id || null, email: p.email, full_name: p.full_name, sid, pwd: false, iat: now, lat: now, idl: 3600, exp: now + 3600 };
  const part = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const cookie = `sacs-session=${encodeURIComponent(`${part}.${createHmac("sha256", SECRET).update(part).digest("base64url")}`)}`;
  cookies.set(p.id, cookie);
  return cookie;
}
async function call(p, method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie: await cookieFor(p), "Content-Type": "application/json", "sec-fetch-site": "same-origin", "x-sacs-background": "1" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
  return { status: res.status, data };
}

/* ── local only: look-alike accounts shaped like production's ───────── */
// No salary, HR and Accountant without a hire date, generated Absent rows on
// the same November days production has (Nov 3-6, 9-11; Nov 2 is a holiday).
if (argv.includes("--setup")) {
  if (db.target !== "local") throw new Error("--setup is for the local stack only.");
  const [main] = await db.rows("select id from branches where code = 'BR-001'");
  const LOOK = [
    { id: "de000000-0000-4000-8000-00000000def1", code: "SACS-EMP-001", role: "employee", full: "Default Employee", hired: "2024-06-01" },
    { id: "de000000-0000-4000-8000-00000000def2", code: "SACS-HR-001", role: "hr", full: "HR Officer", hired: null },
    { id: "de000000-0000-4000-8000-00000000def3", code: "SACS-ACCT-001", role: "accountant", full: "Payroll JM", hired: null },
  ];
  for (const p of LOOK) {
    const email = `${p.code.toLowerCase()}@defense.local`;
    const body = { id: p.id, email, password: randomUUID(), email_confirm: true, user_metadata: { role: p.role, full_name: p.full, branch_id: p.role === "hr" ? null : main.id, employee_id: p.code } };
    const res = await fetch(`${auth.url}/auth/v1/admin/users`, { method: "POST", headers: { apikey: auth.key, Authorization: `Bearer ${auth.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok && res.status !== 422) throw new Error(`local user ${p.code}: HTTP ${res.status}`);
    await db.exec(`insert into profiles (id, email, full_name, role, employee_id, branch_id, employee_type, position, basic_salary, date_hired, employee_status, archived, is_demo)
      values (${lit(p.id)}, ${lit(email)}, ${lit(p.full)}, ${lit(p.role)}::user_role, ${lit(p.code)}, ${lit(main.id)}, 'Teaching', 'Staff', 0, ${lit(p.hired)}, 'Active', false, false)
      on conflict (id) do nothing;`);
    // Absent rows as the nightly close leaves them (copied from a demo Absent row's shape).
    await db.exec(`begin; alter table attendance_logs disable trigger user;
      insert into attendance_logs (employee_id, employee_name, branch_id, log_date, status)
      select ${lit(p.id)}, ${lit(p.full)}, ${lit(main.id)}, d::date, 'Absent' from unnest(array['2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-09','2026-11-10','2026-11-11']) d
      where not exists (select 1 from attendance_logs a where a.employee_id = ${lit(p.id)} and a.log_date = d::date);
      alter table attendance_logs enable trigger user; commit;`);
  }
  say("Local look-alike accounts ready (SACS-EMP-001, SACS-HR-001, SACS-ACCT-001).");
}

/* ── facts ────────────────────────────────────────────────────────────── */
const person = async (where) => (await db.rows(`select id, role::text role, branch_id, email, full_name, employee_id, date_hired, basic_salary from profiles where ${where} limit 1`))[0];
const byCode = (code) => person(`employee_id = ${lit(code)}`);
const superAdmin = await person("role = 'super_admin' and is_demo and not coalesce(archived, false) order by email");
const tag = (table, ids, note = null) => (ids.length ? db.exec(`insert into defense_data_rows (table_name, row_id, batch, note) values ${ids.map((id) => `(${lit(table)}, ${lit(String(id))}, ${lit(BATCH)}, ${lit(note)})`).join(", ")} on conflict do nothing;`) : null);

// Before migration 20261112040000 (a --plan on production) the tag table does not exist yet.
const [{ ok: HAS_TAGS }] = await db.rows("select to_regclass('public.defense_data_rows') is not null as ok");
if (!HAS_TAGS && !PLAN) throw new Error("Apply migration 20261112040000_defense_data_rows first.");
const report = [];
const skipped = [];
const runStart = new Date().toISOString();

for (const t of TARGETS) {
  const me = await byCode(t.code);
  if (!me) { skipped.push(`${t.code}: account not found`); continue; }
  const name = `${me.full_name} (${t.code})`;

  // 1. Hire date, only when empty; never before an attendance row.
  // Accountant accounts are HR's (the Super Admin's Edit refuses them): Demo HR
  // One sets the date (user decision 2026-11-13), resending the current name,
  // type and position so nothing else changes.
  if (!me.date_hired && me.role === "accountant") {
    const [first] = await db.rows(`select min(log_date)::text d from attendance_logs where employee_id = ${lit(me.id)}`);
    const hired = first?.d && first.d < t.hiredDefault ? first.d : t.hiredDefault;
    const hrActor = await byCode("DEMO-001");
    const [cur] = await db.rows(`select full_name, employee_type, position from profiles where id = ${lit(me.id)}`);
    report.push([name, "Date hired", hired, `${hrActor.full_name} (HR, User Management)`]);
    if (!PLAN) {
      const r = await call(hrActor, "PATCH", "/api/admin/employees", { id: me.id, action: "update", date_hired: hired, full_name: cur.full_name, employee_type: cur.employee_type, position: cur.position });
      if (r.status !== 200) skipped.push(`${name}: date hired refused (${r.status} ${JSON.stringify(r.data).slice(0, 160)})`);
    }
  } else if (!me.date_hired) {
    const [first] = await db.rows(`select min(log_date)::text d from attendance_logs where employee_id = ${lit(me.id)}`);
    const hired = first?.d && first.d < t.hiredDefault ? first.d : t.hiredDefault;
    report.push([name, "Date hired", hired, `Super Admin (${superAdmin.full_name})`]);
    if (!PLAN) {
      const r = await call(superAdmin, "PATCH", "/api/admin/users", { id: me.id, action: "update", date_hired: hired });
      if (r.status !== 200) skipped.push(`${name}: date hired refused (${r.status} ${JSON.stringify(r.data).slice(0, 160)})`);
    }
  }

  // 2. Salary, only when none on record and none scheduled.
  const hr1 = await byCode("DEMO-001");
  const source = await byCode(t.salaryFrom);
  const [scheduled] = await db.rows(`select count(*)::int n from employee_salary_changes where employee_id = ${lit(me.id)}`);
  if (!(Number(me.basic_salary) > 0) && !scheduled.n) {
    report.push([name, "Basic salary", `${source.basic_salary} from 2026-11-01 (as ${t.salaryFrom})`, hr1.full_name]);
    if (!PLAN) {
      const r = await call(hr1, "POST", "/api/hr/salary-changes", { employee_id: me.id, new_salary: Number(source.basic_salary), effective_date: "2026-11-01", reason: "Salary adjustment", note: "Defense data: salary on record (same as the demo account of this role)." });
      if (r.status >= 300) skipped.push(`${name}: salary refused (${r.status} ${JSON.stringify(r.data).slice(0, 160)})`);
    }
  }

  // 3. Nov 1-12: the generated Absent days, by plan.
  const corrector = await byCode(CORRECTOR[t.code]);
  const days = await db.rows(`select id, log_date::text d, status from attendance_logs where employee_id = ${lit(me.id)} and log_date between '2026-11-01'::date and least('2026-11-12'::date, ${lit(today)}::date) and coalesce(archived_duplicate, false) = false order by log_date`);
  const absent = days.filter((d) => d.status === "Absent");
  const planned = days.length ? days.slice(0, DAY_PLAN.length) : [];
  for (const [i, day] of planned.entries()) {
    const step = DAY_PLAN[i];
    if (step.kind === "absent") { report.push([name, day.d, "stays Absent (deduction shows)", "—"]); continue; }
    // Rule (2026-11-12 local run): Correct record refuses a time in alone on an
    // Absent day ("This day has no time out"), so no time-out request can be
    // filed for it. Kept Absent and listed; never bypassed.
    if (step.kind === "request" && day.status === "Absent") {
      skipped.push(`${name} ${day.d}: stays Absent: Correct record refuses a time in alone on an Absent day, so no time-out request can be filed (rule kept)`);
      continue;
    }
    if (day.status === "Absent") {
      const type = step.kind === "request" ? "time_in" : "both";
      report.push([name, day.d, `${step.in}${type === "both" ? `–${step.out}` : " (time in)"}`, `${corrector.full_name}: Correct record`]);
      if (!PLAN) {
        const r = await call(corrector, "PATCH", "/api/attendance/corrections", { action: "correct_record", log_id: day.id, type, time_in: step.in, ...(type === "both" ? { time_out: step.out } : {}), note: step.note });
        if (r.status !== 200) { skipped.push(`${name} ${day.d}: Correct record refused (${r.status} ${JSON.stringify(r.data).slice(0, 160)})`); continue; }
      }
    }
    if (step.kind !== "request") continue;
    const decision = step.decide === "last" ? LAST_DECISION[t.code] : step.decide;
    report.push([name, day.d, `time-out request ${step.out} → ${decision}`, decision === "pending" ? "—" : corrector.full_name]);
    if (PLAN) continue;
    const [log] = await db.rows(`select status from attendance_logs where id = ${lit(day.id)}`);
    let [corr] = await db.rows(`select id, status from attendance_corrections where log_id = ${lit(day.id)} and corrected_time_out is not null and original_time_out is null and status in ('pending','approved','rejected') order by requested_at desc limit 1`);
    if (!corr && ["Incomplete", "Undertime", "Half Day"].includes(log.status)) {
      const r = await call(me, "POST", "/api/attendance/corrections", { log_id: day.id, corrected_time: step.out, reason: "Forgot to tap out; logbook shows the time out." });
      if (r.status >= 300) { skipped.push(`${name} ${day.d}: time-out request refused (${r.status} ${JSON.stringify(r.data).slice(0, 160)})`); continue; }
      [corr] = await db.rows(`select id, status from attendance_corrections where log_id = ${lit(day.id)} and status = 'pending' order by requested_at desc limit 1`);
    }
    if (corr?.status === "pending" && decision !== "pending") {
      const r = await call(corrector, "PATCH", "/api/attendance/corrections", decision === "approve"
        ? { correction_id: corr.id, decision: "approve", note: "Matches the logbook." }
        : { correction_id: corr.id, decision: "reject", resolution: "half_day", note: "The logbook shows a half day only." });
      if (r.status !== 200) skipped.push(`${name} ${day.d}: decision refused (${r.status} ${JSON.stringify(r.data).slice(0, 160)})`);
    }
  }
  if (!absent.length && !PLAN) say(`${name}: no Absent day left in Nov 1-12 (already done).`);

  // 4. One pending leave request (7+ days ahead), within the paid balance.
  const [leave] = HAS_TAGS ? await db.rows(`select count(*)::int n from leave_requests l join defense_data_rows t on t.table_name = 'leave_requests' and t.row_id = l.id::text where l.employee_id = ${lit(me.id)}`) : [{ n: 0 }];
  if (!leave.n && db.target === "production" && !cookies.has(me.id)) {
    skipped.push(`${name}: own leave request not filed: the account cannot sign in (its email domain receives no mail)`);
  } else if (!leave.n) {
    const start = new Date(Date.now() + (8 + 8) * 86400e3); // 8+ days from now, on a weekday
    while ([0, 6].includes(start.getUTCDay())) start.setUTCDate(start.getUTCDate() + 1);
    const day = start.toISOString().slice(0, 10);
    report.push([name, "Leave request", `${day}, Vacation Leave, with pay, pending`, "the employee"]);
    if (!PLAN) {
      const r = await call(me, "POST", "/api/me/leave-requests", { leave_type: "Vacation Leave", pay_status: "with_pay", start_date: day, end_date: day, reason: "Family errand (defense data)." });
      if (r.status >= 300) skipped.push(`${name}: leave refused (${r.status} ${JSON.stringify(r.data).slice(0, 160)})`);
      else {
        const [row] = await db.rows(`select id from leave_requests where employee_id = ${lit(me.id)} and start_date = ${lit(day)} order by submitted_at desc limit 1`);
        if (row) await tag("leave_requests", [row.id]);
      }
    }
  }

  // The defense-data tag: what was added for this account in this run.
  if (!PLAN) {
    // By what the rows are (this script's own notes), so a run that stopped half-way is tagged on the next one.
    await tag("employee_salary_changes", (await db.rows(`select id from employee_salary_changes where employee_id = ${lit(me.id)} and note like 'Defense data:%'`)).map((r) => r.id));
    await tag("attendance_corrections", (await db.rows(`select id from attendance_corrections where employee_id = ${lit(me.id)} and (reason like 'Logbook%' or review_note like 'Logbook%' or reason like 'Forgot to tap out; logbook%')`)).map((r) => r.id));
  }
}
if (!PLAN) {
  const actors = [superAdmin.id, ...(await db.rows(`select id from profiles where employee_id in ('DEMO-001','SACS-HR-001','SACS-EMP-001','SACS-ACCT-001')`)).map((r) => r.id)];
  await tag("audit_logs", (await db.rows(`select id from audit_logs where created_at >= ${lit(runStart)} and actor_id in (${actors.map(lit).join(", ")})`)).map((r) => r.id));
}

say(`\n${PLAN ? "PLAN (nothing written)" : "Done"} on ${db.target}:`);
for (const r of report) say(`  ${r[0].padEnd(34)} ${r[1].padEnd(14)} ${r[2].padEnd(48)} ${r[3]}`);
if (!report.length) say("  nothing to do (already applied)");
if (skipped.length) { say("Skipped (a rule refused it; not bypassed):"); for (const s of skipped) say(`  ${s}`); }
const [tagged] = HAS_TAGS ? await db.rows(`select count(*)::int n from defense_data_rows where batch = ${lit(BATCH)}`) : [{ n: 0 }];
say(`Rows tagged ${BATCH}: ${tagged.n}`);
