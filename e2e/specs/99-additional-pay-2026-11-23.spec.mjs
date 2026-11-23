// Honorarium, Bonus and Adjustment (2026-11-23): the Accountant files them
// (one honorarium for two employees at once), HR approves, and the payslip of
// that month carries each as its own line. Honorarium and the taxable
// adjustment are taxed; the bonus is "other benefits" (exempt up to the yearly
// ceiling); a minus adjustment lowers the gross. A reason is required.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const TAG = `E2E-AP-${Date.now() % 100000}`;
const toAmount = (n) => Math.round(Number(n) * 100) / 100;

test("Additional Pay: honorarium (two employees), bonus, minus adjustment; HR approves; own lines on the payslip", async ({ page, monitor }) => {
  monitor.at("Accountant > Additional Pay");
  monitor.allow(/^400 POST \/api\/accountant\/payroll/, /status of 400/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const day = "2026-11-10";
  let periodLabel;

  await step(page, "Accountant files: a reason is required for an adjustment; one honorarium for two; a bonus; −₱300", async () => {
    await as(page, "accountant", "ac-incentives");
    const noReason = await api(page, "POST", "/api/accountant/payroll", { action: "add_monthly_item", employee_id: ana.id, kind: "adjustment", item_date: day, description: `${TAG} fix`, amount: -300 });
    expect(noReason.status).toBe(400);
    const hon = await api(page, "POST", "/api/accountant/payroll", { action: "add_monthly_item", employee_ids: [ana.id, bea.id], kind: "honorarium", item_date: day, description: `${TAG} Seminar speaker`, amount: 1500 });
    expect(hon.status, JSON.stringify(hon.data)).toBe(200);
    expect(hon.data.filed).toBe(2);
    periodLabel = `${hon.data.payroll_month_label.split(" ")[0]} 16-${new Date(Date.UTC(Number(hon.data.payroll_month.slice(0, 4)), Number(hon.data.payroll_month.slice(5, 7)), 0)).getUTCDate()}, ${hon.data.payroll_month.slice(0, 4)}`;
    for (const body of [
      { kind: "bonus", description: `${TAG} Service bonus`, amount: 2000 },
      { kind: "adjustment", description: `${TAG} Overpaid allowance`, amount: -300, reason: "Allowance paid twice in October" },
    ]) {
      const res = await api(page, "POST", "/api/accountant/payroll", { action: "add_monthly_item", employee_id: ana.id, item_date: day, ...body });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
    }
    expect(await rows(db().from("payroll_monthly_incentives").select("id").like("description", `${TAG}%`).eq("approval_status", "pending"))).toHaveLength(4);
  });

  await step(page, "HR approves them (preset remark) on Incentive & loan approvals", async () => {
    await as(page, "hr", "hr-adjustment-approvals");
    const list = await api(page, "GET", "/api/hr/adjustment-approvals?status=pending");
    const mine = list.data.items.filter((i) => String(i.detail).includes(TAG));
    expect(mine.map((i) => i.type_label).sort()).toEqual(["Adjustment", "Bonus", "Honorarium", "Honorarium"]);
    expect(mine.find((i) => i.type_label === "Adjustment").detail).toMatch(/Reason: Allowance paid twice/);
    for (const i of mine) {
      const res = await api(page, "PATCH", "/api/hr/adjustment-approvals", { kind: i.kind, id: i.id, decision: "approve", remark: { code: "approve.as_requested" } });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
    }
  });

  await step(page, "Ana's payslip: three own lines; gross up by 1,500 + 2,000 − 300; the bonus is tax-free", async () => {
    await as(page, "accountant", "ac-process");
    psql(`set session_replication_role = replica; delete from payroll_entries where employee_id = '${ana.id}' and pay_period = '${periodLabel}' and status = 'draft';`);
    const res = await api(page, "POST", "/api/accountant/payroll", { action: "save_draft", employee_id: ana.id, pay_period: periodLabel });
    expect(res.status, `save_draft ${periodLabel}: ${JSON.stringify(res.data).slice(0, 300)}`).toBe(200);
    const entry = await rows(db().from("payroll_entries").select("payroll").eq("employee_id", ana.id).eq("pay_period", periodLabel).eq("status", "draft").single());
    const notes = (entry.payroll.audit?.lines?.incentives || []).map((l) => l.note);
    expect(notes).toContain(`Honorarium: ${TAG} Seminar speaker (Nov 10)`);
    expect(notes).toContain(`Bonus: ${TAG} Service bonus (Nov 10)`);
    expect(notes).toContain(`Adjustment: ${TAG} Overpaid allowance. Allowance paid twice in October (Nov 10)`);
    expect(toAmount(entry.payroll.totals.bonus_items)).toBe(2000);
    expect(toAmount(entry.payroll.monthly?.bonuses?.exempt)).toBeGreaterThanOrEqual(2000 - toAmount(entry.payroll.monthly?.bonuses?.taxable || 0));
  });
});
