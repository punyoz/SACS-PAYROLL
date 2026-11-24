// Payroll approval flow (decisions 2026-11-15), local stack only: the run
// card's Included / Drafts / Left out groups and the payslips outside the
// branch's active list, every reason a disabled Submit gives (the Action needed panel was removed
// 2026-11-16), the left-out list, the batch table's statuses, filters and
// counts (the same as the run card's), and the expanded blocked banner.
// Seeds its own November 1-15 case in Main Campus with its own five people
// (flow-*@e2e.test), so it runs alone or after any other spec, and removes
// them afterwards.
//
//   E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test e2e/specs/99-approval-flow-2026-11-15.spec.mjs --project=desktop
//   E2E_BEFORE=1 …   screenshots only (for the code before these changes)
// Screenshots: screenshots/2026-11-15-approval-flow/{before,after}/.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as, loginThroughUi, signOutLocally } from "../support/auth.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, confirm, writeRemark } from "../support/flow.mjs";
import { db, psql, retireAccountsCreatedSince, rows } from "../support/db.mjs";
// Accounts this spec makes are retired after it (e2e/support/db.mjs). Taken when
// the spec starts (after the seed), on the real clock.
let SPEC_START = null;
test.beforeAll(() => { SPEC_START = new Date(Date.now()).toISOString(); });
test.afterAll(async () => { await retireAccountsCreatedSince(SPEC_START); });

import { ACCOUNTS, BRANCH_MAIN } from "../accounts.mjs";

const BEFORE = process.env.E2E_BEFORE === "1";
const OUT = join(process.cwd(), "screenshots", "2026-11-15-approval-flow", BEFORE ? "before" : "after");
mkdirSync(OUT, { recursive: true });
const PERIOD = "November 1-15, 2026";
const shot = (locator, name) => locator.screenshot({ path: join(OUT, `${name}.png`) });
const peso = (text) => Number(String(text).replace(/[^\d.]/g, ""));
const payroll = (gross, deductions) => ({
  basic_salary: gross,
  totals: { gross_pay: gross, total_incentives: 0, total_deductions: deductions, net_pay: gross - deductions },
  audit: { attendance: { counts: { attended_days: 10 } } },
});

test.use({ viewport: { width: 1366, height: 900 } });

/** The spec's own people (flow-*@e2e.test) and everything of theirs (the auth rows with their cascades on). */
function removeFlowPeople() {
  psql(`set session_replication_role = replica;
    create temp table flow_ids as select id from auth.users where email like 'flow-%@e2e.test';
    delete from attendance_logs where employee_id in (select id from flow_ids);
    delete from payroll_entries where employee_id in (select id from flow_ids);
    delete from payroll_run_exclusions where employee_id in (select id from flow_ids);
    delete from notifications where recipient_id in (select id from flow_ids);
    delete from profiles where id in (select id from flow_ids);
    set session_replication_role = origin;
    delete from auth.users where id in (select id from flow_ids);`);
}

test("approval flow: who goes to HR, why a run cannot be submitted, and what is still open", async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  const branch = await rows(db().from("branches").select("id").eq("name", BRANCH_MAIN).single());
  test.skip((await rows(db().from("payroll_runs").select("id").eq("branch_id", branch.id).eq("period_label", PERIOD))).length > 0, "November 1-15 already has a run");
  // Main Campus' own people stay as they are: only this spec's payslips exist for November 1-15.
  const others = await rows(db().from("payroll_entries").select("id").eq("branch_id", branch.id).eq("pay_period", PERIOD));
  test.skip(others.length > 0, "Main Campus already has November 1-15 payslips");

  removeFlowPeople(); // a run stopped half way leaves them behind
  const people = {};
  for (const [key, name, profile] of [
    ["final", "Fay Final", {}],
    ["draft", "Dan Draft", {}],
    ["archived", "Dora Archived", { archived: true }],
    ["held", "Carl Held", { payroll_hold: true, payroll_hold_reason: "AWOL case open" }],
    ["waiting", "Eli Waiting", {}],
  ]) {
    const email = `flow-${key}@e2e.test`;
    const meta = { role: "employee", full_name: name, employee_id: `E2E-FLOW-${key.toUpperCase()}`, employee_type: "Teaching", basic_salary: 30000, branch_id: branch.id, archived: Boolean(profile.archived) };
    const created = await db().auth.admin.createUser({ email, password: "E2e-Flow#2026-x", email_confirm: true, user_metadata: meta });
    expect(created.error).toBeNull();
    const id = created.data.user.id;
    await db().from("profiles").upsert({ id, email, full_name: name, role: "employee", branch_id: branch.id, employee_status: "Active", date_hired: "2024-06-01", archived: false, payroll_hold: false, ...profile });
    people[key] = { id, name };
  }
  // The staff list is cached for 10 s (src/lib/auth/users-cache.js): the Accountant sees the new people after that.
  await new Promise((r) => setTimeout(r, 11000));

  try {
    const inserted = await db().from("payroll_entries").insert([
      { employee_id: people.final.id, employee_name: people.final.name, employee_type: "Teaching", pay_period: PERIOD, status: "paid", payroll: payroll(15000, 1234.56) },
      { employee_id: people.archived.id, employee_name: people.archived.name, employee_type: "Teaching", pay_period: PERIOD, status: "paid", payroll: payroll(5000, 0) },
      { employee_id: people.draft.id, employee_name: people.draft.name, employee_type: "Teaching", pay_period: PERIOD, status: "draft", payroll: payroll(14000, 0) },
    ]);
    expect(inserted.error).toBeNull();
    psql(`set session_replication_role = replica;
      insert into attendance_logs (employee_id, employee_name, log_date, time_in, status, late_minutes, undertime_minutes, created_at)
      values ('${people.waiting.id}', '${people.waiting.name}', '2026-11-10', '2026-11-10T00:00:00Z', 'Incomplete', 0, 0, now());`);

    // ── The Draft filter by address (?batch=draft): the batch table opens filtered ──
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(PERIOD)}&batch=draft`);
    await settle(page);
    if (!BEFORE) {
      const filtered = main(page).getByTestId("batch-card");
      await expect(filtered.getByTestId("batch-count-draft")).toHaveAttribute("aria-pressed", "true");
      await expect(filtered.getByTestId("batch-row")).toHaveCount(1);
      await expect(filtered.getByTestId("batch-row").first()).toContainText("Dan Draft");
    }

    // ── Batch table: the same counts as the run card ──
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(PERIOD)}`);
    await settle(page);
    const batch = main(page).getByTestId("batch-card");
    await batch.scrollIntoViewIfNeeded();
    if (!BEFORE) {
      const server = (await api(page, "GET", `/api/accountant/payroll-runs?period=${encodeURIComponent(PERIOD)}`)).data.runs.find((c) => c.branch_name === BRANCH_MAIN && !c.locked);
      await expect(batch.getByTestId("batch-count-all")).toContainText(String(server.expected_count));
      await expect(batch.getByTestId("batch-count-final")).toContainText(String(server.processed_count));
      await expect(batch.getByTestId("batch-count-draft")).toContainText(String(server.draft_count));
      await expect(batch.getByTestId("batch-count-in_run")).toContainText("0");
      await expect(batch.getByTestId("batch-count-ready")).toContainText("Ready to process");
      await expect(batch.getByTestId("batch-count-final")).toContainText("Processed (Final)");
      await expect(batch.getByTestId("batch-count-off_list")).toBeVisible();
      // The Off list filter shows Carl (on hold); Dora (archived) is not in the batch at all.
      await batch.getByTestId("batch-count-off_list").click();
      await expect(batch.getByTestId("batch-row").filter({ hasText: "Carl Held" })).toHaveCount(1);
      await batch.getByTestId("batch-count-off_list").click();
    }
    await shot(batch, "batch-table");
    const banner = batch.getByTestId("batch-blocked-banner");
    if (await banner.count()) {
      if (!BEFORE) {
        await banner.getByText("Show who, by reason").click();
        await expect(banner.getByTestId("blocked-group-attendance")).toContainText("Eli Waiting");
        await expect(banner.getByTestId("blocked-group-hold")).toContainText("Carl Held");
      }
      await shot(banner, "blocked-banner-expanded");
      if (!BEFORE) {
        // Each name is a link to its row.
        await banner.getByTestId("blocked-group-hold").getByRole("button", { name: "Carl Held" }).click();
        await expect(batch.getByTestId("batch-row")).toHaveCount(1);
        await expect(batch.getByTestId("batch-row").first()).toContainText("Carl Held");
      }
    }

    // ── Run card ──
    const card = main(page).locator(BEFORE ? "div.rounded-lg.border" : "[data-testid=run-card]", { hasText: BRANCH_MAIN }).first();
    await card.scrollIntoViewIfNeeded();
    await shot(card, "run-card");
    if (!BEFORE) {
      const included = card.getByTestId("group-included");
      await expect(included.getByTestId("run-row").filter({ hasText: "Fay Final" })).toHaveCount(1);
      await expect(card.getByTestId("group-outside")).toContainText("Dora Archived");
      await expect(card.getByTestId("group-drafts-count")).toHaveText("(1)");
      const leftOut = card.getByTestId("group-left-out");
      for (const name of ["Dan Draft", "Eli Waiting", "Dora Archived"]) await expect(leftOut).toContainText(name);
      await expect(leftOut).not.toContainText("Carl Held");
      await expect(leftOut.getByTestId("left-out-row").filter({ hasText: "Dan Draft" })).toContainText("Draft");
      await expect(leftOut.getByTestId("left-out-row").filter({ hasText: "Dora Archived" })).toContainText("Not in this branch's active list");
      await expect(card.getByTestId("run-card-counts")).toContainText(/\d+ of \d+ processed · 1 draft · 1 not in active list/);
      // The Included total equals the header's net.
      const header = peso(await card.getByTestId("run-card-net").innerText());
      expect(peso(await card.getByTestId("included-total-net").innerText())).toBe(header);
      // Disabled, with every reason listed.
      await expect(card.getByTestId("submit-run")).toBeDisabled();
      await expect(card.getByTestId("submit-reasons")).toContainText("Confirm the employees left out first");
      // Ticking Dora puts her payslip in; the header and total follow.
      await card.getByTestId("include-outside").click();
      await expect.poll(async () => peso(await card.getByTestId("run-card-net").innerText())).toBeCloseTo(header + 5000, 2);
      expect(peso(await card.getByTestId("included-total-net").innerText())).toBeCloseTo(header + 5000, 2);
      await expect(leftOut).not.toContainText("Dora Archived");
      await card.getByTestId("include-outside").click();
      await card.getByTestId("group-drafts").locator("summary").click();
      await expect(card.getByTestId("group-drafts")).toContainText("Dan Draft");
      // Drafts are finalized from the batch table, not here (decided 2026-11-16, 3dac550): the group explains it.
      await expect(card.getByTestId("group-drafts").getByRole("button", { name: "Finalize" })).toHaveCount(0);
      await expect(card.getByTestId("group-drafts")).toContainText("A Draft is never sent to HR");
      await shot(card, "run-card-groups-open");

      // Confirm and submit: the Draft is left out, never in the run.
      await card.getByLabel("I confirm these employees are intentionally excluded").click();
      await expect(card.getByTestId("submit-run")).toBeEnabled();
      await card.getByTestId("submit-run").click();
      await confirm(page, "Submit for HR Approval");
      const pending = main(page).locator("[data-testid=run-card][data-status=pending]", { hasText: BRANCH_MAIN }).first();
      await expect(pending).toBeVisible();
      await expect(pending.getByTestId("group-included")).toContainText("Sent to HR (Pending HR approval)");
      await expect(pending.getByTestId("run-row").filter({ hasText: "Fay Final" })).toHaveCount(1);
      await expect(pending.getByTestId("run-row").filter({ hasText: "Dora Archived" })).toHaveCount(0);
      await shot(pending, "run-card-pending");
      const run = await rows(db().from("payroll_runs").select("id,total_net").eq("branch_id", branch.id).eq("period_label", PERIOD).single());
      expect(Number(run.total_net)).toBeCloseTo(header, 2);
      const draft = await rows(db().from("payroll_entries").select("status,run_id").eq("employee_id", people.draft.id).eq("pay_period", PERIOD).single());
      expect(draft).toEqual({ status: "draft", run_id: null });
      const notice = await rows(db().from("notifications").select("body").eq("kind", "payroll_run_submitted").eq("run_id", run.id).limit(1).single());
      expect(notice.body).toMatch(/net ₱[\d,]+\.\d{2}/);
      expect(notice.body).toMatch(/\d+ left out: .*Dan Draft/);

      // HR sees who was left out and why.
      await as(page, "hr", "hr-payroll-approval");
      const detail = await api(page, "GET", `/api/hr/payroll-runs?run_id=${run.id}`);
      const why = Object.fromEntries(detail.data.exclusions.map((x) => [x.employee_name, x.left_out_label]));
      expect(why).toMatchObject({ "Dan Draft": "Draft", "Dora Archived": "Not in this branch's active list", "Eli Waiting": "Not processed" });
      await as(page, "accountant", `ac-process&period=${encodeURIComponent(PERIOD)}`);
      await settle(page);
    }

    // ── Employees left out of a payroll run ──
    const list = main(page).locator("[data-slot=card]", { hasText: "Employees left out of a payroll run" }).first();
    await list.scrollIntoViewIfNeeded();
    if (!BEFORE) {
      await expect(list).toContainText("Dan Draft");
      await expect(list.getByTestId("left-out-follow-up").filter({ hasText: "Draft" })).toHaveCount(1);
    }
    await shot(list, "left-out-list");
  } finally {
    psql(`set session_replication_role = replica;
      delete from notifications where run_id in (select id from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}');
      delete from payroll_run_exclusions where run_id in (select id from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}');
      delete from payroll_run_items where run_id in (select id from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}');
      delete from payroll_approval_history where run_id in (select id from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}');
      update payroll_entries set run_id = null where run_id in (select id from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}');
      delete from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}';`);
    removeFlowPeople();
  }
});

// ── Accountant ↔ HR ↔ employee: one run through every hand-off, on the real screens ──
const bell = async (page) => {
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const menu = page.getByTestId("notifications-menu");
  await expect(menu).toBeVisible();
  return menu;
};
const closeBell = (page) => page.keyboard.press("Escape");
const openCard = (page) => main(page).getByTestId("run-card").filter({ hasText: BRANCH_MAIN }).filter({ has: page.getByTestId("submit-run") }).first();
const followUp = async (page, endpoint, name) => {
  const res = await api(page, "GET", endpoint);
  return (res.data?.excluded || []).find((x) => x.employee_name === name && x.period_label === PERIOD)?.follow_up_label || null;
};
async function submitOpenCard(page, confirmLabel) {
  const card = openCard(page);
  await card.scrollIntoViewIfNeeded();
  const ack = card.getByLabel("I confirm these employees are intentionally excluded");
  if (await ack.count()) await ack.check();
  await expect(card.getByTestId("submit-run")).toBeEnabled();
  await card.getByTestId("submit-run").click();
  await confirm(page, confirmLabel);
}
async function hrDecide(page, runNo, decision, remarks) {
  await as(page, "hr", "hr-payroll-approval");
  const back = main(page).getByRole("button", { name: "All runs" });
  if (await back.isVisible().catch(() => false)) { await back.click(); await settle(page); }
  await page.getByRole("tab", { name: /Pending HR approval/ }).click();
  await settle(page);
  await main(page).locator("tr", { hasText: PERIOD }).filter({ hasText: BRANCH_MAIN }).first().getByRole("button", { name: "Review" }).click();
  await settle(page);
  if (runNo > 1) await expect(main(page).getByText(new RegExp(`supplemental|run ${runNo}`, "i")).first()).toBeVisible();
  await main(page).getByRole("button", { name: decision, exact: true }).click();
  if (remarks) await writeRemark(page, "pa-remark", remarks);
  await page.getByRole("dialog").getByRole("button", { name: decision, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
  await settle(page);
}

test("approval hand-off: Accountant submits, HR rejects and approves, employee is told, a supplemental run follows", async ({ page }) => {
  test.skip(BEFORE, "after the changes only");
  test.setTimeout(15 * 60 * 1000);
  const branch = await rows(db().from("branches").select("id").eq("name", BRANCH_MAIN).single());
  test.skip((await rows(db().from("payroll_runs").select("id").eq("branch_id", branch.id).eq("period_label", PERIOD))).length > 0, "November 1-15 already has a run");
  test.skip((await rows(db().from("payroll_entries").select("id").eq("branch_id", branch.id).eq("pay_period", PERIOD))).length > 0, "Main Campus already has November 1-15 payslips");
  const REASON = "E2E hand-off: please recheck the deductions";
  const runOf = (no) => rows(db().from("payroll_runs").select("id,status,remarks,run_no").eq("branch_id", branch.id).eq("period_label", PERIOD).eq("run_no", no).single());

  removeFlowPeople();
  const people = {};
  for (const [key, name] of [["final", "Fay Final"], ["draft", "Dan Draft"], ["waiting", "Eli Waiting"]]) {
    const email = `flow-${key}@e2e.test`;
    const meta = { role: "employee", full_name: name, employee_id: `E2E-FLOW-${key.toUpperCase()}`, employee_type: "Teaching", basic_salary: 30000, branch_id: branch.id };
    const created = await db().auth.admin.createUser({ email, password: "E2e-Flow#2026-x", email_confirm: true, user_metadata: meta });
    expect(created.error).toBeNull();
    const id = created.data.user.id;
    await db().from("profiles").upsert({ id, email, full_name: name, role: "employee", branch_id: branch.id, employee_status: "Active", date_hired: "2024-06-01", archived: false, payroll_hold: false });
    people[key] = { id, name, email };
  }
  // Fay signs in like any employee (the planted code), for her bell and payslips.
  ACCOUNTS.flowFay = { login: people.final.email, email: people.final.email, password: "E2e-Flow#2026-x", portal: "/employee" };
  const fayPayslips = async () => JSON.stringify((await api(page, "GET", "/api/me/payslips")).data || {}).includes(PERIOD);

  try {
    expect((await db().from("payroll_entries").insert([
      { employee_id: people.final.id, employee_name: people.final.name, employee_type: "Teaching", pay_period: PERIOD, status: "paid", payroll: payroll(15000, 1234.56) },
      { employee_id: people.draft.id, employee_name: people.draft.name, employee_type: "Teaching", pay_period: PERIOD, status: "draft", payroll: payroll(14000, 0) },
    ])).error).toBeNull();
    const processUrl = `ac-process&period=${encodeURIComponent(PERIOD)}`;
    // People made here skip the app's routes, so the server's 10 s user cache (src/lib/auth/users-cache.js) may still hold the last spec's.
    await page.waitForTimeout(11_000);

    // 1. Accountant submits; the Draft and Eli are left out.
    await as(page, "accountant", processUrl);
    await settle(page);
    await submitOpenCard(page, "Submit for HR Approval");
    expect((await runOf(1)).status).toBe("pending");

    // 2. HR's bell names the branch, the net and who was left out; it opens Payroll Approval.
    await as(page, "hr", "hr-dashboard");
    await settle(page);
    let menu = await bell(page);
    const hrNotice = menu.getByRole("menuitem").filter({ hasText: `Payroll waiting for approval: ${BRANCH_MAIN}` }).filter({ hasText: PERIOD }).first();
    await expect(hrNotice).toContainText(/net ₱13,765\.44/);
    await expect(hrNotice).toContainText(/\d+ left out: .*Dan Draft.*Eli Waiting/);
    await hrNotice.click();
    await expect(page).toHaveURL(/page=hr-payroll-approval/);
    // HR's left-out list reads the same server list as the Accountant's.
    expect(await followUp(page, "/api/hr/payroll-runs?view=excluded", "Dan Draft")).toBe("Draft");

    // 3. The employee cannot see the payslip before HR approves.
    await signOutLocally(page);
    await loginThroughUi(page, "flowFay");
    expect(await fayPayslips()).toBe(false);

    // 4. HR rejects with a reason (the HR screen).
    await hrDecide(page, 1, "Reject", REASON);
    expect(await runOf(1)).toMatchObject({ status: "rejected", remarks: REASON });

    // 5. Accountant: the bell and the run card carry HR's reason; resubmit.
    await as(page, "accountant", processUrl);
    await settle(page);
    menu = await bell(page);
    await expect(menu.getByRole("menuitem").filter({ hasText: `Payroll rejected: ${BRANCH_MAIN}, ${PERIOD}` }).first()).toContainText(REASON);
    await closeBell(page);
    const card = main(page).locator("[data-testid=run-card][data-status=rejected]", { hasText: BRANCH_MAIN }).first();
    await expect(card).toContainText(REASON);
    await expect(card.getByTestId("group-included").getByTestId("run-row").filter({ hasText: "Fay Final" })).toHaveCount(1);
    await submitOpenCard(page, "Resubmit");
    expect((await runOf(1)).status).toBe("pending");
    expect((await rows(db().from("notifications").select("body").eq("kind", "payroll_run_submitted").eq("run_id", (await runOf(1)).id))).some((n) => /resubmitted by/.test(n.body))).toBe(true);

    // 6. HR approves (the HR screen).
    await hrDecide(page, 1, "Approve", "E2E hand-off approved");
    expect((await runOf(1)).status).toBe("approved");

    // 7. Accountant: told, the card is Paid, the left-out list stays.
    await as(page, "accountant", processUrl);
    await settle(page);
    menu = await bell(page);
    await expect(menu.getByRole("menuitem").filter({ hasText: `Payroll approved: ${BRANCH_MAIN}, ${PERIOD}` }).first()).toBeVisible();
    await closeBell(page);
    await expect(main(page).locator("[data-testid=run-card][data-status=approved]", { hasText: BRANCH_MAIN }).first()).toBeVisible();
    expect(await followUp(page, "/api/accountant/payroll-runs?view=excluded", "Dan Draft")).toBe("Draft");
    expect(await followUp(page, "/api/accountant/payroll-runs?view=excluded", "Eli Waiting")).toBeTruthy();

    // 8. The employee: "Your payslip is ready" in the bell, and the payslip is visible.
    await signOutLocally(page);
    await loginThroughUi(page, "flowFay");
    menu = await bell(page);
    const ready = menu.getByRole("menuitem").filter({ hasText: "Your payslip is ready" }).filter({ hasText: PERIOD }).first();
    await expect(ready).toBeVisible();
    await expect(ready).not.toContainText("₱");
    await ready.click();
    await expect(page).toHaveURL(/page=emp-payslips/);
    expect(await fayPayslips()).toBe(true);

    // 9. Dan's Draft is finalized: a supplemental run for him; the list follows it on both sides.
    expect((await db().from("payroll_entries").update({ status: "paid" }).eq("employee_id", people.draft.id).eq("pay_period", PERIOD)).error).toBeNull();
    await as(page, "accountant", processUrl);
    await settle(page);
    expect(await followUp(page, "/api/accountant/payroll-runs?view=excluded", "Dan Draft")).toBe("Processed, not submitted");
    await expect(openCard(page).getByTestId("run-row").filter({ hasText: "Dan Draft" })).toHaveCount(1);
    await submitOpenCard(page, "Submit for HR Approval");
    expect((await runOf(2)).status).toBe("pending");
    expect(await followUp(page, "/api/accountant/payroll-runs?view=excluded", "Dan Draft")).toBe("In supplemental run, Pending HR approval");
    await as(page, "hr", "hr-payroll-approval");
    expect(await followUp(page, "/api/hr/payroll-runs?view=excluded", "Dan Draft")).toBe("In supplemental run, Pending HR approval");

    // 10. HR rejects the supplemental run: Dan is back on the list; resubmitted and approved, he leaves it.
    await hrDecide(page, 2, "Reject", REASON);
    await as(page, "accountant", processUrl);
    await settle(page);
    expect(await followUp(page, "/api/accountant/payroll-runs?view=excluded", "Dan Draft")).toBe("Left out again: supplemental run rejected by HR");
    await submitOpenCard(page, "Resubmit");
    await hrDecide(page, 2, "Approve", "E2E supplemental approved");
    expect((await runOf(2)).status).toBe("approved");
    await as(page, "accountant", processUrl);
    expect(await followUp(page, "/api/accountant/payroll-runs?view=excluded", "Dan Draft")).toBeNull();
    expect(await followUp(page, "/api/accountant/payroll-runs?view=excluded", "Eli Waiting")).toBeTruthy();
    // Dan was told too; the first run's people were not told twice.
    const released = await rows(db().from("notifications").select("recipient_id").eq("kind", "payslip_released").in("recipient_id", [people.final.id, people.draft.id]));
    expect(released.filter((n) => n.recipient_id === people.final.id)).toHaveLength(1);
    expect(released.filter((n) => n.recipient_id === people.draft.id)).toHaveLength(1);
  } finally {
    delete ACCOUNTS.flowFay;
    psql(`set session_replication_role = replica;
      delete from notifications where run_id in (select id from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}');
      delete from payroll_run_exclusions where run_id in (select id from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}');
      delete from payroll_run_items where run_id in (select id from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}');
      delete from payroll_approval_history where run_id in (select id from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}');
      update payroll_entries set run_id = null where run_id in (select id from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}');
      delete from payroll_runs where branch_id = '${branch.id}' and period_label = '${PERIOD}';`);
    removeFlowPeople();
  }
});
