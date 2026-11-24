// Follow-up release 2026-11-24: the AWOL reply (My Notices, HR "Record reply", HR's decision back to the employee),
// leave credits as one pool, Maintenance as a position.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64");

test.describe.configure({ mode: "serial" });

/** An AWOL case for Bea with the 1st notice sent (as the nightly job leaves it). */
async function plantCase() {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  psql(`set session_replication_role = replica; delete from awol_replies where employee_id = '${bea.id}'; delete from awol_notices where employee_id = '${bea.id}';
    delete from employee_awol_cases where employee_id = '${bea.id}';`);
  const first = manilaDay(-7);
  const replyBy = manilaDay(3);
  const [c] = await rows(db().from("employee_awol_cases").insert({ employee_id: bea.id, branch_id: bea.branch_id, first_absent_on: first, stage: "first_notice", auto_flagged: true,
    automation: "auto", confirmed_at: new Date().toISOString(), confirmed_by_name: "System", first_notice_sent_on: manilaDay(-2), first_notice_reply_by: replyBy }).select("id"));
  const sent = await db().rpc("awol_send_notice", { p_case: c.id, p_kind: "first", p_today: manilaDay(-2), p_reply_by: replyBy, p_separation: null });
  expect(sent.error).toBeNull();
  return { bea, caseId: c.id, replyBy };
}

test("AWOL reply: the employee replies from My Notices; the automation stops; HR records an offline reply, closes; the employee sees the decision", async ({ page, monitor }) => {
  monitor.at("Employee > My Notices");
  const { bea, caseId } = await plantCase();

  await step(page, "Employee > Dashboard: the notice banner links to My Notices", async () => {
    await as(page, "employee2", "emp-dash");
    await settle(page);
    const banner = main(page).getByTestId("awol-banner");
    await expect(banner).toContainText("You have an attendance notice.");
    await banner.getByRole("button", { name: "Open My Notices" }).click();
    await expect(main(page).getByTestId("my-notices")).toBeVisible();
  });

  await step(page, "Employee > My Notices > Reply (reason, explanation, attachment): received; the automation stops", async () => {
    const form = main(page).getByTestId("awol-reply-form");
    await form.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Illness / medical" }).click();
    await form.locator("textarea").fill("I was confined at the hospital; the medical certificate is attached.");
    await form.locator('input[type="file"]').setInputFiles({ name: "medical-certificate.pdf", mimeType: "application/pdf", buffer: Buffer.from(PDF, "base64") });
    await form.getByRole("button", { name: "Send reply" }).click();
    await expect(main(page).getByTestId("reply-received")).toContainText("Your reply was received on");
    const [c] = await rows(db().from("employee_awol_cases").select("automation,automation_reason,employee_reply").eq("id", caseId));
    expect(c).toMatchObject({ automation: "response", automation_reason: expect.stringMatching(/Response received/) });
    const [r] = await rows(db().from("awol_replies").select("kind,reason_code,attachments").eq("case_id", caseId));
    expect(r).toMatchObject({ kind: "reply", reason_code: "illness" });
    expect(r.attachments).toHaveLength(1);
    // A reply is never edited: a second reply is refused; a follow-up is allowed.
    const again = await api(page, "POST", "/api/me/awol-notices", { case_id: caseId, kind: "reply", reason_code: "other", explanation: "Second reply attempt here" });
    expect(again.status).toBe(409);
    const follow = await api(page, "POST", "/api/me/awol-notices", { case_id: caseId, kind: "follow_up", explanation: "I can report back on Monday." });
    expect(follow.status).toBe(201);
  });

  await step(page, "HR > AWOL cases: the reply and its attachment; Record reply (offline); Close with a preset remark", async () => {
    await as(page, "hr", "hr-awol");
    await settle(page);
    // 2026-11-26: the replies and their files are in the case's details drawer.
    const row = main(page).getByRole("row").filter({ hasText: bea.full_name });
    await row.getByRole("button", { name: bea.full_name }).click();
    const drawer = page.getByTestId("awol-drawer");
    await expect(drawer.getByTestId("awol-replies")).toContainText("I was confined at the hospital");
    await expect(drawer.getByRole("button", { name: "medical-certificate.pdf" })).toBeVisible();
    await page.keyboard.press("Escape");
    const recorded = await api(page, "PATCH", "/api/hr/awol-cases", { case_id: caseId, action: "record_reply", employee_reply: "Called the office; confirmed the confinement.", received_how: "phone", received_on: manilaDay(0),
      attachments: [{ name: "call-notes.pdf", type: "application/pdf", data: PDF }] });
    expect(recorded.status, JSON.stringify(recorded.data)).toBe(200);
    expect((await rows(db().from("awol_replies").select("kind").eq("case_id", caseId))).map((x) => x.kind).sort()).toEqual(["follow_up", "hr_record", "reply"]);
    const closed = await api(page, "PATCH", "/api/hr/awol-cases", { case_id: caseId, action: "close", outcome: "false_alarm", remark: { code: "other", extra: "Excused: hospital confinement with certificate" } });
    expect(closed.status, JSON.stringify(closed.data)).toBe(200);
  });

  await step(page, "Employee > My Notices: HR's decision; the employee was notified", async () => {
    expect((await rows(db().from("notifications").select("kind").eq("recipient_id", bea.id).eq("kind", "awol_decision"))).length).toBeGreaterThan(0);
    await as(page, "employee2", "emp-notices");
    await settle(page);
    await expect(main(page).getByTestId("my-notice").first()).toContainText("HR's decision");
    // Only the employee, HR and the Super Admin open the attachments: an Admin cannot.
    const [r] = await rows(db().from("awol_replies").select("attachments").eq("case_id", caseId).eq("kind", "reply"));
    await as(page, "admin", "adm-dashboard");
    const res = await api(page, "GET", `/api/hr/awol-cases/notice?reply_file=${encodeURIComponent(r.attachments[0].path)}`);
    expect(res.status).toBe(403);
  });
});

test("leave credits: one pool on My Requests; Maintenance is a position (no Group field)", async ({ page, monitor }) => {
  monitor.at("Employee > My Requests > Leave credits");
  await step(page, "Employee > My Requests: 'Leave credits: X of 5 days used · Y days left'; no per-type bars", async () => {
    await as(page, "employee", "emp-leave");
    await settle(page);
    const credits = main(page).getByTestId("leave-credits");
    await expect(credits).toContainText("Leave credits");
    await expect(credits).toContainText(/of 5 days used · \d+(\.\d)? days? left/);
    await expect(main(page).getByText("With pay remaining")).toHaveCount(0);
  });
  await step(page, "HR: 'Maintenance' is a position; the employee form has no Group field", async () => {
    await as(page, "hr", "hr-employees");
    const positions = await api(page, "GET", "/api/hr/positions");
    expect(JSON.stringify(positions.data)).toContain("Maintenance");
    await settle(page);
    await main(page).getByRole("button", { name: /Add employee|New employee/ }).first().click();
    await expect(page.getByRole("dialog").getByText("Group", { exact: true })).toHaveCount(0);
  });
});
