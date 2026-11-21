// LOCAL proof for PS-202611-0001 (user decision 2026-11-15, item 1a): a Final
// payslip made in testing mode in the middle of November 1-15, approved by HR
// and recomputed by the Super Admin's override, ends equal to the centavo to a
// payslip processed normally after the cutoff, and the 13th month and the 2026
// year-end tax count it once.
//
// Two new employees with the same salary and the same attendance:
//   E: Final payslip generated on Nov 6 in testing mode (like Ehd's), then the
//      rest of the attendance arrives, HR approves, the Super Admin overrides;
//   F: processed normally on Nov 16 (the generation day).
// Nov 11 is Incomplete for both and is left out on both (confirm_incomplete),
// as the app does by default.
//
//   E2E_PROOF=1 E2E_TIME_TRAVEL=1 E2E_HEADLESS=1 npx playwright test e2e/specs/99-testing-mode-override-proof-2026-11-15.spec.mjs
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { api } from "../support/flow.mjs";
import { db, profileByEmail, psql, retireAccountsCreatedSince, rows } from "../support/db.mjs";
// Accounts this spec makes are retired after it (e2e/support/db.mjs). Taken when
// the spec starts (after the seed), on the real clock.
let SPEC_START = null;
test.beforeAll(() => { SPEC_START = new Date(Date.now()).toISOString(); });

import { ACCOUNTS } from "../accounts.mjs";
import { TIME_TRAVEL, shiftBrowser, travelHome, travelTo } from "../support/time-travel.mjs";

const PERIOD = "November 1-15, 2026";
const REASON = "Payslip created in testing mode before the cutoff closed; recomputed for the full period.";
const stamp = Date.now();
const EARLY = ["2026-10-30", "2026-11-03", "2026-11-04", "2026-11-05"];
const LATER = ["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-12", "2026-11-13"];
const INCOMPLETE = "2026-11-11";
const AMOUNTS = ["basic_salary", "gross_pay", "total_deductions", "net_pay", "absences_deduction", "sss", "philhealth", "pagibig", "withholding_tax"];

const setSwitch = (enforced) => db().rpc("set_payroll_window_enforcement", { p_enforced: enforced, p_expires_on: null, p_reason: `E2E proof ${enforced ? "ON" : "OFF"}`, p_actor: null, p_actor_name: "E2E", p_source: "seed", p_environment: "local" });

test.afterAll(async () => { await travelHome(); await setSwitch(true); await retireAccountsCreatedSince(SPEC_START); });

function person(branchId, n) {
  return {
    first_name: n === 1 ? "Proofa" : "Proofb", last_name: `Override ${String(stamp).slice(-6).replace(/\d/g, (d) => "abcdefghij"[d])}`, email: `proof${n}.${stamp}@e2e.test`, role: "employee", branch_id: branchId,
    employee_type: "Teaching", position: "Employee", employment_type: "Full-time", employment_status: "Probationary",
    employee_status: "Active", date_hired: "2026-09-23", basic_salary: 17000, date_of_birth: `199${n}-0${n}-1${n}`, sex: "Male",
    civil_status: "Single", address: "1 Proof St, Pasig City", cp_number: `0917${String(stamp).slice(-6)}${n}`,
    sss_number: `34${String(stamp).slice(-7)}${n}`, philhealth_number: `12${String(stamp).slice(-9)}${n}`, pagibig_number: `13${String(stamp).slice(-9)}${n}`, tin_number: `5${String(stamp).slice(-7)}${n}`,
    emergency_contact_name: "Rosa Proof", emergency_contact_relationship: "Parent", emergency_contact_address: "1 Proof St, Pasig City", emergency_contact_number: "09181234567",
  };
}

function plant(p, dates, status = "Absent") {
  // A day the app already created (e.g. today's Absent at generation) is kept as is.
  const sql = dates.map((d) => `insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out, total_hours, status)
    select '${p.id}', '${p.full_name}', 'Teaching', '${p.branch_id}', '${d}', ${status === "Incomplete" ? `'${d} 08:00+08'` : "null"}, null, 0, '${status}'
    where not exists (select 1 from attendance_logs a where a.employee_id = '${p.id}' and a.log_date = '${d}' and not a.archived_duplicate);`).join("\n");
  psql(sql);
}

const entryOf = (id) => rows(db().from("payroll_entries").select("*").eq("employee_id", id).eq("pay_period", PERIOD).single());
const counted = (e) => (e.payroll?.audit?.lines?.deductions || []).map((l) => `${l.log_date} ${l.type}`).sort();

test("PS-202611-0001 proof: testing-mode payslip + HR approval + Super Admin override = a normal payslip", async ({ page, monitor }) => {
  // The known role-switch flake (e2e/README.md): a portal's requests still in flight go out signed out.
  monitor.allow(/^401 GET /, /status of 401/);
  test.skip(process.env.E2E_PROOF !== "1" || !TIME_TRAVEL, "local proof only: E2E_PROOF=1 E2E_TIME_TRAVEL=1");
  test.setTimeout(15 * 60 * 1000);
  await shiftBrowser(page.context());
  const acct = await profileByEmail(ACCOUNTS.accountant.email);
  const report = {};

  // 1. Two identical employees (HR), no attendance yet.
  await as(page, "hr", "hr-employees");
  const made = [];
  for (const n of [1, 2]) {
    const res = await api(page, "POST", "/api/admin/employees", person(acct.branch_id, n));
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    made.push(await profileByEmail(person(acct.branch_id, n).email));
  }
  const [E, F] = made;
  // The window holds exactly Ehd's live records (the nightly close may have filled days since hire).
  psql(`delete from attendance_logs where employee_id in ('${E.id}', '${F.id}') and log_date between '2026-10-30' and '2026-11-15';`);
  for (const p of made) plant(p, EARLY);

  // 2. Nov 6, testing mode (switch OFF): the Accountant makes E's Final payslip mid-cutoff.
  await travelTo("2026-11-06", page);
  expect((await setSwitch(false)).error).toBeNull();
  await as(page, "accountant");
  const early = await api(page, "PATCH", "/api/accountant/payroll", { action: "generate", employee_id: E.id, pay_period: PERIOD, confirm_incomplete: true });
  expect(early.status, JSON.stringify(early.data)).toBe(200);
  const before = await entryOf(E.id);
  expect(before.status).toBe("paid");
  expect(before.created_in_testing_mode).toBe(true);
  report.before = Object.fromEntries(AMOUNTS.map((k) => [k, Number(before[k])]));
  report.before.counted = counted(before);
  report.before.attendance_through = before.payroll.generation.attendance_through;

  // 3. The rest of the cutoff's attendance arrives; Nov 16, F is processed normally.
  for (const p of made) { plant(p, LATER); plant(p, [INCOMPLETE], "Incomplete"); }
  await travelTo("2026-11-16", page);
  await as(page, "accountant");
  const normal = await api(page, "PATCH", "/api/accountant/payroll", { action: "generate", employee_id: F.id, pay_period: PERIOD, confirm_incomplete: true });
  expect(normal.status, JSON.stringify(normal.data)).toBe(200);
  const fEntry = await entryOf(F.id);
  expect(fEntry.status).toBe("paid");

  // 4. The Accountant submits the branch's run (E's testing-mode payslip in it); HR approves.
  const sub = await api(page, "PATCH", "/api/accountant/payroll-runs", { action: "submit", branch_id: acct.branch_id, period: PERIOD, acknowledge_exclusions: true });
  expect(sub.status, JSON.stringify(sub.data)).toBe(200);
  const run = await rows(db().from("payroll_runs").select("id,status").eq("branch_id", acct.branch_id).eq("period_label", PERIOD).eq("status", "pending").single());
  const items = await rows(db().from("payroll_run_items").select("entry_id").eq("run_id", run.id));
  expect(items.map((i) => i.entry_id)).toEqual(expect.arrayContaining([before.id, fEntry.id]));
  await as(page, "hr");
  const approved = await api(page, "PATCH", "/api/hr/payroll-runs", { action: "approve", run_id: run.id, remarks: "E2E proof" });
  expect(approved.status, JSON.stringify(approved.data)).toBe(200);

  // 5. The Super Admin's override recomputes E's approved payslip.
  await as(page, "super_admin");
  const over = await api(page, "PATCH", "/api/accountant/payroll", { action: "override_final", employee_id: E.id, pay_period: PERIOD, reason: REASON, confirm_incomplete: true });
  expect(over.status, JSON.stringify(over.data)).toBe(200);
  const after = await entryOf(E.id);
  report.after = Object.fromEntries(AMOUNTS.map((k) => [k, Number(after[k])]));
  report.after.counted = counted(after);
  report.after.attendance_through = after.payroll.generation.attendance_through;
  report.after.left_out = (after.payroll.generation.confirmed_incomplete || []).map((b) => `${b.log_date} ${b.status}`);
  report.normal = Object.fromEntries(AMOUNTS.map((k) => [k, Number(fEntry[k])]));
  report.normal.counted = counted(fEntry);
  report.normal.left_out = (fEntry.payroll.generation.confirmed_incomplete || []).map((b) => `${b.log_date} ${b.status}`);

  expect(report.after.attendance_through).toBe("2026-11-15");
  expect(report.after.counted).toEqual([...EARLY, ...LATER].map((d) => `${d} absent`).sort());
  expect(report.after.left_out).toEqual([`${INCOMPLETE} Incomplete`]);
  for (const k of AMOUNTS) expect(report.after[k], `${k}: overridden = normal`).toBe(report.normal[k]);
  expect(after.payroll.totals).toEqual(fEntry.payroll.totals);
  expect(after.payroll.basic_earned).toEqual(fEntry.payroll.basic_earned);
  expect((await rows(db().from("payroll_entries").select("id").eq("employee_id", E.id).eq("pay_period", PERIOD))).length).toBe(1);
  expect((await rows(db().from("payroll_records").select("archived").eq("employee_id", E.id).eq("period_label", PERIOD))).filter((r) => !r.archived).length).toBe(1);

  // 6. Year-end tax 2026 (Super Admin): E and F equal, one payslip each.
  const tax = await api(page, "POST", "/api/payroll/year-end-tax", { action: "run", year: 2026, branch_id: acct.branch_id });
  expect(tax.status, JSON.stringify(tax.data)).toBe(200);
  const annual = await rows(db().from("payroll_tax_annualizations").select("employee_id,payslip_count,taxable_compensation,tax_due,tax_withheld").eq("tax_year", 2026).in("employee_id", [E.id, F.id]));
  const ae = annual.find((a) => a.employee_id === E.id); const af = annual.find((a) => a.employee_id === F.id);
  report.tax = { E: ae, F: af };
  expect(ae.payslip_count).toBe(1);
  expect({ ...ae, employee_id: null }).toEqual({ ...af, employee_id: null });

  // 7. 13th month (Dec 1, the Accountant): E and F equal, Nov 1-15 counted once.
  await travelTo("2026-12-01", page);
  await as(page, "accountant");
  const th = await api(page, "PATCH", "/api/accountant/payroll", { action: "process_13th_month", year: 2026, employee_ids: [E.id, F.id] });
  expect(th.status, JSON.stringify(th.data)).toBe(200);
  const thirteenth = await rows(db().from("payroll_thirteenth_month").select("employee_id,basic_earned,amount,breakdown").eq("year", 2026).in("employee_id", [E.id, F.id]));
  const te = thirteenth.find((t) => t.employee_id === E.id); const tf = thirteenth.find((t) => t.employee_id === F.id);
  report.thirteenth = { E: { basic_earned: te.basic_earned, amount: te.amount, periods: te.breakdown.periods }, F: { basic_earned: tf.basic_earned, amount: tf.amount } };
  expect(te.breakdown.periods.filter((p) => (p.label || p.pay_period || p.period) === PERIOD || JSON.stringify(p).includes(PERIOD)).length).toBe(1);
  expect(Number(te.basic_earned)).toBe(Number(tf.basic_earned));
  expect(Number(te.amount)).toBe(Number(tf.amount));

  console.log(`PROOF REPORT ${JSON.stringify(report, null, 2)}`);
});
