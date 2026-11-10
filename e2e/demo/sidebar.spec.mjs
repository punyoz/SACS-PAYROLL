// Part F screens (2026-11-09): the "My Account" group and the collapsible work
// groups, the old URLs, and the menu on phones. Saved sign-ins from
// auth.setup.mjs; headless, parallel.
import { test, expect } from "@playwright/test";
import { stateFile } from "./roles.mjs";

test.describe.configure({ mode: "parallel" });

const group = (page, name) => page.locator(`[data-nav-group="${name}"]`);
const header = (page, name) => group(page, name).locator("button[aria-expanded]");

test.describe("Employee", () => {
  test.use({ storageState: stateFile("employee") });
  test("My Account is open by default; old request URLs open the right tab of My Requests", async ({ page }) => {
    await page.goto("/employee");
    await expect(header(page, "My Account")).toHaveAttribute("aria-expanded", "true");
    for (const label of ["My Attendance", "My Timesheet", "My Leave", "My Payslips", "My Requests", "My BIR Form 2316", "My Profile"]) {
      await expect(group(page, "My Account").getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await page.goto("/employee?page=emp-loans");
    await expect(page.getByTestId("my-requests")).toBeVisible();
    await expect(page.getByTestId("my-requests-tab-loans")).toHaveAttribute("aria-selected", "true");
    await page.goto("/employee?page=emp-13th");
    await expect(page.getByTestId("my-requests-tab-thirteenth_month")).toHaveAttribute("aria-selected", "true");
  });
});

for (const [role, portal, first] of [["hr", "/hr", "Employees"], ["accountant", "/accountant", "Payroll"]]) {
  test.describe(role, () => {
    test.use({ storageState: stateFile(role) });
    test(`${role}: groups closed by default, toggle, remembered, open on the current page`, async ({ page }) => {
      await page.goto(portal);
      await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("sacs-nav-groups:")) localStorage.removeItem(k); });
      await page.reload();
      await expect(header(page, "My Account")).toHaveAttribute("aria-expanded", "false");
      await header(page, first).click();
      await expect(header(page, first)).toHaveAttribute("aria-expanded", "true");
      await page.reload();
      await expect(header(page, first)).toHaveAttribute("aria-expanded", "true"); // remembered
      await page.goto(`${portal}?page=${role === "hr" ? "hr-my-payslips" : "ac-my-payslips"}`);
      await expect(header(page, "My Account")).toHaveAttribute("aria-expanded", "true"); // the current page's group
      await expect(group(page, "My Account").getByRole("button", { name: "My Payslips", exact: true })).toHaveAttribute("data-active", "true");
      // Keyboard: the header is a button (Enter toggles), with a visible focus ring.
      await header(page, "My Account").focus();
      await page.keyboard.press("Enter");
      await expect(header(page, "My Account")).toHaveAttribute("aria-expanded", "false");
    });
  });
}

for (const [role, portal] of [["admin", "/admin"], ["super_admin", "/super-admin"]]) {
  test.describe(role, () => {
    test.use({ storageState: stateFile(role) });
    test(`${role}: no My Account group; the My APIs refuse`, async ({ page, request }) => {
      await page.goto(portal);
      await page.locator("#portal-main").waitFor();
      await expect(group(page, "My Account")).toHaveCount(0);
      for (const path of ["/api/me/payslips", "/api/me/requests", "/api/me/attendance/logs?from=2026-11-01&to=2026-11-09"]) {
        expect((await request.get(path)).status(), path).toBe(403);
      }
    });
  });
}

test.describe("phones", () => {
  for (const width of [360, 768]) {
    test.describe(`${width}px`, () => {
      test.use({ storageState: stateFile("hr"), viewport: { width, height: 800 }, isMobile: width < 700, hasTouch: width < 700 });
      test(`HR menu at ${width}px: groups work, one open at a time, no sideways scroll`, async ({ page }) => {
        await page.goto("/hr");
        await page.locator("#portal-main").waitFor();
        if (width < 768) await page.locator("[data-sidebar=trigger]").first().click();
        await header(page, "Employees").click();
        await expect(header(page, "Employees")).toHaveAttribute("aria-expanded", "true");
        await header(page, "Payroll").click();
        await expect(header(page, "Payroll")).toHaveAttribute("aria-expanded", "true");
        if (width < 768) await expect(header(page, "Employees")).toHaveAttribute("aria-expanded", "false"); // one at a time on phones
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      });
    });
  }
});

test.describe("Super Admin: an HR's home branch", () => {
  test.use({ storageState: stateFile("super_admin") });
  test("the HR row shows its home branch; the edit dialog picks it", async ({ page }) => {
    await page.goto("/super-admin?page=sa-accounts");
    await expect(page.locator("#portal-main").getByText("All Branches · paid in Main Branch").first()).toBeVisible();
    await page.getByRole("button", { name: "Edit Demo HR One" }).click();
    const pick = page.getByTestId("hr-home-branch");
    await expect(pick).toBeVisible();
    await expect(pick).toContainText("Main Branch");
    await expect(page.getByText("Home branch (for payroll)")).toBeVisible();
  });
});
