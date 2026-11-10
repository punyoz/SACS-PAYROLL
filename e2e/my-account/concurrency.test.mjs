// G9.5 and G9.6 (2026-11-09), by API with concurrent calls (no browser),
// LOCAL demo data only. They write: run them on a snapshot you restore after.
//   node --test e2e/my-account/concurrency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { as, LOCAL_BASE, sessionCookie } from "../../scripts/demo/local-api.mjs";
import { context, manilaToday } from "../../scripts/demo/build-local.mjs";
import { database } from "../../scripts/demo/db.mjs";

const local = database("local");
const { by, roster, branchCodes } = await context();
const { periodForDateKey } = await import("../../src/lib/payroll/periods.js");
const period = periodForDateKey(manilaToday()).label;

test("G9.5 two Accountants of one branch process and submit the same cutoff at once", async () => {
  const people = roster.filter((p) => p.on_payroll && p.branch_code === "BR-001" && !p.separated_on && !["acc-b1-1", "acc-b1-2"].includes(p.tag));
  const entries = people.map((p) => ({ employee_id: p.id }));
  const [a, b] = await Promise.all([by("acc-b1-1"), by("acc-b1-2")].map((acc) => as(acc).post("/api/accountant/payroll", { action: "batch_submit", pay_period: period, entries })));
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const dupes = await local.rows(`select employee_id, count(*)::int n from payroll_entries where pay_period = '${period}' and employee_id in (${people.map((p) => `'${p.id}'`).join(",")}) group by 1 having count(*) > 1`);
  assert.deepEqual(dupes, [], "no payslip is processed twice");
  // Each Accountant's own payslip, by the other one.
  await as(by("acc-b1-2")).post("/api/accountant/payroll", { action: "batch_submit", pay_period: period, entries: [{ employee_id: by("acc-b1-1").id }] });
  await as(by("acc-b1-1")).post("/api/accountant/payroll", { action: "batch_submit", pay_period: period, entries: [{ employee_id: by("acc-b1-2").id }] });
  const submit = { action: "submit", branch_id: branchCodes["BR-001"].id, period, acknowledge_exclusions: true };
  const [s1, s2] = await Promise.all([by("acc-b1-1"), by("acc-b1-2")].map((acc) => as(acc).patch("/api/accountant/payroll-runs", submit)));
  const statuses = [s1.status, s2.status].sort();
  console.log("  submit replies:", statuses.join(", "), "|", [s1, s2].map((r) => r.data?.error || "submitted").join(" | "));
  const runs = await local.rows(`select count(*)::int n from payroll_runs where branch_id = '${branchCodes["BR-001"].id}' and period_label = '${period}' and status = 'pending'`);
  // The current cutoff is still running (its payslips stay Drafts until it ends), so a submission is
  // refused with a clear message; when it goes through, it goes through once.
  if (statuses[0] === 200) assert.equal(runs[0].n, 1, "one run waits for HR, not two");
  else { assert.ok([s1, s2].every((r) => r.status === 409 && r.data?.error), "both told why, clearly"); assert.equal(runs[0].n, 0); }
});

test("G9.6 two Admins of one branch open kiosks and tap the same card at the same moment", async () => {
  const creds = Object.fromEntries((await import("node:fs")).readFileSync("demo-data/credentials.csv", "utf8").trim().split(/\r?\n/).slice(1).map((l) => { const [tag, , , pw] = l.split(","); return [tag, pw]; }));
  const kiosks = [];
  for (const tag of ["adm-b1-1", "adm-b1-2"]) {
    const res = await fetch(`${LOCAL_BASE}/api/admin/attendance/verify-password`, { method: "POST", headers: { cookie: await sessionOf(by(tag)), "Content-Type": "application/json" }, body: JSON.stringify({ password: creds[tag], purpose: "unlock" }) });
    assert.equal(res.status, 200, `${tag} unlocks`);
    const body = await res.json();
    assert.equal(body.valid, true);
    assert.equal(body.kiosk.branch_id, branchCodes["BR-001"].id, "the kiosk is the Admin's own branch");
    kiosks.push(res.headers.getSetCookie().find((c) => c.startsWith("sacs-kiosk="))?.split(";")[0]);
  }
  assert.ok(kiosks.every(Boolean), "both kiosks hold a kiosk session");
  const person = by(process.env.TAP_PERSON || "emp6");
  const before = await local.rows(`select count(*)::int n from attendance_taps where employee_id = '${person.id}'`);
  const tap = (cookie) => fetch(`${LOCAL_BASE}/api/admin/attendance`, { method: "POST", headers: { cookie, "x-sacs-kiosk": "1", "Content-Type": "application/json" }, body: JSON.stringify({ rfid_code: person.rfid_uid }) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const replies = await Promise.all(kiosks.map(tap));
  console.log("  tap replies:", replies.map((r) => `${r.status} ${r.data.tap || r.data.code || ""} ${String(r.data.message || r.data.error || "").slice(0, 60)}`).join(" | "));
  const after = await local.rows(`select count(*)::int n from attendance_taps where employee_id = '${person.id}'`);
  assert.ok(after[0].n - before[0].n <= 1, `one raw tap recorded, not two (${after[0].n - before[0].n})`);
  const other = by("emp9"); // Branch 2: refused at a Branch 1 kiosk
  const foreign = await fetch(`${LOCAL_BASE}/api/admin/attendance`, { method: "POST", headers: { cookie: kiosks[0], "x-sacs-kiosk": "1", "Content-Type": "application/json" }, body: JSON.stringify({ rfid_code: other.rfid_uid }) });
  assert.ok(foreign.status >= 400, `another branch's card is refused (${foreign.status})`);
});

const sessionOf = (person) => sessionCookie(person);
