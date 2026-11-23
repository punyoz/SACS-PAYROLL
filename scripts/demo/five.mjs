// The five live demo employees for the redefense (requested 2026-11-24).
//
//   node scripts/demo/five.mjs build                  LOCAL ONLY: on a local copy of live, the five (+ their
//                                                     non-login Demo Admin) and their November, through the app
//   node scripts/demo/five.mjs export                 local -> demo-data/five-bundle.json
//   node scripts/demo/five.mjs check --target=production   READ-ONLY: what a load would do, and every reason it would stop
//   node scripts/demo/five.mjs load  --target=production   load the bundle (the project URL typed back, then a yes)
//   node scripts/demo/five.mjs taps  --target=production   the school days since the last tap, up to today (daily job)
//   node scripts/demo/five.mjs remove --target=production  snapshot, then delete the five and everything theirs, logins included
//
// Who acts: the demo accounts kept on live (Demo HR One decides, Demo Accountant
// One Main processes) and "Demo Admin Main" (no login) files the substitution,
// so every row is demo-only and the removal never touches a real person's row.
// The passwords stay in demo-data/five-credentials.csv (gitignored); nothing
// here prints one. Keys come from the environment and are never printed.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, PRODUCTION } from "./config.mjs";
import { confirm, database, lit } from "./db.mjs";
import { as, localAuthAdmin, ok } from "./local-api.mjs";
import { profileInsert } from "./build-local.mjs";
import { stableId } from "./roster.mjs";
import { fiveRoster, saveFiveCredentials } from "./five-roster.mjs";

process.env.DEMO_SCOPE = "five";
const [command, ...rest] = process.argv.slice(2);
const target = (rest.find((a) => a.startsWith("--target=")) || "--target=local").split("=")[1];
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

const FIRST = "November 1-15, 2026";
const SECOND = "November 16-30, 2026";
const HR = { id: stableId("hr1"), role: "hr", full: "Demo HR One" };
const ACC = { id: stableId("acc-b1-1"), role: "accountant", full: "Demo Accountant One Main" };

const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const manilaToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const isWeekend = (key) => [0, 6].includes(new Date(`${key}T00:00:00Z`).getUTCDay());

/**
 * November, per person: the days that are not an ordinary day. Each entry is
 * [in, out] (Manila "HH:MM", null = no tap) or "none" (no tap at all). Every
 * other school day is an ordinary day (in 07:40-07:58, out 17:00-17:14).
 */
const NOVEMBER = {
  "emp-demo1": { "2026-11-05": ["08:25", "17:04"], "2026-11-10": ["07:48", "19:05"], "2026-11-12": "none", "2026-11-13": "none" },
  "emp-demo2": { "2026-11-09": ["08:18", "17:03"], "2026-11-17": "none" },
  "emp-demo3": { "2026-11-06": ["07:52", null], "2026-11-11": ["12:55", "17:02"], "2026-11-18": ["07:47", null], "2026-11-19": "none" },
  "emp-demo4": { "2026-11-03": ["08:14", "17:05"], "2026-11-04": ["07:50", "10:30"], "2026-11-13": ["07:45", "18:40"], "2026-11-16": ["08:31", "17:02"] },
  "emp-demo5": { "2026-11-06": ["07:44", "18:35"], "2026-11-10": ["08:22", "17:06"] },
};

/** An ordinary day's taps, stable per person and day (a rebuild is identical). */
function ordinary(tag, day) {
  const h = [...`${tag}${day}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7);
  const pad = (n) => String(n).padStart(2, "0");
  return [`07:${pad(40 + (h % 19))}`, `17:${pad(h % 15)}`];
}

/** Taps for `people` on the school days from..to (holidays and weekends skipped by the database). */
function tapsSql(people, from, to, { plan = true } = {}) {
  const values = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (isWeekend(day)) continue;
    for (const p of people) {
      const special = plan ? NOVEMBER[p.tag]?.[day] : undefined;
      if (special === "none") continue;
      const [tin, tout] = special || ordinary(p.tag, day);
      values.push(`(${lit(p.id)}::uuid, ${lit(day)}::date, ${lit(tin)}::time, ${tout ? `${lit(tout)}::time` : "null::time"})`);
    }
  }
  if (!values.length) return "select 1;";
  return `insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out)
select p.id, p.full_name, p.employee_type, p.branch_id, v.d, (v.d + v.tin) at time zone 'Asia/Manila', (v.d + v.tout) at time zone 'Asia/Manila'
from (values ${values.join(",\n  ")}) v(id, d, tin, tout)
join profiles p on p.id = v.id
where not exists (select 1 from attendance_holidays x where x.holiday_date = v.d and x.day_part = 'whole' and public.attendance_holiday_applies(x.branch_ids, p.branch_id))
  and not exists (select 1 from attendance_logs a where a.employee_id = p.id and a.log_date = v.d and not a.archived_duplicate);`;
}

// ───────────────────────────── build (LOCAL ONLY) ─────────────────────────────
const local = () => database("local");
let step = 0;
async function stage(name, fn) {
  step += 1;
  const result = await fn();
  log(`${String(step).padStart(2)} ${name}${result ? `: ${result}` : ""}`);
}

async function build() {
  if (target !== "local") throw new Error("build is LOCAL ONLY (a local copy of live).");
  const db = local();
  const [branch] = await db.rows("select * from branches where code = 'BR-001'");
  const kept = await db.rows(`select id, full_name from profiles where id in (${lit(HR.id)}, ${lit(ACC.id)}) and is_demo and not archived`);
  if (!branch || kept.length !== 2) throw new Error("Not a copy of live: the Main Branch, Demo HR One and Demo Accountant One Main must be there.");
  const { people, admin, all } = fiveRoster(branch);
  const by = (n) => people[n - 1];
  const [have] = await db.rows(`select count(*)::int n from profiles where id in (${all.map((p) => lit(p.id)).join(", ")})`);
  if (have.n) throw new Error(`${have.n} of the five are already on the local stack: restore a fresh copy of live first.`);
  const today = manilaToday();
  const yesterday = addDays(today, -1);

  await stage("accounts and profiles", async () => {
    saveFiveCredentials(people);
    for (const p of all) {
      await localAuthAdmin.upsertUser({ id: p.id, email: p.email, password: p.password || `Nl${stableId(`${p.tag}:x`).replace(/-/g, "")}#9`, user_metadata: {
        role: p.role, full_name: p.full, branch_id: p.branch_id, employee_id: p.employee_id, employee_type: p.employee_type || null,
        position: p.position || null, basic_salary: p.basic_salary || null, employee_status: "Active", is_demo: true } });
    }
    await db.exec(["begin;", ...all.map((p) => profileInsert(p)),
      ...people.map((p) => `update profiles set employment_status = ${lit(p.employment_status)}, employment_type = 'Full-time', staff_group = ${lit(p.staff_group || null)},
        contract_end_date = ${lit(p.contract_end_date || null)}, on_payroll = true, address = 'Demo Street, Antipolo City, Rizal',
        emergency_contact_name = 'Demo Contact', emergency_contact_relationship = 'Spouse', emergency_contact_address = 'Demo Street, Antipolo City, Rizal',
        emergency_contact_number = ${lit(p.cp_number.replace(/^0999/, "0998"))} where id = ${lit(p.id)};`),
      `update profiles set on_payroll = false where id = ${lit(admin.id)};`,
      "commit;"].join("\n"));
    return `${people.length} employees + ${admin.full} (no login)`;
  });

  await stage("RFID cards (HR registers)", async () => {
    for (const p of people) ok(`card ${p.tag}`, await as(HR).post("/api/rfid/cards", { action: "register", employee_id: p.id, uid: p.rfid_uid, reason: "Demo card issued" }));
    return `${people.length} cards`;
  });

  await stage("taps Nov 3 to yesterday", async () => {
    await db.exec(tapsSql(people, "2026-11-03", yesterday));
    const [n] = await db.rows(`select count(*)::int n from attendance_logs where employee_id in (${people.map((p) => lit(p.id)).join(", ")})`);
    return `${n.n} days`;
  });

  // Requests for days already past are written as the employee's route files them
  // (filed on that date); every decision goes through HR's own route.
  const leave = {};
  await stage("leave filed in November (as filed on the day)", async () => {
    const rows = [
      ["vl", by(1), "Vacation Leave", "2026-11-12", "2026-11-13", null, "2026-11-03", "Family reunion in Batangas"],
      ["sl", by(2), "Sick Leave", "2026-11-17", "2026-11-17", null, "2026-11-18", "Fever; clinic visit"],
      ["half", by(3), "Vacation Leave", "2026-11-11", "2026-11-11", "AM", "2026-11-09", "Morning: bank and government office errands"],
      ["rej", by(4), "Vacation Leave", "2026-11-09", "2026-11-09", null, "2026-11-04", "Personal errand"],
    ];
    for (const [key, p, type, start, end, half, filed, reason] of rows) {
      const r = { id: randomUUID() };
      await db.exec(`insert into leave_requests (id, employee_id, employee_name, position, leave_type, start_date, end_date, reason, status, submitted_at, updated_at, pay_status, branch_id, half_day)
        values (${lit(r.id)}, ${lit(p.id)}, ${lit(p.full)}, ${lit(p.position)}, ${lit(type)}, ${lit(start)}, ${lit(end)}, ${lit(reason)}, 'pending_admin', ${lit(`${filed}T01:30:00Z`)}, ${lit(`${filed}T01:30:00Z`)},
          'paid', ${lit(p.branch_id)}, ${lit(half)});`);
      leave[key] = r.id;
    }
    ok("approve VL", await as(HR).patch("/api/hr/leave-requests", { id: leave.vl, action: "approve" }));
    ok("approve SL", await as(HR).patch("/api/hr/leave-requests", { id: leave.sl, action: "approve" }));
    ok("approve half day", await as(HR).patch("/api/hr/leave-requests", { id: leave.half, action: "approve" }));
    ok("reject", await as(HR).patch("/api/hr/leave-requests", { id: leave.rej, action: "reject", remark: { code: "reject.leave.school_activity" }, reason: "Conflicts with the Grade 4 field trip that day." }));
    return "VL approved (2 days), SL approved, half day AM approved, VL rejected (Conflicts with school activity)";
  });

  await stage("nightly close Nov 3 to yesterday (Absent / Incomplete)", async () => {
    await db.exec(`select public.attendance_close_days('2026-11-03'::date, ${lit(yesterday)}::date);`);
    const s = await db.rows(`select status, count(*)::int n from attendance_logs where employee_id in (${people.map((p) => lit(p.id)).join(", ")}) group by 1 order by 2 desc`);
    return s.map((x) => `${x.status} ${x.n}`).join(", ");
  });

  await stage("missing time-outs: corrections (one approved, one pending)", async () => {
    const logs = await db.rows(`select id, log_date::text d, status from attendance_logs where employee_id = ${lit(by(3).id)} and log_date in ('2026-11-06', '2026-11-18') order by log_date`);
    const ids = [];
    for (const l of logs) {
      const res = ok(`correction ${l.d} (${l.status})`, await as(by(3)).post("/api/me/attendance/corrections", { log_id: l.id, corrected_time: l.d === "2026-11-06" ? "17:05" : "17:10", reason: "Forgot to tap out; left after class." }));
      ids.push(res?.correction?.id || res?.id || null);
    }
    const list = ok("list corrections", await as(HR).get("/api/attendance/corrections?status=pending")).corrections || [];
    const first = list.find((c) => c.employee_id === by(3).id && String(c.log_date).startsWith("2026-11-06"));
    if (!first) throw new Error("the Nov 6 correction is not in HR's pending list");
    ok("approve correction", await as(HR).patch("/api/attendance/corrections", { correction_id: first.id, decision: "approve", note: "Confirmed with the guard's logbook." }));
    return "Nov 6 approved, Nov 18 pending";
  });

  const ot = {};
  await stage("overtime (approved and worked, pending, past the shift with no request)", async () => {
    const rows = [["p1", by(1), "2026-11-10", "17:00", "19:00", 120, "2026-11-09", "Grade 6 recognition rehearsal"],
      ["p5", by(5), "2026-11-06", "17:00", "18:30", 90, "2026-11-05", "Stage set-up for the school program"]];
    for (const [key, p, day, start, end, minutes, filed, reason] of rows) {
      const r = { id: randomUUID() };
      await db.exec(`insert into overtime_requests (id, employee_id, branch_id, request_date, planned_start, planned_end, minutes, reason, status, late_filing, prepared, filed_by, filed_by_name, created_at)
        values (${lit(r.id)}, ${lit(p.id)}, ${lit(p.branch_id)}, ${lit(day)}, ${lit(start)}, ${lit(end)}, ${minutes}, ${lit(reason)}, 'pending', false,
          ${lit({ filed_on: filed, period: FIRST, cutoff_minutes_with_this: minutes, limits: { file_days_before: 1, late_filing_days_after: 2 } })}, ${lit(p.id)}, ${lit(p.full)}, ${lit(`${filed}T02:00:00Z`)});`);
      ot[key] = r.id;
      ok(`approve OT ${key}`, await as(HR).patch("/api/hr/overtime-requests", { id: r.id, decision: "approve", note: "Approved: school event." }));
    }
    const ahead = addDays(today, 2);
    const day = isWeekend(ahead) ? addDays(ahead, 2) : ahead;
    ok("pending OT", await as(by(2)).post("/api/me/overtime-requests", { request_date: day, planned_start: "17:00", planned_end: "18:00", reason: "Checking quarterly exam papers" }));
    return `2 approved and worked; 1 pending (${day}); Ramon Nov 13 out 18:40 with no request`;
  });

  await stage("pending leave (filed now through the employee's route)", async () => {
    let day = addDays(today, 7);
    while (isWeekend(day)) day = addDays(day, 1);
    ok("pending leave", await as(by(5)).post("/api/me/leave-requests", { leave_type: "Vacation Leave", start_date: day, end_date: day, reason: "Barangay ID and clearance" }));
    return `Nestor, ${day}`;
  });

  await stage("substitution (the Demo Admin files, HR approves)", async () => {
    const res = ok("file substitution", await as(admin).post("/api/substitutions", { absent_employee_id: by(2).id, substitute_id: by(1).id, sub_date: "2026-11-17",
      start_time: "09:00", end_time: "12:00", periods: 3, class_section: "Grade 5 - Sampaguita", subject: "Science", leave_request_id: leave.sl }));
    const id = res?.substitution?.id || res?.id;
    if (!id) throw new Error(`no substitution id: ${JSON.stringify(res).slice(0, 200)}`);
    ok("approve substitution", await as(HR).patch("/api/substitutions", { id, action: "approve" }));
    return "Marisol covers Carlo on Nov 17, 3 periods";
  });

  await stage("honorarium and adjustment (Accountant files, HR approves)", async () => {
    const filed = [];
    for (const [p, kind, amount, description] of [[by(1), "honorarium", 1500, "Host, Recognition Day program"], [by(4), "adjustment", 500, "October transport allowance underpaid"]]) {
      ok(`${kind}`, await as(ACC).post("/api/accountant/payroll", { action: "add_monthly_item", employee_id: p.id, item_date: "2026-11-14", kind, description, amount, reason: description }));
      filed.push(p.id);
    }
    const list = ok("HR list", await as(HR).get("/api/hr/adjustment-approvals?status=pending")).items || [];
    const mine = list.filter((i) => i.kind === "incentive" && filed.includes(i.employee_id));
    for (const i of mine) ok("approve item", await as(HR).patch("/api/hr/adjustment-approvals", { kind: "incentive", id: i.id, decision: "approve", remark: { code: "approve.as_requested" } }));
    return `${mine.length} approved`;
  });

  await stage("salary loan (Accountant files, HR approves)", async () => {
    ok("loan", await as(ACC).post("/api/accountant/loans", { action: "create_loan", employee_id: by(1).id, loan_type: "salary_loan", principal: 10000, interest_pct: 0,
      number_of_payrolls: 4, amortization: 2500, date_granted: "2026-11-12", start_period: "2026-11-16", description: "Salary loan", final_pay_authorized: true }));
    const list = ok("HR list", await as(HR).get("/api/hr/adjustment-approvals?status=pending")).items || [];
    const loan = list.find((i) => i.kind === "loan" && i.employee_id === by(1).id);
    if (!loan) throw new Error("the loan is not in HR's list");
    ok("approve loan", await as(HR).patch("/api/hr/adjustment-approvals", { kind: "loan", id: loan.id, decision: "approve", remark: { code: "approve.as_requested" } }));
    return "₱10,000 over 4 payrolls from Nov 16-30";
  });

  await stage("special working day Sat Nov 28 (make-up, the three teachers)", async () => {
    ok("special day", await as(HR).post("/api/hr/special-days", { work_date: "2026-11-28", branch_ids: [branch.id], audience: "employees",
      employee_ids: [by(1).id, by(2).id, by(3).id], start_time: "08:00", end_time: "12:00", reason: "Make-up classes for Nov 20 (no classes: Typhoon Yolanda)", pay_type: "makeup" }));
    return "08:00-12:00, make-up";
  });

  await stage(`payroll ${FIRST}: processed, submitted, approved (Paid)`, async () => {
    // Live's own run for the period must be approved first (a supplemental run follows an approved one).
    const [main] = await db.rows(`select id, status from payroll_runs where branch_id = ${lit(branch.id)} and period_start = '2026-11-01' order by run_no limit 1`);
    if (main && main.status !== "approved") {
      ok("approve the Main Branch's own run (LOCAL copy only: on live this is HR's decision)", await as(HR).patch("/api/hr/payroll-runs", { action: "approve", run_ids: [main.id] }));
    }
    const res = ok("batch", await as(ACC).post("/api/accountant/payroll", { action: "batch_submit", pay_period: FIRST, entries: people.map((p) => ({ employee_id: p.id })) }));
    if ((res.skipped || []).length) throw new Error(`skipped: ${JSON.stringify(res.skipped).slice(0, 400)}`);
    ok("submit", await as(ACC).patch("/api/accountant/payroll-runs", { action: "submit", branch_id: branch.id, period: FIRST }));
    const [run] = await db.rows(`select id, status, run_no from payroll_runs where branch_id = ${lit(branch.id)} and period_start = '2026-11-01' order by run_no desc limit 1`);
    const approved = ok("approve", await as(HR).patch("/api/hr/payroll-runs", { action: "approve", run_ids: [run.id] }));
    if (!approved?.approved) throw new Error(`not approved: ${JSON.stringify(approved).slice(0, 300)}`);
    return `run ${run.run_no}`;
  });

  await stage(`payroll ${SECOND}: drafts`, async () => {
    for (const p of people) ok(`draft ${p.tag}`, await as(ACC).post("/api/accountant/payroll", { action: "save_draft", employee_id: p.id, pay_period: SECOND }));
    return `${people.length} drafts`;
  });

  await stage("Demo Admin Main: no login", async () => {
    await db.exec(`update auth.users set banned_until = '2999-01-01' where id = ${lit(admin.id)};`);
  });

  await report(db, people);
}

async function report(db, people) {
  const ids = people.map((p) => lit(p.id)).join(", ");
  const rows = await db.rows(`select p.full_name, p.employment_status,
    (select string_agg(status || ' ' || n, ', ') from (select status, count(*) n from attendance_logs a where a.employee_id = p.id group by 1 order by 1) s) attendance,
    (select string_agg(leave_type || ' ' || status, ', ') from leave_requests l where l.employee_id = p.id) leave,
    (select string_agg(status, ', ') from overtime_requests o where o.employee_id = p.id) overtime,
    (select string_agg(pay_period || ' ' || status || ' net ' || round((payroll->'totals'->>'net_pay')::numeric, 2), '; ' order by pay_period) from payroll_entries e where e.employee_id = p.id) payslips
    from profiles p where p.id in (${ids}) order by p.employee_id`);
  for (const r of rows) {
    log(`${r.full_name} (${r.employment_status})`);
    log(`   attendance: ${r.attendance}`);
    log(`   leave: ${r.leave || "-"} | overtime: ${r.overtime || "-"}`);
    log(`   payslips: ${r.payslips || "-"}`);
  }
}

// ───────────────────────────── live commands ─────────────────────────────
/** demo.mjs with the five scope (its prompts and guards unchanged). */
function demoCommand(name, extra = []) {
  const run = spawnSync(process.execPath, [join("scripts", "demo", "demo.mjs"), name, `--target=${target}`, ...extra], { stdio: "inherit", env: { ...process.env, DEMO_SCOPE: "five" } });
  process.exitCode = run.status ?? 1;
}

/** READ-ONLY: the five's numbers are free on the target, then demo.mjs's own plan (nothing written). */
async function check() {
  const db = database(target);
  const [branch] = await db.rows("select * from branches where code = 'BR-001'");
  const { all } = fiveRoster(branch);
  const clash = await db.rows(`select 'person' what, full_name n from profiles where id in (${all.map((p) => lit(p.id)).join(", ")})
    union all select 'e-mail', full_name from profiles where lower(email) in (${all.map((p) => lit(p.email.toLowerCase())).join(", ")})
    union all select 'employee no.', full_name from profiles where employee_id in (${all.filter((p) => p.employee_id).map((p) => lit(p.employee_id)).join(", ")})
    union all select 'card', uid from rfid_cards where uid in (${all.filter((p) => p.rfid_uid).map((p) => lit(p.rfid_uid)).join(", ")})
    union all select 'login', 'auth user' from auth.users where id in (${all.map((p) => lit(p.id)).join(", ")}) or lower(email) in (${all.map((p) => lit(p.email.toLowerCase())).join(", ")})`);
  const kept = await db.rows(`select full_name, archived, employee_status from profiles where id in (${lit(HR.id)}, ${lit(ACC.id)})`);
  const [run] = await db.rows(`select status, run_no from payroll_runs where branch_id = ${lit(branch.id)} and period_start = '2026-11-01' order by run_no desc limit 1`);
  console.log(`Target: ${target}`);
  console.log(`  kept demo approvers: ${kept.map((k) => `${k.full_name} (${k.employee_status}${k.archived ? ", archived" : ""})`).join(", ") || "MISSING"}`);
  console.log(`  ${FIRST}, Main Branch: ${run ? `run ${run.run_no} is ${run.status}` : "no run yet"}${run && run.status !== "approved" ? "  <- must be approved before the load (the five's run is a supplemental run)" : ""}`);
  console.log(clash.length ? `  ALREADY TAKEN (the load would stop): ${clash.map((c) => `${c.what} ${c.n}`).join("; ")}` : "  ids, e-mails, employee numbers, cards and logins: all free");
  if (kept.length !== 2) console.log("  STOP: Demo HR One and Demo Accountant One Main must exist.");
}

/**
 * The daily job until the defense: ordinary taps for the five on every school
 * day after their last tapped day, up to yesterday (or today after 17:30).
 * The automatic Absent rows the nightly close made for those days (no tap,
 * never edited) are replaced; a day someone edited is never touched.
 */
async function taps() {
  if (target === "production") {
    console.log(`PRODUCTION. Type the project URL to continue (${PRODUCTION.url}):`);
    if (!(await confirm(">", PRODUCTION.url))) return console.log("The URL did not match. Nothing was done.");
  }
  const db = database(target);
  const [branch] = await db.rows("select * from branches where code = 'BR-001'");
  const { people } = fiveRoster(branch);
  const live = await db.rows(`select id from profiles where id in (${people.map((p) => lit(p.id)).join(", ")}) and not archived`);
  const active = people.filter((p) => live.some((l) => l.id === p.id));
  if (!active.length) return console.log("The five are not on the target. Nothing done.");
  const ids = active.map((p) => lit(p.id)).join(", ");
  const [last] = await db.rows(`select max(log_date)::text d from attendance_logs where employee_id in (${ids}) and time_in is not null`);
  const now = new Date(Date.now() + 8 * 3600e3);
  const today = now.toISOString().slice(0, 10);
  const until = now.getUTCHours() * 60 + now.getUTCMinutes() >= 17 * 60 + 30 ? today : addDays(today, -1);
  const from = addDays(last.d, 1);
  if (from > until) return console.log(`Nothing to add: the five's taps already reach ${last.d}.`);
  const [auto] = await db.rows(`select count(*)::int n from attendance_logs where employee_id in (${ids}) and log_date between ${lit(from)} and ${lit(until)}
    and time_in is null and time_out is null and status = 'Absent' and changed_by is null and leave_request_id is null`);
  console.log(`Will add ordinary taps for ${active.length} demo employees, school days ${from} to ${until}, replacing ${auto.n} automatic Absent day(s). Nothing else changes.`);
  if (!(await confirm("Add them? (yes/no)"))) return console.log("Nothing done.");
  await db.exec(`begin; alter table attendance_logs disable trigger user;
    delete from attendance_logs where employee_id in (${ids}) and log_date between ${lit(from)} and ${lit(until)}
      and time_in is null and time_out is null and status = 'Absent' and changed_by is null and leave_request_id is null;
    alter table attendance_logs enable trigger user; commit;`);
  await db.exec(tapsSql(active, from, until, { plan: false }));
  const [n] = await db.rows(`select count(*)::int n from attendance_logs where employee_id in (${ids}) and log_date between ${lit(from)} and ${lit(until)} and time_in is not null`);
  console.log(`added: ${n.n} tapped days.`);
}

const commands = {
  build,
  export: () => demoCommand("export"),
  check,
  load: () => demoCommand("seed"),
  remove: () => demoCommand("remove"),
  taps,
  report: async () => { const db = database(target); const [b] = await db.rows("select * from branches where code = 'BR-001'"); await report(db, fiveRoster(b).people); },
};
if (!commands[command]) {
  console.log(`Commands: ${Object.keys(commands).join(", ")} (credentials: ${join(DATA_DIR, "five-credentials.csv")})`);
  process.exit(1);
}
await commands[command]();
