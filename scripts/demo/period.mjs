// The defense data for every account on payroll, Oct 1 to today (requested 2026-11-24).
//
//   node scripts/demo/period.mjs build      LOCAL ONLY (a fresh copy of live, the local app on :3101 with the
//                                           local-build tap patch): wipe the scope, then generate everything
//                                           through the app's routes, the RFID terminal and the nightly close
//   node scripts/demo/period.mjs verify     LOCAL: the checks (reconciliation, totals, statuses, text)
//   node scripts/demo/period.mjs export     LOCAL -> demo-data/period-bundle.json (+ the record updates)
//   node scripts/demo/period.mjs plan  --target=production   READ-ONLY: per person, what would be replaced
//   node scripts/demo/period.mjs apply --target=production   replace on live in one transaction (+ rollback file)
//
// The plan is scripts/demo/period-plan.mjs, the scope scripts/demo/period-scope.mjs. No key or password printed.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";
import { database, lit } from "./db.mjs";
import { as, kioskCookie, kioskTap, ok } from "./local-api.mjs";
import { stableId } from "./roster.mjs";
import * as PLAN from "./period-plan.mjs";
import { SCOPE, scopeWhere, wipeSql } from "./period-scope.mjs";

const [command, ...rest] = process.argv.slice(2);
const target = (rest.find((a) => a.startsWith("--target=")) || "--target=local").split("=")[1];
const resumeAt = Number((rest.find((a) => a.startsWith("--resume-at=")) || "--resume-at=1").split("=")[1]);
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

// The kept approver accounts, with realistic names (owner's yes, 2026-11-24).
export const ACTORS = [{ id: stableId("hr1"), first: "Maricel", middle: null, last: "Santos" }, { id: stableId("acc-b1-1"), first: "Rowena", middle: null, last: "Dizon" }];
const HR = { id: stableId("hr1"), role: "hr", full: "Maricel Santos", email: "" };
const ACC = { id: stableId("acc-b1-1"), role: "accountant", full: "Rowena Dizon", email: "" };
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const manilaNow = () => new Date(Date.now() + 8 * 3600e3);
const manilaToday = () => manilaNow().toISOString().slice(0, 10);
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
/** A stable 0..n-1 from a text (a rebuild is identical). */
const pick = (text, n) => parseInt(createHash("sha256").update(text).digest("hex").slice(0, 8), 16) % n;
const iso = (day, time) => `${day}T${time}:00+08:00`;

let step = 0;
async function stage(name, fn) {
  step += 1;
  if (step < resumeAt) return;
  const result = await fn();
  log(`${String(step).padStart(2)} ${name}${result ? `: ${result}` : ""}`);
}

/** The accounts on payroll, matched to the plan. */
async function people(db) {
  const rows = await db.rows(`select p.id, p.full_name, p.employee_id, lower(p.role::text) as role, p.branch_id, p.email, p.rfid_uid, p.date_hired::text as date_hired,
      p.employee_type, p.employment_status, p.employee_status, p.basic_salary, p.position
    from profiles p where not p.archived and p.on_payroll and lower(p.role::text) in ('employee','accountant','hr')`);
  const used = new Set();
  const out = PLAN.PEOPLE.map((plan, i) => {
    const m = plan.match;
    const row = rows.find((r) => !used.has(r.id) && (m.code ? r.employee_id === m.code : r.full_name === m.name && r.role === m.role));
    if (!row) throw new Error(`not found on the target: ${JSON.stringify(m)}`);
    used.add(row.id);
    return { ...row, ...plan, n: i + 1, full: row.full_name };
  });
  const extra = rows.filter((r) => !used.has(r.id));
  if (extra.length) throw new Error(`on payroll but not in the plan: ${extra.map((r) => r.full_name).join(", ")}`);
  return out;
}

async function branches(db) {
  const rows = await db.rows("select id, code, name from branches");
  return Object.fromEntries(rows.map((b) => [b.code, b]));
}

// ───────────────────────────── build (LOCAL ONLY) ─────────────────────────────
async function build() {
  if (target !== "local") throw new Error("build is LOCAL ONLY.");
  const db = database("local");
  const br = await branches(db);
  let all = await people(db);
  const by = (key) => all.find((p) => p.key === key);
  const today = manilaToday();
  const yesterday = addDays(today, -1);
  const scope = () => ({ ids: all.map((p) => p.id), branches: [...new Set(all.map((p) => p.branch_id).filter(Boolean))], from: PLAN.FROM });

  await stage("wipe the scope (these accounts, Oct 1 to today)", async () => {
    const B = [br["BR-001"].id, br["BR-003"].id];
    const paid = (await db.rows(`select distinct employee_id from payroll_entries where run_id in (select id from payroll_runs where branch_id in (${B.map(lit).join(", ")}) and period_start >= ${lit(PLAN.FROM)})`)).map((r) => r.employee_id);
    await db.exec(wipeSql({ ...scope(), branches: B, paid }));
    return `${SCOPE.length} tables`;
  });

  await stage("complete records (names, branch, ID, contact, government numbers, emergency contact)", async () => {
    const sql = ["begin;"];
    for (const a of ACTORS) {
      const full = [a.first, a.middle, a.last].filter(Boolean).join(" ");
      sql.push(`update profiles set first_name = ${lit(a.first)}, middle_name = ${lit(a.middle)}, last_name = ${lit(a.last)}, full_name = ${lit(full)}, updated_at = now() where id = ${lit(a.id)};`);
      sql.push(`update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('full_name', ${lit(full)}) where id = ${lit(a.id)};`);
    }
    for (const p of all) {
      const set = [];
      if (p.rename) {
        const full = `${p.rename.first} ${p.rename.middle} ${p.rename.last}`;
        set.push(`first_name = ${lit(p.rename.first)}`, `middle_name = ${lit(p.rename.middle)}`, `last_name = ${lit(p.rename.last)}`, `full_name = ${lit(full)}`);
      }
      if (p.branch) set.push(`branch_id = ${lit(br[p.branch].id)}`);
      if (p.code) set.push(`employee_id = ${lit(p.code)}`);
      if (p.position) set.push(`position = ${lit(p.position)}`);
      if (p.salary) set.push(`basic_salary = ${p.salary}`);
      if (p.hired) set.push(`date_hired = ${lit(p.hired)}`);
      if (p.category) set.push(`employee_type = ${lit(p.category)}`);
      if (p.status) set.push(`employment_status = ${lit(p.status)}`);
      if (p.active) set.push("employee_status = 'Active'", "payroll_hold = false", "payroll_hold_reason = null");
      if (p.cp) set.push(`cp_number = ${lit(p.cp)}`);
      if (p.address) set.push(`address = ${lit(p.address)}`);
      if (p.emergency) set.push(`emergency_contact_name = ${lit(p.emergency[0])}`, `emergency_contact_relationship = ${lit(p.emergency[1])}`,
        `emergency_contact_address = ${lit(p.address || "Antipolo City, Rizal")}`, `emergency_contact_number = ${lit(p.emergency[2])}`);
      if (p.separation) set.push(`separation_reason = ${lit(p.separation.reason)}`, `separated_on = ${lit(p.separation.on)}`);
      if (!p.key.match(/^(marisol|carlo|liza|ramon|nestor)$/)) {
        const g = PLAN.govNumbers(p.n);
        set.push(`sss_number = ${lit(g.sss_number)}`, `philhealth_number = ${lit(g.philhealth_number)}`, `pagibig_number = ${lit(g.pagibig_number)}`, `tin_number = ${lit(g.tin_number)}`);
      }
      set.push("updated_at = now()");
      sql.push(`update profiles set ${set.join(", ")} where id = ${lit(p.id)};`);
    }
    // A salary first recorded as "0 -> X" (set when HR salaries were entered, Nov 19) applies from the hire date.
    sql.push(`alter table employee_salary_changes disable trigger user;
      update employee_salary_changes c set effective_date = coalesce(p.date_hired, '2026-09-01')
        from profiles p where p.id = c.employee_id and c.old_salary = 0 and c.employee_id in (${all.map((x) => lit(x.id)).join(", ")});
      alter table employee_salary_changes enable trigger user;`);
    sql.push("commit;");
    await db.exec(sql.join("\n"));
    all = await people(db).catch(() => all);
    return `${all.length} records`;
  });

  await stage("RFID cards (HR registers the missing ones; issued before Oct 1)", async () => {
    const have = await db.rows(`select employee_id from rfid_cards where status = 'active' and employee_id in (${all.map((p) => lit(p.id)).join(", ")})`);
    let n = 0;
    for (const p of all) {
      if (have.some((h) => h.employee_id === p.id)) continue;
      const uid = String(9990000300 + p.n);
      ok(`card ${p.key}`, await as(HR).post("/api/rfid/cards", { action: "register", employee_id: p.id, uid, reason: "Card issued" }));
      n += 1;
    }
    const ids = all.map((p) => lit(p.id)).join(", ");
    await db.exec(`begin; alter table rfid_cards disable trigger user; alter table rfid_card_events disable trigger user;
      update rfid_cards set registered_at = least(registered_at, '2026-09-28 08:00+08'), created_at = least(created_at, '2026-09-28 08:00+08') where employee_id in (${ids}) and status = 'active';
      update rfid_card_events set created_at = least(created_at, '2026-09-28 08:00+08'), effective_on = least(effective_on, '2026-09-28') where employee_id in (${ids}) and to_status = 'active';
      alter table rfid_cards enable trigger user; alter table rfid_card_events enable trigger user; commit;`);
    all = await people(db);
    const cards = await db.rows(`select employee_id, uid from rfid_cards where status = 'active' and employee_id in (${ids})`);
    for (const p of all) p.uid = cards.find((c) => c.employee_id === p.id)?.uid;
    return `${n} registered, ${cards.length} active`;
  });

  await stage("teacher licenses (Marisol, Carlo: fictional PRC numbers, verified by HR)", async () => {
    for (const p of all.filter((x) => x.licensed)) {
      ok(`license ${p.key}`, await as(HR).post("/api/hr/teacher-license", { action: "turn_on", employee_id: p.id, reason: "PRC license presented", prc_license_no: p.licensed.no, license_expires_on: p.licensed.expires }));
      ok(`verify ${p.key}`, await as(HR).post("/api/hr/teacher-license", { action: "verify", employee_id: p.id, reason: "Checked against the PRC verification site" }));
    }
    return "2 licensed";
  });

  await stage(`attendance incentives: Perfect Attendance ₱${PLAN.PERFECT_ATTENDANCE}, Early Bird ₱${PLAN.EARLY_BIRD} (${PLAN.DEMO_NOTE})`, async () => {
    await db.exec(`begin;
      insert into payroll_rate_configs (rate_type, scope, value, effective_date, note, created_by_name)
        select v.t, 'global', v.v, '2026-10-01', ${lit(PLAN.DEMO_NOTE)}, 'Super Administrator'
        from (values ('perfect_attendance_bonus', ${PLAN.PERFECT_ATTENDANCE}::numeric)) v(t, v)
        where not exists (select 1 from payroll_rate_configs c where c.rate_type = v.t and c.effective_date = '2026-10-01' and c.note = ${lit(PLAN.DEMO_NOTE)});
      update system_config set value = ${lit(String(PLAN.EARLY_BIRD))} where section = 'early_bird' and key = 'incentive_amount';
      commit;`);
    return "rates from Oct 1";
  });

  // Requests come before the taps: an approved leave day has no taps (the terminal refuses them).
  const leaveIds = {};
  await stage("leave (as filed on the day; HR decides)", async () => {
    for (const l of PLAN.LEAVE) {
      const p = by(l.who);
      const id = randomUUID();
      await db.exec(`insert into leave_requests (id, employee_id, employee_name, position, leave_type, start_date, end_date, reason, status, submitted_at, updated_at, pay_status, branch_id, half_day)
        values (${lit(id)}, ${lit(p.id)}, ${lit(p.full)}, ${lit(p.position)}, ${lit(l.type)}, ${lit(l.start)}, ${lit(l.end)}, ${lit(l.reason)}, 'pending_admin',
          ${lit(`${l.filed}T01:30:00Z`)}, ${lit(`${l.filed}T01:30:00Z`)}, 'paid', ${lit(p.branch_id)}, ${lit(l.half || null)});`);
      leaveIds[`${l.who}:${l.start}`] = id;
      if (l.decision === "approve") ok(`approve ${l.who}`, await as(HR).patch("/api/hr/leave-requests", { id, action: "approve" }));
      if (l.decision === "reject") ok(`reject ${l.who}`, await as(HR).patch("/api/hr/leave-requests", { id, action: "reject", remark: l.remark, reason: l.note }));
    }
    const s = await db.rows(`select status, count(*)::int n from leave_requests where id in (${Object.values(leaveIds).map(lit).join(", ")}) group by 1`);
    return s.map((x) => `${x.status} ${x.n}`).join(", ");
  });

  await stage("overtime filed ahead (HR decides)", async () => {
    let n = 0;
    for (const o of PLAN.OVERTIME) {
      const p = by(o.who);
      if (o.day === "upcoming") {
        let d = addDays(today, 2); while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
        ok(`OT ${o.who}`, await as(p).post("/api/me/overtime-requests", { request_date: d, planned_start: o.start, planned_end: o.end, reason: o.reason }));
        n += 1; continue;
      }
      const id = randomUUID();
      const minutes = toMin(o.end) - toMin(o.start);
      const period = PLAN.PERIODS.find((x) => o.day >= x.start && o.day <= x.end).label;
      await db.exec(`insert into overtime_requests (id, employee_id, branch_id, request_date, planned_start, planned_end, minutes, reason, status, late_filing, prepared, filed_by, filed_by_name, created_at)
        values (${lit(id)}, ${lit(p.id)}, ${lit(p.branch_id)}, ${lit(o.day)}, ${lit(o.start)}, ${lit(o.end)}, ${minutes}, ${lit(o.reason)}, 'pending', false,
          ${lit({ filed_on: o.filed, period, cutoff_minutes_with_this: minutes, limits: { file_days_before: 1, late_filing_days_after: 2 } })}, ${lit(p.id)}, ${lit(p.full)}, ${lit(`${o.filed}T02:00:00Z`)});`);
      ok(`approve OT ${o.who}`, await as(HR).patch("/api/hr/overtime-requests", { id, decision: "approve", note: "Approved: school event." }));
      n += 1;
    }
    return `${n} requests`;
  });

  await stage(`special working day Sat ${PLAN.MAKEUP_DAY.date} (make-up; the three teachers)`, async () => {
    // A past Saturday: written as HR declared it on Mon Nov 16 (the route takes today or later only), with the
    // route's own row and notice to the covered teachers.
    const id = randomUUID();
    const covered = PLAN.MAKEUP_COVERS.map((k) => by(k));
    await db.exec(`begin;
      insert into special_working_days (id, work_date, branch_ids, audience, employee_ids, start_time, end_time, reason, pay_type, premium_pct, created_by, created_by_name, created_at)
        values (${lit(id)}, ${lit(PLAN.MAKEUP_DAY.date)}, array[${lit(br["BR-001"].id)}]::uuid[], 'employees', array[${covered.map((p) => lit(p.id)).join(", ")}]::uuid[],
          ${lit(PLAN.MAKEUP_DAY.start)}, ${lit(PLAN.MAKEUP_DAY.end)}, ${lit(PLAN.MAKEUP_DAY.reason)}, 'makeup', 130, ${lit(HR.id)}, 'Maricel Santos', '2026-11-16 09:00+08');
      insert into notifications (recipient_id, kind, title, body, link_page, created_at)
        select x, 'special_working_day', 'Special working day: Sat, Nov 21, 2026', ${lit(`Make-up day, 8:00 AM to 12:00 PM. ${PLAN.MAKEUP_DAY.reason}`)}, 'emp-attendance', '2026-11-16 09:00+08'
        from unnest(array[${covered.map((p) => lit(p.id)).join(", ")}]::uuid[]) x;
      commit;`);
    return `${PLAN.MAKEUP_DAY.start}-${PLAN.MAKEUP_DAY.end}`;
  });

  await stage("taps at the RFID terminal, Oct 1 to yesterday, from each one's current schedule", async () => {
    const kiosk = kioskCookie(HR);
    // Anjo worked until Oct 21: Active while his October days are tapped, Separated again right after.
    const anjo = by("anjo");
    await db.exec(`update profiles set employee_status = 'Active' where id = ${lit(anjo.id)};`);
    const cards = await db.rows(`select employee_id, uid from rfid_cards where status = 'active' and employee_id in (${all.map((p) => lit(p.id)).join(", ")})`);
    for (const p of all) p.uid = cards.find((c) => c.employee_id === p.id)?.uid;
    const stats = { taps: 0, refused: 0, days: 0 };
    const refusals = [];
    for (const p of all) {
      if (!p.uid) throw new Error(`${p.full}: no active card`);
      const start = p.date_hired && p.date_hired > PLAN.FROM ? p.date_hired : PLAN.FROM;
      const stop = PLAN.STOP_TAPPING[p.key] || addDays(today, 1);
      // The days the database calls working days for this person (holidays, rest days excluded; the special day included).
      const days = await db.rows(`select d::date::text as day, s.work_start as start_min, s.work_end as end_min, s.grace as grace_minutes
        from generate_series(${lit(start)}::date, least(${lit(yesterday)}::date, ${lit(addDays(stop, -1))}::date), interval '1 day') d,
        lateral public.attendance_schedule_for(${lit(p.id)}::uuid, ${lit(p.branch_id)}::uuid, d::date) s
        where public.attendance_is_working_day_for(${lit(p.id)}::uuid, ${lit(p.branch_id)}::uuid, d::date)
          and not exists (select 1 from leave_requests l where l.employee_id = ${lit(p.id)} and l.status = 'approved' and d::date between l.start_date::date and l.end_date::date and l.half_day is null)
        order by 1`);
      for (const d of days) {
        const special = PLAN.SPECIAL_DAYS[p.key]?.[d.day];
        if (special === "none") continue;
        let startMin = Number(d.start_min), endMin = Number(d.end_min);
        if (d.day === PLAN.MAKEUP_DAY.date) { startMin = toMin(PLAN.MAKEUP_DAY.start); endMin = toMin(PLAN.MAKEUP_DAY.end); }
        const halfLeave = (await db.rows(`select half_day from leave_requests where employee_id = ${lit(p.id)} and status = 'approved' and half_day is not null and ${lit(d.day)}::date between start_date::date and end_date::date`))[0]?.half_day;
        const mid = Math.round((startMin + endMin) / 2);
        let tin = startMin - (5 + pick(`${p.id}${d.day}in`, 21));
        let tout = endMin + pick(`${p.id}${d.day}out`, 21);
        if (halfLeave === "AM") tin = mid - (3 + pick(`${p.id}${d.day}h`, 8));
        if (halfLeave === "PM") tout = mid + pick(`${p.id}${d.day}h`, 6);
        if (Array.isArray(special)) {
          if (special[0] !== "auto") tin = special[0] === null ? null : toMin(special[0]);
          if (special[1] !== "auto") tout = special[1] === null ? null : toMin(special[1]);
        }
        stats.days += 1;
        for (const t of [tin, tout]) {
          if (t === null) continue;
          const res = await kioskTap(kiosk, p.uid, iso(d.day, hhmm(t)));
          if (res.status === 200 && res.data?.persisted) stats.taps += 1;
          else { stats.refused += 1; refusals.push(`${p.full} ${d.day} ${hhmm(t)}: ${res.status} ${res.data?.error || res.data?.message || ""}`.slice(0, 160)); }
        }
      }
    }
    await db.exec(`begin; update profiles set employee_status = 'Separated' where id = ${lit(anjo.id)};
      alter table rfid_cards disable trigger user;
      update rfid_cards set status = 'inactive', status_reason = 'Separated (resigned): last day Oct 21', status_changed_at = '2026-10-22 08:00+08', status_changed_by_name = 'Maricel Santos'
        where employee_id = ${lit(anjo.id)} and status = 'active';
      alter table rfid_cards enable trigger user; commit;`);
    if (refusals.length) { console.log(refusals.slice(0, 15).join("\n")); throw new Error(`${refusals.length} taps refused`); }
    return `${stats.days} days, ${stats.taps} taps`;
  });

  await stage("nightly close Oct 1 to yesterday (the database sets every status)", async () => {
    await db.exec(`select public.attendance_close_days(${lit(PLAN.FROM)}::date, ${lit(yesterday)}::date);`);
    const s = await db.rows(`select status, count(*)::int n from attendance_logs where employee_id in (${all.map((p) => lit(p.id)).join(", ")}) and log_date >= ${lit(PLAN.FROM)} group by 1 order by 2 desc`);
    return s.map((x) => `${x.status} ${x.n}`).join(", ");
  });

  await stage("missing time-outs: corrections (the employee files; HR decides)", async () => {
    const out = [];
    for (const c of PLAN.CORRECTIONS) {
      const p = by(c.who);
      const [l] = await db.rows(`select id, status from attendance_logs where employee_id = ${lit(p.id)} and log_date = ${lit(c.day)}`);
      if (!l) throw new Error(`${p.full} ${c.day}: no attendance record`);
      ok(`correction ${c.who} ${c.day}`, await as(p).post("/api/me/attendance/corrections", { log_id: l.id, corrected_time: c.time, reason: "Forgot to tap out; left after class." }));
      if (c.decision === "approve") {
        const list = ok("pending corrections", await as(HR).get("/api/attendance/corrections?status=pending")).corrections || [];
        const mine = list.find((x) => x.employee_id === p.id && String(x.log_date).startsWith(c.day));
        ok("approve correction", await as(HR).patch("/api/attendance/corrections", { correction_id: mine.id, decision: "approve", note: c.note }));
      }
      out.push(`${c.who} ${c.day} ${c.decision ? "approved" : "pending"}`);
    }
    return out.join(", ");
  });

  await stage("substitution (proposed by the system from Carlo's approved sick leave; HR picks Marisol)", async () => {
    const l = PLAN.LEAVE.find((x) => x.substitute);
    const [proposal] = await db.rows(`select id from substitutions where leave_request_id = ${lit(leaveIds[`${l.who}:${l.start}`])} and status = 'pending' and substitute_id is null`);
    if (!proposal) throw new Error("no substitution was proposed");
    ok("approve with Marisol", await as(HR).patch("/api/substitutions", { id: proposal.id, action: "approve", substitute_id: by(l.substitute).id, periods: 3 }));
    return "Marisol covers Carlo, Nov 17";
  });

  await stage("honoraria and adjustment (Accountant files, HR approves)", async () => {
    for (const a of PLAN.ADDITIONAL) {
      ok(a.kind, await as(ACC).post("/api/accountant/payroll", { action: "add_monthly_item", employee_id: by(a.who).id, item_date: a.date, kind: a.kind, description: a.description, amount: a.amount, reason: a.description }));
    }
    const list = ok("HR list", await as(HR).get("/api/hr/adjustment-approvals?status=pending")).items || [];
    const mine = list.filter((i) => i.kind === "incentive" && all.some((p) => p.id === i.employee_id));
    for (const i of mine) ok("approve", await as(HR).patch("/api/hr/adjustment-approvals", { kind: "incentive", id: i.id, decision: "approve", remark: { code: "approve.as_requested" } }));
    return `${mine.length} approved`;
  });

  await stage("loans and cash advance (Accountant files, HR approves)", async () => {
    for (const l of PLAN.LOANS) {
      const amort = Math.round((l.principal / l.payrolls) * 100) / 100;
      // As the Accountant filed it on the grant date (the route takes this month's 16-end or later only): the
      // route's own row, waiting for HR.
      const p = by(l.who);
      await db.exec(`insert into payroll_loans (employee_id, branch_id, loan_type, description, date_granted, principal, interest_pct, number_of_payrolls, amortization, start_period,
          final_pay_authorized, created_by, created_by_name, approval_status, created_at)
        values (${lit(p.id)}, ${lit(p.branch_id)}, ${lit(l.type)}, ${lit(l.description)}, ${lit(l.granted)}, ${l.principal}, 0, ${l.payrolls}, ${amort}, ${lit(l.start)},
          true, ${lit(ACC.id)}, 'Rowena Dizon', 'pending', ${lit(`${l.granted}T02:00:00Z`)});`);
    }
    const list = ok("HR list", await as(HR).get("/api/hr/adjustment-approvals?status=pending")).items || [];
    const mine = list.filter((i) => i.kind === "loan" && all.some((p) => p.id === i.employee_id));
    for (const i of mine) ok("approve loan", await as(HR).patch("/api/hr/adjustment-approvals", { kind: "loan", id: i.id, decision: "approve", remark: { code: "approve.as_requested" } }));
    return `${mine.length} approved`;
  });

  await stage("tenure pay protection (the system grants it from 2 years of service)", async () => {
    const [r] = await db.rows(`select public.tenure_auto_grant(${lit(today)}::date) as n`);
    const g = await db.rows(`select p.full_name from tenure_protection_grants g join profiles p on p.id = g.employee_id where g.revoked_on is null and g.employee_id in (${all.map((p) => lit(p.id)).join(", ")})`);
    return `${r.n} granted: ${g.map((x) => x.full_name).join(", ")}`;
  });

  // After Nov 1-15 is paid (his absence starts Nov 18; the case holds pay from then on).
  const awolStage = () => stage("AWOL case for Ramon (opened as the nightly job does; HR proceeds)", async () => {
    const ramon = by("ramon");
    const from = PLAN.STOP_TAPPING.ramon;
    const [g] = await db.rows(`select public.awol_case_guards(${lit(ramon.id)}::uuid, ${lit(from)}::date, ${lit(yesterday)}::date) g`);
    const failed = (g.g.checks || []).filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join("; ");
    const [lastPresent] = await db.rows(`select max(log_date)::text d from attendance_logs where employee_id = ${lit(ramon.id)} and log_date < ${lit(from)} and time_in is not null`);
    const caseId = randomUUID();
    await db.exec(`insert into employee_awol_cases (id, employee_id, branch_id, first_absent_on, last_present_on, stage, auto_flagged, notes, guards, automation, automation_reason, automation_changed_at, automation_changed_by_name)
      values (${lit(caseId)}, ${lit(ramon.id)}, ${lit(ramon.branch_id)}, ${lit(from)}, ${lit(lastPresent.d)}, 'flagged', true,
        'Opened by System, rule: 5 scheduled working days absent with no taps and no request.', ${lit(g.g)}::jsonb,
        ${g.g.ok ? "'auto'" : "'needs_review'"}, ${g.g.ok ? "null" : lit(`A guard failed: ${failed}`)}, now(), 'System');`);
    ok("HR proceeds", await as(HR).patch("/api/hr/awol-cases", { case_id: caseId, action: "proceed", remark: { code: "other", extra: "Checked: no request and no tap; the data gap is staff not tapping yet." } }));
    return `1st notice sent (guards failed first: ${failed || "none"})`;
  });

  // Payroll: each period in order, each branch through the real flow. Nov 16-30 stays as drafts for the defense.
  for (const period of PLAN.PERIODS) {
    if (!period.final) await awolStage();
    await stage(`payroll ${period.label}${period.final ? ": processed, submitted, HR-approved" : ": drafts for the defense"}`, async () => {
      const notes = [];
      for (const code of ["BR-001", "BR-003"]) {
        // A separated employee is paid through final pay only (Anjo: Oct 1-21 in his final pay).
        const staff = all.filter((p) => p.branch_id === br[code].id && (!p.date_hired || p.date_hired <= period.end) && !p.separation);
        if (!staff.length) continue;
        const accountant = code === "BR-001" ? ACC : { ...by("janeacc"), role: "accountant" };
        if (!period.final) {
          let held = 0;
          for (const p of staff) {
            const r = await as(accountant).patch("/api/accountant/payroll", { action: "generate", employee_id: p.id, pay_period: period.label, confirm_incomplete: true });
            if (r.status === 409 && r.data?.code === "payroll_hold") { held += 1; continue; } // Ramon: pay on hold (AWOL)
            ok(`draft ${p.key}`, r);
          }
          notes.push(`${br[code].name} ${staff.length - held} drafts${held ? `, ${held} on hold` : ""}`);
          continue;
        }
        // Resumable: a branch whose run is already approved is done; a submitted one only needs HR.
        const [have] = await db.rows(`select id, status from payroll_runs where branch_id = ${lit(br[code].id)} and period_label = ${lit(period.label)} order by run_no desc limit 1`);
        if (have?.status === "approved") { notes.push(`${br[code].name} already paid`); continue; }
        if (!have || have.status !== "pending") {
          const res = ok(`batch ${code}`, await as(accountant).post("/api/accountant/payroll", { action: "batch_submit", pay_period: period.label, entries: staff.map((p) => ({ employee_id: p.id })) }));
          const skipped = (res.skipped || []).filter((k) => !/already been processed/.test(k.reason || ""));
          if (skipped.length) throw new Error(`${code} skipped: ${JSON.stringify(skipped).slice(0, 500)}`);
          let submit = await as(accountant).patch("/api/accountant/payroll-runs", { action: "submit", branch_id: br[code].id, period: period.label });
          if (submit.status === 409 && submit.data?.code === "exclusions_unacknowledged") {
            const notesBy = Object.fromEntries((submit.data.missing || []).map((m) => [m.id, "Separated: paid through final pay."]));
            submit = await as(accountant).patch("/api/accountant/payroll-runs", { action: "submit", branch_id: br[code].id, period: period.label, acknowledge_exclusions: true, exclusion_notes: notesBy });
          }
          ok(`submit ${code}`, submit);
        }
        const [run] = await db.rows(`select id from payroll_runs where branch_id = ${lit(br[code].id)} and period_label = ${lit(period.label)} order by run_no desc limit 1`);
        // Demo HR One decides both branches (the Robinson HR's own payslip is in Robinson's run: another HR decides).
        const approved = ok(`approve ${code}`, await as(HR).patch("/api/hr/payroll-runs", { action: "approve", run_ids: [run.id] }));
        if (!approved?.approved) throw new Error(`${code} not approved: ${JSON.stringify(approved).slice(0, 300)}`);
        notes.push(`${br[code].name} ${staff.length} paid`);
      }
      // Anjo's final pay once his last half is paid (separated Oct 21).
      if (period.label === "October 16-31, 2026") {
        const anjo = by("anjo");
        const [pending] = await db.rows(`select id from payroll_final_pay_submissions where employee_id = ${lit(anjo.id)} and status::text like 'pending%' limit 1`);
        if (!pending) ok("final pay", await as(ACC).post("/api/accountant/final-pay", { employee_id: anjo.id, release_on: "2026-11-20" }));
        const [fp] = await db.rows(`select id from payroll_final_pay_submissions where employee_id = ${lit(anjo.id)} order by created_at desc limit 1`);
        ok("HR approves final pay", await as(HR).patch("/api/hr/final-pay-approvals", { id: fp.id, action: "approve", remark: { code: "approve.as_requested" } }));
        notes.push("Anjo final pay approved");
      }
      return notes.join("; ");
    });
  }

  await report(db, all);
}

async function report(db, all) {
  const rows = await db.rows(`select p.full_name,
    (select string_agg(status || ' ' || n, ', ') from (select status, count(*) n from attendance_logs a where a.employee_id = p.id and a.log_date >= ${lit(PLAN.FROM)} group by 1 order by 2 desc) s) attendance,
    (select string_agg(pay_period || ' ' || status || ' ' || round((payroll->'totals'->>'net_pay')::numeric, 2), '; ' order by created_at) from payroll_entries e where e.employee_id = p.id and e.pay_period like '%2026') payslips
    from profiles p where p.id in (${all.map((p) => lit(p.id)).join(", ")}) order by p.full_name`);
  for (const r of rows) log(`${r.full_name}\n     ${r.attendance}\n     ${r.payslips || "-"}`);
}

const commands = { build, report: async () => { const db = database(target); await report(db, await people(db)); } };
if (!commands[command]) { console.log(`Commands: ${Object.keys(commands).join(", ")}`); process.exit(1); }
await commands[command]();
