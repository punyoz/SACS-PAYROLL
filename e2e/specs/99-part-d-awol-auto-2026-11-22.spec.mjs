// Part D (2026-11-22): the system opens an AWOL case with the 1st notice
// PREPARED; HR reviews the PDF and sends it with one click (the reply deadline
// starts then, and the employee is told then). The notice template is editable.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

test("AWOL: a system-opened case — automatic, review the prepared notice; by hand, Proceed sends it; the template editor opens", async ({ page, monitor }) => {
  monitor.at("HR > AWOL Cases (system-opened)");
  monitor.allow(/^4\d\d PATCH \/api\/hr\/awol-cases/, /status of 4\d\d/);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  // One open case per employee; cases are never hard-deleted (employee_awol_cases_block_hard_delete):
  // an earlier spec's open case for Bea is closed first (system cleanup, triggers off).
  psql(`set session_replication_role = replica; update employee_awol_cases set stage = 'closed', outcome = coalesce(outcome, 'false_alarm') where employee_id = '${bea.id}' and stage <> 'closed';`);
  const since = new Date(Date.now() - 864e5).toISOString();
  const [opened] = await rows(db().from("employee_awol_cases").insert({
    employee_id: bea.id, branch_id: bea.branch_id, first_absent_on: "2026-11-02", stage: "flagged", auto_flagged: true,
    notes: "Opened by System, rule: 3 scheduled working days absent with no taps and no leave. 1st notice prepared for HR to review and send.",
  }).select("id"));

  try {
    await as(page, "hr", "hr-awol");
    await settle(page);
    // The case list (the reports table under it also names Bea, with a select checkbox per row).
    const row = main(page).locator("tr", { hasText: bea.full_name }).filter({ hasNot: page.getByRole("checkbox") });
    await expect(row).toHaveCount(1);

    await step(page, "HR > AWOL Cases > the system-opened case: Automatic, the system confirms it tonight, no deadline yet; the drawer says 'Opened by System'", async () => {
      await expect(row.getByTestId("awol-automation")).toContainText("Automatic");
      await expect(row.getByTestId("awol-next-step")).toContainText("The system confirms it tonight");
      await expect(row).not.toContainText("Reply by");
      await row.getByRole("button", { name: bea.full_name, exact: true }).click();
      const drawer = page.getByTestId("awol-drawer");
      await expect(drawer).toContainText("Opened by System");
      await page.keyboard.press("Escape");
      await row.getByRole("button", { name: `More for ${bea.full_name}` }).click();
      await expect(page.getByRole("menuitem", { name: "Review notice (PDF)" })).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await step(page, "Review notice (PDF): a real PDF before sending", async () => {
      const res = await page.request.get(`/api/hr/awol-cases/notice?id=${opened.id}`);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/pdf");
      expect((await res.body()).toString("latin1").startsWith("%PDF-")).toBe(true);
    });

    await step(page, "HR runs it by hand: Proceed sends the 1st notice; the deadline starts today; Bea is told", async () => {
      psql(`update employee_awol_cases set automation = 'stopped', automation_reason = 'E2E: HR handles it by hand' where id = '${opened.id}';`);
      await page.reload();
      await settle(page);
      const hand = main(page).locator("tr", { hasText: bea.full_name }).filter({ hasNot: page.getByRole("checkbox") });
      await hand.getByTestId("awol-proceed").click();
      await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
      await expect(hand).toContainText("Reply by", { timeout: 20000 });
      const saved = await rows(db().from("employee_awol_cases").select("stage,first_notice_sent_on,first_notice_reply_by").eq("id", opened.id).single());
      expect(saved.stage).toBe("first_notice");
      expect(saved.first_notice_sent_on).toBeTruthy();
      expect(saved.first_notice_reply_by > saved.first_notice_sent_on).toBe(true);
      const told = await rows(db().from("notifications").select("kind").eq("recipient_id", bea.id).eq("kind", "awol_first_notice").gte("created_at", since));
      expect(told.length).toBeGreaterThan(0);
      await expect(hand.getByTestId("awol-proceed")).toHaveCount(0);
    });

    await step(page, "A case HR opened by hand cannot skip ahead: it still needs its confirm step", async () => {
      await db().from("employee_awol_cases").update({ stage: "flagged", auto_flagged: false, first_notice_sent_on: null, first_notice_reply_by: null }).eq("id", opened.id);
      const res = await api(page, "PATCH", "/api/hr/awol-cases", { case_id: opened.id, action: "first_notice", sent_on: "2026-11-22", reply_by: "2026-11-27" });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    await step(page, "Notice template: the editor opens with the text and its fields", async () => {
      await main(page).getByRole("button", { name: "AWOL settings" }).click();
      const text = page.getByRole("dialog").getByLabel("Notice template");
      await expect(text).toBeVisible();
      await expect(text).toHaveValue(/\{reply_by\}/);
      await page.keyboard.press("Escape");
    });
  } finally {
    psql(`set session_replication_role = replica; update employee_awol_cases set stage = 'closed', outcome = coalesce(outcome, 'false_alarm') where id = '${opened.id}';`);
  }
});
