// Process Payroll cleanup (2026-11-14): the entry form, the Computation
// summary and the batch table, 1st and 2nd half, desktop and phone. Local
// stack only. The test makes its own employee (a copy of Bea, same branch)
// with its own October attendance and an Incomplete Oct 20 for the Blocked
// row, so specs that process Bea's October 16-31 earlier in a full run cannot
// hide it (2026-11-21). The employee is retired afterwards. Screenshots: screenshots/2026-11-14-process-cleanup/.
//
//   E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test e2e/specs/99-process-page-cleanup.spec.mjs --project=desktop
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { main, settle } from "../support/portal.mjs";
import { db, rows, profileByEmail, retireAccountsCreatedSince } from "../support/db.mjs";

const OUT = join(process.cwd(), "screenshots", "2026-11-14-process-cleanup");
mkdirSync(OUT, { recursive: true });
const FIRST = "October 1-15, 2026";
const SECOND = "October 16-31, 2026";
const BLOCKED_DAY = "2026-10-20";
const DESKTOP = { width: 1366, height: 900 };
const PHONE = { width: 390, height: 844 };

/** A copy of Bea in her branch, on time Oct 1-30 (weekdays) except an Incomplete Oct 20. */
async function plantBlockedEmployee() {
  const bea = await profileByEmail("emp2@e2e.test");
  const stamp = Date.now();
  const email = `process-cleanup.${stamp}@e2e.test`;
  const full_name = "Aaron E2E Process Cleanup";
  const { data, error } = await db().auth.admin.createUser({ email, password: `E2e-Pc#${stamp}`, email_confirm: true, user_metadata: { role: "employee", full_name } });
  if (error) throw new Error(error.message);
  const id = data.user.id;
  // No card (set only through RFID registration) and no photo (it must sit in the owner's own folder).
  const { id: _id, email: _email, created_at: _c, updated_at: _u, rfid_uid: _card, photo_path: _p, photo_thumb_path: _t, photo_updated_at: _pu, ...rest } = bea;
  await rows(db().from("profiles").upsert({ ...rest, id, email, full_name, employee_id: `E2E-PC-${stamp}`, archived: false, on_payroll: true }, { onConflict: "id" }).select("id"));
  const logs = [];
  for (let d = 1; d <= 30; d += 1) {
    const day = `2026-10-${String(d).padStart(2, "0")}`;
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    logs.push({ employee_id: id, employee_name: full_name, employee_type: bea.employee_type, branch_id: bea.branch_id, log_date: day,
      time_in: `${day}T07:00:00+08:00`, time_out: `${day}T17:00:00+08:00`, status: "Absent" });
  }
  await rows(db().from("attendance_logs").insert(logs).select("id"));
  await rows(db().from("attendance_logs").update({ time_out: null, status: "Incomplete" }).eq("employee_id", id).eq("log_date", BLOCKED_DAY).select("id"));
  return id;
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test("Process Payroll: short labels, one note per explanation, read-only batch table with status pills", async ({ page }) => {
  const since = new Date().toISOString();
  await plantBlockedEmployee();
  try {
    for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      await page.setViewportSize(size);
      for (const period of [FIRST, SECOND]) {
        const half = period === FIRST ? "1st" : "2nd";
        await as(page, "accountant", `ac-process&period=${encodeURIComponent(period)}`);
        await settle(page);
        const batch = main(page).getByTestId("batch-card");
        const form = main(page).locator("#pc-entry");

        // Entry form: the deferral is said once; labels are short; Basic salary is ₱ + read-only.
        await expect(main(page).getByText("Deducted on the 2nd half of the month")).toHaveCount(0);
        await expect(main(page).getByTestId("deferred-note")).toHaveCount(half === "1st" ? 1 : 0);
        await expect(form.getByText("Single entry, or edit a saved draft.")).toHaveCount(0);
        await expect(form.getByText("Basic salary (monthly)", { exact: true })).toBeVisible();
        expect(await form.locator("#pc-basic").inputValue()).toMatch(/^\d{1,3}(,\d{3})*\.\d{2}$/);
        await expect(form.locator("#pc-basic")).toHaveAttribute("readonly", "");
        if (half === "2nd") {
          for (const [id, name] of [["pc-sss", "SSS"], ["pc-philhealth", "PhilHealth"], ["pc-pagibig", "Pag-IBIG"], ["pc-tax", "Withholding tax"]]) {
            await expect(form.locator(`#${id}`)).toHaveText(new RegExp(`^${name}`));
          }
          await expect(form.getByRole("button", { name: "Flag SSS for review" })).toBeVisible();
          // "How was this tax computed?" once, in the summary.
          await expect(main(page).getByTestId("tax-how")).toHaveCount(1);
        }
        await expect(main(page).getByTestId("tag-legend")).toBeVisible();

        // ⓘ opens with the keyboard (no hover needed).
        const tip = form.getByRole("button", { name: "About Basic salary" });
        await tip.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByText("Set by HR in the employee's record.")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByText("Set by HR in the employee's record.")).toBeHidden();

        await form.screenshot({ path: join(OUT, `form-${half}-half-${label}.png`) });
        const summary = main(page).locator('[data-slot="card"]').filter({ hasText: "Computation summary" }).first();
        await summary.screenshot({ path: join(OUT, `summary-${half}-half-${label}.png`) });

        // Batch: summary bar, no number boxes, 10 rows a page, statuses on every row.
        await expect(batch.getByTestId("batch-summary")).toBeVisible();
        await expect(batch.locator("[data-testid=batch-row] input[type=number]")).toHaveCount(0);
        await expect(batch.getByRole("combobox", { name: "Rows per page" })).toHaveText("10");
        await expect(batch.getByTestId("process-pager")).toContainText(/Showing 1–\d+ of \d+/);
        const rowCount = await batch.getByTestId("batch-row").count();
        expect(rowCount).toBeGreaterThan(0);
        expect(rowCount).toBeLessThanOrEqual(10);
        await expect(batch.getByTestId("batch-status")).toHaveCount(rowCount);
        await expect(batch.getByTestId("process-all")).toContainText(/^Process all ready \(\d+\)$/);
        if (label === "desktop") {
          const headers = (await batch.locator("thead th").allInnerTexts()).map((t) => t.trim());
          expect(headers.includes("Contributions")).toBe(half === "2nd");
          expect(headers.includes("Tax")).toBe(half === "2nd");
          expect(headers).not.toContain("SSS");
        }

        // Blocked: one banner, no warning rows in the table; the pill says why.
        if (half === "2nd") {
          await expect(batch.getByTestId("batch-blocked-banner")).toContainText("unresolved attendance");
          const blocked = batch.locator("[data-testid=batch-status][data-status=blocked]").first();
          await blocked.getByRole("button").click();
          await expect(page.getByTestId("batch-blocked-reason")).toContainText("Incomplete record, Oct 20");
          await page.screenshot({ path: join(OUT, `batch-blocked-reason-${label}.png`) });
          await page.keyboard.press("Escape");
          await expect(page.getByTestId("batch-blocked-reason")).toBeHidden();
          await batch.getByTestId("batch-count-blocked").click();
          await expect(batch.getByTestId("batch-row")).toHaveCount(await batch.locator("[data-testid=batch-status][data-status=blocked], [data-testid=batch-status][data-status=first_half]").count());
          await batch.getByTestId("batch-count-blocked").click();
        }

        // Expand the first row's breakdown.
        const first = batch.getByTestId("batch-row").first();
        if (label === "desktop") await first.getByRole("button", { name: /^Show breakdown/ }).click();
        else await first.getByRole("button", { expanded: false }).first().click();
        await expect(batch.getByTestId("batch-breakdown").first()).toBeVisible();
        await batch.screenshot({ path: join(OUT, `batch-${half}-half-${label}.png`) });

        // Edit in the form: the form switches to that employee.
        const name = (await first.locator("p.font-medium").first().innerText()).trim();
        await first.getByRole("button", { name: /^More actions for / }).click();
        await page.getByRole("menuitem", { name: "Edit in the form" }).click();
        await expect(form.locator("#pc-employee")).toContainText(name);

        expect(await overflow(page), `${label} ${half} half: no sideways scroll`).toBeLessThanOrEqual(1);
      }
    }
  } finally {
    await retireAccountsCreatedSince(since);
  }
});
