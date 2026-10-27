// Moving around a portal and reading what it shows.
import { expect } from "@playwright/test";

// Every sidebar page per role (ids from src/app/*/*-portal.jsx).
export const PAGES = {
  super_admin: [
    ["sa-dashboard", "SA Dashboard"], ["sa-accounts", "Admin & HR Accounts"], ["sa-branches", "Branch Management"],
    ["sa-roles", "Roles & Permissions"], ["sa-maintenance", "System Maintenance"], ["sa-config", "System Configuration"],
    ["sa-audit", "Audit & Monitoring"], ["sa-backup", "Backup & Recovery"], ["sa-profile", "Profile"],
  ],
  admin: [
    ["adm-dashboard", "Branch Dashboard"], ["adm-attendance", "Branch Attendance"], ["adm-overtime", "Overtime & Substitute"],
    ["adm-leaves", "Leave Recommendations"], ["adm-transfers", "Transfer Endorsements"], ["adm-incentives", "Incentive Recommendations"],
    ["adm-schedules", "Schedule Requests"], ["adm-incidents", "Incident & AWOL Reports"], ["adm-rfid-issues", "RFID Issues"],
    ["adm-announcements", "Announcements"], ["adm-payroll", "Payroll Summary"], ["adm-branch-reports", "Branch Reports"],
    ["adm-maintenance", "RFID Terminal & Cards"], ["adm-profile", "Profile"],
  ],
  hr: [
    ["hr-dashboard", "Dashboard"], ["hr-employees", "User Management"], ["hr-transfers", "Transfer Requests"],
    ["hr-tenure", "Tenure Pay Protection"], ["hr-attendance", "Attendance"], ["hr-schedules", "Work Schedules"],
    ["hr-rfid-cards", "RFID Cards"], ["hr-rfid-terminals", "RFID Terminal"], ["hr-leaves", "Leave Approval"],
    ["hr-awol", "AWOL Cases"], ["hr-branch-requests", "Branch Requests"], ["hr-payroll-approval", "Payroll Approval"],
    ["hr-payroll-records", "Payroll Records"], ["hr-subsidy-approvals", "Subsidy Approvals"],
    ["hr-adjustment-approvals", "Incentive & Loan Approvals"], ["hr-gov-rates", "Government Rates"], ["hr-reports", "HR Reports"],
    ["hr-profile", "Profile"],
  ],
  accountant: [
    ["ac-dashboard", "Dashboard"], ["ac-process", "Process Payroll"], ["ac-records", "Payroll Records"], ["ac-payslips", "Payslips"],
    ["ac-loans", "Loans"], ["ac-incentives", "Incentives & Overload"], ["ac-cash-advances", "Cash Advances"],
    ["ac-13th", "13th Month Pay"], ["ac-approvals", "Subsidies"], ["ac-final-pay", "Final Pay"],
    ["ac-attendance", "View Attendance"], ["ac-gov-rates", "Government Rates"], ["ac-monitoring", "Payroll Monitoring"], ["ac-reports", "Payroll Reports"],
    ["ac-profile", "Profile"],
  ],
  employee: [
    ["emp-dash", "Dashboard"], ["emp-attendance", "Attendance"], ["emp-timesheet", "Timesheet"],
    ["emp-payslips", "Payslips"], ["emp-leave", "Leave"], ["emp-profile", "Profile"],
  ],
};

export const main = (page) => page.locator("#portal-main");

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Click a sidebar entry by its exact label (opening the mobile sheet if needed). */
export async function navTo(page, label) {
  let item = page.locator('[data-sidebar="menu-button"]').filter({ hasText: new RegExp(`^\\s*${escapeRe(label)}\\s*(\\d+)?\\s*$`) }).first();
  if (!(await item.isVisible().catch(() => false))) {
    const trigger = page.locator('[data-sidebar="trigger"]').first();
    if (await trigger.isVisible().catch(() => false)) await trigger.click();
    item = page.locator('[data-sidebar="menu-button"]:visible').filter({ hasText: new RegExp(`^\\s*${escapeRe(label)}\\s*(\\d+)?\\s*$`) }).first();
  }
  await item.click();
  await settle(page);
}

const BUSY = '#portal-main [data-slot="skeleton"], #portal-main [aria-busy="true"], #portal-main .animate-spin';

/**
 * Wait until the page stops loading. Returns false when something is still
 * spinning after `timeout` (an endless spinner).
 */
export async function settle(page, timeout = 25000) {
  await page.waitForTimeout(400);
  const done = await page.waitForFunction((sel) => !document.querySelector(sel), BUSY, { timeout }).then(() => true).catch(() => false);
  await page.waitForTimeout(300);
  return done;
}

// Lines that change by themselves (clocks, "x minutes ago", live counters).
const VOLATILE = [
  /\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\b/i, /\bago\b/i, /just now/i, /\bseconds?\b/i, /Updated/i, /Last (refresh|updated|sync)/i,
  /Good (morning|afternoon|evening)/i, /^\d+$/,
];

/** The visible text of the page body, as a set of stable lines. */
export async function snapshot(page) {
  const text = await main(page).innerText().catch(() => "");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !VOLATILE.some((re) => re.test(l)));
  return {
    text,
    lines: new Set(lines),
    rows: await page.locator("#portal-main table tbody tr").count(),
  };
}

/** Lines that were on screen before and are gone now. */
export function lostLines(before, after) {
  return [...before.lines].filter((l) => !after.lines.has(l));
}

/** The page shows something real: not blank, no crash screen, no stuck dialog. */
export async function expectHealthy(page, where) {
  const text = await main(page).innerText().catch(() => "");
  expect(text.trim().length, `${where}: page is blank`).toBeGreaterThan(10);
  expect(text, `${where}: Next.js error page`).not.toMatch(/Application error|Unhandled Runtime Error|This page could not be found/);
  const dialogs = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible');
  expect(await dialogs.count(), `${where}: a dialog is open by itself`).toBe(0);
  // A table body with no rows at all is a list without an empty state.
  const bodies = page.locator("#portal-main table tbody");
  for (let i = 0; i < await bodies.count(); i += 1) {
    const body = bodies.nth(i);
    if (!(await body.isVisible())) continue;
    expect(await body.locator("tr").count(), `${where}: table ${i + 1} has no rows and no empty state`).toBeGreaterThan(0);
  }
}

/** Horizontal overflow of the whole page (px); a table scrolling inside its own box is fine. */
export async function pageOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
