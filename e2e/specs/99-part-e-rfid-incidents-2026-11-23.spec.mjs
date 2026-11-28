// Part E steps 7-8 (2026-11-23, changed 2026-11-28): lost / broken cards are no
// longer reported on the issue form (Admin uses RFID Cards: Lost / Replace);
// incident and RFID reports are tracked for HR and closed when HR resolves them.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const tracked = (requestId) => rows(db().from("automation_actions").select("id,status,summary").eq("module", "incident_tracking").eq("entity_type", "branch_request").eq("entity_id", requestId));

test("lost/broken-card reports go to RFID Cards; reports tracked until HR resolves them", async ({ page, monitor }) => {
  monitor.at("Part E steps 7-8 (RFID / incidents)");
  await db().from("system_config").update({ value: "false" }).eq("section", "automation").in("key", ["paused", "paused_rfid_issues", "paused_incident_tracking"]);
  const emp = await profileByEmail(ACCOUNTS.employee3.email);
  const [card] = await rows(db().from("rfid_cards").select("id,status").eq("employee_id", emp.id).eq("status", "active"));
  expect(card, "Carlo has an active card (seed)").toBeTruthy();

  let rfidRequest;
  let incidentRequest;
  await step(page, "Admin's form offers only Reader not working / Other; a lost or broken card report is refused (use RFID Cards)", async () => {
    await as(page, "admin2", "adm-rfid-issues");
    await page.getByRole("button", { name: "Report an issue" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").first().click();
    await expect(page.getByRole("option", { name: "Reader not working" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Other" })).toBeVisible();
    await expect(page.getByRole("option", { name: /Lost card|Broken card/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    for (const issue_type of ["lost_card", "broken_card"]) {
      const res = await api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "rfid_issue", employee_id: emp.id, details: { issue_type }, note: "E2E: lost on the jeepney" });
      expect(res.status, JSON.stringify(res.data)).toBe(400);
      expect(JSON.stringify(res.data)).toMatch(/RFID Cards/);
    }
    expect((await rows(db().from("rfid_cards").select("status").eq("id", card.id).single())).status).toBe("active");
    const res = await api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "rfid_issue", details: { issue_type: "reader_fault", device: "Main gate reader" }, note: "E2E: reader light is off" });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    rfidRequest = res.data.request.id;
    expect(await tracked(rfidRequest)).toMatchObject([{ status: "open" }]);
  });

  await step(page, "Admin files an incident: tracked for HR", async () => {
    const res = await api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "incident_report", employee_id: emp.id, details: { incident_type: "misconduct", incident_date: manilaDay(-1) }, note: "E2E: argued with a parent" });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    incidentRequest = res.data.request.id;
    expect(await tracked(incidentRequest)).toMatchObject([{ status: "open", summary: expect.stringMatching(/^Incident report, .*Misconduct/) }]);
  });

  await step(page, "HR resolves both: the tracked items close", async () => {
    await as(page, "hr", "hr-branch-requests");
    for (const id of [rfidRequest, incidentRequest]) {
      const res = await api(page, "PATCH", "/api/hr/branch-requests", { id, decision: "resolve", note: "E2E: handled with the employee" });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect(await tracked(id)).toMatchObject([{ status: "closed" }]);
    }
  });
});
