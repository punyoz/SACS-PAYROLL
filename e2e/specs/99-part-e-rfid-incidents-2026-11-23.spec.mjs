// Part E steps 7-8 (2026-11-23): a card the branch Admin reports lost is
// blocked at once (logged "by System", HR can reactivate it); incident and RFID
// reports are tracked as open items for HR and closed when HR resolves them.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const tracked = (requestId) => rows(db().from("automation_actions").select("id,status,summary").eq("module", "incident_tracking").eq("entity_type", "branch_request").eq("entity_id", requestId));

test("lost-card report blocks the card; reports tracked until HR resolves them", async ({ page, monitor }) => {
  monitor.at("Part E steps 7-8 (RFID / incidents)");
  await db().from("system_config").update({ value: "false" }).eq("section", "automation").in("key", ["paused", "paused_rfid_issues", "paused_incident_tracking"]);
  const emp = await profileByEmail(ACCOUNTS.employee3.email);
  const [card] = await rows(db().from("rfid_cards").select("id,status").eq("employee_id", emp.id).eq("status", "active"));
  expect(card, "Carlo has an active card (seed)").toBeTruthy();

  let rfidRequest;
  let incidentRequest;
  await step(page, "Admin reports the card lost: blocked at once, logged by System, tracked for HR", async () => {
    await as(page, "admin2", "adm-rfid-issues");
    const res = await api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "rfid_issue", employee_id: emp.id, details: { issue_type: "lost_card" }, note: "E2E: lost on the jeepney" });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.cards_blocked).toBe(1);
    rfidRequest = res.data.request.id;
    expect((await rows(db().from("rfid_cards").select("status").eq("id", card.id).single())).status).toBe("inactive");
    const [log] = await rows(db().from("automation_actions").select("status,kind").eq("module", "rfid_issues").eq("entity_type", "rfid_card").eq("entity_id", card.id).order("created_at", { ascending: false }).limit(1));
    expect(log).toMatchObject({ status: "done", kind: "applied" });
    expect(await tracked(rfidRequest)).toMatchObject([{ status: "open" }]);
  });

  await step(page, "Admin files an incident: tracked for HR", async () => {
    const res = await api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "incident_report", employee_id: emp.id, details: { incident_type: "misconduct", incident_date: manilaDay(-1) }, note: "E2E: argued with a parent" });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    incidentRequest = res.data.request.id;
    expect(await tracked(incidentRequest)).toMatchObject([{ status: "open", summary: expect.stringMatching(/^Incident report, .*Misconduct/) }]);
  });

  await step(page, "HR resolves both: the tracked items close; HR reactivates the card (the undo)", async () => {
    await as(page, "hr", "hr-branch-requests");
    for (const id of [rfidRequest, incidentRequest]) {
      const res = await api(page, "PATCH", "/api/hr/branch-requests", { id, decision: "resolve", note: "E2E: handled with the employee" });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect(await tracked(id)).toMatchObject([{ status: "closed" }]);
    }
    const back = await api(page, "PATCH", "/api/rfid/cards", { action: "reactivate", card_id: card.id, reason: "E2E: the card was found" });
    expect(back.status, JSON.stringify(back.data)).toBe(200);
    expect((await rows(db().from("rfid_cards").select("status").eq("id", card.id).single())).status).toBe("active");
  });
});
