// Part F (2026-11-22): bulk actions on lists. Select rows (one by one, the
// page, or all matching), one remark for all, each row checked by the server
// and reported (done / not done with the reason); each decision audited on its
// own (Part H). First list: HR's overtime requests.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { manilaDay, writeRemark } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

test("bulk: HR approves three overtime requests at once; a row refused by the server is reported, not skipped", async ({ page, monitor }) => {
  monitor.allow(/^409 PATCH \/api\/hr\/overtime-requests/, /status of 409/);
  const people = await Promise.all([ACCOUNTS.employee.email, ACCOUNTS.employee2.email, ACCOUNTS.employee3.email].map(profileByEmail));
  const day = manilaDay(30 + (Math.floor(Date.now() / 1000) % 200));
  const TAG = `E2E bulk ${Date.now()}`;
  const planted = await rows(db().from("overtime_requests").insert(people.map((p) => ({
    employee_id: p.id, branch_id: p.branch_id, request_date: day, planned_start: "17:00", planned_end: "18:00", minutes: 60, reason: TAG,
  }))).select("id,employee_id"));

  await as(page, "hr", "hr-leaves");
  await settle(page);
  const card = main(page).getByTestId("hr-overtime-requests");
  const ours = card.getByRole("row").filter({ hasText: day });
  await expect(ours).toHaveCount(3);

  await step(page, "Select the three, the bar counts them; Clear empties it", async () => {
    for (const p of people) await card.getByRole("checkbox", { name: `Select ${p.full_name} ${day}` }).check();
    await expect(card.getByTestId("bulk-bar")).toContainText("3 selected");
    await card.getByTestId("bulk-bar").getByRole("button", { name: "Clear" }).click();
    await expect(card.getByTestId("bulk-bar")).toHaveCount(0);
    for (const p of people) await card.getByRole("checkbox", { name: `Select ${p.full_name} ${day}` }).check();
  });

  await step(page, "Approve selected: one remark for all; Carlo's was cancelled meanwhile and is reported with the reason", async () => {
    await card.getByTestId("bulk-bar").getByRole("button", { name: "Approve selected" }).click();
    const dialog = page.getByTestId("bulk-dialog");
    await expect(dialog.getByTestId("bulk-row")).toHaveCount(3);
    // Behind the screen's back: Carlo cancels his (the server must refuse that row).
    const carlo = planted.find((r) => r.employee_id === people[2].id);
    await db().from("overtime_requests").update({ status: "cancelled" }).eq("id", carlo.id);
    await writeRemark(page, "bulk-remark", "", { preset: "Approved as requested" });
    await dialog.getByRole("button", { name: "Approve (3)" }).click();
    await expect(dialog.getByTestId("bulk-summary")).toHaveText("2 done, 1 not done (see the reasons above).");
    await expect(dialog.getByTestId("bulk-row").filter({ hasText: people[2].full_name })).toContainText("already cancelled");
    await dialog.getByRole("button", { name: "Done" }).click();
    const after = await rows(db().from("overtime_requests").select("id,status").in("id", planted.map((r) => r.id)));
    expect(after.filter((r) => r.status === "approved")).toHaveLength(2);
    // One audited remark per decided item.
    const audited = await rows(db().from("audit_logs").select("entity_id,metadata").in("entity_id", planted.map((r) => r.id)).eq("metadata->>kind", "decision_remark"));
    expect(audited.map((a) => a.metadata.remark_code)).toEqual(["approve.as_requested", "approve.as_requested"]);
  });
});

test("bulk: HR filters pending leave by type and name (kept in the address), selects all shown, rejects them with one remark", async ({ page }) => {
  const people = await Promise.all([ACCOUNTS.employee.email, ACCOUNTS.employee2.email].map(profileByEmail));
  const TAG = `E2E bulk leave ${Date.now()}`;
  const ids = [];
  for (const [n, p] of people.entries()) {
    const day = manilaDay(80 + (Math.floor(Date.now() / 1000) % 200) * 2 + n);
    const id = `e2e-f-${Date.now()}-${n}`;
    await rows(db().from("leave_requests").insert({ id, employee_id: p.id, employee_name: p.full_name, leave_type: "Emergency Leave", start_date: day, end_date: day,
      reason: TAG, status: "pending_accountant", pay_status: "with_pay", branch_id: p.branch_id }).select("id"));
    ids.push(id);
  }
  await as(page, "hr", "hr-leaves");
  await settle(page);
  const filters = main(page).getByTestId("leave-pending-filters");

  await step(page, "Type filter with counts, name search; both stay in the address", async () => {
    await filters.getByRole("combobox", { name: "Leave type" }).click();
    await page.getByRole("option", { name: /^Emergency Leave \(\d+\)$/ }).click();
    await expect(page).toHaveURL(/lv_type=Emergency/);
    await filters.getByRole("textbox", { name: "Search pending leave" }).fill(people[0].full_name);
    await expect(main(page).locator("li", { hasText: TAG })).toHaveCount(1);
    await filters.getByRole("textbox", { name: "Search pending leave" }).fill("");
    await expect(main(page).locator("li", { hasText: TAG })).toHaveCount(2);
  });

  await step(page, "Select all shown → Reject selected with one preset: both rejected, one audited remark each", async () => {
    await filters.getByRole("checkbox", { name: /Select all shown/ }).check();
    await main(page).getByTestId("bulk-bar").getByRole("button", { name: "Reject selected" }).click();
    const dialog = page.getByTestId("bulk-dialog");
    await dialog.getByRole("button", { name: /^Reject \(\d+\)$/ }).click();
    await expect(dialog.getByText("Choose a remark (a reason is required).")).toBeVisible();
    await writeRemark(page, "bulk-remark", "", { preset: "Incomplete documents" });
    await dialog.getByRole("button", { name: /^Reject \(\d+\)$/ }).click();
    await expect(dialog.getByTestId("bulk-summary")).toContainText("done");
    await expect(dialog.getByTestId("bulk-summary")).not.toContainText("not done");
    await dialog.getByRole("button", { name: "Done" }).click();
    const after = await rows(db().from("leave_requests").select("status,decision_reason").in("id", ids));
    expect(after).toEqual([{ status: "rejected", decision_reason: "Incomplete documents" }, { status: "rejected", decision_reason: "Incomplete documents" }]);
    const audited = await rows(db().from("audit_logs").select("entity_id").in("entity_id", ids).eq("metadata->>kind", "decision_remark"));
    expect(audited).toHaveLength(2);
  });
});

test("HR > User Management: offboarding starts from the selected rows (no separate Offboard many button)", async ({ page }) => {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  await as(page, "hr", "hr-employees");
  await settle(page);
  await expect(main(page).getByRole("button", { name: "Offboard many" })).toHaveCount(0);
  await main(page).getByRole("searchbox").first().fill(bea.full_name).catch(() => main(page).getByPlaceholder(/Search name/).fill(bea.full_name));
  await main(page).getByRole("checkbox", { name: `Select ${bea.full_name}` }).check();
  await main(page).getByTestId("bulk-bar").getByRole("button", { name: "Offboard selected" }).click();
  const dialog = page.getByTestId("offboard-many");
  await expect(dialog.getByTestId("bulk-row")).toHaveCount(1);
  await expect(dialog.getByTestId("bulk-row").first()).toContainText(bea.full_name);
  await page.keyboard.press("Escape");
  expect((await profileByEmail(ACCOUNTS.employee2.email)).employee_status).not.toBe("Separated");
});
