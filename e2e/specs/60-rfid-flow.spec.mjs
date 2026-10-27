// RFID: no registered terminals (removed 2026-10-27); HR registers a card, unlocks the terminal with the password, the
// tap shows up as attendance; a duplicate tap, a deactivated card and an
// unknown card are refused.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { choose, manilaDay, refresh } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const ANA_CARD = "1000000001";
const BEA_CARD = "1000000002";

async function tap(page, uid) {
  const response = page.waitForResponse((r) => r.url().includes("/api/admin/attendance") && r.request().method() === "POST", { timeout: 30000 });
  await page.locator("#rt-scan-input").click();
  await page.keyboard.type(uid, { delay: 20 });
  await page.keyboard.press("Enter");
  const res = await response;
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

test("RFID: register card → unlock terminal → tap → attendance; duplicate, deactivated and unknown cards", async ({ page, monitor }) => {
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const today = manilaDay(0);

  // Registered terminals were removed (2026-10-27): no one adds or edits one.
  // Every role that runs the kiosk only has "Open RFID Terminal".
  for (const [role, pageId, where] of [
    ["admin", "adm-maintenance", "Admin > RFID Terminal & Cards"],
    ["hr", "hr-rfid-terminals", "HR > RFID Terminal"],
    ["super_admin", "sa-maintenance", "Super Admin > System Maintenance"],
  ]) {
    await step(page, `${where} > Open RFID Terminal only; no terminals to add or edit`, async () => {
      monitor.at(where);
      monitor.allow(/^40[345] (GET|POST|PATCH) \/api\/rfid\/terminals/);
      await as(page, role, pageId);
      await expect(main(page).getByRole("button", { name: "Open RFID Terminal" })).toBeEnabled();
      for (const name of ["Add terminal", "Edit", "Reset key", "Switch off", "Switch on"]) {
        await expect(main(page).getByRole("button", { name, exact: true })).toHaveCount(0);
      }
      await expect(main(page).getByText("RFID terminals", { exact: true })).toHaveCount(0);
      const statuses = await page.evaluate(async () => Promise.all([
        fetch("/api/rfid/terminals").then((r) => r.status),
        fetch("/api/rfid/terminals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Sneaky Gate" }) }).then((r) => r.status),
      ]));
      // Gone: the proxy refuses an API path it does not know (403) before Next.js would say 404.
      for (const status of statuses) expect([403, 404, 405], "the terminals API is gone").toContain(status);
    });
  }
  const before = await rows(db().from("rfid_terminals").select("id"));
  expect(before, "no terminal was created").toHaveLength(0);

  await step(page, "HR > RFID Cards > Register with no number / letters only (refused)", async () => {
    monitor.at("HR > RFID Cards");
    monitor.allow(/^4(00|09|22) POST \/api\/rfid\/cards/);
    await as(page, "hr", "hr-rfid-cards");
    await main(page).getByRole("button", { name: "Register card" }).click();
    const dialog = page.getByRole("dialog");
    await choose(page, dialog.locator("#rf-emp"), /Ana/);
    // Card numbers are digits only: letters never reach the field.
    await dialog.locator("#rf-uid").pressSequentially("ABC");
    await expect(dialog.locator("#rf-uid")).toHaveValue("");
    await dialog.locator("#rf-reason").fill("E2E new card");
    await dialog.getByRole("button", { name: "Register card" }).click();
    await page.waitForTimeout(1000);
    await expect(dialog).toBeVisible();
    expect((await profileByEmail(ACCOUNTS.employee.email)).rfid_uid || "").toBe("");
  });

  await step(page, "HR > RFID Cards > Register Bea's number for Ana (refused: in use)", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.locator("#rf-uid").fill(BEA_CARD);
    await dialog.getByRole("button", { name: "Register card" }).click();
    await page.waitForTimeout(1500);
    await expect(dialog).toBeVisible();
    expect((await profileByEmail(ACCOUNTS.employee.email)).rfid_uid || "").toBe("");
  });

  await step(page, "HR > RFID Cards > Register Ana's card", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.locator("#rf-uid").fill(ANA_CARD);
    await dialog.getByRole("button", { name: "Register card" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    expect((await profileByEmail(ACCOUNTS.employee.email)).rfid_uid).toBe(ANA_CARD);
    await refresh(page);
    await expect(main(page).locator("tr", { hasText: "Ana" }).first()).toBeVisible();
  });

  await step(page, "HR > RFID Cards > Deactivate Bea's card", async () => {
    const row = main(page).locator("tr", { hasText: "Bea" }).first();
    await row.getByRole("button", { name: "Deactivate" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#rf-reason").fill("E2E card returned");
    await dialog.getByRole("button", { name: "Deactivate" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    const cards = await rows(db().from("rfid_cards").select("status").eq("uid", BEA_CARD));
    expect(cards[0]?.status).toBe("inactive");
  });

  await step(page, "HR > RFID Terminal > unlock", async () => {
    monitor.at("RFID Terminal");
    await as(page, "hr", "hr-rfid-terminals");
    await main(page).getByRole("button", { name: "Open RFID Terminal" }).click();
    await page.waitForURL(/rfid-terminal/);
    // No terminal to choose: the password opens it (2026-10-27).
    await expect(page.locator("#rt-terminal")).toHaveCount(0);
    await page.locator("#rt-lock-password").fill(ACCOUNTS.hr.password);
    await page.getByRole("button", { name: "Unlock terminal" }).click();
    await page.locator("#rt-scan-input").waitFor({ timeout: 30000 });
  });

  await step(page, "RFID Terminal > tap Ana's card", async () => {
    const res = await tap(page, ANA_CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expect(page.getByText(/Ana/).first()).toBeVisible();
    const logs = await rows(db().from("attendance_logs").select("time_in,log_date").eq("employee_id", ana.id).eq("log_date", today));
    expect(logs, "the tap is an attendance row for today").toHaveLength(1);
    expect(logs[0].time_in).toBeTruthy();
  });

  await step(page, "RFID Terminal > tap Ana's card again at once (duplicate)", async () => {
    const res = await tap(page, ANA_CARD);
    expect(res.status).toBe(200);
    expect(res.body.tap).toBe("duplicate");
    await expect(page.getByText(/already recorded/i).first()).toBeVisible();
    const logs = await rows(db().from("attendance_logs").select("id").eq("employee_id", ana.id).eq("log_date", today));
    expect(logs).toHaveLength(1);
  });

  await step(page, "RFID Terminal > tap Bea's deactivated card (refused)", async () => {
    monitor.allow(/^4\d\d POST \/api\/admin\/attendance/);
    const res = await tap(page, BEA_CARD);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.code).toBe("card_inactive");
    await expect(page.getByText("Card inactive. Please see HR.").first()).toBeVisible();
  });

  await step(page, "RFID Terminal > tap an unknown card (refused)", async () => {
    const res = await tap(page, "9999999999");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  await step(page, "Employee > Attendance > today's tap is listed", async () => {
    monitor.at("Employee > Attendance");
    await as(page, "employee", "emp-attendance");
    await settle(page);
    const day = new Date(`${today}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    await expect(main(page).getByText(new RegExp(day.replace(" ", "\\s+"))).first()).toBeVisible();
  });
});
