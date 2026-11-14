// Overrides only in the processing window, contributions apart from
// withholding tax, and a tag on every line (2026-11-03) — live and watchable.
//
// The server's "today" moves (E2E_TIME_TRAVEL=1), so the window can be seen
// open, closed and reopened:
//   Oct 30  inside the October 16-31 window (Oct 30 – Nov 3): an Absent
//           override with a reason; the Final payslip, HR's view, the employee
//           payslip show it tagged and marked Overridden
//   after   Final payslip / submitted to HR: locked in the UI, refused (403)
//           through a direct API call
//   Nov 10  HR rejected the run: overrides reopen for that run (after the window)
//   Nov 3   November 1-15 (window Nov 16 – Nov 20): locked, refused
// Screenshots (desktop and phone width): test-results/tour-tags/.
//
//   E2E_TIME_TRAVEL=1 E2E_SLOWMO=500 npx playwright test e2e/specs/20-payroll-flow.spec.mjs e2e/specs/99-tags-override-tour.spec.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, confirm } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_MAIN } from "../accounts.mjs";
import { TIME_TRAVEL, shiftBrowser, travelHome, travelTo } from "../support/time-travel.mjs";

const OCT2 = "October 16-31, 2026";
const NOV1 = "November 1-15, 2026";
const SHOTS = join(process.cwd(), "test-results", "tour-tags");
const REASON = "E2E: RFID reader at the gate was down on Oct 22; absence confirmed by the principal";
const REJECT = "E2E: please re-check Ana's absence count";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const log = { n: 0, checks: [] };
const say = (text) => { log.n += 1; console.log(`  [#${log.n}] ${text}`); };
function check(where, ok, text) {
  log.checks.push({ where, ok, text });
  say(`${ok ? "OK  " : "FAIL"} ${where}: ${text}`);
  expect.soft(ok, `${where}: ${text}`).toBe(true);
}
async function shot(page, name, { phone = false } = {}) {
  mkdirSync(SHOTS, { recursive: true });
  if (phone) await page.setViewportSize(PHONE);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, `${name}${phone ? "-phone" : ""}.png`), fullPage: true });
  if (phone) await page.setViewportSize(DESKTOP);
  say(`screenshot ${name}${phone ? "-phone" : ""}.png`);
}
const card = (page, title) => main(page).locator("[data-slot=card]").filter({ has: page.locator("[data-slot=card-title]", { hasText: title }) }).first();
const runCard = (page) => main(page).locator("div.rounded-lg.border", { hasText: BRANCH_MAIN }).filter({ has: page.getByRole("button", { name: /Submit for HR Approval|Resubmit for HR Approval/ }) }).first();

async function openProcess(page, period, who = /Ana/) {
  await page.goto(`/accountant?page=ac-process&period=${encodeURIComponent(period)}`);
  await main(page).waitFor();
  await settle(page);
  try { await choose(page, main(page).locator("#pc-employee"), who); } catch { await page.keyboard.press("Escape"); await settle(page); await choose(page, main(page).locator("#pc-employee"), who); }
  await settle(page);
}

/** Every line in the summary carries a tag; returns [{ label, tag }]. */
async function taggedLines(scope) {
  return scope.locator("[data-testid=payroll-line-groups] li[data-line]").evaluateAll((els) => els.map((el) => ({ line: el.dataset.line, tag: el.dataset.tag, text: el.innerText.replace(/\s+/g, " ").slice(0, 140) })));
}

const overrideBody = (employeeId, absences) => ({
  action: "save_draft", employee_id: employeeId, pay_period: OCT2,
  deductions: { absences_days: absences, late_days: 0, undertime_minutes: 0, half_days: 0, leave_with_pay_days: 0, leave_without_pay_days: 0 },
  override_reason: "E2E direct API call",
});

test.use({ viewport: DESKTOP });

test("overrides in the processing window; contributions vs tax; tagged lines everywhere", async ({ page, monitor }) => {
  test.skip(!TIME_TRAVEL, "run with E2E_TIME_TRAVEL=1 (the server's today must move)");
  test.setTimeout(30 * 60 * 1000);
  await shiftBrowser(page.context());
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const oct1 = await rows(db().from("payroll_entries").select("id,status").eq("employee_id", ana.id).eq("pay_period", "October 1-15, 2026"));
  test.skip(!oct1.length || oct1[0].status !== "paid", "needs October 1-15 approved (run 20-payroll-flow first)");
  // Needs October 16-31 untouched with Ana employed: 96/97 (year-end tax,
  // override) approve that run and separate Ana earlier in the full suite.
  // Run on its own after 20-payroll-flow (e2e/README.md, "Separate passes").
  {
    const mainId = (await rows(db().from("branches").select("id").eq("name", "Main Campus").single())).id;
    const taken = await rows(db().from("payroll_runs").select("id").eq("branch_id", mainId).eq("period_label", "October 16-31, 2026"));
    const anaNow = await profileByEmail(ACCOUNTS.employee.email);
    test.skip(taken.length > 0 || Boolean(anaNow.separated_on), "October 16-31 already used by 96/97 in this run: run this spec in its own pass after 20-payroll-flow");
  }
  const blocked = async () => (await rows(db().from("audit_logs").select("id,metadata,actor_name,created_at").eq("action", "attendance_override_blocked"))).length;

  try {
    await as(page, "accountant", "ac-dashboard");
    await travelTo("2026-10-30", page);

    // ── Inside the window, on a draft: override with a reason ──────────────
    let computedAbsent = 0;
    await step(page, "Accountant > Process Payroll > Oct 16-31 > inside the window (Oct 30)", async () => {
      monitor.at("Accountant > Process Payroll (window open)");
      await openProcess(page, OCT2);
      await expect(main(page).getByTestId("override-open")).toBeVisible();
      check("Window open", await main(page).locator("#pc-absences").isEnabled(), "Absent is editable inside the window");
      check("Read-only", (await main(page).locator("#pc-sss").count()) === 0 || !(await main(page).locator("input#pc-sss").count()), "SSS is computed text, not an input");
      await expect(main(page).getByTestId("group-contributions")).toBeVisible();
      await expect(main(page).getByTestId("group-tax")).toBeVisible();
      await expect(main(page).getByTestId("form-taxable-income")).toBeVisible();
      const summary = card(page, "Computation summary");
      const lines = await taggedLines(summary);
      say(`Computation summary lines: ${lines.map((l) => `${l.line}[${l.tag}]`).join(", ")}`);
      check("Tags", lines.length > 0 && lines.every((l) => l.tag), `every summary line has a tag (${lines.length} lines)`);
      for (const title of ["Additions", "Government contributions (employee share)", "Withholding tax (income tax)"]) {
        check("Groups", await summary.getByText(title, { exact: true }).isVisible(), `"${title}" group shown`);
      }
      await summary.getByText("How was this tax computed?").first().click();
      await expect(summary.getByTestId("tax-how").first()).toHaveAttribute("open", "");
      await summary.getByText("What the tags mean").click();
      await shot(page, "01-process-oct2-window-open");
      await shot(page, "01-process-oct2-window-open", { phone: true });
      computedAbsent = Number(await main(page).locator("#pc-absences").inputValue()) || 0;
      await main(page).locator("#pc-absences").fill(String(computedAbsent + 1));
      await main(page).locator("#pc-override-reason").fill(REASON);
      await settle(page);
      await expect(summary.getByTestId("line-overridden").first()).toBeVisible();
      await shot(page, "02-override-with-reason");
      await main(page).getByRole("button", { name: "Process payroll →" }).click();
      await expect(page.getByText(/Payroll processed successfully|Payroll Processed/).first()).toBeVisible({ timeout: 60000 });
      const entry = await rows(db().from("payroll_entries").select("payroll,status").eq("employee_id", ana.id).eq("pay_period", OCT2).single());
      check("Stored", entry.status === "paid" && entry.payroll?.audit?.deviations?.reason === REASON, "Final payslip saved with the override and its reason");
      const log2 = await rows(db().from("audit_logs").select("metadata").eq("action", "process").eq("entity_type", "payroll_entry").order("created_at", { ascending: false }).limit(1));
      check("Logged", log2[0]?.metadata?.override_reason === REASON, "the override is in the audit log with the reason");
    });

    await step(page, "Accountant > Process payroll for all (the rest of the branch)", async () => {
      await page.goto(`/accountant?page=ac-process&period=${encodeURIComponent(OCT2)}`);
      await main(page).waitFor();
      await settle(page);
      await main(page).getByTestId("process-all").click();
      await confirm(page, "Process payroll");
      await expect(page.getByText(/Payroll processed for \d+ employee|No payslips processed/).first()).toBeVisible({ timeout: 90000 });
    });

    await step(page, "Accountant > Payslips > Ana's Oct 16-31 payslip: groups, tags, Overridden", async () => {
      monitor.at("Accountant > Payslips");
      const entry = await rows(db().from("payroll_entries").select("id").eq("employee_id", ana.id).eq("pay_period", OCT2).single());
      await page.goto(`/accountant?page=ac-payslips&entry=${entry.id}`);
      await main(page).waitFor();
      await settle(page);
      const doc = main(page).locator("[data-print-area]").first();
      // The batch opened another employee's payslip: pick Ana's.
      await choose(page, main(page).locator("#ac-payslip-select"), new RegExp(`Ana.*${OCT2}`));
      await settle(page);
      await expect(doc).toContainText("Ana");
      await expect(doc.getByTestId("payroll-line-groups")).toBeVisible();
      const lines = await taggedLines(doc);
      check("Payslip", lines.every((l) => l.tag), `every payslip line tagged (${lines.length})`);
      check("Payslip", lines.some((l) => l.line === "absent" && /overridden/i.test(l.text)), "the overridden absence is marked");
      check("Payslip", !/employer|EC contribution/i.test(await doc.innerText()), "no employer share or EC on the payslip");
      await shot(page, "03-accountant-payslip");
    });

    // ── Final payslip: locked, and refused by the API ─────────────────────
    await step(page, "Accountant > Process Payroll > Ana again: Final payslip, overrides locked", async () => {
      await openProcess(page, OCT2);
      await expect(main(page).getByTestId("override-locked")).toContainText("Final payslip");
      check("Locked UI", await main(page).locator("#pc-absences").isDisabled(), "Absent field disabled");
      await shot(page, "04-locked-final-payslip");
      const before = await blocked();
      const res = await api(page, "POST", "/api/accountant/payroll", { ...overrideBody(ana.id, computedAbsent + 3), action: "submit" });
      check("API", res.status === 403 && res.data?.code === "override_payslip_final", `direct POST refused: ${res.status} ${res.data?.code}`);
      check("Logged", (await blocked()) === before + 1, "blocked attempt logged");
    });

    await step(page, "Accountant > Submit for HR Approval; overrides locked while with HR", async () => {
      await page.goto(`/accountant?page=ac-process&period=${encodeURIComponent(OCT2)}`);
      await main(page).waitFor();
      await settle(page);
      await runCard(page).getByRole("button", { name: "Submit for HR Approval" }).click();
      await confirm(page, "Submit for HR Approval");
      await openProcess(page, OCT2, /Bea/);
      await expect(main(page).getByTestId("override-locked")).toContainText("submitted to HR");
      await shot(page, "05-locked-submitted-to-hr");
      const bea = await profileByEmail(ACCOUNTS.employee2.email);
      const res = await api(page, "POST", "/api/accountant/payroll", overrideBody(bea.id, 2));
      check("API", res.status === 403 && /override_run_submitted|override_payslip_final/.test(res.data?.code || ""), `direct POST refused while with HR: ${res.status} ${res.data?.code}`);
    });

    await step(page, "HR > Payroll Approval > Ana's row: same groups and tags; reject", async () => {
      monitor.at("HR > Payroll Approval");
      await as(page, "hr", "hr-payroll-approval");
      await page.getByRole("tab", { name: /Pending HR Approval/ }).click();
      await settle(page);
      await main(page).locator("tr", { hasText: OCT2 }).filter({ hasText: BRANCH_MAIN }).first().getByRole("button", { name: "Review" }).click();
      await settle(page);
      await main(page).getByRole("button", { name: /Show Ana.*computation/ }).first().click();
      const groups = main(page).getByTestId("payroll-line-groups").first();
      await expect(groups).toBeVisible();
      const lines = await taggedLines(main(page));
      check("HR view", lines.length > 0 && lines.every((l) => l.tag), `every line tagged in HR's view (${lines.length})`);
      check("HR view", await groups.getByText("Government contributions (employee share)", { exact: true }).isVisible(), "contributions group shown");
      check("HR view", await groups.getByTestId("line-overridden").first().isVisible(), "the Overridden marker is shown to HR");
      await shot(page, "06-hr-approval-breakdown");
      await shot(page, "06-hr-approval-breakdown", { phone: true });
      await main(page).getByRole("button", { name: "Reject", exact: true }).click();
      await page.locator("#pa-remarks").fill(REJECT);
      await page.getByRole("dialog").getByRole("button", { name: "Reject", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
    });

    // ── HR rejected: reopened for that run only, even after the window ─────
    await step(page, "Accountant > Nov 10 (window closed) > rejected run: overrides reopened; reprocess Ana", async () => {
      await as(page, "accountant", "ac-dashboard");
      await travelTo("2026-11-10", page);
      await openProcess(page, OCT2);
      await expect(main(page).getByTestId("override-open")).toContainText("HR returned this payroll run");
      await main(page).locator("#pc-absences").fill(String(computedAbsent + 2));
      await main(page).locator("#pc-override-reason").fill(`${REASON}; HR asked to add Oct 23 too`);
      await shot(page, "07-reopened-after-rejection");
      await main(page).getByRole("button", { name: "Process payroll →" }).click();
      await expect(page.getByText(/Payroll processed successfully|Payroll Processed|Payslip Reprocessed/).first()).toBeVisible({ timeout: 60000 });
      const entry = await rows(db().from("payroll_entries").select("payroll").eq("employee_id", ana.id).eq("pay_period", OCT2).single());
      check("Reopened", Number(entry.payroll?.deductions?.absences_days) === computedAbsent + 2, `reprocessed with ${computedAbsent + 2} absent days`);
      await page.goto(`/accountant?page=ac-process&period=${encodeURIComponent(OCT2)}`);
      await main(page).waitFor();
      await settle(page);
      await runCard(page).getByRole("button", { name: "Resubmit for HR Approval" }).click();
      await confirm(page, "Resubmit");
    });

    await step(page, "HR > approve the resubmitted run", async () => {
      await as(page, "hr", "hr-payroll-approval");
      await expect(main(page).getByTestId("hr-processing-windows")).toContainText("read-only");
      await expect(main(page).getByTestId("hr-processing-windows")).toContainText("Super Admin");
      await shot(page, "07b-hr-processing-windows");
      const back = main(page).getByRole("button", { name: "All runs" });
      if (await back.isVisible().catch(() => false)) { await back.click(); await settle(page); }
      await page.getByRole("tab", { name: /Pending HR Approval/ }).click();
      await settle(page);
      await main(page).locator("tr", { hasText: OCT2 }).filter({ hasText: BRANCH_MAIN }).first().getByRole("button", { name: "Review" }).click();
      await settle(page);
      await main(page).getByRole("button", { name: "Approve", exact: true }).click();
      await page.locator("#pa-remarks").fill("E2E approved after the override check");
      await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
    });

    await step(page, "Accountant > approved run: overrides locked, API refuses", async () => {
      await as(page, "accountant", "ac-dashboard");
      await openProcess(page, OCT2);
      await expect(main(page).getByTestId("override-locked")).toContainText(/approved|Final payslip/);
      const before = await blocked();
      const res = await api(page, "POST", "/api/accountant/payroll", overrideBody(ana.id, 0));
      check("API", res.status === 403, `direct POST on the approved period refused: ${res.status} ${res.data?.code}`);
      check("Logged", (await blocked()) === before + 1, "blocked attempt logged");
      await shot(page, "08-locked-approved");
    });

    await step(page, "Employee > Payslips > Oct 16-31: tagged, why-tax note, no employer shares", async () => {
      monitor.at("Employee > Payslips");
      await as(page, "employee", "emp-payslips");
      await settle(page);
      const row = main(page).locator("tr", { hasText: OCT2 }).first();
      if (await row.isVisible().catch(() => false)) {
        await row.getByRole("button").first().click().catch(() => {});
        await settle(page);
      }
      const groups = main(page).getByTestId("payroll-line-groups").first();
      await expect(groups).toBeVisible();
      check("Employee payslip", await main(page).getByTestId("why-tax").first().isVisible(), "\"Why is there a withholding tax?\" shown");
      check("Employee payslip", !/employer share|EC contribution/i.test(await groups.innerText()), "no employer shares on the employee's payslip");
      await main(page).getByTestId("why-tax").first().locator("summary").click();
      await shot(page, "09-employee-payslip");
      await shot(page, "09-employee-payslip", { phone: true });
      // The raw table is not on the employee's side.
      check("Employee", !(await main(page).getByTestId("withholding-tax-section").count()), "no tax table in the Employee portal");
    });

    await step(page, "Employee > the past approved Oct 1-15 payslip still opens (stored figures only)", async () => {
      const row = main(page).locator("tr", { hasText: "October 1-15, 2026" }).first();
      await row.getByRole("button").first().click().catch(() => {});
      await settle(page);
      await shot(page, "10-employee-past-payslip");
    });

    // ── Government Rates ───────────────────────────────────────────────────
    await step(page, "Accountant > Government Rates > withholding tax section; check ₱41,925", async () => {
      monitor.at("Accountant > Government Rates");
      await as(page, "accountant", "ac-gov-rates");
      await settle(page);
      const section = main(page).getByTestId("withholding-tax-section");
      await expect(section).toBeVisible();
      await section.locator("#gr-tax-check").fill("41925");
      await expect(section.getByTestId("tax-check-result")).toContainText("3,593.40");
      check("Gov rates", await section.locator("tr[data-active]").count() === 1, "the ₱33,333 – ₱66,666 bracket is highlighted");
      await shot(page, "11-gov-rates-withholding");
      await shot(page, "11-gov-rates-withholding", { phone: true });
      await section.locator("#gr-tax-check").fill("16912.50");
      await expect(section.getByTestId("tax-check-result")).toContainText("exempt bracket");
    });

    await step(page, "HR > Government Rates (read-only)", async () => {
      await as(page, "hr", "hr-gov-rates");
      await settle(page);
      await expect(main(page).getByTestId("withholding-tax-section")).toBeVisible();
      await expect(main(page).getByText("Read-only.").first()).toBeVisible();
      await shot(page, "12-hr-gov-rates");
    });

    // ── Before the window opens ────────────────────────────────────────────
    await step(page, "Accountant > Nov 3 > November 1-15 (window Nov 16 – Nov 20): locked, API refuses", async () => {
      await as(page, "accountant", "ac-dashboard");
      await travelTo("2026-11-03", page);
      await openProcess(page, NOV1);
      await expect(main(page).getByTestId("override-locked")).toContainText("Overrides are only available during the processing window (Nov 16 to Nov 20)");
      check("Locked UI", await main(page).locator("#pc-absences").isDisabled() && await main(page).locator("#pc-half-days").isDisabled(), "Absent and Half day disabled");
      check("Locked UI", await main(page).locator("#pc-leave-without-pay-days").isDisabled(), "Leave without pay disabled too (decision 2026-11-03)");
      await shot(page, "13-locked-before-window");
      await shot(page, "13-locked-before-window", { phone: true });
      const before = await blocked();
      // One more absence than the logs give: an override (the same count would not be).
      const novComputed = Number(await main(page).locator("#pc-absences").inputValue()) || 0;
      const res = await api(page, "POST", "/api/accountant/payroll", { ...overrideBody(ana.id, novComputed + 5), pay_period: NOV1 });
      check("API", res.status === 403 && res.data?.code === "override_outside_window", `direct POST before the window refused: ${res.status} ${res.data?.code}`);
      check("Logged", (await blocked()) === before + 1, "blocked attempt logged (who, when, which payslip)");
      const noOverride = await api(page, "POST", "/api/accountant/payroll", { ...overrideBody(ana.id, novComputed), pay_period: NOV1, override_reason: "" });
      say(`Same draft without an override: ${noOverride.status} (not an override, so not blocked)`);
    });
  } finally {
    await travelHome(page);
    const failed = log.checks.filter((c) => !c.ok);
    console.log(`\n  ── Summary: ${log.checks.length} checks, ${failed.length} failed ──`);
    failed.forEach((c) => console.log(`  FAIL ${c.where}: ${c.text}`));
  }
});
