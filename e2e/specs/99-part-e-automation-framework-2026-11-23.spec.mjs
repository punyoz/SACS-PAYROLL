// Part E step 1 (2026-11-23): the Automation card. HR / Super Admin pause and
// resume; the branch Admin checks what the system prepared (Note / Object,
// own branch only); HR undoes an applied action with a reason (refused when the
// module has no undo); nothing is ever approved here.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, writeRemark } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const setPaused = (value) => db().from("system_config").update({ value }).eq("section", "automation").eq("key", "paused");

test("automation: pause / resume, Admin Note and Object (own branch), HR Undo refused without a module undo", async ({ page, monitor }) => {
  // Only the refusals this spec provokes: Admin undo / foreign branch (403), Undo without a module undo (409).
  monitor.allow(/^40[39] PATCH \/api\/automation/, /status of 40[39]/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const TAG = `E2E automation ${Date.now()}`;
  await setPaused("false");
  const log = async (kind, summary) => {
    const { data, error } = await db().rpc("automation_log", { p_module: "spec_test", p_rule: "an E2E rule", p_kind: kind, p_summary: summary, p_data: { tag: TAG }, p_employee: ana.id, p_branch: ana.branch_id });
    expect(error, "automation_log").toBeNull();
    return data;
  };
  const noted = await log("proposal", `${TAG} to note`);
  const objected = await log("proposal", `${TAG} to object`);
  const applied = await log("applied", `${TAG} applied`);

  try {
    await step(page, "HR > Dashboard > Automation: pause, then resume (audited)", async () => {
      monitor.at("HR > Dashboard > Automation");
      await as(page, "hr", "hr-dashboard");
      await settle(page);
      const card = main(page).getByTestId("automation-card");
      await expect(card).toBeVisible();
      await card.getByTestId("automation-pause").click();
      await expect(card.getByTestId("automation-paused")).toBeVisible();
      expect((await rows(db().from("system_config").select("value").eq("section", "automation").eq("key", "paused").single())).value).toBe("true");
      await card.getByTestId("automation-pause").click();
      await expect(card.getByTestId("automation-paused")).toHaveCount(0);
      const audited = await rows(db().from("audit_logs").select("action").in("action", ["automation_pause", "automation_resume"]).order("created_at", { ascending: false }).limit(2));
      expect(audited.map((a) => a.action).sort()).toEqual(["automation_pause", "automation_resume"]);
    });

    await step(page, "Admin > Dashboard > Automation: Note sends it to HR with the note", async () => {
      monitor.at("Admin > Dashboard > Automation");
      await as(page, "admin", "adm-dashboard");
      await settle(page);
      const card = main(page).getByTestId("automation-card");
      const item = card.getByTestId("automation-item").filter({ hasText: `${TAG} to note` });
      await expect(item).toContainText("by System, rule: an E2E rule");
      await item.getByRole("button", { name: "Note" }).click();
      await page.getByRole("dialog").getByLabel("Note").fill("Checked the taps, looks right");
      await page.getByRole("dialog").getByRole("button", { name: "Send to HR" }).click();
      await expect(card.getByTestId("automation-item").filter({ hasText: `${TAG} to note` })).toHaveCount(0);
      const saved = await rows(db().from("automation_actions").select("status,admin_note,admin_objected,forwarded_by").eq("id", noted).single());
      expect(saved).toMatchObject({ status: "with_hr", admin_note: "Checked the taps, looks right", admin_objected: false });
    });

    await step(page, "Admin > Object needs a preset; it goes to HR marked as objected (and audited)", async () => {
      const card = main(page).getByTestId("automation-card");
      const item = card.getByTestId("automation-item").filter({ hasText: `${TAG} to object` });
      await item.getByRole("button", { name: "Object" }).click();
      await writeRemark(page, "automation-object", "", { preset: "The data it used is wrong" });
      await page.getByRole("dialog").getByRole("button", { name: "Object" }).click();
      await expect(card.getByTestId("automation-item").filter({ hasText: `${TAG} to object` })).toHaveCount(0);
      const saved = await rows(db().from("automation_actions").select("status,admin_objected,admin_note").eq("id", objected).single());
      expect(saved).toMatchObject({ status: "with_hr", admin_objected: true, admin_note: "The data it used is wrong" });
      const remarks = await rows(db().from("audit_logs").select("metadata").eq("entity_id", objected).eq("metadata->>kind", "decision_remark"));
      expect(remarks.map((r) => r.metadata.remark_code)).toContain("object.automation.wrong_data");
    });

    await step(page, "Admin cannot undo; another branch's item cannot be checked", async () => {
      expect((await api(page, "PATCH", "/api/automation", { id: applied, action: "undo", remark: { code: "revoke.automation.in_error" } })).status).toBe(403);
      const north = await rows(db().from("branches").select("id").neq("id", ana.branch_id).limit(1));
      const { data: foreignId } = await db().rpc("automation_log", { p_module: "spec_test", p_rule: "an E2E rule", p_kind: "proposal", p_summary: `${TAG} other branch`, p_data: {}, p_employee: null, p_branch: north[0].id });
      expect((await api(page, "PATCH", "/api/automation", { id: foreignId, action: "note", note: "not mine" })).status).toBe(403);
      const list = await api(page, "GET", "/api/automation");
      expect(list.data.actions.some((a) => a.summary === `${TAG} other branch`)).toBe(false);
    });

    await step(page, "HR > the forwarded items show the Admin's note and objection; Undo without a module undo is refused", async () => {
      await as(page, "hr", "hr-dashboard");
      await settle(page);
      const card = main(page).getByTestId("automation-card");
      await expect(card.getByTestId("automation-item").filter({ hasText: `${TAG} to object` })).toContainText("Admin objected");
      const done = card.getByTestId("automation-item").filter({ hasText: `${TAG} applied` });
      await done.getByRole("button", { name: "Undo" }).click();
      await writeRemark(page, "automation-undo", "", { preset: "Applied in error" });
      await page.getByRole("dialog").getByRole("button", { name: "Undo" }).click();
      await expect(page.getByRole("dialog")).toContainText("can't be undone here");
      await page.keyboard.press("Escape");
      expect((await rows(db().from("automation_actions").select("status").eq("id", applied).single())).status).toBe("done");
    });
  } finally {
    await setPaused("true");
  }
});
