// Part E step 1 (2026-11-23), as changed since: Settings > Automation (52815e9;
// the dashboards lost the card). HR / Super Admin pause and resume (all, or one
// module); there is no Admin step (20261124150000): the branch Admin's Note /
// Object is refused and the Admin sees their own branch only; HR undoes an
// applied action with a reason (refused when the module has no undo).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, writeRemark } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const setPaused = (value) => db().from("system_config").update({ value }).eq("section", "automation").eq("key", "paused");

test("automation: pause / resume (all and one module), Admin Note and Object refused (own branch only), HR Undo refused without a module undo", async ({ page, monitor }) => {
  // Only the refusals this spec provokes: Admin undo / foreign branch (403), Note / Object and Undo without a module undo (409).
  monitor.allow(/^40[39] PATCH \/api\/automation/, /status of 40[39]/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const TAG = `E2E automation ${Date.now()}`;
  await setPaused("false");
  const log = async (kind, summary) => {
    const { data, error } = await db().rpc("automation_log", { p_module: "spec_test", p_rule: "an E2E rule", p_kind: kind, p_summary: summary, p_data: { tag: TAG }, p_employee: ana.id, p_branch: ana.branch_id });
    expect(error, "automation_log").toBeNull();
    return data;
  };
  const proposed = await log("proposal", `${TAG} proposed`);
  const applied = await log("applied", `${TAG} applied`);

  try {
    await step(page, "HR > Settings > Automation: Pause all, then Resume all (audited)", async () => {
      monitor.at("HR > Automation");
      await as(page, "hr", "hr-automation");
      await settle(page);
      const card = main(page).getByTestId("automation-settings");
      await expect(card).toBeVisible();
      await card.getByTestId("automation-pause").click();
      await expect(card.getByTestId("automation-paused")).toBeVisible();
      expect((await rows(db().from("system_config").select("value").eq("section", "automation").eq("key", "paused").single())).value).toBe("true");
      await card.getByTestId("automation-pause").click();
      await expect(card.getByTestId("automation-paused")).toHaveCount(0);
      const audited = await rows(db().from("audit_logs").select("action").in("action", ["automation_pause", "automation_resume"]).order("created_at", { ascending: false }).limit(2));
      expect(audited.map((a) => a.action).sort()).toEqual(["automation_pause", "automation_resume"]);
    });

    await step(page, "HR > switch one module off, then on again", async () => {
      const card = main(page).getByTestId("automation-settings");
      const sw = card.getByTestId("automation-modules").getByRole("switch", { name: "Attendance flags" });
      await expect(sw).toHaveAttribute("aria-checked", "true");
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "false");
      expect((await rows(db().from("system_config").select("value").eq("section", "automation").eq("key", "paused_attendance_flags").single())).value).toBe("true");
      await expect(card.getByTestId("automation-paused"), "only that module").toHaveCount(0);
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "true");
    });

    await step(page, "Admin: Note and Object are refused (no Admin step); undo refused; another branch's item is neither listed nor touched", async () => {
      monitor.at("Admin > Automation API");
      await as(page, "admin", "adm-dashboard");
      for (const action of ["note", "object"]) {
        const res = await api(page, "PATCH", "/api/automation", { id: proposed, action, note: "Checked the taps", remark: { code: "object.automation.wrong_data" } });
        expect(res.status, action).toBe(409);
        expect(res.data.error).toMatch(/straight to HR/);
      }
      const after = await rows(db().from("automation_actions").select("status,admin_note,admin_objected").eq("id", proposed).single());
      expect(after).toMatchObject({ status: "with_hr", admin_objected: false });
      expect(after.admin_note || null).toBeNull();
      expect((await api(page, "PATCH", "/api/automation", { id: applied, action: "undo", remark: { code: "revoke.automation.in_error" } })).status).toBe(403);
      const north = await rows(db().from("branches").select("id").neq("id", ana.branch_id).limit(1));
      const { data: foreignId } = await db().rpc("automation_log", { p_module: "spec_test", p_rule: "an E2E rule", p_kind: "proposal", p_summary: `${TAG} other branch`, p_data: {}, p_employee: null, p_branch: north[0].id });
      // Refused either way (no Admin step, and not their branch); nothing changes on it.
      expect([403, 409]).toContain((await api(page, "PATCH", "/api/automation", { id: foreignId, action: "note", note: "not mine" })).status);
      expect(await rows(db().from("automation_actions").select("status,admin_note").eq("id", foreignId).single())).toEqual({ status: "with_hr", admin_note: null });
      const list = await api(page, "GET", "/api/automation");
      expect(list.data.actions.some((a) => a.summary === `${TAG} other branch`)).toBe(false);
      expect(list.data.actions.some((a) => a.summary === `${TAG} proposed`), "own branch listed").toBe(true);
    });

    await step(page, "HR > Activity log: the item went straight to HR; Undo without a module undo is refused and nothing changes", async () => {
      await as(page, "hr", "hr-automation");
      await settle(page);
      const card = main(page).getByTestId("automation-settings");
      await card.getByRole("searchbox").first().fill(TAG);
      await expect(card.getByRole("row").filter({ hasText: `${TAG} proposed` })).toContainText("by System, rule: an E2E rule");
      const done = card.getByRole("row").filter({ hasText: `${TAG} applied` });
      await done.getByRole("button", { name: "Undo" }).click();
      await writeRemark(page, "automation-undo", "", { preset: "Applied in error" });
      await page.getByRole("dialog").getByRole("button", { name: "Undo" }).click();
      await expect(page.getByText("can't be undone here").first()).toBeVisible();
      expect((await rows(db().from("automation_actions").select("status").eq("id", applied).single())).status).toBe("done");
    });
  } finally {
    await setPaused("false"); // the default: automation on (user decision 2026-11-23)
  }
});
