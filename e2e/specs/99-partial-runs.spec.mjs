// Partial payroll runs (2026-10-29), live: the Accountant may submit a
// branch's run without every employee, never silently. The employees left
// out are listed with a note; Submit stays disabled until the Accountant
// confirms. HR sees the same list on the run. The record stays, the
// follow-up list shows who is still waiting, and an employee left out is
// paid later in a supplemental run of the same period, which HR approves
// before the employee sees it. A full run (20-payroll-flow) has no extra step.
//
// Runs after 20-payroll-flow (October 1-15 approved, everyone included).
//   E2E_SLOWMO=500 npx playwright test e2e/specs/20-payroll-flow.spec.mjs e2e/specs/99-partial-runs.spec.mjs
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, confirm } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_MAIN } from "../accounts.mjs";

const OCT1 = "October 1-15, 2026";
const OCT2 = "October 16-31, 2026";
const NOTE = "New hire, pending documents";

test.use({ viewport: { width: 1280, height: 800 } });

const clock = () => new Date().toLocaleTimeString("en-PH", { hour12: false, timeZone: "Asia/Manila" });
let n = 0;
const results = [];
const say = (t) => { n += 1; console.log(`  [#${n} ${clock()}] ${t}`); };
function check(where, ok, text) {
  results.push({ where, ok, text, step: n + 1, time: clock() });
  say(`${ok ? "PASS" : "FAIL"} ${where}: ${text}`);
  return ok;
}
/** A payslip for the period among those the employee is shown (not text inside another payslip). */
const hasPayslip = (res, label) => (res.data?.payslips || []).some((p) => p.period_label === label);
const runCard = (page) => main(page).locator("div.rounded-lg.border", { hasText: BRANCH_MAIN }).filter({ has: page.getByRole("button", { name: /Submit|Resubmit/ }) }).first();

async function openProcess(page, period = OCT2) {
  await page.goto(`/accountant?page=ac-process&period=${encodeURIComponent(period)}`);
  await main(page).waitFor();
  await settle(page);
}

async function processOne(page, name) {
  say(`Processing ${name} on her own (Process payroll →)…`);
  await openProcess(page);
  const trigger = main(page).locator("#pc-employee");
  try { await choose(page, trigger, new RegExp(name)); } catch { await page.keyboard.press("Escape"); await settle(page); await choose(page, trigger, new RegExp(name)); }
  await settle(page);
  await main(page).getByRole("button", { name: "Process payroll →" }).click();
  await page.locator("[data-sonner-toast]").first().waitFor({ timeout: 20000 }).catch(() => {});
  await settle(page);
}

test("partial runs: deliberate, visible, recorded, and followed up in a supplemental run", async ({ page, monitor }) => {
  test.setTimeout(20 * 60 * 1000);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const branch = await rows(db().from("branches").select("id").eq("name", BRANCH_MAIN).single());
  const oct1Run = await rows(db().from("payroll_runs").select("id,status").eq("branch_id", branch.id).eq("period_label", OCT1).maybeSingle());
  test.skip(oct1Run?.status !== "approved", "needs October 1-15 approved (run 20-payroll-flow first)");
  // October's 2nd half is generated today (as in 96/98), removed at the end.
  const day = Math.max(16, Number(new Date().toLocaleString("en-CA", { timeZone: "Asia/Manila" }).slice(8, 10)));
  const planted = psql(`set session_replication_role = replica;
    insert into payroll_schedule_settings (effective_from, first_half_day, second_half_day, window_days, note, created_by_name)
    values ('2026-10-16', 15, ${day}, 5, 'E2E partial runs: 2nd half generated today', 'E2E') returning id;`).split(/\s+/).pop();

  try {
    await step(page, "A full run (October 1-15, 20-payroll-flow) has no exclusion step and no record", async () => {
      const left = await rows(db().from("payroll_run_exclusions").select("id").eq("run_id", oct1Run.id));
      check("Full run", left.length === 0, `October 1-15 run: ${left.length} employees recorded as left out`);
    });

    await step(page, "Accountant processes only Ana for October 16-31", async () => {
      monitor.at("Accountant > Process Payroll");
      say("Logging in as Accountant…");
      await as(page, "accountant", `ac-process&period=${encodeURIComponent(OCT2)}`);
      await processOne(page, "Ana");
    });

    let leftOutIds = [];
    await step(page, "Accountant > the run card lists who is left out; Submit waits for the confirmation", async () => {
      await openProcess(page);
      const card = runCard(page);
      await card.scrollIntoViewIfNeeded();
      const ack = card.getByTestId("exclusion-ack");
      check("Acknowledge", await ack.isVisible(), "the left-out list appears on the run card");
      const text = (await ack.innerText()).replace(/\s+/g, " ");
      say(`Left-out list on screen: ${text.slice(0, 220)}`);
      check("Acknowledge", /Bea/.test(text) && !/Ana Lopez/.test(text), "Bea is listed, Ana (processed) is not");
      const submitBtn = card.getByRole("button", { name: /Submit for HR Approval/ });
      check("Acknowledge", await submitBtn.isDisabled(), "Submit is disabled before the confirmation");
      const status = await api(page, "GET", `/api/accountant/payroll-runs?period=${encodeURIComponent(OCT2)}`);
      leftOutIds = (status.data.runs.find((r) => r.branch_id === branch.id)?.missing || []).map((m) => m.id);
      say("Server check: submitting without the confirmation (direct API call)…");
      const blind = await api(page, "PATCH", "/api/accountant/payroll-runs", { action: "submit", branch_id: branch.id, period: OCT2 });
      check("Acknowledge", blind.status === 409 && blind.data?.code === "exclusions_unacknowledged", `the API refuses it too (${blind.status} ${blind.data?.code})`);
      say(`Typing a note for Bea: "${NOTE}"…`);
      await card.locator(`#ex-note-${branch.id}-${bea.id}`).fill(NOTE);
      await page.waitForTimeout(800);
      say("Ticking “I confirm these employees are intentionally excluded…”…");
      await card.locator(`#ex-ack-${branch.id}`).click();
      check("Acknowledge", await submitBtn.isEnabled(), "Submit becomes clickable after the confirmation");
      say("Clicking Submit for HR Approval…");
      await submitBtn.click();
      await confirm(page, "Submit for HR Approval");
      await page.locator("[data-sonner-toast]").first().waitFor({ timeout: 20000 }).catch(() => {});
      const toast = (await page.locator("[data-sonner-toast]").allInnerTexts()).join(" | ").replace(/\s+/g, " ");
      check("Submit", /Submitted for HR Approval/.test(toast) && /left out/.test(toast), `on screen: ${toast.slice(0, 160)}`);
    });

    const run1 = await rows(db().from("payroll_runs").select("id,status,run_no,submission_no,total_employees").eq("branch_id", branch.id).eq("period_label", OCT2).eq("run_no", 1).single());
    const stored = await rows(db().from("payroll_run_exclusions").select("*").eq("run_id", run1.id));
    check("Record", run1.status === "pending" && run1.total_employees === 1, `run 1 is ${run1.status} with ${run1.total_employees} employee`);
    check("Record", stored.length === leftOutIds.length && stored.some((x) => x.employee_id === bea.id && x.reason === NOTE), `${stored.length} left out stored, Bea with her note`);

    await step(page, "HR > Payroll Approval > the run shows who was left out, before approving", async () => {
      monitor.at("HR > Payroll Approval");
      say("Logging in as HR…");
      await as(page, "hr", "hr-payroll-approval");
      await page.getByRole("tab", { name: /Pending HR Approval/ }).click();
      await settle(page);
      const row = main(page).locator("tr", { hasText: OCT2 }).filter({ hasText: BRANCH_MAIN }).first();
      check("HR list", /left out/.test(await row.innerText()), "the pending list shows the left-out count");
      await row.getByRole("button", { name: "Review" }).click();
      await settle(page);
      const alert = main(page).getByTestId("run-exclusions");
      check("HR review", await alert.isVisible(), "the left-out list is on the review screen, above the figures");
      const text = (await alert.innerText()).replace(/\s+/g, " ");
      say(`HR sees: ${text.slice(0, 220)}`);
      check("HR review", text.includes("Bea") && text.includes(NOTE), "Bea and the Accountant's note are shown");
      await page.waitForTimeout(2500);
      say("Clicking Approve (the dialog repeats the warning)…");
      await main(page).getByRole("button", { name: "Approve", exact: true }).click();
      const dialog = page.getByRole("dialog");
      check("HR approve", /left out/.test(await dialog.innerText()), "the approve dialog warns that employees were left out");
      await dialog.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 30000 });
      const after = await rows(db().from("payroll_runs").select("status").eq("id", run1.id).single());
      check("HR approve", after.status === "approved", `run 1 is ${after.status}`);
    });

    await step(page, "Follow-up lists: Bea is waiting (HR and Accountant)", async () => {
      await page.goto("/hr?page=hr-payroll-approval");
      await settle(page);
      const hrList = await api(page, "GET", "/api/hr/payroll-runs?view=excluded");
      check("Follow-up", (hrList.data?.excluded || []).some((x) => x.employee_id === bea.id && x.follow_up === "not_processed" && x.reason === NOTE), "HR's list has Bea, not processed yet, with the note");
      const card = main(page).locator("[data-slot=card]").filter({ has: page.locator("[data-slot=card-title]", { hasText: "Employees left out of a payroll run" }) }).first();
      await card.scrollIntoViewIfNeeded();
      check("Follow-up", /Bea/.test(await card.innerText()), "HR's 'Employees left out' card lists Bea");
      await page.waitForTimeout(1500);
    });

    await step(page, "Employee (Bea) > no October 16-31 payslip yet", async () => {
      await as(page, "employee2", "emp-payslips");
      const res = await api(page, "GET", "/api/employee/payslips");
      check("Employee", !hasPayslip(res, OCT2), "Bea has no October 16-31 payslip while she is left out");
    });

    await step(page, "Accountant processes Bea later: a supplemental run, not blocked by the approved run", async () => {
      monitor.at("Accountant > supplemental run");
      await as(page, "accountant", `ac-process&period=${encodeURIComponent(OCT2)}`);
      const reproAna = await api(page, "PATCH", "/api/accountant/payroll", { action: "generate", employee_id: ana.id, pay_period: OCT2, reprocess: true });
      check("Locks", reproAna.status === 409, `Ana's approved payslip stays locked (${reproAna.status} ${reproAna.data?.code || ""})`);
      await processOne(page, "Bea");
      const beaEntry = await rows(db().from("payroll_entries").select("status,run_id").eq("employee_id", bea.id).eq("pay_period", OCT2).single());
      check("Supplemental", beaEntry.status === "paid" && !beaEntry.run_id, "Bea's Final payslip is made after run 1 was approved");
      await openProcess(page);
      const card = runCard(page);
      await card.scrollIntoViewIfNeeded();
      const text = (await card.innerText()).replace(/\s+/g, " ");
      check("Supplemental", /Supplemental run 2/.test(text), "the run card offers Supplemental run 2");
      const ack = card.getByTestId("exclusion-ack");
      if (await ack.isVisible().catch(() => false)) {
        say("Others are still left out: confirming again for run 2…");
        await card.locator(`#ex-ack-${branch.id}`).click();
      }
      say("Clicking Submit supplemental run 2…");
      await card.getByRole("button", { name: /Submit supplemental run 2/ }).click();
      await confirm(page, "Submit for HR Approval");
      await page.locator("[data-sonner-toast]").first().waitFor({ timeout: 20000 }).catch(() => {});
    });

    const run2 = await rows(db().from("payroll_runs").select("id,status,run_no,total_employees").eq("branch_id", branch.id).eq("period_label", OCT2).eq("run_no", 2).maybeSingle());
    check("Supplemental", run2?.status === "pending" && run2.total_employees === 1, `run 2 is ${run2?.status} with ${run2?.total_employees} employee (Bea)`);
    const items2 = run2 ? await rows(db().from("payroll_run_items").select("employee_id").eq("run_id", run2.id)) : [];
    check("Supplemental", items2.length === 1 && items2[0].employee_id === bea.id, "run 2 holds only Bea; Ana stays in run 1");

    await step(page, "Bea still sees nothing until HR approves run 2; HR approves", async () => {
      await as(page, "employee2", "emp-payslips");
      const before = await api(page, "GET", "/api/employee/payslips");
      check("Employee", !hasPayslip(before, OCT2), "not visible while run 2 waits for HR");
      await as(page, "hr", "hr-payroll-approval");
      await page.getByRole("tab", { name: /Pending HR Approval/ }).click();
      await settle(page);
      await main(page).locator("tr", { hasText: OCT2 }).filter({ hasText: BRANCH_MAIN }).first().getByRole("button", { name: "Review" }).click();
      await settle(page);
      const title = await main(page).locator("[data-slot=card-title]").first().innerText();
      check("HR review", /Supplemental run 2/.test(title), `HR sees "${title.replace(/\s+/g, " ").trim()}"`);
      say("HR approving supplemental run 2…");
      await main(page).getByRole("button", { name: "Approve", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
      await as(page, "employee2", "emp-payslips");
      await settle(page);
      const after = await api(page, "GET", "/api/employee/payslips");
      check("Employee", hasPayslip(after, OCT2), "Bea sees her October 16-31 payslip after run 2 is approved");
    });

    await step(page, "The record stays; Bea leaves the follow-up list", async () => {
      await as(page, "hr", "hr-payroll-approval");
      const list = await api(page, "GET", "/api/hr/payroll-runs?view=excluded");
      check("Follow-up", !(list.data?.excluded || []).some((x) => x.employee_id === bea.id), "Bea is no longer waiting");
      const detail = await api(page, "GET", `/api/hr/payroll-runs?run_id=${run1.id}`);
      check("Record", (detail.data?.exclusions || []).some((x) => x.employee_id === bea.id && x.reason === NOTE), "run 1 still records that Bea was left out, with the note");
      const kept = await rows(db().from("payroll_run_exclusions").select("id").eq("run_id", run1.id).eq("employee_id", bea.id));
      let refused = false;
      try { psql(`delete from payroll_run_exclusions where id = '${kept[0].id}';`); } catch { refused = true; }
      check("Record", refused, "the record cannot be deleted");
    });
  } finally {
    psql(`set session_replication_role = replica; delete from payroll_schedule_settings where id = '${planted}';`);
  }
});

test.afterAll(() => {
  const line = "=".repeat(70);
  console.log(`\n${line}\n PARTIAL RUNS SUMMARY (${clock()}): ${results.filter((r) => r.ok).length}/${results.length} PASS\n${line}`);
  for (const r of results) console.log(`   ${r.ok ? "PASS" : "FAIL"}  #${r.step} ${r.time}  ${r.where}: ${r.text}`);
  console.log(line);
});
