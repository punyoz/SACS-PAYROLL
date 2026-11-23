// Part E step 6 (2026-11-23): Perfect Attendance waits for HR. Processing
// computes it, holds it (₱0 on the payslip) and lists it for HR as a system
// recommendation; once HR approves, recomputing the payslip pays it.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const PERIOD = "November 16-30, 2026";
const BONUS = 500;
let planted = null;

test.afterEach(() => {
  if (!planted) return;
  psql(`set session_replication_role = replica;
    delete from payroll_rate_configs where id = '${planted.rate}';
    update system_config set value = '${planted.from}' where section = 'automation' and key = 'incentive_approval_from';`);
  planted = null;
});

const perfectRec = (employeeId) => rows(db().from("incentive_recommendations").select("id,status,amount")
  .eq("employee_id", employeeId).eq("period_start", "2026-11-16").eq("kind", "perfect_attendance"));

async function draft(page, person) {
  await as(page, "accountant", "ac-process");
  const res = await api(page, "POST", "/api/accountant/payroll", { action: "save_draft", employee_id: person.id, pay_period: PERIOD });
  expect(res.status, `save_draft: ${JSON.stringify(res.data).slice(0, 300)}`).toBe(200);
  return rows(db().from("payroll_entries").select("payroll").eq("employee_id", person.id).eq("pay_period", PERIOD).eq("status", "draft").single());
}

test("Perfect Attendance: held for HR, then paid once HR approves", async ({ page, monitor }) => {
  monitor.at("Part E step 6 (incentive recommendations)");
  test.skip(manilaDay(0) < "2026-11-17" || manilaDay(0) > "2026-11-30", "written for a day inside November 16-30, 2026");
  // Bea (Main branch, where the Accountant works).
  const emp = await profileByEmail(ACCOUNTS.employee2.email);
  const from = (await rows(db().from("system_config").select("value").eq("section", "automation").eq("key", "incentive_approval_from").single())).value;
  // Planted with triggers off (local only): a rate change needs the account that made it, which a test has no session for here.
  const rateId = psql(`set session_replication_role = replica;
    insert into payroll_rate_configs (rate_type, scope, value, effective_date, note, created_by_name)
    values ('perfect_attendance_bonus', 'global', ${BONUS}, '2026-11-01', 'E2E step 6', 'E2E') returning id;`).split(/\s+/).filter(Boolean).pop();
  planted = { rate: rateId, from };
  await db().from("system_config").update({ value: "2026-11-16" }).eq("section", "automation").eq("key", "incentive_approval_from");

  // On time every weekday of the month so far (the 2nd half settles the whole month; 08:00-17:00 shift).
  const days = [];
  for (let d = 1; `2026-11-${String(d).padStart(2, "0")}` < manilaDay(0); d += 1) {
    const day = `2026-11-${String(d).padStart(2, "0")}`;
    if (![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) days.push(day);
  }
  psql(`set session_replication_role = replica; delete from incentive_recommendations where employee_id = '${emp.id}';
    delete from attendance_logs where employee_id = '${emp.id}' and log_date between '2026-11-01' and '2026-11-30';`);
  await rows(db().from("attendance_logs").insert(days.map((day) => ({
    employee_id: emp.id, employee_name: emp.full_name, branch_id: emp.branch_id, log_date: day, status: "Present",
    time_in: `${day}T07:55:00+08:00`, time_out: `${day}T17:05:00+08:00`, shift_start_minutes: 480, shift_end_minutes: 1020,
  }))).select("id"));

  await step(page, "Accountant processes: computed, held (₱0), listed for HR", async () => {
    const entry = await draft(page, emp);
    const item = (entry.payroll.rule_incentives?.items || []).find((i) => i.kind === "perfect_attendance");
    expect(item, `perfect attendance computed: ${JSON.stringify(entry.payroll.audit?.attendance?.blocking || entry.payroll.audit?.attendance?.counts)}`).toMatchObject({ amount: BONUS, paid: false, status: "pending" });
    expect(Number(entry.payroll.totals.perfect_attendance_incentive)).toBe(0);
    expect(await perfectRec(emp.id)).toMatchObject([{ status: "pending", amount: BONUS }]);
  });

  await step(page, "HR sees it on Incentive & loan approvals and approves it", async () => {
    await as(page, "hr", "hr-adjustment-approvals");
    const list = await api(page, "GET", "/api/hr/adjustment-approvals?status=pending");
    const mine = list.data.items.find((i) => i.kind === "rule_incentive" && i.employee_id === emp.id);
    expect(mine).toMatchObject({ type_label: "Perfect Attendance (system)", approval_status: "pending", filed_by: "System (rule)" });
    const res = await api(page, "PATCH", "/api/hr/adjustment-approvals", { kind: "rule_incentive", id: mine.id, decision: "approve", remark: { code: "approve.as_requested" } });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(await perfectRec(emp.id)).toMatchObject([{ status: "approved" }]);
    const again = await api(page, "PATCH", "/api/hr/adjustment-approvals", { kind: "rule_incentive", id: mine.id, decision: "approve", remark: { code: "approve.as_requested" } });
    expect(again.status, "decided once").toBeGreaterThanOrEqual(400);
  });

  await step(page, "Recomputed: paid once, the recommendation stays approved", async () => {
    const entry = await draft(page, emp);
    expect(Number(entry.payroll.totals.perfect_attendance_incentive)).toBe(BONUS);
    expect((entry.payroll.rule_incentives.items || []).find((i) => i.kind === "perfect_attendance")).toMatchObject({ paid: true });
    expect(await perfectRec(emp.id)).toHaveLength(1);
  });
});
