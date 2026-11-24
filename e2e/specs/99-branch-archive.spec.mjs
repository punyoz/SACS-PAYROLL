// Archived branches (2026-11-24): the Super Admin archives a branch (never deletes it); branch dropdowns and lists
// show only active branches, "Show archived" brings them back for history; a branch with active accounts is refused.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const NAME = "E2E Archive Test";

test("archive a branch: hidden from dropdowns, shown under Show archived; refused while active accounts remain", async ({ page, monitor }) => {
  monitor.at("Super Admin > Branch Management > Archive");
  psql(`delete from branches where name = '${NAME}';`);
  const [branch] = await rows(db().from("branches").insert({ name: NAME, location: "Test location", code: "BR-E2E", status: "Active" }).select("id"));

  await step(page, "Super Admin: a branch with an active account cannot be archived", async () => {
    await as(page, "super_admin", "sa-branches");
    const main1 = await profileByEmail(ACCOUNTS.employee.email);
    const refused = await api(page, "PATCH", "/api/admin/branches", { id: main1.branch_id, status: "Archived" });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/still has \d+ active account/);
  });

  await step(page, "Super Admin: archive the empty branch; the list hides it until Show archived", async () => {
    const res = await api(page, "PATCH", "/api/admin/branches", { id: branch.id, status: "Archived" });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const [kept] = await rows(db().from("branches").select("status").eq("id", branch.id));
    expect(kept.status).toBe("Archived");
    const list = await api(page, "GET", "/api/admin/branches");
    expect(list.data.branches.map((b) => b.name)).not.toContain(NAME);
    const all = await api(page, "GET", "/api/admin/branches?include_archived=1");
    expect(all.data.branches.map((b) => b.name)).toContain(NAME);
    await page.reload();
    await settle(page);
    await expect(main(page).getByRole("row").filter({ hasText: NAME })).toHaveCount(0);
    await main(page).getByTestId("branches-show-archived").click();
    await expect(main(page).getByRole("row").filter({ hasText: NAME }).first()).toContainText("Archived");
  });

  await step(page, "HR > Employees: the branch filter offers active branches; 'All branches + archived' lists the archived one", async () => {
    await as(page, "hr", "hr-employees");
    await settle(page);
    await main(page).getByRole("combobox", { name: "Filter by branch" }).click();
    await expect(page.getByRole("option", { name: new RegExp(NAME) })).toHaveCount(0);
    await page.getByRole("option", { name: "All branches + archived" }).click();
    await main(page).getByRole("combobox", { name: "Filter by branch" }).click();
    await expect(page.getByRole("option", { name: `${NAME} (archived)` })).toBeVisible();
    await page.keyboard.press("Escape");
  });
  psql(`delete from branches where name = '${NAME}';`);
});
