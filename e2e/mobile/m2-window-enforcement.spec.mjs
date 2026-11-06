// Processing window enforcement on a phone (390x844): the Super Admin turns
// it OFF from System Configuration, the red banner fits the phone on System
// Configuration, Process Payroll and Payroll Approval, then it is turned ON
// again and every banner is gone.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle, pageOverflow } from "../support/portal.mjs";
import { db, rows } from "../support/db.mjs";

const BANNER = "Testing mode: processing window not enforced.";
const banner = (page) => page.getByTestId("testing-mode-banner");
const card = (page) => main(page).getByTestId("window-enforcement-section");

/** Elements sticking out past the right edge (to name the culprit). */
async function wideElements(page) {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll("#portal-main *")]
      .filter((el) => el.getBoundingClientRect().right > limit + 1 && el.getBoundingClientRect().width > 0)
      .filter((el) => ![...el.children].some((c) => c.getBoundingClientRect().right > limit + 1))
      .slice(0, 6)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 50)}" right=${Math.round(el.getBoundingClientRect().right)}`);
  });
}

async function openCard(page) {
  await as(page, "super_admin", "sa-config");
  await settle(page);
  await page.getByRole("tab", { name: "Payroll", exact: true }).click();
  await settle(page);
  await card(page).scrollIntoViewIfNeeded();
}

test("phone: processing window switch OFF -> banners on every page -> ON again", async ({ page, monitor }) => {
  test.setTimeout(15 * 60 * 1000);
  const state = async () => { const r = await db().rpc("payroll_window_enforcement_state"); return (r.data || [])[0]; };
  if ((await state())?.enforced === false) {
    await db().rpc("set_payroll_window_enforcement", { p_enforced: true, p_expires_on: null, p_reason: "E2E phone: start ON", p_actor: null, p_actor_name: "E2E", p_source: "seed", p_environment: "local" });
  }

  await step(page, "Phone > Super Admin > System Configuration > Turn OFF", async () => {
    monitor.at("Phone > SA config (OFF)");
    await openCard(page);
    // The Payroll tab before the change: the switch must add no width.
    const before = await pageOverflow(page);
    if (before > 1) console.log(`  note: System Configuration > Payroll is already ${before}px wider than the phone before the switch: ${(await wideElements(page)).join(" | ")}`);
    await page.locator("#we-reason").fill("E2E phone: demo rehearsal");
    await card(page).getByRole("button", { name: "Turn OFF (testing mode)" }).click();
    await expect(card(page).getByText("OFF — testing mode")).toBeVisible();
    await expect(banner(page).first()).toContainText(BANNER);
    const after = await pageOverflow(page);
    if (after > 1) console.log(`  note: wide after OFF: ${(await wideElements(page)).join(" | ")}`);
    expect(after, "the switch and its banner add no width to System Configuration on the phone").toBeLessThanOrEqual(Math.max(1, before));
  });

  for (const [role, pageId, label] of [["accountant", "ac-process", "Process Payroll"], ["hr", "hr-payroll-approval", "Payroll Approval"]]) {
    await step(page, `Phone > ${label} > red banner, fits the phone`, async () => {
      monitor.at(`Phone > ${label} (OFF)`);
      await as(page, role, pageId);
      await settle(page);
      await expect(banner(page).first()).toContainText(BANNER);
      expect(await pageOverflow(page), `${label} fits the phone`).toBeLessThanOrEqual(1);
    });
  }

  await step(page, "Phone > Super Admin > Turn ON > banners gone", async () => {
    await openCard(page);
    await page.locator("#we-reason").fill("E2E phone: rehearsal done");
    await card(page).getByRole("button", { name: "Turn ON (enforce the window)" }).click();
    await expect(card(page).getByText("ON", { exact: true })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    for (const [role, pageId] of [["accountant", "ac-process"], ["hr", "hr-payroll-approval"]]) {
      await as(page, role, pageId);
      await settle(page);
      await expect(banner(page)).toHaveCount(0);
    }
    expect((await state()).enforced).toBe(true);
    const audit = await rows(db().from("audit_logs").select("metadata").eq("action", "payroll_window_enforcement_changed").order("created_at", { ascending: false }).limit(2));
    expect(audit.map((a) => a.metadata.reason)).toEqual(["E2E phone: rehearsal done", "E2E phone: demo rehearsal"]);
  });
});
