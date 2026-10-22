// Payroll, end to end: the Accountant processes and submits the run, HR
// rejects it with a reason, the Accountant sees the reason and resubmits, HR
// approves, it is in History, and the Employee sees the payslip only after
// approval. Status labels: Not submitted to HR / Pending HR Approval /
// Rejected by HR / Paid.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, confirm, refresh } from "../support/flow.mjs";
import { db, rows } from "../support/db.mjs";

const PERIOD = "October 1-15, 2026";
const BRANCH = "Main Campus";
const REASON = "E2E: re-check Ana's absence on Oct 6 before paying";

const runCard = (page) => main(page).locator("div.rounded-lg.border", { hasText: BRANCH }).filter({ has: page.getByRole("button", { name: /Submit for HR Approval|Resubmit for HR Approval/ }) }).first();
// HR's Payroll Approval keeps an open run in the address (?pa_run=); go back to the list.
const backToRuns = async (page) => {
  const back = main(page).getByRole("button", { name: "All runs" });
  if (await back.isVisible().catch(() => false)) { await back.click(); await settle(page); }
};
const runStatus = async () => {
  const branch = await rows(db().from("branches").select("id").eq("name", BRANCH).single());
  const run = await rows(db().from("payroll_runs").select("id,status,remarks").eq("branch_id", branch.id).eq("period_label", PERIOD).maybeSingle());
  return run;
};

test("payroll: process → submit → HR rejects → resubmit → HR approves → employee sees payslip", async ({ page, monitor }) => {
  const processUrl = `ac-process&period=${encodeURIComponent(PERIOD)}`;

  await step(page, "Accountant > Process Payroll > open October 1-15", async () => {
    monitor.at("Accountant > Process Payroll");
    await as(page, "accountant", processUrl);
    await settle(page);
    await expect(main(page).getByText(BRANCH).first()).toBeVisible();
  });

  await step(page, "Accountant > Process Payroll > click Process payroll for all", async () => {
    await main(page).getByRole("button", { name: "Process payroll for all →" }).click();
    await confirm(page, "Process payroll");
    // A processed batch opens the first payslip (Pay Record).
    await expect(page.getByText("Batch Payroll Processed").first()).toBeVisible({ timeout: 90000 });
    await expect(main(page).getByText("PAYSLIP NO.").first()).toBeVisible();
    // Bug 2026-10-22: batch payslips printed Branch "—" (no branch stored).
    expect(await main(page).innerText()).toMatch(new RegExp(`Branch\\s+${BRANCH}`));
    // Back on Process Payroll the run exists and is not with HR yet.
    await as(page, "accountant", processUrl);
    await expect(main(page).getByText("Not submitted to HR").first()).toBeVisible();
  });

  await step(page, "Employee > Payslips > nothing before HR approves", async () => {
    monitor.at("Employee > Payslips (before approval)");
    await as(page, "employee", "emp-payslips");
    await settle(page);
    await expect(main(page).getByText(PERIOD)).toHaveCount(0);
    const res = await api(page, "GET", "/api/employee/payslips");
    expect(JSON.stringify(res.data || {})).not.toContain(PERIOD);
  });

  await step(page, "Accountant > Process Payroll > Submit for HR Approval", async () => {
    monitor.at("Accountant > submit");
    await as(page, "accountant", processUrl);
    await runCard(page).getByRole("button", { name: "Submit for HR Approval" }).click();
    await confirm(page, "Submit for HR Approval");
    await expect(main(page).getByText("Pending HR Approval").first()).toBeVisible();
    await refresh(page);
    await expect(main(page).getByText("Pending HR Approval").first()).toBeVisible();
    expect((await runStatus()).status).toBe("pending");
  });

  await step(page, "HR > Payroll Approval > Review > Reject without a reason (refused)", async () => {
    monitor.at("HR > Payroll Approval > reject");
    await as(page, "hr", "hr-payroll-approval");
    await page.getByRole("tab", { name: /Pending HR Approval/ }).click();
    await settle(page);
    const row = main(page).locator("tr", { hasText: PERIOD }).filter({ hasText: BRANCH }).first();
    await row.getByRole("button", { name: "Review" }).click();
    await settle(page);
    await main(page).getByRole("button", { name: "Reject", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  await step(page, "HR > Payroll Approval > Reject with a reason", async () => {
    await page.locator("#pa-remarks").fill(REASON);
    await page.getByRole("dialog").getByRole("button", { name: "Reject", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
    await settle(page);
    expect((await runStatus()).status).toBe("rejected");
    await refresh(page);
    // The run that was open stays open after a refresh.
    await expect(main(page).getByText(REASON).first()).toBeVisible();
    await backToRuns(page);
    await page.getByRole("tab", { name: /Rejected by HR/ }).click();
    await settle(page);
    await expect(main(page).locator("tr", { hasText: PERIOD }).filter({ hasText: BRANCH })).toBeVisible();
  });

  await step(page, "Accountant > Process Payroll > sees HR's reason, resubmits", async () => {
    monitor.at("Accountant > resubmit");
    await as(page, "accountant", processUrl);
    await expect(main(page).getByText("Rejected by HR").first()).toBeVisible();
    await expect(main(page).getByText(REASON)).toBeVisible();
    await runCard(page).getByRole("button", { name: "Resubmit for HR Approval" }).click();
    await confirm(page, "Resubmit");
    await refresh(page);
    await expect(main(page).getByText("Pending HR Approval").first()).toBeVisible();
    expect((await runStatus()).status).toBe("pending");
  });

  await step(page, "HR > Payroll Approval > Review > Approve", async () => {
    monitor.at("HR > Payroll Approval > approve");
    await as(page, "hr", "hr-payroll-approval");
    await backToRuns(page);
    await page.getByRole("tab", { name: /Pending HR Approval/ }).click();
    await settle(page);
    await main(page).locator("tr", { hasText: PERIOD }).filter({ hasText: BRANCH }).first().getByRole("button", { name: "Review" }).click();
    await settle(page);
    await main(page).getByRole("button", { name: "Approve", exact: true }).click();
    await page.locator("#pa-remarks").fill("E2E approved after correction");
    await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
    expect((await runStatus()).status).toBe("approved");
  });

  await step(page, "HR > Payroll Approval > Paid and History tabs (after refresh)", async () => {
    await refresh(page);
    await backToRuns(page);
    await page.getByRole("tab", { name: /^Paid/ }).click();
    await settle(page);
    await expect(main(page).locator("tr", { hasText: PERIOD }).filter({ hasText: BRANCH })).toBeVisible();
    await page.getByRole("tab", { name: /History/ }).click();
    await settle(page);
    const history = main(page).locator("tr", { hasText: PERIOD });
    await expect(history.filter({ hasText: /Reject/i }).first()).toBeVisible();
    await expect(history.filter({ hasText: /Approv|Paid/i }).first()).toBeVisible();
    await expect(main(page).getByText(REASON).first()).toBeVisible();
  });

  await step(page, "Accountant > Payroll Records > the run shows Paid", async () => {
    monitor.at("Accountant > Payroll Records");
    await as(page, "accountant", "ac-records");
    await settle(page);
    await expect(main(page).getByText("Paid").first()).toBeVisible();
  });

  await step(page, "Employee > Payslips > October 1-15 is there after approval", async () => {
    monitor.at("Employee > Payslips (after approval)");
    await as(page, "employee", "emp-payslips");
    await settle(page);
    await expect(main(page).getByText(PERIOD).first()).toBeVisible();
    await refresh(page);
    await expect(main(page).getByText(PERIOD).first()).toBeVisible();
  });
});
