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
  // Dates read as dates on screen (2026-11-24): the rows are found by their selection checkbox, named with the day.
  const ours = card.getByRole("row").filter({ has: page.getByRole("checkbox", { name: new RegExp(`^Select .* ${day}$`) }) });
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
    await filters.getByRole("searchbox", { name: "Search name, ID or details" }).fill(people[0].full_name);
    await expect(main(page).locator("li", { hasText: TAG })).toHaveCount(1);
    await filters.getByRole("searchbox", { name: "Search name, ID or details" }).fill("");
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

test("HR: Move and Replace start from the list's selection (no separate Move many / Replace many buttons)", async ({ page }) => {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  await as(page, "hr", "hr-transfers");
  await settle(page);
  await expect(main(page).getByRole("button", { name: "Move many" })).toHaveCount(0);
  await main(page).getByRole("checkbox", { name: `Select ${bea.full_name}` }).first().check();
  await main(page).getByTestId("bulk-bar").getByRole("button", { name: "Move selected" }).click();
  const move = page.getByTestId("move-many");
  await expect(move.getByTestId("bulk-row")).toHaveCount(1);
  await expect(move.getByTestId("bulk-row").first()).toContainText(bea.full_name);
  await page.keyboard.press("Escape");

  // A card for Bea to replace (local test data only).
  const uid = `55${Date.now()}`.slice(0, 10);
  const card = await (await page.request.post("/api/rfid/cards", { data: { action: "register", employee_id: bea.id, uid, reason: "E2E part F" } }));
  expect([200, 409]).toContain(card.status());
  await as(page, "hr", "hr-rfid-cards");
  await settle(page);
  await expect(main(page).getByRole("button", { name: "Replace many" })).toHaveCount(0);
  await main(page).getByRole("checkbox", { name: `Select ${bea.full_name} card` }).first().check();
  await main(page).getByTestId("bulk-bar").getByRole("button", { name: "Replace selected" }).click();
  const replace = page.getByTestId("rfid-bulk-replace");
  await expect(replace.getByTestId("bulk-row")).toHaveCount(1);
  await expect(replace.getByTestId("bulk-row").first()).toContainText(bea.full_name);
  await page.keyboard.press("Escape");
  expect((await profileByEmail(ACCOUNTS.employee2.email)).branch_id, "nothing moved").toBe(bea.branch_id);
});

// 2026-11-26: branch Admins are view-only (PR #54); schedule requests are closed-out history. The live bulk flow
// from the branch Admins is the incentive proposal: HR ticks several and decides them with one required remark.
test("bulk: HR approves two incentive proposals from branch Admins with one remark (required here)", async ({ page }) => {
  const people = await Promise.all([ACCOUNTS.employee.email, ACCOUNTS.employee2.email].map(profileByEmail));
  const admin = await profileByEmail(ACCOUNTS.admin.email);
  const TAG = `E2E bulk proposal ${Date.now()}`;
  const planted = await rows(db().from("branch_admin_requests").insert(people.map((p) => ({
    branch_id: p.branch_id, kind: "incentive_endorsement", employee_id: p.id, status: "pending", admin_note: TAG,
    details: { employee_name: p.full_name, kind: "incentive", amount: 300, item_date: manilaDay(0), description: "Helped at the school fair" },
    created_by: admin.id, created_by_name: admin.full_name, history: [],
  }))).select("id"));
  const ids = planted.map((r) => r.id);
  await as(page, "hr", "hr-branch-requests");
  await settle(page);
  for (const p of people) await main(page).getByRole("checkbox", { name: `Select ${p.full_name} request` }).first().check();
  await main(page).getByTestId("bulk-bar").first().getByRole("button", { name: "Approve selected" }).click();
  const dialog = page.getByTestId("bulk-dialog");
  await dialog.getByRole("button", { name: "Approve (2)" }).click();
  await expect(dialog.getByText("Choose a remark (a reason is required).")).toBeVisible();
  await writeRemark(page, "bulk-remark", "school fair", { preset: "Approved as requested" });
  await dialog.getByRole("button", { name: "Approve (2)" }).click();
  await expect(dialog.getByTestId("bulk-summary")).toHaveText("2 done.");
  await dialog.getByRole("button", { name: "Done" }).click();
  const after = await rows(db().from("branch_admin_requests").select("status,decision_note").in("id", ids));
  expect(after.map((r) => r.status)).toEqual(["approved", "approved"]);
  expect(after.map((r) => r.decision_note)).toEqual(["Approved as requested: school fair", "Approved as requested: school fair"]);
  expect((await rows(db().from("audit_logs").select("entity_id").in("entity_id", ids).eq("metadata->>kind", "decision_remark")))).toHaveLength(2);
});

// 2026-11-24: the branch Admin is view-only (no endorsing); HR decides. The Admin still sees the branch's pending
// leave and transfers, with no Endorse action and no selection boxes; nothing is written by the Admin.
test("view-only: the branch Admin sees pending leave but cannot endorse or select it; nothing is written", async ({ page }) => {
  const people = await Promise.all([ACCOUNTS.employee.email, ACCOUNTS.employee2.email].map(profileByEmail));
  const TAG = `E2E view-only ${Date.now()}`;
  const ids = [];
  for (const [n, p] of people.entries()) {
    const day = manilaDay(120 + (Math.floor(Date.now() / 1000) % 200) * 2 + n);
    const id = crypto.randomUUID(); // a real leave id (the message threads take UUIDs)
    await rows(db().from("leave_requests").insert({ id, employee_id: p.id, employee_name: p.full_name, leave_type: "Vacation Leave", start_date: day, end_date: day,
      reason: TAG, status: "pending_accountant", pay_status: "with_pay", branch_id: p.branch_id }).select("id"));
    ids.push(id);
  }
  await as(page, "admin", "adm-leaves");
  await settle(page);
  await expect(main(page).getByText(TAG).first()).toBeVisible();
  await expect(main(page).getByRole("button", { name: /Endorse/ })).toHaveCount(0);
  await expect(main(page).getByRole("checkbox", { name: new RegExp(`^Select ${people[0].full_name} `) })).toHaveCount(0);
  const recs = await rows(db().from("branch_admin_requests").select("id").eq("kind", "leave_endorsement").in("ref_id", ids));
  expect(recs).toHaveLength(0);
});

test("view-only: the branch Admin sees a pending transfer but cannot endorse it", async ({ page }) => {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const admin = await profileByEmail(ACCOUNTS.admin.email);
  const north = await rows(db().from("branches").select("id").eq("name", "E2E North Branch").single());
  const [t] = await rows(db().from("transfer_requests").insert({ employee_id: bea.id, from_branch_id: bea.branch_id, to_branch_id: north.id, requested_by: admin.id, status: "pending", remarks: `E2E view-only transfer ${Date.now()}` }).select("id"));
  try {
    await as(page, "admin", "adm-transfers");
    await settle(page);
    await expect(main(page).getByText(bea.full_name).first()).toBeVisible();
    await expect(main(page).getByRole("button", { name: /Endorse/ })).toHaveCount(0);
    await expect(main(page).getByRole("checkbox", { name: `Select ${bea.full_name} transfer` })).toHaveCount(0);
  } finally {
    await db().from("transfer_requests").update({ status: "rejected" }).eq("id", t.id);
  }
});
