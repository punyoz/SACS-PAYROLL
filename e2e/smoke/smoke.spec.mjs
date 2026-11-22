// SMOKE suite (2026-11-22): the few flows that must work after every change,
// in under ~20 minutes. Local stack only (fresh seed). Run with:
//
//   npm run test:smoke
//
// 17 tests: sign in as each role (5); HR overrides an attendance day; the
// Accountant processes a payslip and submits to HR, HR approves, the payslip
// PDF opens (one chain, in order); the Employee files and cancels a leave and
// an overtime request; the Super Admin downloads a backup; one sidebar page
// per role (5). Each test cleans up what it adds where that matters.
import { test, expect } from "../support/test.mjs";
import { as, loginThroughUi, signOutLocally } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { expectHealthy, main, navTo, settle } from "../support/portal.mjs";
import { api, confirm, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_MAIN, ROLES } from "../accounts.mjs";

const PERIOD = "October 1-15, 2026";
const LABEL = { super_admin: "Super Admin", admin: "Admin", hr: "HR", accountant: "Accountant", employee: "Employee" };

/** The next weekday at least `from` days ahead. */
function nextWeekday(from) {
  for (let n = from; n < from + 7; n += 1) {
    const key = manilaDay(n);
    if (![0, 6].includes(new Date(`${key}T00:00:00Z`).getUTCDay())) return key;
  }
  throw new Error("no weekday");
}

// ── 1-5. Sign in as each role (password + emailed code) ─────────────────────
for (const role of ROLES) {
  test(`smoke: ${LABEL[role]} signs in and lands on the dashboard`, async ({ page }) => {
    await signOutLocally(page);
    await loginThroughUi(page, role);
    await settle(page);
    await expectHealthy(page, `${LABEL[role]} dashboard`);
  });
}

// ── 6. HR overrides an attendance day ───────────────────────────────────────
test("smoke: HR overrides an attendance day (both times, with a note)", async ({ page }) => {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  // The most recent past weekday that is not a holiday.
  const recent = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => manilaDay(-n));
  const holidays = new Set((await rows(db().from("attendance_holidays").select("holiday_date").gte("holiday_date", recent.at(-1)).lte("holiday_date", recent[0]))).map((h) => String(h.holiday_date).slice(0, 10)));
  const day = recent.find((key) => ![0, 6].includes(new Date(`${key}T00:00:00Z`).getUTCDay()) && !holidays.has(key));
  await step(page, `HR > Attendance > override Bea's ${day}`, async () => {
    await as(page, "hr", "hr-attendance");
    await settle(page);
    const res = await api(page, "PATCH", "/api/attendance/corrections", {
      action: "correct_record", employee_id: bea.id, log_date: day, type: "both", time_in: "07:00", time_out: "16:00",
      note: "E2E smoke: forgot the card, confirmed by the branch Admin",
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const log = await rows(db().from("attendance_logs").select("time_in,time_out,status").eq("employee_id", bea.id).eq("log_date", day).eq("archived_duplicate", false).single());
    expect(log.time_in && log.time_out, "both times are on the record").toBeTruthy();
  });
});

// ── 7-9. Process → submit to HR → HR approves → the payslip PDF ─────────────
test.describe("smoke: payroll chain", () => {
  test.describe.configure({ mode: "serial" });
  const processUrl = `ac-process&period=${encodeURIComponent(PERIOD)}`;
  const runCard = (page) => main(page).locator("div.rounded-lg.border", { hasText: BRANCH_MAIN }).filter({ has: page.getByRole("button", { name: /Submit for HR Approval|Resubmit for HR Approval/ }) }).first();
  const runStatus = async () => {
    const branch = await rows(db().from("branches").select("id").eq("name", BRANCH_MAIN).single());
    return rows(db().from("payroll_runs").select("id,status").eq("branch_id", branch.id).eq("period_label", PERIOD).maybeSingle());
  };

  test("smoke: the Accountant processes October 1-15 and submits it to HR", async ({ page }) => {
    await step(page, "Accountant > Process Payroll > Process payroll for all", async () => {
      await as(page, "accountant", processUrl);
      await settle(page);
      await main(page).getByTestId("process-all").click();
      await confirm(page, "Process payroll");
      await expect(page.getByText(/Payroll processed for \d+ employee/).first()).toBeVisible({ timeout: 90000 });
    });
    await step(page, "Accountant > Submit for HR Approval", async () => {
      await as(page, "accountant", processUrl);
      await runCard(page).getByRole("button", { name: "Submit for HR Approval" }).click();
      await confirm(page, "Submit for HR Approval");
      await expect(main(page).getByText("Pending HR approval").first()).toBeVisible();
      expect((await runStatus()).status).toBe("pending");
    });
  });

  test("smoke: HR approves the run", async ({ page }) => {
    await step(page, "HR > Payroll Approval > Review > Approve", async () => {
      await as(page, "hr", "hr-payroll-approval");
      await page.getByRole("tab", { name: /Pending HR approval/ }).click();
      await settle(page);
      await main(page).locator("tr", { hasText: PERIOD }).filter({ hasText: BRANCH_MAIN }).first().getByRole("button", { name: "Review" }).click();
      await settle(page);
      await main(page).getByRole("button", { name: "Approve", exact: true }).click();
      await page.locator("#pa-remarks").fill("E2E smoke approval");
      await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
      expect((await runStatus()).status).toBe("approved");
    });
  });

  test("smoke: the approved payslip opens as a PDF; the Employee sees it listed", async ({ page }) => {
    const ana = await profileByEmail(ACCOUNTS.employee.email);
    const [entry] = await rows(db().from("payroll_entries").select("id,payslip_no,status").eq("employee_id", ana.id).eq("pay_period", PERIOD).eq("status", "paid"));
    expect(entry, "Ana's approved October 1-15 payslip").toBeTruthy();
    await step(page, "Accountant > Pay Record > PDF", async () => {
      await as(page, "accountant");
      const res = await page.request.get(`/api/accountant/payroll?format=pdf&entry_id=${entry.id}`);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/pdf");
      expect((await res.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    });
    await step(page, "Employee > My Payslips > the payslip is listed after approval", async () => {
      await as(page, "employee", "emp-payslips");
      await settle(page);
      await expect(main(page).getByText(PERIOD).first()).toBeVisible();
    });
  });
});

// ── 10-11. The Employee files and cancels a leave and an overtime request ───
test("smoke: the Employee files a leave request and cancels it", async ({ page }) => {
  const reason = `E2E smoke leave ${Date.now()}`;
  const start = nextWeekday(10);
  await step(page, "Employee > My Leave > file, then Cancel", async () => {
    await as(page, "employee", "emp-leave");
    await settle(page);
    const filed = await api(page, "POST", "/api/me/leave-requests", { leave_type: "Vacation Leave", pay_status: "with_pay", start_date: start, end_date: start, reason });
    expect([200, 201], JSON.stringify(filed.data)).toContain(filed.status);
    const [row] = await rows(db().from("leave_requests").select("id,status").eq("reason", reason));
    expect(row, "the request reached the database").toBeTruthy();
    const cancelled = await api(page, "PATCH", "/api/me/leave-requests", { id: row.id, action: "cancel" });
    expect(cancelled.status, JSON.stringify(cancelled.data)).toBe(200);
    expect((await rows(db().from("leave_requests").select("status").eq("id", row.id).single())).status).toBe("cancelled");
  });
});

test("smoke: the Employee files an overtime request and cancels it on the page", async ({ page }) => {
  const date = nextWeekday(2);
  await step(page, "Employee > My Leave > Overtime request > file, then Cancel", async () => {
    await as(page, "employee", "emp-leave");
    await settle(page);
    const filed = await api(page, "POST", "/api/me/overtime-requests", { request_date: date, planned_start: "17:00", planned_end: "18:00", reason: "E2E smoke overtime" });
    expect(filed.status, JSON.stringify(filed.data)).toBe(201);
    await page.reload();
    await settle(page);
    const row = main(page).getByTestId("my-overtime-requests").getByRole("row").filter({ hasText: date });
    await row.getByRole("button", { name: "Cancel" }).click();
    await expect(row).toContainText("Cancelled");
  });
});

// ── 12. The Super Admin downloads a backup ──────────────────────────────────
test("smoke: the Super Admin downloads the full backup (password, ZIP)", async ({ page }) => {
  await step(page, "Super Admin > Backup & Recovery > Download everything", async () => {
    await as(page, "super_admin", "sa-backup");
    await settle(page);
    const card = main(page).locator('[data-testid="backup"]');
    await card.getByRole("button", { name: /Download everything/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#backup-password").fill(ACCOUNTS.super_admin.password);
    await dialog.getByRole("checkbox").click();
    const pending = page.waitForEvent("download", { timeout: 300000 });
    await dialog.getByRole("button", { name: "Download" }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(/sacs-payroll_everything_\d{4}-\d{2}-\d{2}_\d{4}\.zip$/);
    const path = await download.path();
    const { statSync } = await import("node:fs");
    expect(statSync(path).size, "the ZIP is not empty").toBeGreaterThan(10_000);
    await expect(dialog).toBeHidden({ timeout: 60000 });
  });
});

// ── 13-17. One sidebar page per role ────────────────────────────────────────
const SIDEBAR = { super_admin: "Audit & Monitoring", admin: "Branch Attendance", hr: "Leave Approval", accountant: "Payroll Records", employee: "My Timesheet" };
for (const role of ROLES) {
  test(`smoke: ${LABEL[role]} opens ${SIDEBAR[role]} from the sidebar`, async ({ page }) => {
    await as(page, role);
    await settle(page);
    await navTo(page, SIDEBAR[role]);
    await expectHealthy(page, `${LABEL[role]} > ${SIDEBAR[role]}`);
  });
}
