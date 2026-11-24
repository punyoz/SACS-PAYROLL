// Additional Pay (2026-11-23, changed 2026-11-26): the Accountant files a honorarium (two employees at
// once), a bonus and items of their OWN pay types (one taxable, one not), HR approves each, and the payslip
// of that month carries each as its own line. "Adjustment" is no longer offered for new items; an older
// adjustment (already filed) is still paid as filed. Pending items can be removed together (only pending).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const TAG = `E2E-AP-${Date.now() % 100000}`;
const toAmount = (n) => Math.round(Number(n) * 100) / 100;

test("Additional Pay: honorarium (two employees), bonus, own pay types (taxable / not); no new adjustment, an old one still paid; HR approves; own lines on the payslip", async ({ page, monitor }) => {
  monitor.at("Accountant > Additional Pay");
  monitor.allow(/^40[09] (POST|PATCH|DELETE) \/api\/accountant\/(payroll|pay-types)/, /status of 40[09]/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const accountant = await profileByEmail(ACCOUNTS.accountant.email);
  const day = "2026-11-10";
  let periodLabel;
  const types = {};

  await step(page, "Accountant > Additional pay types: add one taxable and one not; a duplicate name is refused", async () => {
    await as(page, "accountant", "ac-pay-types");
    await settle(page);
    const card = main(page).getByTestId("pay-types");
    await card.locator("#pt-name").fill(`${TAG} Club adviser`);
    await card.getByRole("button", { name: "Add pay type" }).click();
    await expect(card.getByRole("row").filter({ hasText: `${TAG} Club adviser` })).toContainText("Taxable");
    const meal = await api(page, "POST", "/api/accountant/pay-types", { name: `${TAG} Meal allowance`, taxable: false, description: "De minimis meal allowance" });
    expect(meal.status, JSON.stringify(meal.data)).toBe(201);
    expect((await api(page, "POST", "/api/accountant/pay-types", { name: `${TAG} meal ALLOWANCE` })).status).toBe(409);
    const list = (await api(page, "GET", "/api/accountant/pay-types")).data.types;
    types.club = list.find((t) => t.name === `${TAG} Club adviser`);
    types.meal = list.find((t) => t.name === `${TAG} Meal allowance`);
    expect(types.club).toMatchObject({ taxable: true, active: true, used: 0 });
    expect(types.meal).toMatchObject({ taxable: false, active: true, used: 0 });
  });

  await step(page, "Accountant > Items: Adjustment is no longer offered (form and server); files a honorarium for two, a bonus and both own types", async () => {
    await as(page, "accountant", "ac-incentives");
    await settle(page);
    await main(page).locator("#ac-item-kind").click();
    const options = page.getByRole("option");
    await expect(options.filter({ hasText: /^Adjustment/ })).toHaveCount(0);
    await expect(options.filter({ hasText: `${TAG} Club adviser` })).toHaveCount(1);
    await expect(options.filter({ hasText: `${TAG} Meal allowance (₱, not taxable)` })).toHaveCount(1);
    await page.keyboard.press("Escape");
    const adj = await api(page, "POST", "/api/accountant/payroll", { action: "add_monthly_item", employee_id: ana.id, kind: "adjustment", item_date: day, description: `${TAG} fix`, amount: -300, reason: "Allowance paid twice" });
    expect(adj.status).toBe(400);
    expect(adj.data.code).toBe("adjustment_retired");
    const hon = await api(page, "POST", "/api/accountant/payroll", { action: "add_monthly_item", employee_ids: [ana.id, bea.id], kind: "honorarium", item_date: day, description: `${TAG} Seminar speaker`, amount: 1500 });
    expect(hon.status, JSON.stringify(hon.data)).toBe(200);
    expect(hon.data.filed).toBe(2);
    periodLabel = `${hon.data.payroll_month_label.split(" ")[0]} 16-${new Date(Date.UTC(Number(hon.data.payroll_month.slice(0, 4)), Number(hon.data.payroll_month.slice(5, 7)), 0)).getUTCDate()}, ${hon.data.payroll_month.slice(0, 4)}`;
    for (const body of [
      { kind: "bonus", description: `${TAG} Service bonus`, amount: 2000 },
      { kind: "custom", pay_type_id: types.club.id, description: `${TAG} Math club`, amount: 700 },
      { kind: "custom", pay_type_id: types.meal.id, description: `${TAG} Meals`, amount: 400 },
    ]) {
      const res = await api(page, "POST", "/api/accountant/payroll", { action: "add_monthly_item", employee_id: ana.id, item_date: day, ...body });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
    }
    const filed = await rows(db().from("payroll_monthly_incentives").select("kind,pay_type_id,non_taxable").like("description", `${TAG}%`).eq("approval_status", "pending"));
    expect(filed).toHaveLength(5);
    expect(filed.find((r) => r.pay_type_id === types.meal.id)).toMatchObject({ kind: "custom", non_taxable: true });
    expect(filed.find((r) => r.pay_type_id === types.club.id)).toMatchObject({ kind: "custom", non_taxable: false });
    // An older adjustment (filed before 2026-11-26) stays and is paid as filed.
    await rows(db().from("payroll_monthly_incentives").insert({
      employee_id: ana.id, branch_id: ana.branch_id, item_date: day, kind: "adjustment", description: `${TAG} Overpaid allowance`, amount: -300,
      reason: "Allowance paid twice in October", non_taxable: false, approval_status: "pending", created_by: accountant.id, created_by_name: accountant.full_name,
    }).select("id"));
  });

  await step(page, "A used type cannot be deleted (deactivate instead); deactivated, it is not offered for new items", async () => {
    const del = await api(page, "DELETE", `/api/accountant/pay-types?id=${types.club.id}`);
    expect(del.status).toBe(409);
    expect(del.data.code).toBe("pay_type_used");
    const off = await api(page, "PATCH", "/api/accountant/pay-types", { id: types.club.id, active: false });
    expect(off.status).toBe(200);
    const refused = await api(page, "POST", "/api/accountant/payroll", { action: "add_monthly_item", employee_id: bea.id, kind: "custom", pay_type_id: types.club.id, item_date: day, description: `${TAG} more`, amount: 100 });
    expect(refused.status).toBe(400);
    expect((await api(page, "PATCH", "/api/accountant/pay-types", { id: types.club.id, active: true })).status).toBe(200);
  });

  await step(page, "HR approves them (preset remark) on Incentive & loan approvals; each own type shows its name", async () => {
    await as(page, "hr", "hr-adjustment-approvals");
    const list = await api(page, "GET", "/api/hr/adjustment-approvals?status=pending");
    const mine = list.data.items.filter((i) => String(i.detail).includes(TAG));
    expect(mine.map((i) => i.type_label).sort()).toEqual(["Adjustment", "Bonus", "Honorarium", "Honorarium", `${TAG} Club adviser`, `${TAG} Meal allowance`].sort());
    expect(mine.find((i) => i.type_label === `${TAG} Meal allowance`).detail).toMatch(/Not taxable/);
    for (const i of mine) {
      const res = await api(page, "PATCH", "/api/hr/adjustment-approvals", { kind: i.kind, id: i.id, decision: "approve", remark: { code: "approve.as_requested" } });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
    }
  });

  await step(page, "Ana's payslip: own lines (the type's name); the old adjustment as filed; the bonus is tax-free", async () => {
    await as(page, "accountant", "ac-process");
    psql(`set session_replication_role = replica; delete from payroll_entries where employee_id = '${ana.id}' and pay_period = '${periodLabel}' and status = 'draft';`);
    const res = await api(page, "POST", "/api/accountant/payroll", { action: "save_draft", employee_id: ana.id, pay_period: periodLabel });
    expect(res.status, `save_draft ${periodLabel}: ${JSON.stringify(res.data).slice(0, 300)}`).toBe(200);
    const entry = await rows(db().from("payroll_entries").select("payroll").eq("employee_id", ana.id).eq("pay_period", periodLabel).eq("status", "draft").single());
    const notes = (entry.payroll.audit?.lines?.incentives || []).map((l) => l.note);
    expect(notes).toContain(`Honorarium: ${TAG} Seminar speaker (Nov 10)`);
    expect(notes).toContain(`Bonus: ${TAG} Service bonus (Nov 10)`);
    expect(notes).toContain(`${TAG} Club adviser: ${TAG} Math club (Nov 10)`);
    expect(notes).toContain(`${TAG} Meal allowance: ${TAG} Meals (not taxable) (Nov 10)`);
    expect(notes).toContain(`Adjustment: ${TAG} Overpaid allowance. Allowance paid twice in October (Nov 10)`);
    expect(toAmount(entry.payroll.totals.bonus_items)).toBe(2000);
    expect(toAmount(entry.payroll.monthly?.bonuses?.exempt)).toBeGreaterThanOrEqual(2000 - toAmount(entry.payroll.monthly?.bonuses?.taxable || 0));
  });

  await step(page, "Accountant > Items: Remove selected takes only pending items; an approved one is refused and nothing is removed", async () => {
    const pend = await api(page, "POST", "/api/accountant/payroll", { action: "add_monthly_item", employee_ids: [ana.id, bea.id], kind: "incentive", item_date: day, description: `${TAG} To remove`, amount: 100 });
    expect(pend.status).toBe(200);
    const pending = await rows(db().from("payroll_monthly_incentives").select("id").eq("description", `${TAG} To remove`));
    const approved = await rows(db().from("payroll_monthly_incentives").select("id").eq("description", `${TAG} Service bonus`));
    const mixed = await api(page, "PATCH", "/api/accountant/payroll", { action: "remove_pending_items", item_ids: [pending[0].id, approved[0].id] });
    expect(mixed.status).toBe(409);
    expect(mixed.data.code).toBe("not_pending");
    expect(await rows(db().from("payroll_monthly_incentives").select("id").eq("description", `${TAG} To remove`).eq("archived", false))).toHaveLength(2);
    await as(page, "accountant", "ac-incentives");
    await settle(page);
    await main(page).getByRole("searchbox").first().fill(`${TAG} To remove`);
    await main(page).getByRole("checkbox", { name: "Select all on this page" }).check();
    await main(page).getByTestId("remove-selected").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove selected" }).click();
    await expect.poll(async () => (await rows(db().from("payroll_monthly_incentives").select("id").eq("description", `${TAG} To remove`).eq("archived", false))).length).toBe(0);
    const logged = await rows(db().from("audit_logs").select("entity_id").eq("action", "monthly_item_archive").in("entity_id", pending.map((p) => p.id)));
    expect(logged).toHaveLength(2);
    expect(await rows(db().from("payroll_monthly_incentives").select("archived").eq("description", `${TAG} Service bonus`).single())).toEqual({ archived: false });
  });
});
