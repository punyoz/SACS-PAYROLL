// Release 4 (2026-11-26, the owner's full-system check): profile sections for every on-payroll role,
// bereavement / maternity on the leave form (with the pool each uses), HR's bulk decisions on every
// approval tab, the branch Admin's one message about several items, one heading on Incidents & RFID.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, manilaDay, newRequest, pickDate, writeRemark } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const PROFILE = { employee: "emp-profile", hr: "hr-profile", accountant: "ac-profile", admin: "adm-profile", super_admin: "sa-profile" };

test("profile: Employment and Government contributions for every on-payroll role; none for Admin and Super Admin", async ({ page }) => {
  for (const role of ["employee", "hr", "accountant", "admin", "super_admin"]) {
    await step(page, `${role} > Profile`, async () => {
      await as(page, role, PROFILE[role]);
      await settle(page);
      const onPayroll = ["employee", "hr", "accountant"].includes(role);
      if (onPayroll) {
        const me = await profileByEmail(ACCOUNTS[role].email);
        await expect(main(page).getByTestId("profile-employment")).toBeVisible();
        await expect(main(page).getByTestId("profile-government")).toBeVisible();
        for (const label of ["Employee ID", "Category", "Employment status", "Position", "Branch", "Date hired"]) {
          await expect(main(page).getByTestId("profile-employment").getByText(label, { exact: true })).toBeVisible();
        }
        if (me.employee_id) await expect(main(page).getByTestId("profile-employment")).toContainText(me.employee_id);
        for (const label of ["SSS number", "PhilHealth number", "Pag-IBIG number", "TIN"]) {
          await expect(main(page).getByTestId("profile-government").getByText(label, { exact: true })).toBeVisible();
        }
      } else {
        await page.waitForTimeout(1500); // the stored profile has loaded
        await expect(main(page).getByTestId("profile-employment")).toHaveCount(0);
        await expect(main(page).getByTestId("profile-government")).toHaveCount(0);
      }
    });
  }
});

test("leave types: bereavement (relationship, date of death, its own pool) to HR; maternity when on file; HR bulk on every approval tab; the Admin messages HR about several items", async ({ page, monitor }) => {
  monitor.allow(/^400 POST \/api\/me\/leave-requests/, /status of 400/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const reason = `E2E bereavement ${Date.now()}`;
  const died = manilaDay(-1);
  const start = manilaDay(1);
  const end = manilaDay(2);
  let leaveId;

  await step(page, "Employee > New request > Leave: the pool each type uses; Bereavement asks relationship and date of death, not 7 days ahead", async () => {
    await as(page, "employee", "emp-leave");
    const form = await newRequest(page, "leave");
    await choose(page, form.getByRole("combobox").first(), "Vacation Leave");
    await expect(form.getByTestId("leave-pool")).toHaveText("Uses your leave credits (one yearly total for vacation, sick and emergency leave).");
    await choose(page, form.getByRole("combobox").first(), "Bereavement Leave");
    await expect(form.getByTestId("leave-pool")).toContainText("School policy: up to 3 days each time. Not from your leave credits.");
    await choose(page, form.getByRole("combobox", { name: "Relationship" }), "Parent");
    await pickDate(page, form.locator("#leave-event-date"), died);
    await pickDate(page, form.getByLabel("Start date"), start);
    await pickDate(page, form.getByLabel("End date"), end);
    await form.getByPlaceholder("State the reason for your leave request").fill(reason);
    await form.getByRole("button", { name: /Submit/ }).click();
    await settle(page);
    const [saved] = await rows(db().from("leave_requests").select("id,leave_type,event_relationship,event_date,status").eq("employee_id", ana.id).eq("reason", reason));
    expect(saved).toMatchObject({ leave_type: "Bereavement Leave", event_relationship: "parent", event_date: died, status: "pending_admin" });
    leaveId = saved.id;
    // The server checks the details too.
    const noRel = await api(page, "POST", "/api/me/leave-requests", { leave_type: "Bereavement Leave", pay_status: "with_pay", start_date: start, end_date: start, reason: "E2E no relationship", event_date: died });
    expect(noRel.status).toBe(400);
    expect(noRel.data.code).toBe("bereavement_details");
    const tooLong = await api(page, "POST", "/api/me/leave-requests", { leave_type: "Bereavement Leave", pay_status: "with_pay", start_date: start, end_date: manilaDay(6), reason: "E2E too long", event_relationship: "sibling", event_date: died });
    expect(tooLong.status).toBe(400);
    expect(tooLong.data.error).toBe("Bereavement Leave is at most 3 days.");
  });

  await step(page, "Employee: Maternity Leave is offered once her sex is on file (statutory, its days)", async () => {
    const before = (await db().auth.admin.getUserById(ana.id)).data.user.user_metadata;
    await db().auth.admin.updateUserById(ana.id, { user_metadata: { ...before, sex: "Female", civil_status: before.civil_status || "Single" } });
    try {
      await as(page, "employee", "emp-leave");
      const form = await newRequest(page, "leave");
      await choose(page, form.getByRole("combobox").first(), "Maternity Leave");
      await expect(form.getByTestId("leave-pool")).toContainText("Statutory: up to 105 days each time. Not from your leave credits.");
      await page.keyboard.press("Escape");
    } finally {
      await db().auth.admin.updateUserById(ana.id, { user_metadata: before });
    }
  });

  await step(page, "Admin > Branch Review: select items (select all) and send ONE message to HR; it is in each item's thread", async () => {
    await as(page, "admin", "adm-leaves");
    await settle(page);
    await main(page).getByRole("tab", { name: "All" }).click();
    await main(page).getByRole("searchbox").first().fill(reason);
    await expect(main(page).getByRole("checkbox", { name: "Select all on this page" })).toBeVisible();
    await main(page).getByRole("checkbox", { name: "Select all on this page" }).check();
    await main(page).getByTestId("message-selected").click();
    const dialog = page.getByTestId("message-selected-dialog");
    await expect(dialog).toContainText("Information only: it does not decide or endorse anything.");
    await dialog.locator("#message-selected-text").fill("E2E: the family called; please check these");
    await dialog.getByRole("button", { name: "Send to HR" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    const msgs = await rows(db().from("branch_item_messages").select("item_type,item_id,author_role,body").eq("item_id", leaveId));
    expect(msgs).toEqual([expect.objectContaining({ item_type: "leave_request", author_role: "admin", body: "E2E: the family called; please check these" })]);
    // Information only: the leave is still waiting for HR.
    expect((await rows(db().from("leave_requests").select("status").eq("id", leaveId).single())).status).toBe("pending_admin");
    // Every Branch Review tab can select items.
    for (const tab of ["adm-overtime", "adm-transfers", "adm-incentives", "adm-schedules"]) {
      await as(page, "admin", tab);
      await settle(page);
      const dataRows = await main(page).locator("tbody tr").filter({ hasNot: page.getByText(/^No /) }).count();
      if (dataRows) await expect(main(page).getByRole("checkbox", { name: "Select all on this page" }).first(), tab).toBeVisible();
    }
    // HR only via the Admin: HR cannot send one message about several items.
    await as(page, "hr", "hr-leaves");
    expect((await api(page, "POST", "/api/branch-messages", { items: [{ item_type: "leave_request", item_id: leaveId }], body: "x" })).status).toBe(403);
  });

  await step(page, "HR > Leave: the bereavement details; select all and bulk Approve with one preset remark", async () => {
    await as(page, "hr", "hr-leaves");
    await settle(page);
    const card = main(page).locator("li", { hasText: reason });
    await expect(card.getByTestId("bereavement-details")).toHaveText(new RegExp(`^Bereavement: Parent, died `));
    await expect(main(page).getByRole("checkbox", { name: "Select all shown" })).toBeVisible();
    await card.getByRole("checkbox").check();
    await main(page).getByTestId("bulk-bar").getByRole("button", { name: "Approve selected" }).click();
    await writeRemark(page, "bulk-remark", "", { preset: "Approved as requested" });
    await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(async () => (await rows(db().from("leave_requests").select("status").eq("id", leaveId).single())).status).toBe("approved");
    // Per event: no split against the credits pool.
    expect(await rows(db().from("leave_requests").select("id").eq("split_from", leaveId))).toHaveLength(0);
  });

  await step(page, "HR > every approval tab where HR decides has select all + bulk Approve / Reject", async () => {
    for (const [pageId, testid] of [["hr-leaves", "hr-overtime-requests"], ["hr-leaves", "substitutions"], ["hr-transfers", null], ["hr-branch-requests", null], ["hr-adjustment-approvals", null], ["hr-subsidy-approvals", null]]) {
      await as(page, "hr", pageId);
      await settle(page);
      const scope = testid ? main(page).getByTestId(testid) : main(page);
      const dataRows = await scope.locator("tbody tr").filter({ hasNot: page.getByText(/^No /) }).count();
      if (!dataRows) continue;
      await expect(scope.getByRole("checkbox", { name: "Select all on this page" }).first(), `${pageId} ${testid || ""}`).toBeVisible();
    }
  });
});

test("Admin > Incidents & RFID: one heading and one description per section", async ({ page }) => {
  await as(page, "admin", "adm-incidents");
  await settle(page);
  await expect(main(page).locator('[data-slot="card-title"]').filter({ hasText: "Incident & AWOL reports" })).toHaveCount(0);
  await expect(main(page).getByText("Report incidents and no-shows. They go to HR's AWOL Cases; HR handles them.")).toHaveCount(0);
  await expect(main(page).getByText(/A no-show goes straight to HR's AWOL Cases queue/)).toHaveCount(1);
  await as(page, "admin", "adm-maintenance");
  await settle(page);
  await expect(main(page).getByText("Your branch's RFID cards, the RFID Terminal, the RFID issues you report, and the card history.")).toHaveCount(1);
});

test("HR > AWOL cases: Stop automation (with a reason) puts the case in HR's hands, Resume gives it back", async ({ page, monitor }) => {
  monitor.at("HR > AWOL Cases (stop / resume)");
  const carlo = await profileByEmail(ACCOUNTS.employee3.email);
  psql(`set session_replication_role = replica; update employee_awol_cases set stage = 'closed', outcome = coalesce(outcome, 'false_alarm') where employee_id = '${carlo.id}' and stage <> 'closed';`);
  const [kase] = await rows(db().from("employee_awol_cases").insert({
    employee_id: carlo.id, branch_id: carlo.branch_id, first_absent_on: manilaDay(-6), stage: "flagged", auto_flagged: true,
    notes: "E2E: opened by System for the stop / resume check.",
  }).select("id"));
  try {
    await as(page, "hr", "hr-awol");
    await settle(page);
    let row = main(page).locator("tr", { hasText: carlo.full_name }).filter({ hasNot: page.getByRole("checkbox") }).first();
    await expect(row.getByTestId("awol-automation")).toContainText("Automatic");
    await row.getByRole("button", { name: `More for ${carlo.full_name}` }).click();
    await page.getByRole("menuitem", { name: "Stop automation" }).click();
    await writeRemark(page, "awol-stop", "E2E: HR handles this one by hand");
    await page.getByRole("dialog").getByRole("button", { name: "Stop automation" }).click();
    await expect.poll(async () => (await rows(db().from("employee_awol_cases").select("automation").eq("id", kase.id).single())).automation).toBe("stopped");
    row = main(page).locator("tr", { hasText: carlo.full_name }).filter({ hasNot: page.getByRole("checkbox") }).first();
    await expect(row.getByTestId("awol-proceed")).toBeVisible();
    await row.getByRole("button", { name: `More for ${carlo.full_name}` }).click();
    await expect(page.getByRole("menuitem", { name: "Stop automation" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Resume automation" }).click();
    await expect.poll(async () => (await rows(db().from("employee_awol_cases").select("automation").eq("id", kase.id).single())).automation).toBe("auto");
  } finally {
    psql(`set session_replication_role = replica; update employee_awol_cases set stage = 'closed', outcome = 'false_alarm' where id = '${kase.id}';`);
  }
});
