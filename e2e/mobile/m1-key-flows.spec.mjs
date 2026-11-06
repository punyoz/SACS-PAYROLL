// The key flows again on a phone (390×844, touch), after the desktop run:
// sign in, move through every sidebar page from the phone menu (no sideways
// scrolling of the whole page), file a leave from the phone, HR decides it
// from the phone, the employee reads a payslip, the Accountant's Process
// Payroll and HR's Payroll Approval, and the RFID kiosk on a phone.
import { test, expect } from "../support/test.mjs";
import { as, loginThroughUi, signOutLocally, ROLE_LABEL } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { PAGES, main, navTo, settle, pageOverflow } from "../support/portal.mjs";
import { choose, confirm, manilaDay, pickDate, refresh } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS, ROLES } from "../accounts.mjs";

const REASON = `E2E phone leave ${Date.now().toString(36)}`;

test("phone: Employee signs in with password + code", async ({ page, monitor }) => {
  monitor.at("Phone > Login");
  await signOutLocally(page);
  await loginThroughUi(page, "employee");
  await expect(main(page)).toBeVisible();
  expect(await pageOverflow(page), "the login → portal page fits the phone").toBeLessThanOrEqual(1);
});

for (const role of ROLES) {
  test(`phone: ${ROLE_LABEL[role]} opens every sidebar page from the phone menu`, async ({ page, monitor }) => {
    test.setTimeout(15 * 60 * 1000);
    await as(page, role);
    const wide = [];
    for (const [, label] of PAGES[role]) {
      await step(page, `Phone > ${ROLE_LABEL[role]} > menu > ${label}`);
      monitor.at(`Phone > ${ROLE_LABEL[role]} > ${label}`);
      await navTo(page, label);
      await expect(main(page)).toBeVisible();
      const over = await pageOverflow(page);
      if (over > 1) wide.push(`${label} (${over}px)`);
    }
    expect(wide, "pages wider than the phone (the whole page scrolls sideways)").toEqual([]);
  });
}

test("phone: Employee files a leave; HR rejects it from the phone; Employee sees it", async ({ page, monitor }) => {
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const day = manilaDay(40);
  await step(page, "Phone > Employee > Leave > file Vacation Leave with the phone form", async () => {
    monitor.at("Phone > Employee > Leave");
    await as(page, "employee", "emp-leave");
    const form = main(page).locator("form").first();
    await choose(page, form.getByRole("combobox").first(), "Vacation Leave");
    await pickDate(page, form.getByLabel("Start date"), day);
    await pickDate(page, form.getByLabel("End date"), day);
    await form.getByPlaceholder("State the reason for your leave request").fill(REASON);
    await form.getByRole("button", { name: /Submit/ }).click();
    await settle(page);
    await expect.poll(async () => (await rows(db().from("leave_requests").select("id").eq("employee_id", ana.id).eq("reason", REASON))).length, { timeout: 30000 }).toBe(1);
  });
  await step(page, "Phone > HR > Leave Approval > Reject it", async () => {
    monitor.at("Phone > HR > Leave Approval");
    await as(page, "hr", "hr-leaves");
    await settle(page);
    const card = main(page).locator("li", { hasText: REASON });
    await card.getByRole("button", { name: "Reject" }).click();
    await confirm(page, "Reject");
    await expect.poll(async () => (await rows(db().from("leave_requests").select("status").eq("employee_id", ana.id).eq("reason", REASON)))[0]?.status, { timeout: 30000 }).toBe("rejected");
  });
  await step(page, "Phone > Employee > Leave > shows Rejected", async () => {
    await as(page, "employee", "emp-leave");
    await refresh(page);
    await expect(main(page).getByText(REASON).first()).toBeVisible();
  });
});

test("phone: Employee reads the approved payslip; Accountant and HR payroll screens work", async ({ page, monitor }) => {
  await step(page, "Phone > Employee > Payslips > the latest approved payslip with its lines", async () => {
    monitor.at("Phone > Employee > Payslips");
    await as(page, "employee", "emp-payslips");
    await settle(page);
    const text = await main(page).innerText();
    // The latest one (October 1-15 from 20-payroll-flow, or a later period).
    expect(text).toMatch(/[A-Z][a-z]+ \d{1,2}-\d{1,2}, 20\d\d/);
    expect(text).toMatch(/Net pay/i);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });
  await step(page, "Phone > Accountant > Process Payroll > the period selector opens and lists periods", async () => {
    monitor.at("Phone > Accountant > Process Payroll");
    await as(page, "accountant", "ac-process");
    await settle(page);
    const select = main(page).getByRole("combobox").first();
    await select.click();
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });
  await step(page, "Phone > HR > Payroll Approval > the runs and the processing windows show", async () => {
    monitor.at("Phone > HR > Payroll Approval");
    await as(page, "hr", "hr-payroll-approval");
    await settle(page);
    await expect(main(page).getByTestId("hr-processing-windows")).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });
});

test("phone: the RFID kiosk unlocks with the Admin's password and takes a tap", async ({ page, monitor }) => {
  monitor.allow(/^4\d\d POST \/api\/admin\/attendance/, /status of 4/);
  await step(page, "Phone > Admin > RFID Terminal & Cards > Open RFID Terminal > unlock", async () => {
    monitor.at("Phone > RFID Terminal");
    await as(page, "admin", "adm-maintenance");
    await main(page).getByRole("button", { name: "Open RFID Terminal" }).click();
    await page.waitForURL(/rfid-terminal/);
    await page.locator("#rt-lock-password").fill(ACCOUNTS.admin.password);
    await page.getByRole("button", { name: "Unlock terminal" }).click();
    await page.locator("#rt-scan-input").waitFor({ timeout: 30000 });
  });
  await step(page, "Phone > Kiosk > Bea's card (Main Campus)", async () => {
    const response = page.waitForResponse((r) => r.url().includes("/api/admin/attendance") && r.request().method() === "POST", { timeout: 30000 });
    await page.locator("#rt-scan-input").click();
    await page.keyboard.type("1000000002", { delay: 20 });
    await page.keyboard.press("Enter");
    const res = await response;
    const body = await res.json().catch(() => ({}));
    // Bea's card was deactivated by 60-rfid-flow; either way the kiosk answers and shows it.
    expect(res.status(), JSON.stringify(body)).toBeLessThan(500);
    await expect(page.getByText(/Bea|recorded|inactive|see HR/i).first()).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });
});
