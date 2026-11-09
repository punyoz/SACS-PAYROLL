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

// Decision 2026-11-09 #8: a transfer HR starts needs no endorsement. It
// applies now and the Admins of both branches are notified; nobody
// transfers themselves.
test("transfer: HR moves Carlo → applies now → both branch Admins notified → moved back", async ({ page, monitor }) => {
  const carlo = await profileByEmail(ACCOUNTS.employee3.email);
  const admin = await profileByEmail(ACCOUNTS.admin.email);
  const admin2 = await profileByEmail(ACCOUNTS.admin2.email);
  const hr = await profileByEmail(ACCOUNTS.hr.email);
  const remarks = `E2E transfer to Main ${Date.now()}`;
  const since = new Date(Date.now() - 1000).toISOString();

  await step(page, "HR > Transfer Requests > Transfer Carlo (no endorsement asked)", async () => {
    monitor.at("HR > Transfer Requests");
    await as(page, "hr", "hr-transfers");
    await page.getByRole("tab", { name: /^All/ }).click();
    await settle(page);
    // Search first: other specs add many demo employees to the list.
    await main(page).getByPlaceholder(/Search by name/).fill("Carlo");
    await main(page).locator("tr", { hasText: "Carlo" }).first().getByRole("button", { name: "Transfer" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("#hr-ba-ask")).toHaveCount(0);
    await choose(page, dialog.locator("#hr-ba-destination"), BRANCH_MAIN);
    await dialog.locator("#hr-ba-remarks").fill(remarks);
    await dialog.getByRole("button", { name: "Transfer now" }).click();
    await confirm(page, "Transfer");
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
    const done = await rows(db().from("transfer_requests").select("status").eq("employee_id", carlo.id).eq("remarks", remarks));
    expect(done.map((r) => r.status)).toEqual(["approved"]);
    expect((await profileByEmail(ACCOUNTS.employee3.email)).branch_id).not.toBe(carlo.branch_id);
  });

  await step(page, "both branch Admins are notified, without amounts", async () => {
    const notes = await rows(db().from("notifications").select("recipient_id,title,body").eq("kind", "transfer_applied").gte("created_at", since));
    const to = new Set(notes.map((n) => n.recipient_id));
    expect(to.has(admin.id) && to.has(admin2.id)).toBe(true);
    expect(notes.map((n) => `${n.title} ${n.body}`).join(" ")).not.toMatch(/₱|\d+\.\d{2}/);
  });

  await step(page, "HR cannot transfer itself (API)", async () => {
    const res = await api(page, "POST", "/api/admin/transfer-requests", { employee_id: hr.id, to_branch_id: carlo.branch_id, remarks: "self" });
    expect(res.status).toBe(403);
  });

  await step(page, "HR moves Carlo back to North (test data restored)", async () => {
    const res = await api(page, "POST", "/api/admin/transfer-requests", { employee_id: carlo.id, to_branch_id: carlo.branch_id, remarks: `${remarks} (back)` });
    expect(res.status).toBe(201);
    expect((await profileByEmail(ACCOUNTS.employee3.email)).branch_id).toBe(carlo.branch_id);
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
  // Daily / Monthly became a date range (alpha test A1): last month holds the October fixtures.
  await main(page).getByRole("combobox", { name: "Date range" }).click();
  await page.getByRole("option", { name: "Last month" }).click();
  await settle(page);
  await expect(main(page).getByText("Ana").first()).toBeVisible();
  await expect(main(page).getByText("Carlo")).toHaveCount(0);
  const res = await api(page, "GET", "/api/admin/branch-oversight?view=employees");
  expect(JSON.stringify(res.data || {})).not.toContain("Carlo");
  await step(page, "Admin (North) > Branch Attendance > sees Carlo, not Ana", async () => {
    monitor.at("Admin (North) > branch scope");
    await as(page, "admin2", "adm-attendance");
    await main(page).getByRole("combobox", { name: "Date range" }).click();
    await page.getByRole("option", { name: "Last month" }).click();
    await settle(page);
    await expect(main(page).getByText("Carlo").first()).toBeVisible();
    await expect(main(page).getByText("Ana")).toHaveCount(0);
  });
});
