// Part C (2026-11-22), as changed since 053a5e0 / d3046f0: the system proposes a
// substitution from an approved leave (no teacher yet); the branch Admin does not
// file one (refused) and has no Arrange button; HR picks the teacher from the
// suggestions (same level and branch, tapped in that day, not on leave, under the
// weekly cap) and approves; a teacher outside the suggestions is refused.
// The pay rules are unit-tested (tests/substitutions-2026-11-22.test.js).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

test("substitution: the system proposes, the Admin cannot file, HR picks a suggested teacher and approves, an unsuggested teacher is refused", async ({ page, monitor }) => {
  monitor.allow(/^40[09] (POST|PATCH) \/api\/substitutions/, /status of 40[09]/);
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
  // The system's proposal from Ana's approved leave (what src/lib/substitutions/proposals.js inserts).
  const [proposal] = await rows(db().from("substitutions").insert({
    branch_id: ana.branch_id, sub_date: today, absent_employee_id: ana.id, substitute_id: null, start_time: start, end_time: end, periods: 1,
    leave_request_id: `e2e-sub-${Date.now()}`, status: "pending", source: "leave", created_by: null, created_by_name: "System",
  }).select("id"));
  const id = proposal.id;

  await step(page, "Admin > Overtime & Substitute: no Arrange button; filing a substitution is refused", async () => {
    await as(page, "admin", "adm-overtime");
    await settle(page);
    await expect(main(page).getByRole("button", { name: "Arrange substitute" })).toHaveCount(0);
    const refused = await api(page, "POST", "/api/substitutions", { absent_employee_id: ana.id, substitute_id: bea.id, sub_date: today, start_time: "16:00", end_time: "16:50", periods: 1 });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/the system proposes them; HR picks the teacher/);
  });

  await step(page, "HR > Leave Approval > Substitute teaching > Assign: Bea is suggested (Carlo, another branch, is not); a teacher outside the suggestions is refused", async () => {
    await as(page, "hr", "hr-leaves");
    await settle(page);
    const row = main(page).getByTestId("substitutions").locator("tr", { hasText: ana.full_name }).filter({ hasText: start });
    await expect(row).toContainText("Pick a teacher");
    await expect(row.getByTestId("pick-substitute")).toHaveText("Assign");
    const refused = await api(page, "PATCH", "/api/substitutions", { id, action: "approve", substitute_id: carlo.id, remark: { code: "approve.as_requested" } });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/cannot substitute here/);
    await row.getByTestId("pick-substitute").click();
    const dialog = page.getByTestId("arrange-substitute");
    await expect(dialog.getByRole("heading")).toContainText("Assign substitute teacher");
    await dialog.getByRole("button", { name: "Find substitutes" }).click();
    const list = dialog.getByTestId("sub-suggestions");
    await expect(list).toContainText(bea.full_name);
    await expect(list).not.toContainText(carlo.full_name); // another branch
    await expect(list).not.toContainText(/subject/i); // never labelled a subject match
    await list.getByRole("radio", { name: new RegExp(bea.full_name) }).check();
    await dialog.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    const saved = await rows(db().from("substitutions").select("status,substitute_id,periods").eq("id", id).single());
    expect(saved).toEqual({ status: "approved", substitute_id: bea.id, periods: 1 });
    const audited = await rows(db().from("audit_logs").select("action").eq("entity_id", id).eq("entity_type", "substitution"));
    expect(audited.map((a) => a.action)).toContain("substitution_approved");
  });

  await step(page, "Accountant > Payroll Reports > the substitution report and its Excel export open", async () => {
    await as(page, "accountant", "ac-reports");
    await settle(page);
    await expect(main(page).getByTestId("substitutions-report")).toBeVisible();
    const file = await page.request.get(`/api/reports/substitutions?from=${today}&to=${today}&by=substitute&format=xlsx`);
    expect(file.status()).toBe(200);
  });
});
