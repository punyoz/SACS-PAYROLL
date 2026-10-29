// Payroll handoff and year rollover, live and watchable (2026-10-29).
//
// Part 1: the Accountant processes October 16-31 (one employee on her own,
// then "Process payroll for all"), checks the Computation summary, submits
// to HR; HR sees the full breakdown and approves; the Accountant's record
// and the Employee's payslip carry the same figures. Each figure is compared
// across the four places it appears.
//
// Part 2 (needs E2E_TIME_TRAVEL=1): the server's "today" moves to Dec 15,
// Dec 29 and Jan 15 so December 2026 and January 2027 can be processed as
// they would be then; 2027 rates, a future rate entry, the tax year choice
// after New Year, tenure crossing two years, breaks per school year and the
// yearly holiday calendar are checked.
//
//   E2E_TIME_TRAVEL=1 E2E_SLOWMO=500 npx playwright test e2e/specs/20-payroll-flow.spec.mjs e2e/specs/98-handoff-rollover.spec.mjs
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, confirm } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_MAIN } from "../accounts.mjs";
import { TIME_TRAVEL, shiftBrowser, travelHome, travelTo } from "../support/time-travel.mjs";

const OCT2 = "October 16-31, 2026";
const DEC1 = "December 1-15, 2026";
const DEC2 = "December 16-31, 2026";
const JAN1 = "January 1-15, 2027";
const JAN2 = "January 16-31, 2027";
const FEB2 = "February 16-28, 2027";

test.use({ viewport: { width: 1280, height: 800 } });

// ── Live log: numbered, timed steps; problems pause on screen ──────────────
const log = { n: 0, problems: [], checks: [] };
const clock = () => new Date().toLocaleTimeString("en-PH", { hour12: false, timeZone: "Asia/Manila" });
function say(text) { log.n += 1; console.log(`  [#${log.n} ${clock()}] ${text}`); return log.n; }
async function problem(page, where, text) {
  const n = say(`PROBLEM (${where}): ${text}`);
  log.problems.push({ step: n, time: clock(), where, text });
  if (page) await page.waitForTimeout(4000);
}
function check(where, ok, text) {
  log.checks.push({ where, ok, text });
  say(`${ok ? "OK  " : "FAIL"} ${where}: ${text}`);
  if (!ok) log.problems.push({ step: log.n, time: clock(), where, text });
  return ok;
}
/** Report the monitor's errors seen since `from` against the step that caused them. */
async function reportIssues(page, monitor, from, where) {
  for (const i of monitor.issues.slice(from)) await problem(page, where, `${i.kind}: ${i.text}`);
}

const num = (v) => Math.round((Number(v) || 0) * 100) / 100;
const peso = (text) => num(String(text || "").replace(/[^0-9.-]/g, ""));
const near = (a, b) => Math.abs(num(a) - num(b)) <= 0.01;
// The summary shows deductions as "- ₱900.00"; the payslip stores 900.
const nearAbs = (a, b) => near(Math.abs(num(a)), Math.abs(num(b)));

/** The Computation summary card: { label -> amount }. */
async function computationSummary(page) {
  const card = main(page).locator("[data-slot=card]").filter({ has: page.locator("[data-slot=card-title]", { hasText: "Computation summary" }) }).first();
  await card.scrollIntoViewIfNeeded();
  const pairs = await card.locator("div.flex.items-baseline.justify-between").evaluateAll((els) => els.map((el) => [...el.children].map((c) => c.textContent.trim())));
  const out = {};
  for (const [label, value] of pairs) if (label && value) out[label] = peso(value);
  return out;
}
const pick = (summary, re) => { const k = Object.keys(summary).find((l) => re.test(l)); return k ? summary[k] : undefined; };

/** Pick an employee in the entry form; the list can re-render while the page loads, so try again once. */
async function chooseEmployee(page, name) {
  await settle(page);
  try {
    await choose(page, main(page).locator("#pc-employee"), name);
  } catch {
    await page.keyboard.press("Escape");
    await settle(page);
    await choose(page, main(page).locator("#pc-employee"), name);
  }
}

async function plantSecondHalfToday(day) {
  return psql(`set session_replication_role = replica;
    insert into payroll_schedule_settings (effective_from, first_half_day, second_half_day, window_days, note, created_by_name)
    values ('2026-10-16', 15, ${day}, 5, 'E2E handoff: 2nd half generated on day ${day}', 'E2E') returning id;`).split(/\s+/).pop();
}

async function waitForResponse(page, where, okText) {
  // A click must produce something visible: a toast, a status line or a dialog change.
  const seen = await Promise.race([
    page.locator("[data-sonner-toast]").first().waitFor({ timeout: 15000 }).then(() => "toast"),
    page.getByText(okText).first().waitFor({ timeout: 15000 }).then(() => "text"),
  ]).catch(() => null);
  if (!seen) await problem(page, where, "the click produced no visible response within 15 s");
  const toasts = (await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ");
  if (toasts) say(`${where}: on screen: ${toasts.slice(0, 200)}`);
  return toasts;
}

// ── Part 1 ─────────────────────────────────────────────────────────────────
test("Part 1: Accountant → HR handoff keeps every figure", async ({ page, monitor }) => {
  test.setTimeout(30 * 60 * 1000);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const hr = await profileByEmail(ACCOUNTS.hr.email);
  const oct1 = await rows(db().from("payroll_entries").select("id,status").eq("employee_id", ana.id).eq("pay_period", "October 1-15, 2026"));
  test.skip(!oct1.length || oct1[0].status !== "paid", "needs October 1-15 approved (run 20-payroll-flow first)");
  const branch = await rows(db().from("branches").select("id").eq("name", BRANCH_MAIN).single());
  const today = Number(new Date().toLocaleString("en-CA", { timeZone: "Asia/Manila" }).slice(8, 10));
  const planted = await plantSecondHalfToday(Math.max(16, today));

  try {
    say("Setting up: an incentive (₱1,500) and a salary loan (₱3,000 over 3 payslips) for Ana, both approved by HR…");
    const [incentive] = await rows(db().from("payroll_monthly_incentives").insert({
      employee_id: ana.id, branch_id: ana.branch_id, item_date: "2026-10-20", kind: "incentive", description: "E2E handoff incentive", amount: 1500,
      archived: false, approval_status: "pending", created_at: "2026-10-20T01:00:00Z",
    }).select("id"));
    expect((await db().rpc("payroll_adjustment_decide", { p_actor: hr.id, p_kind: "incentive", p_id: incentive.id, p_decision: "approve", p_note: null })).error?.message).toBeUndefined();
    // Approved "on Oct 20": an approval after October's cutoff is paid in November (intended).
    psql(`set session_replication_role = replica; update payroll_monthly_incentives set decided_at = '2026-10-20T02:00:00Z' where id = '${incentive.id}';`);

    say("Logging in as Accountant…");
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(OCT2)}`);
    const loanRes = await api(page, "POST", "/api/accountant/loans", { action: "create_loan", employee_id: ana.id, loan_type: "salary_loan", principal: 3000, number_of_payrolls: 3, date_granted: "2026-10-20", start_period: "2026-10-16", description: "E2E handoff loan" });
    check("Setup", loanRes.status < 300, `salary loan filed (${loanRes.status}${loanRes.data?.error ? `: ${loanRes.data.error}` : ""})`);
    const [loan] = await rows(db().from("payroll_loans").select("id").eq("employee_id", ana.id).eq("description", "E2E handoff loan"));
    if (loan) expect((await db().rpc("payroll_adjustment_decide", { p_actor: hr.id, p_kind: "loan", p_id: loan.id, p_decision: "approve", p_note: null })).error?.message).toBeUndefined();

    // 1-3. Single entry: Ana.
    let summary;
    await step(page, "Accountant > Process Payroll > Ana (single entry)", async () => {
      monitor.at("Accountant > Process Payroll (single)");
      say(`Navigating to Process Payroll, branch ${BRANCH_MAIN}, period ${OCT2}…`);
      await page.goto(`/accountant?page=ac-process&period=${encodeURIComponent(OCT2)}`);
      await main(page).waitFor();
      await settle(page);
      say("Selecting Ana in the payroll entry form…");
      await chooseEmployee(page, /Ana/);
      await settle(page);
      summary = await computationSummary(page);
      say(`Computation summary: ${Object.entries(summary).map(([k, v]) => `${k} ${v}`).join(" · ").slice(0, 600)}`);
      for (const [label, re] of [["Gross pay", /^Gross pay/], ["SSS", /^SSS/], ["PhilHealth", /^PhilHealth/], ["Pag-IBIG", /^Pag-IBIG/], ["Loans", /^Loans/], ["Incentives", /Incentives \/ overload|other incentives/]]) {
        check("Computation summary", pick(summary, re) !== undefined, `${label} line shown (${pick(summary, re)})`);
      }
      check("Computation summary", Math.abs(pick(summary, /^Loans/) || 0) > 0, "the approved loan's installment is deducted");
      check("Computation summary", (pick(summary, /Incentives \/ overload/) || 0) + (pick(summary, /other incentives/) || 0) >= 1500, "the approved ₱1,500 incentive is added");
      await page.waitForTimeout(1500);
      say("Clicking Process payroll → for Ana…");
      const before = monitor.issues.length;
      await main(page).getByRole("button", { name: "Process payroll →" }).click();
      await waitForResponse(page, "Process (single)", "Payroll processed successfully");
      await reportIssues(page, monitor, before, "Process (single)");
      await settle(page);
    });

    await step(page, "Accountant > Process Payroll > Process payroll for all", async () => {
      monitor.at("Accountant > Process Payroll (batch)");
      await page.goto(`/accountant?page=ac-process&period=${encodeURIComponent(OCT2)}`);
      await main(page).waitFor();
      await settle(page);
      say("Clicking Process payroll for all →…");
      const before = monitor.issues.length;
      await main(page).getByRole("button", { name: "Process payroll for all →" }).click();
      await confirm(page, "Process payroll");
      await waitForResponse(page, "Process (batch)", "Batch Payroll Processed");
      await reportIssues(page, monitor, before, "Process (batch)");
    });

    const entry = await rows(db().from("payroll_entries").select("*").eq("employee_id", ana.id).eq("pay_period", OCT2).single());
    const people = await rows(db().from("payroll_entries").select("employee_name,status").eq("branch_id", branch.id).eq("pay_period", OCT2));
    say(`Processed for ${OCT2}: ${people.map((p) => `${p.employee_name} (${p.status})`).join(", ")}`);
    // 2nd half (decision 2026-10-29): "Gross pay" is this payslip's gross, as
    // HR and the employee see it; the month's is its own "Monthly gross" line.
    const payslipGross = pick(summary, /^Gross pay/);
    const monthGross = pick(summary, /^Monthly gross/);
    const firstHalf = await rows(db().from("payroll_entries").select("gross_pay").eq("employee_id", ana.id).eq("pay_period", "October 1-15, 2026").single());
    check("Process → database", near(payslipGross, entry.gross_pay), `summary "Gross pay" ${payslipGross} = the payslip's gross ${entry.gross_pay}`);
    // The cutoff gross includes this payslip's incentives, which the summary lists on their own lines.
    const cutoffIncentives = num(entry.payroll?.totals?.total_incentives);
    check("Process → database", near(monthGross, num(entry.gross_pay) - cutoffIncentives + num(firstHalf.gross_pay)), `summary "Monthly gross" ${monthGross} = 1st half ${firstHalf.gross_pay} + this cutoff ${entry.gross_pay} less its incentives ${cutoffIncentives}`);
    for (const [k, re] of [["sss", /^SSS/], ["philhealth", /^PhilHealth/], ["pagibig", /^Pag-IBIG/], ["withholding_tax", /^Withholding tax/]]) {
      check("Process → database", nearAbs(entry[k], pick(summary, re)), `${k}: summary ${pick(summary, re)} vs stored ${entry[k]}`);
    }
    check("Process → database", nearAbs(entry.payroll?.totals?.loan_deduction, pick(summary, /^Loans/)), `loans: summary ${pick(summary, /^Loans/)} vs stored ${entry.payroll?.totals?.loan_deduction}`);
    check("Process → database", near(entry.net_pay, pick(summary, /net pay$/i)), `net pay: summary ${pick(summary, /net pay$/i)} vs stored ${entry.net_pay}`);

    // 4. Submit.
    await step(page, "Accountant > Submit for HR Approval", async () => {
      monitor.at("Accountant > submit");
      await page.goto(`/accountant?page=ac-process&period=${encodeURIComponent(OCT2)}`);
      await main(page).waitFor();
      await settle(page);
      say("Submitting payroll for HR approval…");
      const card = main(page).locator("div.rounded-lg.border", { hasText: BRANCH_MAIN }).filter({ has: page.getByRole("button", { name: /Submit for HR Approval/ }) }).first();
      const before = monitor.issues.length;
      await card.getByRole("button", { name: "Submit for HR Approval" }).click();
      await confirm(page, "Submit for HR Approval");
      await waitForResponse(page, "Submit", "Pending HR Approval");
      await reportIssues(page, monitor, before, "Submit");
      const run = await rows(db().from("payroll_runs").select("id,status").eq("branch_id", branch.id).eq("period_label", OCT2).single());
      check("Submit", run.status === "pending", `run status after submit: ${run.status}`);
    });

    // 5-7. HR.
    const run = await rows(db().from("payroll_runs").select("id,status,total_gross,total_net").eq("branch_id", branch.id).eq("period_label", OCT2).single());
    const item = await rows(db().from("payroll_run_items").select("*").eq("run_id", run.id).eq("employee_id", ana.id).single());
    for (const k of ["gross_pay", "sss", "philhealth", "pagibig", "withholding_tax", "net_pay"]) {
      check("Submitted → HR's run", near(item[k], entry[k]), `${k}: payslip ${entry[k]} vs HR run item ${item[k]}`);
    }
    check("Submitted → HR's run", num(item.loans) > 0 && nearAbs(item.loans, pick(summary, /^Loans/)), `loans: summary ${pick(summary, /^Loans/)} vs HR run item ${item.loans}`);
    check("Submitted → HR's run", num(item.total_incentives) >= 1500, `incentives on HR's item: ${item.total_incentives}`);

    await step(page, "HR > Payroll Approval > Review > full breakdown > Approve", async () => {
      monitor.at("HR > Payroll Approval");
      say("Logging out, logging in as HR…");
      await as(page, "hr", "hr-payroll-approval");
      await page.getByRole("tab", { name: /Pending HR Approval/ }).click();
      await settle(page);
      say(`Opening the ${BRANCH_MAIN} ${OCT2} run…`);
      await main(page).locator("tr", { hasText: OCT2 }).filter({ hasText: BRANCH_MAIN }).first().getByRole("button", { name: "Review" }).click();
      await settle(page);
      const row = main(page).locator("tr", { hasText: "Ana" }).first();
      const rowText = (await row.innerText()).replace(/\s+/g, " ");
      for (const k of ["gross_pay", "sss", "philhealth", "pagibig", "loans"]) {
        const shown = rowText.includes(Number(item[k]).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        check("HR review row", shown, `${k} ${item[k]} shown in Ana's row`);
      }
      say("Expanding Ana's row for the full computation…");
      await row.getByRole("button", { name: /Show .* computation/ }).click();
      await page.waitForTimeout(1200);
      const breakdown = (await main(page).locator("tr", { hasText: /earnings/i }).first().innerText().catch(() => "")).replace(/\s+/g, " ");
      check("HR breakdown", /earnings/i.test(breakdown) && /gross pay/i.test(breakdown), "the breakdown opens with Earnings and Gross pay");
      check("HR breakdown", /incentive/i.test(breakdown), "the incentive line is in the breakdown");
      check("HR breakdown", /loan/i.test(breakdown), "the loan line is in the breakdown");
      check("HR breakdown", /sss/i.test(breakdown) && /philhealth/i.test(breakdown) && /pag-?ibig/i.test(breakdown), "SSS / PhilHealth / Pag-IBIG lines are in the breakdown");
      await page.waitForTimeout(2500);
      say("Clicking Approve as HR…");
      const before = monitor.issues.length;
      await main(page).getByRole("button", { name: "Approve", exact: true }).click();
      await page.locator("#pa-remarks").fill("E2E handoff approved");
      await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
      await waitForResponse(page, "Approve", "Approved");
      await reportIssues(page, monitor, before, "Approve");
      const after = await rows(db().from("payroll_runs").select("status").eq("id", run.id).single());
      check("Approve", after.status === "approved", `run status after approve: ${after.status}`);
    });

    // 8. Accountant record and Employee payslip.
    const final = await rows(db().from("payroll_entries").select("*").eq("id", entry.id).single());
    for (const k of ["gross_pay", "sss", "philhealth", "pagibig", "withholding_tax", "total_deductions", "net_pay"]) {
      check("Approval → stored payslip", near(final[k], entry[k]), `${k}: before approval ${entry[k]}, after ${final[k]}`);
    }
    await step(page, "Accountant > Payroll Records > Ana's payslip", async () => {
      monitor.at("Accountant > Payroll Records");
      say("Logging in as Accountant, opening Payroll Records…");
      await as(page, "accountant", "ac-records");
      await settle(page);
      const rowText = (await main(page).locator("tr", { hasText: OCT2 }).filter({ hasText: "Ana" }).first().innerText()).replace(/\s+/g, " ");
      check("Accountant record", /Paid/.test(rowText), `Ana's ${OCT2} record: ${rowText.slice(0, 120)}`);
    });
    await step(page, "Employee > Payslips > October 16-31", async () => {
      monitor.at("Employee > Payslips");
      say("Logging in as Employee (Ana), opening Payslips…");
      await as(page, "employee", "emp-payslips");
      await settle(page);
      const res = await api(page, "GET", "/api/employee/payslips");
      const list = res.data?.payslips || res.data?.records || res.data?.data || [];
      const mine = (Array.isArray(list) ? list : []).find((p) => (p.period_label || p.pay_period) === OCT2);
      check("Employee payslip", Boolean(mine), `${OCT2} payslip visible to Ana`);
      if (mine) {
        check("Employee payslip", near(mine.gross_pay, final.gross_pay), `gross: employee ${mine.gross_pay} vs stored ${final.gross_pay}`);
        check("Employee payslip", near(mine.total_deductions, final.total_deductions), `deductions: employee ${mine.total_deductions} vs stored ${final.total_deductions}`);
        check("Employee payslip", near(mine.net_pay, final.net_pay), `net: employee ${mine.net_pay} vs stored ${final.net_pay}`);
      }
      const shown = await main(page).getByText(OCT2).first().isVisible().catch(() => false);
      check("Employee payslip", shown, `${OCT2} listed on screen`);
      await page.waitForTimeout(2000);
    });
  } finally {
    if (planted) psql(`set session_replication_role = replica; delete from payroll_schedule_settings where id = '${planted}';`);
  }
});

// ── Part 2 ─────────────────────────────────────────────────────────────────
/** Weekday attendance 07:00-17:00 for the Main Campus people, skipping the holidays in the table. */
function plantAttendance(from, to) {
  // The hard-delete guard is bypassed for the delete only (as e2e/fixtures.sql).
  psql(`begin; set local session_replication_role = replica;
    delete from attendance_logs where log_date between '${from}' and '${to}' and employee_id in (select id from profiles where email like '%@e2e.test');
    set local session_replication_role = origin;
    insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out, status)
    select p.id, p.full_name, p.employee_type, p.branch_id, d::date,
      (d::date + time '07:00') at time zone 'Asia/Manila', (d::date + time '17:00') at time zone 'Asia/Manila', 'Absent'
    from profiles p cross join generate_series('${from}'::date, '${to}'::date, '1 day') d
    where p.email in ('emp1@e2e.test','emp2@e2e.test','acct@e2e.test','hr@e2e.test','emp3@e2e.test')
      and extract(isodow from d) < 6
      and not exists (select 1 from attendance_holidays h where h.holiday_date = d::date and h.day_part = 'whole');
    commit;`);
}
/** Ana's run item for a period (HR's view of the payslip). */
async function runItem(employeeId, branchId, period) {
  const run = await rows(db().from("payroll_runs").select("id").eq("branch_id", branchId).eq("period_label", period).maybeSingle());
  return run ? rows(db().from("payroll_run_items").select("*").eq("run_id", run.id).eq("employee_id", employeeId).maybeSingle()) : null;
}

async function processAndApprove(page, period, branchId, { ui = false } = {}) {
  await as(page, "accountant", `ac-process&period=${encodeURIComponent(period)}`);
  await settle(page);
  if (ui) {
    say(`Clicking Process payroll for all → for ${period}…`);
    await main(page).getByRole("button", { name: "Process payroll for all →" }).click();
    await confirm(page, "Process payroll");
    await waitForResponse(page, `Process ${period}`, "Batch Payroll Processed");
  } else {
    say(`Processing ${period} for the branch (API)…`);
    const people = await rows(db().from("profiles").select("id").eq("branch_id", branchId).in("email", ["emp1@e2e.test", "emp2@e2e.test", "acct@e2e.test", "hr@e2e.test"]));
    const res = await api(page, "POST", "/api/accountant/payroll", { action: "batch_submit", pay_period: period, entries: people.map((p) => ({ employee_id: p.id })) });
    check(period, res.status === 200, `processed (${res.status}${res.data?.error ? `: ${res.data.error}` : ""}; failed ${JSON.stringify(res.data?.failed || []).slice(0, 200)})`);
  }
  say(`Submitting ${period} for HR approval…`);
  const sub = await api(page, "PATCH", "/api/accountant/payroll-runs", { action: "submit", branch_id: branchId, period });
  check(period, sub.status < 300, `submitted (${sub.status}${sub.data?.error ? `: ${sub.data.error}` : ""})`);
  const run = await rows(db().from("payroll_runs").select("id,status").eq("branch_id", branchId).eq("period_label", period).maybeSingle());
  await as(page, "hr", "hr-payroll-approval");
  say(`HR approving ${period}…`);
  const ok = await api(page, "PATCH", "/api/hr/payroll-runs", { action: "approve", run_id: run?.id, remarks: "E2E rollover" });
  check(period, ok.status < 300, `approved (${ok.status}${ok.data?.error ? `: ${ok.data.error}` : ""})`);
}

test("Part 2: December 2026 → January 2027 and beyond", async ({ page, monitor }) => {
  test.skip(!TIME_TRAVEL, "run with E2E_TIME_TRAVEL=1 (the server's today must move)");
  test.setTimeout(45 * 60 * 1000);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const carlo = await profileByEmail(ACCOUNTS.employee3.email);
  const hr = await profileByEmail(ACCOUNTS.hr.email);
  const branch = await rows(db().from("branches").select("id").eq("name", BRANCH_MAIN).single());
  const planted = await plantSecondHalfToday(29);
  const originalHire = carlo.date_hired;

  await shiftBrowser(page.context());
  // Signing in clears localStorage (e2e/support/auth.mjs), so after a role
  // switch the browser can be on today while the server is in December:
  // React then reports the server/client date text as a hydration mismatch.
  // That is the test's clock, not the app (real-date runs still catch it).
  monitor.allow(/Hydration failed because the server rendered text/, /Encountered a script tag while rendering React component/);
  try {
    say("Setting up: weekday attendance Dec 1, 2026 – Jan 15, 2027 (holidays skipped), and a December incentive for Ana…");
    plantAttendance("2026-12-01", "2027-01-15");
    const [inc] = await rows(db().from("payroll_monthly_incentives").insert({
      employee_id: ana.id, branch_id: ana.branch_id, item_date: "2026-12-10", kind: "incentive", description: "E2E December incentive", amount: 800,
      archived: false, approval_status: "pending", created_at: "2026-12-10T01:00:00Z",
    }).select("id"));
    await db().rpc("payroll_adjustment_decide", { p_actor: hr.id, p_kind: "incentive", p_id: inc.id, p_decision: "approve", p_note: null });
    psql(`set session_replication_role = replica; update payroll_monthly_incentives set decided_at = '2026-12-10T02:00:00Z' where id = '${inc.id}';`);

    // The server's clock really moved.
    await travelTo("2026-12-15", page);
    await as(page, "hr", "hr-tenure");
    const probe = await api(page, "GET", "/api/hr/tenure-protection");
    check("Time travel", probe.data?.today === "2026-12-15", `server today = ${probe.data?.today}`);

    say("=== December 1-15, 2026 (today = Dec 15) ===");
    await processAndApprove(page, DEC1, branch.id);

    await travelTo("2026-12-29", page);
    say("=== December 16-31, 2026 (today = Dec 29) ===");
    await step(page, "Accountant > Process Payroll > December 16-31 (year's last cutoff)", async () => {
      await as(page, "accountant", `ac-process&period=${encodeURIComponent(DEC2)}`);
      await settle(page);
      await chooseEmployee(page, /Ana/);
      await settle(page);
      const s = await computationSummary(page);
      say(`December 16-31 summary for Ana: ${Object.entries(s).map(([k, v]) => `${k} ${v}`).join(" · ").slice(0, 500)}`);
      check(DEC2, Math.abs(pick(s, /^SSS/) || 0) > 0 && Math.abs(pick(s, /^PhilHealth/) || 0) > 0 && Math.abs(pick(s, /^Pag-IBIG/) || 0) > 0, `SSS ${pick(s, /^SSS/)} / PhilHealth ${pick(s, /^PhilHealth/)} / Pag-IBIG ${pick(s, /^Pag-IBIG/)} computed (not ₱0)`);
      await page.waitForTimeout(2000);
    });
    await processAndApprove(page, DEC2, branch.id, { ui: true });
    const dec2 = await rows(db().from("payroll_entries").select("*").eq("employee_id", ana.id).eq("pay_period", DEC2).single());
    const dec2Item = await runItem(ana.id, branch.id, DEC2);
    check(DEC2, dec2.status === "paid", `Ana's payslip is ${dec2.status}`);
    check(DEC2, num(dec2.sss) > 0 && num(dec2.philhealth) > 0 && num(dec2.pagibig) > 0, `contributions ${dec2.sss} / ${dec2.philhealth} / ${dec2.pagibig}`);
    check(DEC2, JSON.stringify(dec2.payroll).includes("E2E December incentive") || num(dec2.payroll?.totals?.other_incentive) >= 800, "the December incentive is on December's payslip");
    check(DEC2, (dec2Item ? num(dec2Item.absent_days) : 0) === 0, `absences ${dec2Item?.absent_days ?? "n/a"} (Dec 25, 30, 31 are holidays, not absences)`);

    await travelTo("2027-01-15", page);
    say("=== January 1-15, 2027 (today = Jan 15, new year) ===");
    await processAndApprove(page, JAN1, branch.id, { ui: true });
    const jan1 = await rows(db().from("payroll_entries").select("*").eq("employee_id", ana.id).eq("pay_period", JAN1).single());
    const jan1Item = await runItem(ana.id, branch.id, JAN1);
    const janText = JSON.stringify(jan1.payroll);
    check(JAN1, jan1.status === "paid", `Ana's payslip is ${jan1.status}`);
    check(JAN1, !janText.includes("E2E December incentive"), "no December incentive carried into January");
    check(JAN1, !/2026-12-/.test(JSON.stringify(jan1.payroll?.sheet || jan1.payroll?.audit?.attendance || {})), "no December attendance days in January's sheet");
    check(JAN1, (jan1Item ? num(jan1Item.absent_days) : 0) === 0, `absences ${jan1Item?.absent_days ?? "n/a"} (Jan 1 is a holiday)`);
    check(JAN1, num(jan1.sss) === 0 && num(jan1.withholding_tax) === 0, "1st half: no contributions or tax (taken on the 2nd half)");
    check(JAN1, num(jan1.gross_pay) > 0 && num(jan1.net_pay) > 0, `gross ${jan1.gross_pay}, net ${jan1.net_pay}`);
    const remaining = await rows(db().from("payroll_loans").select("remaining_balance,status").eq("employee_id", ana.id).eq("description", "E2E handoff loan").maybeSingle()).catch(() => null);
    if (remaining) say(`Ana's loan after December: balance ${remaining.remaining_balance} (${remaining.status}) — a loan legitimately carries over.`);

    // 2. Rates for a year with no new entry: the latest in force applies.
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(JAN2)}`);
    const jan2 = await api(page, "GET", `/api/accountant/payroll?period=${encodeURIComponent(JAN2)}`);
    const janRow = (jan2.data?.attendance_rows || []).find((r) => r.employee_id === ana.id);
    check("2027 rates", num(janRow?.defaults?.sss) > 0 && num(janRow?.defaults?.philhealth) > 0 && num(janRow?.defaults?.pagibig) > 0,
      `January 16-31, 2027 (no 2027 rate rows): SSS ${janRow?.defaults?.sss}, PhilHealth ${janRow?.defaults?.philhealth}, Pag-IBIG ${janRow?.defaults?.pagibig} from the latest rates in force`);

    // 3. Super Admin adds a future rate; past payroll is untouched.
    await step(page, "Super Admin > Government Rates > add PhilHealth 3% from Feb 1, 2027", async () => {
      await as(page, "super_admin", "sa-config");
      await settle(page);
      say("Adding a PhilHealth rate of 3% effective Feb 1, 2027 (Super Admin)…");
      const res = await api(page, "POST", "/api/admin/payroll-rates", { rate_type: "philhealth_pct", scope: "global", value: 3, effective_date: "2027-02-01", note: "E2E future rate" });
      check("Future rate", res.status < 300, `saved (${res.status}${res.data?.error ? `: ${res.data.error}` : ""})`);
    });
    const dec2After = await rows(db().from("payroll_entries").select("philhealth,net_pay").eq("id", dec2.id).single());
    check("Future rate", near(dec2After.philhealth, dec2.philhealth) && near(dec2After.net_pay, dec2.net_pay), "December 2026's approved payslip unchanged");
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(FEB2)}`);
    const feb = await api(page, "GET", `/api/accountant/payroll?period=${encodeURIComponent(FEB2)}`);
    const jan2b = await api(page, "GET", `/api/accountant/payroll?period=${encodeURIComponent(JAN2)}`);
    const febRow = (feb.data?.attendance_rows || []).find((r) => r.employee_id === ana.id);
    const janRow2 = (jan2b.data?.attendance_rows || []).find((r) => r.employee_id === ana.id);
    check("Future rate", num(febRow?.defaults?.philhealth) > num(janRow2?.defaults?.philhealth),
      `PhilHealth January 2027 ${janRow2?.defaults?.philhealth} → February 2027 ${febRow?.defaults?.philhealth}`);

    // 4. Tax year choice after the new year.
    await step(page, "Accountant > Payroll Reports > year-end for 2026 (now in 2027)", async () => {
      await as(page, "accountant", "ac-reports");
      await settle(page);
      const card = (t) => main(page).locator("[data-slot=card]").filter({ has: page.locator("[data-slot=card-title]", { hasText: t }) }).first();
      const ye = card("Year-end tax annualization");
      await ye.scrollIntoViewIfNeeded();
      const yearBox = ye.getByRole("combobox", { name: "Annualization year" });
      await yearBox.click();
      const options = (await page.getByRole("option").allInnerTexts()).map((t) => t.trim());
      await page.keyboard.press("Escape");
      check("Tax year", options.includes("2026") && options.includes("2027"), `annualization years offered: ${options.join(", ")}`);
      await choose(page, yearBox, "2026");
      await settle(page);
      say("Running the 2026 annualization in January 2027…");
      await ye.getByRole("button", { name: /Run annualization|Run again/ }).click();
      await confirm(page, "Run annualization");
      const bir = card("BIR forms");
      await bir.scrollIntoViewIfNeeded();
      await settle(page, 40000);
      const birYear = (await bir.getByRole("combobox", { name: "Tax year" }).innerText()).trim();
      check("Tax year", birYear === "2026", `BIR forms open on ${birYear} (last year) in January 2027`);
      const res = await api(page, "GET", "/api/payroll/bir-forms?year=2026");
      const anaRow = (res.data?.rows || []).find((r) => r.employee_id === ana.id);
      const paid2026 = await rows(db().from("payroll_entries").select("withholding_tax,pay_period").eq("employee_id", ana.id).eq("status", "paid").like("pay_period", "%, 2026"));
      const withheld = num(paid2026.reduce((s, e) => s + num(e.withholding_tax), 0));
      check("Tax year", anaRow && near(anaRow.tax_withheld, withheld), `Ana's 2026 tax withheld: forms ${anaRow?.tax_withheld} vs her 2026 payslips ${withheld}`);
      const file = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
      await bir.getByRole("button", { name: "Alphalist (CSV)", exact: true }).click();
      check("Tax year", Boolean(await file), "2026 alphalist downloads in 2027");
    });

    // 5. Tenure crossing two years, no yearly update.
    psql(`update profiles set date_hired = '2025-01-12' where id = '${carlo.id}';`);
    await travelTo("2027-01-10", page);
    await as(page, "hr", "hr-tenure");
    let t = await api(page, "GET", "/api/hr/tenure-protection");
    let c = (t.data?.employees || []).find((e) => e.id === carlo.id || e.employee_id === carlo.id);
    check("Tenure", c && c.meets_tenure === false, `Jan 10, 2027 (hired Jan 12, 2025): meets 2 years = ${c?.meets_tenure}, eligible from ${c?.eligible_from}`);
    await travelTo("2027-01-15", page);
    t = await api(page, "GET", "/api/hr/tenure-protection");
    c = (t.data?.employees || []).find((e) => e.id === carlo.id || e.employee_id === carlo.id);
    check("Tenure", c && c.meets_tenure === true, `Jan 15, 2027: meets 2 years = ${c?.meets_tenure} (no manual update)`);

    // 6. Breaks per school year.
    check("Breaks", t.data?.school_year === "2026-2027" && (t.data?.school_years || []).includes("2027-2028"), `school year ${t.data?.school_year}; offered ${(t.data?.school_years || []).join(", ")}`);
    say("Saving a 2027-2028 Christmas break (HR)…");
    const before = await rows(db().from("school_break_periods").select("id,school_year,kind,start_date,end_date"));
    const saved = await api(page, "POST", "/api/hr/tenure-protection", { action: "save_break", school_year: "2027-2028", kind: "christmas", start_date: "2027-12-20", end_date: "2028-01-02", note: "E2E" });
    check("Breaks", saved.status < 300, `2027-2028 Christmas break saved (${saved.status}${saved.data?.error ? `: ${saved.data.error}` : ""})`);
    const after = await rows(db().from("school_break_periods").select("id,school_year,kind,start_date,end_date"));
    const untouched = before.every((b) => after.some((a) => a.id === b.id && a.start_date === b.start_date && a.end_date === b.end_date));
    check("Breaks", untouched, "earlier school years' breaks unchanged");
    await page.goto("/hr?page=hr-tenure");
    await settle(page);
    await page.waitForTimeout(2000);

    // 7. Holidays for a year nobody has entered (2028), as the Dec 1 job does.
    const made = psql("begin; select public.attendance_seed_holidays(2028); select count(*) from attendance_holidays where extract(year from holiday_date) = 2028; rollback;").split(/\s+/).filter(Boolean).pop();
    check("Holidays", Number(made) >= 11, `the yearly job builds 2028's holidays (${made} days; rolled back)`);
  } finally {
    await travelHome(page);
    psql(`set session_replication_role = replica; delete from payroll_schedule_settings where id = '${planted}';`);
    psql(`update profiles set date_hired = ${originalHire ? `'${originalHire}'` : "null"} where id = '${carlo.id}';`);
  }
});

test.afterAll(() => {
  const line = "=".repeat(70);
  console.log(`\n${line}\n HANDOFF + ROLLOVER SUMMARY (${clock()})\n${line}`);
  console.log(` Checks: ${log.checks.length}, passed ${log.checks.filter((c) => c.ok).length}, failed ${log.checks.filter((c) => !c.ok).length}`);
  for (const c of log.checks) console.log(`   ${c.ok ? "PASS" : "FAIL"}  ${c.where}: ${c.text}`);
  console.log(` Problems: ${log.problems.length}`);
  for (const p of log.problems) console.log(`   ! step #${p.step} at ${p.time}  ${p.where}: ${p.text}`);
  console.log(line);
});
