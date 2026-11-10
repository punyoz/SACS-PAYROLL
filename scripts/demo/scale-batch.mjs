// G9.11 (LOCAL ONLY): 80 extra fake employees in Branch 1, a timed "Process
// payroll for all" by the API, then the batch is removed again.
//   node scripts/demo/scale-batch.mjs
import { database, lit } from "./db.mjs";
import { as, localAuthAdmin } from "./local-api.mjs";
import { attendanceSql, context, manilaToday, profileInsert } from "./build-local.mjs";
import { stableId } from "./roster.mjs";

const local = database("local");
const { by, branchCodes, roster } = await context();
const b1 = branchCodes["BR-001"];
const today = manilaToday();
const { periodForDateKey } = await import("../../src/lib/payroll/periods.js");
const period = periodForDateKey(today);
const extra = Array.from({ length: 80 }, (_, i) => {
  const n = i + 1;
  return { tag: `scale${n}`, id: stableId(`scale${n}`), role: "employee", first: "Scale", middle: "Demo", last: `Test ${["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"][n % 8]} ${["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"][Math.floor(n / 8) % 10]}`,
    full: "", email: `scale${n}@demo-scale.invalid`, branch_id: b1.id, branch_code: "BR-001", on_payroll: true, employee_type: n % 3 ? "Teaching" : "Non-Teaching", position: n % 3 ? "Teacher" : "Utility Staff",
    basic_salary: 15000 + (n * 211) % 20000, date_hired: "2024-06-03", employee_id: `DEMO-S${String(n).padStart(3, "0")}`,
    sss_number: `98${String(n).padStart(8, "0")}`, philhealth_number: `9800${String(n).padStart(8, "0")}`, pagibig_number: `9810${String(n).padStart(8, "0")}`, tin_number: `998${String(n).padStart(6, "0")}`, cp_number: `0998${String(1000000 + n).padStart(7, "0")}` };
}).map((p) => ({ ...p, full: `${p.first} ${p.middle} ${p.last}` }));

console.log(`creating ${extra.length} fake employees in ${b1.name}…`);
for (const p of extra) await localAuthAdmin.upsertUser({ id: p.id, email: p.email, password: `${p.id}Aa1!`, user_metadata: { role: "employee", full_name: p.full, branch_id: b1.id, employee_id: p.employee_id, is_demo: true } });
await local.exec(["begin;", ...extra.map((p) => profileInsert(p)), "commit;"].join("\n"));
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
await local.exec(attendanceSql({ people: extra, from: period.start_key, to: yesterday, today, nowMinutes: 24 * 60 }));

// The payroll route reads accounts through a short cache (src/lib/auth/users-cache.js): wait for it.
await new Promise((r) => setTimeout(r, Number(process.env.SCALE_WAIT_MS || 65000)));
const staff = [...roster.filter((p) => p.on_payroll && p.branch_code === "BR-001" && !p.separated_on && !p.tag.startsWith("acc-b1")), ...extra];
const t0 = performance.now();
const res = await as(by("acc-b1-1")).post("/api/accountant/payroll", { action: "batch_submit", pay_period: period.label, entries: staff.map((p) => ({ employee_id: p.id })) });
const ms = Math.round(performance.now() - t0);
console.log(`batch for ${staff.length} people (${period.label}): HTTP ${res.status}, ${res.data?.processed?.length ?? 0} processed, ${res.data?.skipped?.length ?? 0} skipped, ${ms} ms (${Math.round(ms / staff.length)} ms a person)`);
console.log("skip reasons:", JSON.stringify([...new Set((res.data?.skipped || []).map((s) => s.reason))]).slice(0, 400));
const [dupes] = await local.rows(`select count(*)::int n from (select employee_id from payroll_entries where pay_period = ${lit(period.label)} group by 1 having count(*) > 1) d`);
console.log(`duplicate payslips: ${dupes.n}`);

// Remove the batch again (local only; the delete guards are bypassed here, never on production).
const ids = extra.map((p) => lit(p.id)).join(", ");
await local.exec(`begin; set local session_replication_role = replica;
  delete from payroll_run_items where employee_id in (${ids}); delete from payroll_deductions where employee_id in (${ids}); delete from payroll_incentives where employee_id in (${ids});
  delete from payroll_records where employee_id in (${ids}); delete from payroll_entries where employee_id in (${ids});
  delete from attendance_logs_history where log_id in (select id from attendance_logs where employee_id in (${ids}));
  delete from attendance_logs where employee_id in (${ids}); delete from notifications where recipient_id in (${ids}); delete from audit_logs where actor_id in (${ids}) or metadata->>'employee_id' in (${ids});
  delete from profiles where id in (${ids}); delete from auth.identities where user_id in (${ids}); delete from auth.users where id in (${ids});
  commit;`);
const [left] = await local.rows("select count(*)::int n from profiles where email like '%@demo-scale.invalid'");
console.log(`removed: ${left.n} scale employees left`);
