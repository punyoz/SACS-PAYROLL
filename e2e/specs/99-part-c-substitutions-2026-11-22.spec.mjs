// Part C (2026-11-22): substitute teaching, attendance and payroll only. The
// branch Admin arranges a substitute from the suggestions (same level and
// branch, tapped in that day, not on leave, under the weekly cap); HR approves
// with a preset remark (audited); a teacher outside the suggestions is refused.
// The pay rules are unit-tested (tests/substitutions-2026-11-22.test.js).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, manilaDay, pickDate, writeRemark } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

test("substitution: Admin arranges from the suggestions, HR approves with a remark, an unsuggested teacher is refused", async ({ page, monitor }) => {
  monitor.allow(/^400 POST \/api\/substitutions/, /status of 400/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const carlo = await profileByEmail(ACCOUNTS.employee3.email);
  const today = manilaDay(0);
  // Same level and branch for Ana and Bea (test data); Bea tapped in today.
  const levelSet = await db().from("profiles").update({ employee_level: "grade_school", employee_type: "Teaching" }).in("id", [ana.id, bea.id]);
  expect(levelSet.error, "test setup: same level for Ana and Bea").toBeNull();
  await db().from("attendance_logs").delete().eq("employee_id", bea.id).eq("log_date", today);
  await rows(db().from("attendance_logs").insert({ employee_id: bea.id, employee_name: bea.full_name, branch_id: bea.branch_id, log_date: today,
    time_in: `${today}T07:00:00+08:00`, time_out: `${today}T17:00:00+08:00` }).select("id"));
  const start = `1${Math.floor(Date.now() / 1000) % 6}:00`; // a different slot per run (10:00-15:00)
  const end = `${start.slice(0, 2)}:50`;
  let id;

  await step(page, "Admin > Overtime & Substitute > Arrange substitute: Bea is suggested; send to HR", async () => {
    await as(page, "admin", "adm-overtime");
    await settle(page);
    const panel = main(page).getByTestId("substitutions");
    await panel.getByRole("button", { name: "Arrange substitute" }).first().click();
    const dialog = page.getByTestId("arrange-substitute");
    await choose(page, dialog.locator("#sub-absent"), ana.full_name);
    await pickDate(page, dialog.locator("#sub-date"), today);
    await dialog.locator("#sub-periods").fill("1");
    await dialog.locator("#sub-start").fill(start);
    await dialog.locator("#sub-end").fill(end);
    await dialog.locator("#sub-class").fill("Grade 5");
    await dialog.getByRole("button", { name: "Find substitutes" }).click();
    const list = dialog.getByTestId("sub-suggestions");
    await expect(list).toContainText(bea.full_name);
    await expect(list).not.toContainText(carlo.full_name); // another branch
    await expect(list).not.toContainText(/subject/i); // never labelled a subject match
    await list.getByRole("radio", { name: new RegExp(bea.full_name) }).check();
    await dialog.getByRole("button", { name: "Send to HR" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    id = (await rows(db().from("substitutions").select("id").eq("substitute_id", bea.id).eq("sub_date", today).eq("start_time", start).eq("status", "pending").single())).id;
    const refused = await api(page, "POST", "/api/substitutions", { absent_employee_id: ana.id, substitute_id: carlo.id, sub_date: today, start_time: "16:00", end_time: "16:50", periods: 1 });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/cannot substitute here/);
    await page.reload();
    await settle(page);
    await expect(main(page).getByTestId("substitutions").locator("tr", { hasText: bea.full_name }).filter({ hasText: start })).toContainText("pending");
  });

  await step(page, "HR > Leave Approval > Substitute teaching > Approve with a preset remark (audited); the taps confirm it", async () => {
    await as(page, "hr", "hr-leaves");
    await settle(page);
    const row = main(page).getByTestId("substitutions").locator("tr", { hasText: bea.full_name }).filter({ hasText: start });
    await expect(row).toContainText("Confirmed by taps");
    await row.getByRole("button", { name: "Approve" }).click();
    await writeRemark(page, "sub-remark", "", { preset: "Approved as requested" });
    await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
    const saved = await rows(db().from("substitutions").select("status,decision_note").eq("id", id).single());
    expect(saved).toEqual({ status: "approved", decision_note: "Approved as requested" });
    const audited = await rows(db().from("audit_logs").select("action,entity_type").eq("entity_id", id).eq("metadata->>kind", "decision_remark"));
    expect(audited).toEqual([{ action: "approve", entity_type: "substitution" }]);
  });

  await step(page, "Accountant > Payroll Reports > the substitution report and its Excel export open", async () => {
    await as(page, "accountant", "ac-reports");
    await settle(page);
    await expect(main(page).getByTestId("substitutions-report")).toBeVisible();
    const file = await page.request.get(`/api/reports/substitutions?from=${today}&to=${today}&by=substitute&format=xlsx`);
    expect(file.status()).toBe(200);
  });
});
