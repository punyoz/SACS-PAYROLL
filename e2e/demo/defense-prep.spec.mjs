// Defense prep 2026-11-12 (LOCAL only, after scripts/rfid-reset.mjs):
//   Part 1  the shared bulk-rows dialog (Register many, Replace many, Offboard
//           many) as HR, the Admin and the Super Admin at 1366px and 390px.
//   Part 2  no active card left; a deleted card number registered again with
//           Register many, then tapped at the RFID Terminal -> attendance.
//   Part 3  My Leave shows "of 6 days".
//   Part 5  exactly one show/hide toggle per password box; the CSS rule ships.
// Headless, saved sign-ins (auth.setup.mjs). Screenshots: test-results/defense-prep.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { psql } from "../support/db.mjs";
import { credentials, stateFile } from "./roles.mjs";

const SHOTS = join(process.cwd(), "test-results", "defense-prep");
mkdirSync(SHOTS, { recursive: true });
const DESKTOP = { width: 1366, height: 860 };
const PHONE = { width: 390, height: 844 };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

async function openCards(page, portal, pageId) {
  await page.goto(`${portal}?page=${pageId}`);
  await page.locator("#portal-main").waitFor();
  await expect(page.getByRole("button", { name: "Register many" })).toBeEnabled({ timeout: 30000 });
}

/** The dialog never scrolls sideways, and its footer stays on screen. */
async function noOverflow(page, dialog) {
  const box = await dialog.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, bottom: el.getBoundingClientRect().bottom, vh: window.innerHeight }));
  expect(box.sw, "no horizontal scroll inside the dialog").toBeLessThanOrEqual(box.cw + 1);
  expect(box.bottom).toBeLessThanOrEqual(box.vh + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no page scroll sideways").toBe(true);
}

async function pick(dialog, page, rowIndex, name) {
  await dialog.getByTestId("bulk-row").nth(rowIndex).getByRole("combobox").click();
  await page.keyboard.type(name);
  await page.getByRole("option", { name: new RegExp(name) }).first().click();
}

for (const [role, portal, pageId] of [["hr", "/hr", "hr-rfid-cards"], ["admin", "/admin", "adm-maintenance"], ["super_admin", "/super-admin", "sa-maintenance"]]) {
  test.describe(`${role}: Register many cards`, () => {
    test.use({ storageState: stateFile(role) });
    for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      test(`rows, Add row, Paste several rows, Check rows (${label})`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openCards(page, portal, pageId);
        await page.getByRole("button", { name: "Register many" }).click();
        const dialog = page.getByTestId("rfid-bulk");
        await expect(dialog.getByTestId("bulk-row")).toHaveCount(3);
        await dialog.getByRole("button", { name: "Add row" }).click();
        await expect(dialog.getByTestId("bulk-row")).toHaveCount(4);
        await dialog.getByRole("button", { name: "Paste several rows" }).click();
        await dialog.locator("textarea").fill("NOBODY-999, 1234567890\nDEMO-009, 12");
        await dialog.getByRole("button", { name: "Add these rows" }).click();
        await expect(dialog.getByTestId("bulk-result").first()).toContainText(/No employee "NOBODY-999"/);
        if (role === "admin") {
          // The Admin's picker lists only its own branch (Main): no Spring Valley person.
          await dialog.getByTestId("bulk-row").nth(1).getByRole("combobox").click();
          await page.keyboard.type("Imelda");
          await expect(page.getByRole("option", { name: /Imelda/ })).toHaveCount(0);
          await page.keyboard.press("Escape");
        }
        await shot(page, `${role}-register-many-${label}`);
        await noOverflow(page, dialog);
        await dialog.getByRole("button", { name: "Check rows" }).click();
        await expect(dialog.getByTestId("bulk-result").nth(1)).toContainText(/exactly 10 digits/, { timeout: 30000 });
        await expect(dialog.getByRole("button", { name: /^Register/ })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      });
    }
  });
}

test.describe("HR: register a deleted card number again, then tap it", () => {
  test.use({ storageState: stateFile("hr") });
  test("Register many -> RFID Terminal tap -> attendance; an unregistered number is refused", async ({ page }) => {
    test.setTimeout(180000);
    const uid = "9990000005"; // DEMO-005's card before the reset (deleted)
    const id = psql("select id from profiles where employee_id = 'DEMO-005'");
    const before = Number(psql(`select count(*) from attendance_taps where employee_id = '${id}'`));
    // A rerun: the card is already registered from the first run.
    const again = psql(`select count(*) from rfid_cards where uid = '${uid}' and status = 'active'`) !== "0";
    await openCards(page, "/hr", "hr-rfid-cards");
    if (!again) {
    await page.getByRole("button", { name: "Register many" }).click();
    const dialog = page.getByTestId("rfid-bulk");
    await pick(dialog, page, 0, "Andrea Demo Ilagan");
    await dialog.locator("[data-bulk-value]").first().fill(uid);
    await dialog.locator("[data-bulk-value]").first().press("Enter"); // a reader's Enter goes to the next row
    await expect(dialog.locator("[data-bulk-value]").nth(1)).toBeFocused();
    await dialog.getByRole("button", { name: "Check rows" }).click();
    await expect(dialog.getByTestId("bulk-result").first()).toContainText("Ready", { timeout: 30000 });
    await dialog.getByRole("button", { name: /^Register 1 card/ }).click();
    await expect(dialog.getByTestId("bulk-result").first()).toContainText("Done", { timeout: 30000 });
    await shot(page, "hr-register-many-done-desktop");
    }
    expect(psql(`select status from rfid_cards where uid = '${uid}'`)).toBe("active");

    await page.goto("/hr?page=hr-rfid-terminals");
    await page.getByRole("button", { name: "Open RFID Terminal" }).click();
    await page.waitForURL(/rfid-terminal/);
    expect(await page.locator("[data-password-toggle]").count(), "one toggle on the kiosk unlock").toBe(1);
    await shot(page, "kiosk-unlock-desktop");
    await page.locator("#rt-lock-password").fill(credentials().hr1.password);
    await page.getByRole("button", { name: "Unlock terminal" }).click();
    await page.locator("#rt-scan-input").waitFor({ timeout: 30000 });
    const tap = async (code) => {
      const response = page.waitForResponse((r) => r.url().includes("/api/admin/attendance") && r.request().method() === "POST", { timeout: 30000 });
      await page.locator("#rt-scan-input").click();
      await page.keyboard.type(code, { delay: 15 });
      await page.keyboard.press("Enter");
      const res = await response;
      return { status: res.status(), body: await res.json().catch(() => ({})) };
    };
    const ok = await tap(uid);
    expect(ok.body.code, JSON.stringify(ok.body)).not.toBe("card_unknown");
    if (!again) expect(Number(psql(`select count(*) from attendance_taps where employee_id = '${id}'`)), "the tap is recorded").toBeGreaterThan(before);
    const unknown = await tap("9990000006"); // DEMO-006's old number, deleted and not registered again
    expect(unknown.body.code).toBe("card_unknown");
    await expect(page.getByText("Card not recognized").first()).toBeVisible();
  });
});

test.describe("HR: Replace many and Offboard many", () => {
  test.use({ storageState: stateFile("hr") });
  for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    test(`Replace many: current card, new number, reason required (${label})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      // Dindo (DEMO-008) gets his old, deleted number back first, so he has a card to replace.
      if (psql("select count(*) from rfid_cards where status = 'active' and uid = '9990000008'") === "0") {
        const id = psql("select id from profiles where employee_id = 'DEMO-008'");
        const res = await page.request.post("/api/rfid/cards", { data: { action: "register", employee_id: id, uid: "9990000008", reason: "E2E" } });
        expect(res.status(), await res.text()).toBe(200);
      }
      await openCards(page, "/hr", "hr-rfid-cards");
      await page.getByRole("button", { name: "Replace many" }).click();
      const dialog = page.getByTestId("rfid-bulk-replace");
      await pick(dialog, page, 0, "Dindo Demo Dimaculangan");
      await expect(dialog.getByTestId("bulk-row").first()).toContainText("0008");
      await dialog.locator("[data-bulk-value]").first().fill(label === "desktop" ? "9990000777" : "9990000778");
      await dialog.getByRole("button", { name: "Check rows" }).click();
      await expect(dialog.getByTestId("bulk-result").first()).toContainText(/Ready.*stops recording at once/s, { timeout: 30000 });
      await expect(dialog.getByRole("button", { name: /^Replace 1 card/ })).toBeDisabled(); // no reason yet
      await dialog.locator("#rf-bulk-reason").fill("New card batch 2027");
      await expect(dialog.getByRole("button", { name: /^Replace 1 card/ })).toBeEnabled();
      await expect(dialog.getByText("The old cards were lost (their numbers can never be used again)")).toBeVisible();
      await shot(page, `hr-replace-many-${label}`);
      await noOverflow(page, dialog);
    });

    test(`Offboard many: date picker, what will happen, HR logins and duplicates refused (${label})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/hr?page=hr-employees");
      await page.getByRole("button", { name: "Offboard many" }).click();
      const dialog = page.getByTestId("offboard-many");
      await dialog.getByRole("button", { name: "Paste several rows" }).click();
      await dialog.locator("textarea").fill("DEMO-009, 2026-11-30\nDEMO-009, 2026-11-30\nDEMO-002, 2026-11-30");
      await dialog.getByRole("button", { name: "Add these rows" }).click();
      const results = dialog.getByTestId("bulk-result");
      await expect(results.nth(2)).toContainText(/Super Admin/); // an HR login, refused on paste
      await expect(results.nth(1)).toContainText(/another row/);
      await dialog.getByTestId("bulk-row").nth(1).getByRole("button", { name: /Remove row/ }).click();
      await dialog.getByRole("button", { name: "Check rows" }).click();
      await expect(results.first()).toContainText(/Separated on Nov 30, 2026; .* final pay needed/, { timeout: 30000 });
      await shot(page, `hr-offboard-many-${label}`);
      await noOverflow(page, dialog);
      // Nothing is separated by a check.
      expect(psql("select employee_status from profiles where employee_id = 'DEMO-009'")).toBe("Active");
    });
  }
});

for (const [role, portal, leavePage] of [["employee", "/employee", "emp-leave"], ["hr", "/hr", "hr-my-leave"], ["accountant", "/accountant", "ac-my-leave"]]) {
  test.describe(`${role}: My Leave`, () => {
    test.use({ storageState: stateFile(role) });
    test("the balance reads of 6 days", async ({ page }) => {
      await page.goto(`${portal}?page=${leavePage}`);
      await page.locator("#portal-main").waitFor();
      await expect(page.getByText(/\d+ of 6 days/)).toBeVisible({ timeout: 30000 });
      await expect(page.getByText(/of 15 days/)).toHaveCount(0);
    });
  });
}

test.describe("Part 5: one eye per password box", () => {
  test("sign-in page: one toggle, masked by default, toggles with aria-pressed; the CSS rule ships", async ({ page }) => {
    for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      await page.setViewportSize(viewport);
      await page.goto("/login");
      const input = page.locator("#login-password");
      await input.fill("Secret123!");
      const toggle = page.locator("[data-password-toggle]");
      await expect(toggle).toHaveCount(1);
      await expect(input).toHaveAttribute("type", "password");
      await expect(input).toHaveAttribute("autocomplete", "current-password");
      await expect(toggle).toHaveAttribute("type", "button");
      await toggle.click();
      await expect(input).toHaveAttribute("type", "text");
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(toggle).toHaveAttribute("aria-label", "Hide password");
      const size = await toggle.boundingBox();
      if (label === "phone") expect(size.height).toBeGreaterThanOrEqual(40);
      await toggle.click();
      await shot(page, `login-${label}`);
    }
    const css = await page.evaluate(async () => (await Promise.all([...document.querySelectorAll("link[rel=stylesheet]")].map((l) => fetch(l.href).then((r) => r.text())))).join("\n"));
    expect(css).toMatch(/::-ms-reveal/);
  });
});

for (const [role, portal] of [["super_admin", "/super-admin"], ["hr", "/hr"], ["employee", "/employee"]]) {
  test.describe(`${role}: change password`, () => {
    test.use({ storageState: stateFile(role) });
    test("one toggle per password box", async ({ page }) => {
      for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
        await page.setViewportSize(viewport);
        await page.goto(portal);
        await page.locator("#portal-main").waitFor();
        await page.locator("[data-account-menu], button[aria-haspopup=menu]").last().click();
        await page.getByRole("menuitem", { name: /change password/i }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.locator("#cp-current")).toBeVisible();
        const inputs = await dialog.locator("[data-password-input]").count();
        expect(await dialog.locator("[data-password-toggle]").count()).toBe(inputs);
        if (role === "super_admin") await shot(page, `change-password-${label}`);
        await page.keyboard.press("Escape");
      }
    });
  });
}

test.describe("Super Admin: backup password prompt", () => {
  test.use({ storageState: stateFile("super_admin") });
  test("one toggle", async ({ page }) => {
    for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      await page.setViewportSize(viewport);
      await page.goto("/super-admin?page=sa-backup");
      await page.locator("#portal-main").waitFor();
      await page.getByRole("button", { name: /download/i }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator("#backup-password")).toBeVisible();
      await expect(dialog.locator("[data-password-toggle]")).toHaveCount(1);
      await shot(page, `backup-password-${label}`);
      await page.keyboard.press("Escape");
    }
  });
});

for (const [role, portal, pageId] of [["hr", "/hr", "hr-leaves"], ["admin", "/admin", "adm-leaves"]]) {
  test.describe(`${role}: the paid-leave balance on the approval screen`, () => {
    test.use({ storageState: stateFile(role) });
    test("a pending request shows x of 6 days used, y remaining", async ({ page }) => {
      for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
        await page.setViewportSize(viewport);
        await page.goto(`${portal}?page=${pageId}`);
        await page.locator("#portal-main").waitFor();
        await expect(page.getByTestId("leave-balance").first()).toContainText(/\d+ of 6 days used, \d+ remaining/, { timeout: 30000 });
        await shot(page, `${role}-leave-balance-${label}`);
      }
    });
  });
}
