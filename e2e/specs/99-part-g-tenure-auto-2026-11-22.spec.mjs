// Part G (2026-11-22): HR's Tenure Pay Protection tabs (Eligible, Granted,
// Revoked, Upcoming 60 days); bulk Grant and bulk Revoke (a preset reason is
// required); HR re-grants a revoked one. The daily job itself is checked in
// scripts/checks/tenure-auto-grant-scenarios.sql.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, writeRemark } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

test("tenure: tabs, bulk grant, bulk revoke with a required preset, HR re-grant", async ({ page, monitor }) => {
  monitor.allow(/^400 POST \/api\/hr\/tenure-protection/, /status of 400/);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const before = { date_hired: bea.date_hired, employment_status: bea.employment_status };
  const policies = await rows(db().from("tenure_protection_policies").select("id,is_active,min_tenure_years").is("branch_id", null));
  await db().from("tenure_protection_grants").delete().eq("employee_id", bea.id);
  await db().from("profiles").update({ date_hired: "2020-01-06", employment_status: "Regular" }).eq("id", bea.id);
  await db().from("tenure_protection_policies").update({ is_active: true, min_tenure_years: 2 }).is("branch_id", null);

  try {
    await as(page, "hr", "hr-tenure");
    await settle(page);

    await step(page, "HR > Tenure > the five tabs; Bea (6 years, Regular) is listed", async () => {
      for (const t of [/^Eligible/, /^Benefit granted/, /^Revoked/, /^Upcoming \(60 days\)/, /^All employees/]) {
        await expect(main(page).getByRole("tab", { name: t })).toBeVisible();
      }
      await expect(main(page).locator("tr", { hasText: bea.full_name })).toBeVisible();
    });

    await step(page, "Grant selected: Bea is protected", async () => {
      await main(page).getByRole("checkbox", { name: `Select ${bea.full_name}` }).check();
      await main(page).getByTestId("bulk-bar").getByRole("button", { name: "Grant selected" }).click();
      const dialog = page.getByTestId("bulk-dialog");
      await dialog.getByRole("button", { name: "Grant (1)" }).click();
      await expect(dialog.getByTestId("bulk-summary")).toContainText("1 done");
      await dialog.getByRole("button", { name: "Done" }).click();
      expect(await rows(db().from("tenure_protection_grants").select("id").eq("employee_id", bea.id).is("revoked_on", null))).toHaveLength(1);
    });

    await step(page, "Revoke selected: no reason refused; a preset revokes; Bea is on the Revoked tab", async () => {
      await main(page).getByRole("tab", { name: /^Benefit granted/ }).click();
      await main(page).getByRole("checkbox", { name: `Select ${bea.full_name}` }).check();
      await main(page).getByTestId("bulk-bar").getByRole("button", { name: "Revoke selected" }).click();
      const dialog = page.getByTestId("bulk-dialog");
      await dialog.getByRole("button", { name: "Revoke (1)" }).click();
      await expect(dialog.getByRole("alert").filter({ hasText: "Choose a remark (a reason is required)." })).toBeVisible();
      await writeRemark(page, "bulk-remark", "", { preset: "Granted in error" });
      await dialog.getByRole("button", { name: "Revoke (1)" }).click();
      await expect(dialog.getByTestId("bulk-summary")).toContainText("1 done");
      await dialog.getByRole("button", { name: "Done" }).click();
      const [g] = await rows(db().from("tenure_protection_grants").select("revoked_on,revoked_by_role,revoke_notes").eq("employee_id", bea.id));
      expect(g.revoked_on).toBeTruthy();
      expect(g.revoked_by_role).toBe("hr");
      expect(g.revoke_notes).toContain("Granted in error");
      await main(page).getByRole("tab", { name: /^Revoked/ }).click();
      await expect(main(page).locator("tr", { hasText: bea.full_name })).toBeVisible();
    });

    await step(page, "Revoked stays revoked for the job; HR re-grants it by hand", async () => {
      const { data: cand } = await db().rpc("tenure_auto_grant_candidates");
      expect((cand || []).map((c) => c.employee_id)).not.toContain(bea.id);
      const res = await api(page, "POST", "/api/hr/tenure-protection", { action: "grant", employee_id: bea.id, effective_from: new Date().toISOString().slice(0, 10), notes: "HR re-grant" });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect(await rows(db().from("tenure_protection_grants").select("id").eq("employee_id", bea.id).is("revoked_on", null))).toHaveLength(1);
    });
  } finally {
    await db().from("tenure_protection_grants").delete().eq("employee_id", bea.id);
    await db().from("profiles").update(before).eq("id", bea.id);
    for (const p of policies) await db().from("tenure_protection_policies").update({ is_active: p.is_active, min_tenure_years: p.min_tenure_years }).eq("id", p.id);
  }
});
