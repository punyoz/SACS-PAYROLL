// Incentives filed after the cutoff move to next month's payroll, with the
// notice shown to the Accountant; late arrivals are recorded but deducted at
// 0%. Runs after the payroll flow (Ana's October 1-15 payslip exists).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { choose, confirm, pickDate, refresh } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

let planted = null;
// The planted schedule goes again even when a step fails (local DB only; the
// hard-delete guard is bypassed for this fixture).
test.afterEach(() => {
  if (planted) psql(`set session_replication_role = replica; delete from payroll_schedule_settings where id = '${planted.id}';`);
  planted = null;
});

test("incentive filed after the cutoff is deferred to next month, with the notice", async ({ page, monitor }) => {
  const description = `E2E late-filed coaching incentive ${Date.now() % 100000}`;

  // The incentive cutoff is the day before the 2nd-half payslip day (Oct 29
  // by default), so nothing filed today (Oct 22) is late yet. The Super Admin
  // screen rightly refuses to move a payday into the past, so the test plants
  // a schedule with October's 2nd half on the 20th (cutoff Oct 19) directly,
  // and removes it afterwards.
  // The schedule guard (rightly) refuses a past payday, so the row is planted
  // with triggers off.
  planted = { id: psql(`set session_replication_role = replica;
    insert into payroll_schedule_settings (effective_from, first_half_day, second_half_day, window_days, note, created_by_name)
    values ('2026-10-16', 15, 20, 5, 'E2E: incentive cutoff in the past', 'E2E') returning id;`).split(/\s+/).pop() };

  await step(page, "Accountant > Incentives & Overload > Add with no employee (refused)", async () => {
    monitor.at("Accountant > Incentives & Overload");
    await as(page, "accountant", "ac-incentives");
    await main(page).getByRole("button", { name: "Send for HR approval →" }).click();
    await expect(main(page).locator('[aria-invalid="true"]').first()).toBeVisible();
  });

  await step(page, "Accountant > Incentives & Overload > file an Oct 5 incentive today (after the Oct 19 cutoff)", async () => {
    await choose(page, main(page).locator("#ac-item-employee"), /Bea/);
    await pickDate(page, main(page).locator("#ac-item-date"), "2026-10-05");
    await expect(main(page).getByRole("status").filter({ hasText: /deferred to next month/ }).first()).toBeVisible();
    await main(page).locator("#ac-item-amount").fill("750");
    await main(page).locator("#ac-item-description").fill(description);
    await main(page).getByRole("button", { name: "Send for HR approval →" }).click();
    await expect(main(page).getByText(/Sent for HR approval — deferred to next month's payroll/)).toBeVisible({ timeout: 30000 });
  });

  await step(page, "Accountant > Incentives & Overload > listed under Deferred incentives after refresh", async () => {
    await refresh(page);
    const deferred = main(page).locator("table", { has: page.locator("caption", { hasText: /Deferred incentives/i }) });
    const row = deferred.locator("tr", { hasText: description }).or(main(page).locator("tr", { hasText: description })).first();
    await expect(row).toBeVisible();
    await expect(row.getByText(/Deferred to next month's payroll/)).toBeVisible();
  });

  // Incentives wait for HR before payroll pays them (20261027020000).
  await step(page, "HR > Incentive & Loan Approvals > approve it; the Accountant sees Approved", async () => {
    monitor.at("HR > Incentive & Loan Approvals");
    await as(page, "hr", "hr-adjustment-approvals");
    const row = main(page).locator("tr", { hasText: description }).first();
    await expect(row.getByText("Pending HR approval")).toBeVisible({ timeout: 30000 });
    await row.getByRole("button", { name: /^Approve/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Approve" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    const item = await rows(db().from("payroll_monthly_incentives").select("approval_status").eq("description", description));
    expect(item[0]?.approval_status).toBe("approved");
    await as(page, "accountant", "ac-incentives");
    await expect(main(page).locator("tr", { hasText: description }).getByText("Approved by HR").first()).toBeVisible({ timeout: 30000 });
  });

  await step(page, "Accountant > Process Payroll > the deferred-items notice", async () => {
    monitor.at("Accountant > Process Payroll");
    await as(page, "accountant", `ac-process&period=${encodeURIComponent("October 16-31, 2026")}`);
    await settle(page);
    await expect(main(page).locator('[role="alert"]', { hasText: /deferred|next month/i }).first()).toBeVisible();
  });
});

test("late arrivals are recorded but deducted at 0%", async ({ page, monitor }) => {
  const ana = await profileByEmail(ACCOUNTS.employee.email);

  await step(page, "Employee > Attendance > Oct 8 is Late", async () => {
    monitor.at("Employee > Attendance");
    const late = await rows(db().from("attendance_logs").select("status,late_minutes").eq("employee_id", ana.id).eq("log_date", "2026-10-08").single());
    expect(late.status).toBe("Late");
    expect(late.late_minutes).toBeGreaterThan(0);
    await as(page, "employee", "emp-attendance");
    await expect(main(page).getByText("Late").first()).toBeVisible();
  });

  await step(page, "Employee > Payslips > October 1-15 shows Late ₱0 (rate 0%)", async () => {
    monitor.at("Employee > Payslips");
    await as(page, "employee", "emp-payslips");
    await settle(page);
    await main(page).getByText("October 1-15, 2026").first().click();
    await settle(page);
    const text = await main(page).innerText();
    expect(text).toMatch(/Late/);
    expect(text).not.toMatch(/Late[^\n]*-\s*₱\s*[1-9]/);
    const items = await rows(db().from("payroll_run_items").select("late_deduction,late_days,late_minutes,run_id,payroll_runs!inner(period_label)").eq("employee_id", ana.id).eq("payroll_runs.period_label", "October 1-15, 2026"));
    expect(items.length, "Ana has an October 1-15 payslip").toBeGreaterThan(0);
    const oct = items[items.length - 1];
    expect(oct.late_days, "the late day is recorded").toBeGreaterThan(0);
    expect(Number(oct.late_deduction || 0)).toBe(0);
  });
});
