// Transfers, work schedules and Tenure Pay Protection: HR manages them, the
// branch Admin only endorses or requests, and each keeps a history that is
// still there after a refresh.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, confirm, refresh } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_MAIN } from "../accounts.mjs";

test("transfer: HR asks for endorsement → Admin endorses → HR rejects → history kept", async ({ page, monitor }) => {
  const carlo = await profileByEmail(ACCOUNTS.employee3.email);
  const remarks = `E2E transfer to Main ${Date.now()}`;

  await step(page, "HR > Transfer Requests > Transfer Carlo (ask Admins first)", async () => {
    monitor.at("HR > Transfer Requests");
    await as(page, "hr", "hr-transfers");
    await page.getByRole("tab", { name: /^All/ }).click();
    await settle(page);
    await main(page).locator("tr", { hasText: "Carlo" }).first().getByRole("button", { name: "Transfer" }).click();
    const dialog = page.getByRole("dialog");
    await choose(page, dialog.locator("#hr-ba-destination"), BRANCH_MAIN);
    await dialog.locator("#hr-ba-remarks").fill(remarks);
    await dialog.locator("#hr-ba-ask").check();
    await dialog.getByRole("button", { name: "Ask for endorsement" }).click();
    await confirm(page, "Ask for endorsement");
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
    const pending = await rows(db().from("transfer_requests").select("id,status").eq("employee_id", carlo.id).eq("remarks", remarks));
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
  });

  await step(page, "Admin (Main) > Transfer Endorsements > Endorse the incoming move", async () => {
    monitor.at("Admin > Transfer Endorsements");
    await as(page, "admin", "adm-transfers");
    const row = main(page).locator("tr", { hasText: "Carlo" }).filter({ hasText: remarks }).first();
    await row.getByRole("button", { name: "Endorse" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#ov-note").fill("E2E: we have a vacancy");
    await dialog.getByRole("button", { name: "Endorse", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await refresh(page);
    await expect(main(page).getByText("E2E: we have a vacancy")).toBeVisible();
  });

  await step(page, "HR > Transfer Requests > sees the endorsement, rejects", async () => {
    monitor.at("HR > Transfer Requests (decide)");
    await as(page, "hr", "hr-transfers");
    const row = main(page).locator("tr", { hasText: remarks }).first();
    await expect(row.getByText(/Endorsed/)).toBeVisible();
    await row.getByRole("button", { name: "Reject" }).click();
    await confirm(page, "Reject");
    const after = await rows(db().from("transfer_requests").select("status").eq("employee_id", carlo.id).eq("remarks", remarks).single());
    expect(after.status).toBe("rejected");
    const still = await profileByEmail(ACCOUNTS.employee3.email);
    expect(still.branch_id, "a rejected transfer leaves the employee where they were").toBe(carlo.branch_id);
    await refresh(page);
    await expect(main(page).locator("tr", { hasText: remarks }).first()).toBeVisible();
    await expect(main(page).locator("tr", { hasText: remarks }).first().getByText("Rejected")).toBeVisible();
  });
});

test("work schedules: HR creates a schedule; it and its history stay after refresh; Admin cannot edit", async ({ page, monitor }) => {
  const name = `E2E Late Shift ${Date.now() % 100000}`;

  await step(page, "HR > Work Schedules > New schedule with no name (refused)", async () => {
    monitor.at("HR > Work Schedules");
    // The server refuses the nameless schedule (400) and the dialog says why.
    monitor.allow(/^400 POST \/api\/admin\/work-schedules/, /status of 400/);
    await as(page, "hr", "hr-schedules");
    await main(page).getByRole("button", { name: "New schedule" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#ws-name").fill("");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[role="alert"], .text-destructive').first()).toBeVisible();
    monitor.clearAllowed();
  });

  await step(page, "HR > Work Schedules > save a new schedule", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.locator("#ws-name").fill(name);
    await dialog.locator("#ws-start").fill("08:00");
    await dialog.locator("#ws-end").fill("17:00");
    await dialog.locator("#ws-grace").fill("10");
    await dialog.locator("#ws-hours").fill("8");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await refresh(page);
    await expect(main(page).getByText(name).first()).toBeVisible();
    const saved = await rows(db().from("work_schedules").select("id").eq("name", name));
    expect(saved.length).toBeGreaterThan(0);
  });

  await step(page, "Admin > Schedule Requests > can request, not edit schedules", async () => {
    monitor.at("Admin > Schedule Requests");
    monitor.allow(/^403 /);
    await as(page, "admin", "adm-schedules");
    await expect(main(page).getByRole("button", { name: "Request a change" })).toBeVisible();
    await expect(main(page).getByRole("button", { name: "New schedule" })).toHaveCount(0);
    const res = await api(page, "POST", "/api/admin/work-schedules", { action: "save_profile", name: "hack", work_start: "08:00", work_end: "17:00" });
    expect([401, 403]).toContain(res.status);
  });
});

test("tenure pay protection: HR grants to an eligible employee; grant history stays", async ({ page, monitor }) => {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const notes = `E2E Contract 2026-${Date.now() % 1000}`;

  await step(page, "HR > Tenure Pay Protection > Meets tenure > Grant Bea", async () => {
    monitor.at("HR > Tenure Pay Protection");
    await as(page, "hr", "hr-tenure");
    await page.getByRole("tab", { name: /Meets tenure/ }).click();
    await settle(page);
    await main(page).locator("tr", { hasText: "Bea" }).first().getByRole("button", { name: "Grant" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#tp-notes").fill(notes);
    await dialog.getByRole("button", { name: "Grant", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    const grants = await rows(db().from("tenure_protection_grants").select("id").eq("employee_id", bea.id));
    expect(grants.length).toBeGreaterThan(0);
  });

  await step(page, "HR > Tenure Pay Protection > Benefit granted + Grant history after refresh", async () => {
    await refresh(page);
    await page.getByRole("tab", { name: /Benefit granted/ }).click();
    await settle(page);
    await expect(main(page).locator("tr", { hasText: "Bea" }).first()).toBeVisible();
    await expect(main(page).getByText(notes).first()).toBeVisible();
  });

  await step(page, "Accountant / Admin > Tenure API refused", async () => {
    monitor.at("Accountant > tenure API");
    monitor.allow(/^403 /);
    await as(page, "accountant");
    const res = await api(page, "POST", "/api/hr/tenure-protection", { action: "grant", employee_id: bea.id });
    expect([401, 403]).toContain(res.status);
  });
});

test("branch scoping: the Main Campus Admin never sees the North branch's people", async ({ page, monitor }) => {
  monitor.at("Admin > branch scope");
  await as(page, "admin", "adm-attendance");
  await page.getByRole("tab", { name: "Monthly" }).click();
  await settle(page);
  await expect(main(page).getByText("Ana").first()).toBeVisible();
  await expect(main(page).getByText("Carlo")).toHaveCount(0);
  const res = await api(page, "GET", "/api/admin/branch-oversight?view=employees");
  expect(JSON.stringify(res.data || {})).not.toContain("Carlo");
  await step(page, "Admin (North) > Branch Attendance > sees Carlo, not Ana", async () => {
    monitor.at("Admin (North) > branch scope");
    await as(page, "admin2", "adm-attendance");
    await page.getByRole("tab", { name: "Monthly" }).click();
    await settle(page);
    await expect(main(page).getByText("Carlo").first()).toBeVisible();
    await expect(main(page).getByText("Ana")).toHaveCount(0);
  });
});
