// Substitution payslip proof (2026-11-25, current rule: substitution paid as overtime,
// periods × 1 h × hourly × 125%, school policy 2026-11-26). LOCAL stack only; fake data only.
//
//   E2E_TIME_TRAVEL=1 E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test -c playwright.proof.config.mjs
//
// Plants: a fake branch, fake substitute "Benjie" (₱32,000, Regular, Teaching, Full-time) and fake
// absent teacher "T. Reyes" (Grade 5) with taps for every working day of November, T. Reyes's approved
// leave on Nov 5, and an HR-approved substitution (Nov 5, 09:00-11:00, 2 periods) that Benjie's taps cover.
// Then the REAL screens: the Accountant processes Nov 1-15 and (on a moved date, Dec 1) Nov 16-30,
// submits each run, HR approves it. The stored payslips are compared with the hand-computed figures
// (PASS/FAIL table) and every view is photographed into docs/reports/substitution-payslip-2026-11-25/.
// Everything planted is removed at the end (PROOF_KEEP=1 keeps it to look around).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { main, settle } from "../support/portal.mjs";
import { confirm, writeRemark } from "../support/flow.mjs";
import { db, plantOtp, psql, rows } from "../support/db.mjs";
import { TEST_OTP } from "../accounts.mjs";
import { travelHome, travelTo } from "../support/time-travel.mjs";

const OUT = join(process.cwd(), "docs", "reports", "substitution-payslip-2026-11-25");
const BRANCH = "Proof Branch";
const FIRST = "November 1-15, 2026";
const SECOND = "November 16-30, 2026";
const BENJIE = { email: "benjie.proof@e2e.test", first: "Benjie", last: "Proof", full: "Benjie Proof", code: "PROOF-001", salary: 32000 };
const REYES = { email: "treyes.proof@e2e.test", first: "T.", last: "Reyes", full: "T. Reyes", code: "PROOF-002", salary: 30000 };
const PASSWORD = `Proof-${Math.random().toString(36).slice(2, 10)}#Aa1`;   // local, never printed

test.describe.configure({ mode: "serial" });
test.setTimeout(10 * 60 * 1000);

const ctx = { branch: null, benjie: null, reyes: null, acct: null };
const results = [];
const peso = (n) => Math.round((Number(n) || 0) * 100) / 100;
const check = (what, expected, actual, working = "") => {
  const diff = peso(peso(actual) - peso(expected));
  results.push({ what, expected: peso(expected), actual: peso(actual), difference: diff, result: Math.abs(diff) < 0.005 ? "PASS" : "FAIL", working });
};
const shot = async (locator, name) => { await locator.screenshot({ path: join(OUT, `${name}.png`) }); };

/* ── Plant (fake, local) ────────────────────────────────────────────────── */

async function createPerson(p, branchId, level) {
  const sb = db();
  const meta = { role: "employee", full_name: p.full, employee_id: p.code, branch_id: branchId, basic_salary: p.salary, position: "Teacher",
    employee_type: "Teaching", employment_status: "Regular", employment_type: "Full-time", date_hired: "2025-06-01" };
  const created = await sb.auth.admin.createUser({ email: p.email, password: PASSWORD, email_confirm: true, user_metadata: meta });
  if (created.error) throw new Error(`create ${p.email}: ${created.error.message}`);
  const id = created.data.user.id;
  const profile = { id, email: p.email, role: "employee", full_name: p.full, first_name: p.first, last_name: p.last, employee_id: p.code, branch_id: branchId,
    basic_salary: p.salary, employee_type: "Teaching", employment_status: "Regular", employment_type: "Full-time", position: "Teacher",
    date_hired: "2025-06-01", employee_status: "Active", employee_level: level };
  const up = await sb.from("profiles").upsert(profile, { onConflict: "id" });
  if (up.error) throw new Error(`profile ${p.email}: ${up.error.message}`);
  return id;
}

async function cleanup() {
  // The Accountant test account back as it was (no branch, on payroll flag removed).
  psql(`update profiles set branch_id = null where email = 'acct@e2e.test';
        update auth.users set raw_user_meta_data = (raw_user_meta_data - 'branch_id') - 'on_payroll' where email = 'acct@e2e.test';`);
  const ids = (await db().from("profiles").select("id").in("email", [BENJIE.email, REYES.email])).data?.map((r) => r.id) || [];
  const branch = (await db().from("branches").select("id").eq("name", BRANCH).maybeSingle()).data;
  if (ids.length || branch) {
    const idList = ids.map((id) => `'${id}'`).join(",") || "null";
    // Every public table that names one of the fake people, then the fake branch's rows (replica: the
    // no-hard-delete guards are bypassed for these fake rows only).
    psql(`set session_replication_role = replica;
      do $$ declare r record; ids uuid[] := array[${idList}]::uuid[]; begin
        for r in select table_name, column_name from information_schema.columns
                 where table_schema = 'public' and data_type = 'uuid'
                   and column_name in ('employee_id', 'substitute_id', 'absent_employee_id', 'user_id', 'recipient_id', 'actor_id')
                   and table_name not in ('profiles')
                   and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') loop
          execute format('delete from public.%I where %I = any($1)', r.table_name, r.column_name) using ids;
        end loop;
        ${branch ? `for r in select table_name from information_schema.columns where table_schema = 'public' and column_name = 'branch_id' and data_type = 'uuid' and table_name not in ('profiles', 'branches')
          and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') loop
          execute format('delete from public.%I where branch_id = $1', r.table_name) using '${branch.id}'::uuid;
        end loop;` : ""}
      end $$;
      delete from public.leave_requests where id like 'proof-%';
      delete from public.profiles where id in (${idList});
      set session_replication_role = origin;
      delete from auth.users where id in (${idList});   -- cascades to auth.identities / sessions
      ${branch ? `delete from public.branches where id = '${branch.id}';` : ""}`);
  }
}

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  await cleanup();
  const sb = db();
  ctx.branch = (await rows(sb.from("branches").insert({ name: BRANCH }).select("id").single())).id;
  ctx.benjie = await createPerson(BENJIE, ctx.branch, "grade_school");
  ctx.reyes = await createPerson(REYES, ctx.branch, "grade_school");
  // The e2e Accountant works this branch for the proof and is not on its payroll (its own payslip is not part of it).
  psql(`update profiles set branch_id = '${ctx.branch}' where email = 'acct@e2e.test';
        update auth.users set raw_user_meta_data = raw_user_meta_data || jsonb_build_object('branch_id', '${ctx.branch}', 'on_payroll', false) where email = 'acct@e2e.test';`);
  // Taps 06:50-17:10 on every regular working day from Oct 26 (October's days after its cutoff are counted on the
  // Nov 1-15 payslip) to Nov 27 (not Nov 2 special day, Nov 20 suspension, Nov 30 holiday); T. Reyes is on leave on Nov 5.
  psql(`insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out, status)
        select p.id, p.full_name, 'Teaching', p.branch_id, d::date,
               (d::date + time '06:50') at time zone 'Asia/Manila', (d::date + time '17:10') at time zone 'Asia/Manila', 'On Time'
        from profiles p cross join generate_series('2026-10-26'::date, '2026-11-27'::date, '1 day') d
        where p.id in ('${ctx.benjie}', '${ctx.reyes}') and extract(isodow from d) < 6
          and d::date not in ('2026-11-02', '2026-11-20') and not (p.id = '${ctx.reyes}' and d::date = '2026-11-05');
        insert into leave_requests (id, employee_id, employee_name, position, leave_type, start_date, end_date, reason, proof_url, status, submitted_at, decided_at, updated_at, pay_status, branch_id, decided_by_name)
        values ('proof-reyes-nov5', '${ctx.reyes}', '${REYES.full}', 'Teacher', 'Vacation Leave', '2026-11-05', '2026-11-05', 'Proof (fake): family matter', '', 'approved', now(), now(), now(), 'with_pay', '${ctx.branch}', 'HR Officer');
        insert into substitutions (branch_id, sub_date, absent_employee_id, substitute_id, start_time, end_time, periods, class_section, leave_request_id, status, created_by_name, decided_by_name, decided_at, decision_note)
        values ('${ctx.branch}', '2026-11-05', '${ctx.reyes}', '${ctx.benjie}', '09:00', '11:00', 2, 'Grade 5', 'proof-reyes-nov5', 'approved', 'Proof Admin', 'HR Officer', now(), 'Approved (proof, fake)');`);
});

test.afterAll(async () => {
  await travelHome();
  if (process.env.PROOF_KEEP !== "1") await cleanup();
});

/* ── The real screens ───────────────────────────────────────────────────── */

const runCard = (page) => main(page).locator("div.rounded-lg.border", { hasText: BRANCH })
  .filter({ has: page.getByRole("button", { name: /Submit for HR Approval|Resubmit for HR Approval/ }) }).first();

async function processAndApprove(page, period) {
  const processUrl = `ac-process&period=${encodeURIComponent(period)}`;
  await as(page, "accountant", processUrl);
  await settle(page);
  await expect(main(page).getByText(BRANCH).first()).toBeVisible();
  await main(page).getByTestId("process-all").click();
  await confirm(page, "Process payroll");
  await expect(page.getByText(/Payroll processed for \d+ employee/).first()).toBeVisible({ timeout: 120000 });
  // The system recommends Perfect Attendance (₱500) for a full month; a run waits until HR decides it.
  // The hand computation has no incentive, so HR rejects these two (fake data, a remark is recorded).
  const recs = (await db().from("incentive_recommendations").select("id").in("employee_id", [ctx.benjie, ctx.reyes]).eq("status", "pending")).data || [];
  if (recs.length) {
    await as(page, "hr", "hr-adjustment-approvals");
    for (const r of recs) {
      const res = await page.request.fetch("/api/hr/adjustment-approvals", { method: "PATCH", headers: { "Content-Type": "application/json" },
        data: { kind: "rule_incentive", id: r.id, decision: "reject", note: "Proof run: kept out so the payslip shows the substitution alone" } });
      expect(res.status(), await res.text()).toBe(200);
    }
  }
  await as(page, "accountant", processUrl);
  await settle(page);
  await runCard(page).getByRole("button", { name: /Submit for HR Approval/ }).click();
  await confirm(page, "Submit for HR Approval");
  await expect(main(page).getByText("Pending HR approval").first()).toBeVisible();

  await as(page, "hr", "hr-payroll-approval");
  const back = main(page).getByRole("button", { name: "All runs" });
  if (await back.isVisible().catch(() => false)) { await back.click(); await settle(page); }
  await page.getByRole("tab", { name: /Pending HR approval/ }).click();
  await settle(page);
  await main(page).locator("tr", { hasText: period }).filter({ hasText: BRANCH }).first().getByRole("button", { name: "Review" }).click();
  await settle(page);
  await main(page).getByRole("button", { name: "Approve", exact: true }).click();
  await writeRemark(page, "pa-remark", "Proof run (fake data)");
  await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
  const run = await rows(db().from("payroll_runs").select("status").eq("branch_id", ctx.branch).eq("period_label", period).single());
  expect(run.status).toBe("approved");
}

async function loginBenjie(page) {
  await page.goto("/api/health");
  await page.context().clearCookies();
  await plantOtp(BENJIE.email);
  await page.goto("/login");
  await page.locator("#login-identity").waitFor();
  for (let i = 0; i < 5; i += 1) {
    await page.fill("#login-identity", BENJIE.email);
    await page.fill("#login-password", PASSWORD);
    if ((await page.inputValue("#login-identity")) === BENJIE.email && (await page.inputValue("#login-password")) === PASSWORD) break;
    await page.waitForTimeout(300);
  }
  await page.locator("form button[type=submit]").first().click();
  await expect(page.getByText("Check your email")).toBeVisible({ timeout: 30000 });
  await page.locator("#login-code").click();
  await page.keyboard.type(TEST_OTP, { delay: 40 });
  await page.waitForURL((url) => url.pathname.startsWith("/employee"), { timeout: 60000 });
}

const entryOf = async (id, period) => rows(db().from("payroll_entries").select("id,payroll,status").eq("employee_id", id).eq("pay_period", period).neq("status", "draft").single());
const docOf = (page) => main(page).locator("[data-print-area]").first();

test("1st half: process, submit, HR approves (Nov 25)", async ({ page }) => {
  await travelHome(page);
  await processAndApprove(page, FIRST);
});

test("2nd half: process, submit, HR approves (on Dec 1)", async ({ page }) => {
  await page.goto("/api/health");
  await travelTo("2026-12-01", page);
  await processAndApprove(page, SECOND);
});

test("the numbers: stored payslips vs the hand computation", async () => {
  const b1 = await entryOf(ctx.benjie, FIRST);
  const b2 = await entryOf(ctx.benjie, SECOND);
  const r1 = await entryOf(ctx.reyes, FIRST);
  const subLines = (b1.payroll.audit?.lines?.incentives || []).filter((l) => l.type === "substitution");
  const sub = subLines.reduce((s, l) => s + Number(l.amount || 0), 0);
  // The system's own method: daily = monthly × 12 ÷ working days a year (261); hourly = daily ÷ 8, to the
  // centavo (the payslip shows ₱183.91 and multiplies that figure); then periods × 1 h × hourly × 125%.
  const daily = BENJIE.salary * 12 / 261;
  const hourly = peso(daily / 8);
  const expectedSub = peso(2 * 1 * hourly * 1.25);
  const m = b2.payroll.monthly || {};
  const d2 = b2.payroll.deductions || {};
  // The system's own Perfect Attendance rule (₱500 a half on these rates, full attendance) pays on the 1st half
  // by itself; it is not taxable here (the taxable income below leaves it out). Shown as its own line.
  const perfect = (b1.payroll.audit?.lines?.incentives || []).filter((l) => l.type === "perfect_attendance").reduce((s, l) => s + Number(l.amount || 0), 0);
  const monthGross = peso(BENJIE.salary + expectedSub + 500);
  const contributions = 1600 + 800 + 200;
  const taxable = peso(BENJIE.salary + expectedSub - contributions);
  const tax = peso((taxable - 20833) * 0.15);

  check("Substitution line (Nov 5, 1st half)", expectedSub, sub, `2 periods × 1 h × ₱${hourly.toFixed(2)} (₱32,000 × 12 ÷ 261 = ₱${daily.toFixed(4)} a day ÷ 8) × 125% = ₱${(2 * hourly * 1.25).toFixed(4)}`);
  check("1st half basic pay", 16000, b1.payroll.basic_salary, "₱32,000 ÷ 2");
  check("Perfect attendance (system rule, 1st half; not substitution)", 500, perfect, "full attendance Oct 26 - Nov 13 on these rates");
  check("1st half gross (as the payslip shows it)", peso(16000 + expectedSub + 500), b1.payroll.monthly?.cutoff?.gross_pay, "₱16,000 + substitution + ₱500 perfect attendance");
  check("1st half deductions", 0, b1.payroll.totals.total_deductions, "contributions and tax are on the 2nd half");
  check("1st half net", peso(16000 + expectedSub + 500), b1.payroll.totals.net_pay, "gross − 0");
  check("Month gross", monthGross, m.monthly_gross, "₱32,000 + substitution + ₱500 perfect attendance");
  check("SSS", 1600, d2.sss, "5% × MSC ₱32,000");
  check("PhilHealth", 800, d2.philhealth, "2.5% × ₱32,000");
  check("Pag-IBIG", 200, d2.pagibig, "2% × ₱10,000 (cap)");
  check("Monthly taxable income", taxable, m.taxable_income, "₱32,000 + substitution − ₱2,600 contributions (perfect attendance not taxable)");
  check("Withholding tax (2nd half)", tax, d2.withholding_tax, `(taxable − ₱20,833) × 15%`);
  check("2nd half has no substitution line", 0, (b2.payroll.audit?.lines?.incentives || []).filter((l) => l.type === "substitution").length, "Nov 5 is in the 1st half");
  check("Basic earned for the 13th month (1st half)", 16000, b1.payroll.basic_earned, "basic only, substitution not included");
  check("Basic earned for the 13th month (2nd half)", 16000, b2.payroll.basic_earned, "basic only");
  check("13th month from November (basic ÷ 12)", peso(32000 / 12), peso((Number(b1.payroll.basic_earned) + Number(b2.payroll.basic_earned)) / 12), "₱32,000 ÷ 12; with the substitution it would be ₱" + peso((32000 + expectedSub) / 12));
  const reyesPerfect = (r1.payroll.audit?.lines?.incentives || []).filter((l) => l.type === "perfect_attendance").reduce((s, l) => s + Number(l.amount || 0), 0);
  check("T. Reyes 1st half basic (paid leave Nov 5, no deduction)", 15000, r1.payroll.basic_salary, "₱30,000 ÷ 2");
  check("T. Reyes 1st half gross", peso(15000 + reyesPerfect), r1.payroll.monthly?.cutoff?.gross_pay, `₱15,000${reyesPerfect ? " + ₱500 perfect attendance" : ""}; the substitution changes nothing`);
  check("T. Reyes has no substitution line", 0, (r1.payroll.audit?.lines?.incentives || []).filter((l) => l.type === "substitution").length, "");
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ results, line_note: subLines[0]?.note || null }, null, 2));
  expect(subLines[0]?.note || "").toContain("covering T. Reyes, Grade 5 (Nov 5)");
  expect(results.filter((r) => r.result === "FAIL")).toEqual([]);
});

test("screenshots: Employee, Accountant, HR, PDF, print, record, report, 13th month", async ({ page }) => {
  await page.goto("/api/health");
  await travelTo("2026-12-01", page);
  const b1 = await entryOf(ctx.benjie, FIRST);
  const b2 = await entryOf(ctx.benjie, SECOND);

  // Employee: My Payslips, both halves.
  await loginBenjie(page);
  await page.goto("/employee?page=emp-payslips");
  await settle(page);
  for (const [period, name] of [[FIRST, "employee-1st-half"], [SECOND, "employee-2nd-half"]]) {
    const row = main(page).locator("tr", { hasText: period.replace(", 2026", "").split(" ")[0] }).filter({ hasText: period.includes("1-15") ? /1-15|1–15/ : /16-30|16–30/ }).first();
    await row.getByRole("button", { name: /View|Showing/ }).click();
    await settle(page);
    await expect(docOf(page)).toContainText(period.includes("1-15") ? "Overtime (substitution)" : "Withholding tax");
    await shot(docOf(page), name);
  }
  // PDF of the 1st half (the employee's own download) and the print layout.
  const pdf = await page.request.get(`/api/employee/payslips?format=pdf&entry_id=${b1.id}`);
  expect(pdf.status()).toBe(200);
  writeFileSync(join(OUT, "pdf-1st-half.pdf"), await pdf.body());
  const firstRow = main(page).locator("tr").filter({ hasText: /1-15|1–15/ }).first();
  await firstRow.getByRole("button", { name: /View|Showing/ }).click();
  await settle(page);
  await page.emulateMedia({ media: "print" });
  await shot(docOf(page), "print-1st-half");
  await page.emulateMedia({ media: "screen" });

  // Accountant: Payroll Records → Payslip, both halves.
  for (const [period, name] of [[FIRST, "accountant-1st-half"], [SECOND, "accountant-2nd-half"]]) {
    await as(page, "accountant", "ac-records");
    await settle(page);
    await main(page).getByRole("searchbox").first().fill("Benjie");
    await page.waitForTimeout(800);
    await main(page).locator("tr", { hasText: period }).filter({ hasText: "Benjie" }).first().getByRole("button").filter({ hasText: /Payslip|View|Open/ }).first().click();
    await settle(page);
    await expect(docOf(page)).toContainText(period);
    await shot(docOf(page), name);
  }

  // HR: Payroll Records, both halves.
  for (const [period, name] of [[FIRST, "hr-1st-half"], [SECOND, "hr-2nd-half"]]) {
    await as(page, "hr", `hr-payroll-records&pr_period=${encodeURIComponent(period)}`);
    await settle(page);
    await main(page).getByRole("searchbox").first().fill("Benjie");
    await page.waitForTimeout(800);
    await main(page).locator("tr", { hasText: period }).filter({ hasText: "Benjie" }).first().getByRole("button").filter({ hasText: /Payslip|View|Open/ }).first().click();
    await settle(page);
    await expect(docOf(page)).toContainText(period);
    await shot(docOf(page), name);
  }

  // The substitution record (HR → Leave) and the Substitution report row (HR → Reports).
  await as(page, "hr", "hr-leaves");
  await settle(page);
  const record = main(page).getByTestId("substitutions");
  await record.getByRole("searchbox").first().fill("Benjie").catch(() => {});
  await page.waitForTimeout(600);
  await shot(record, "substitution-record");
  await as(page, "hr", "hr-reports");
  await settle(page);
  const report = main(page).getByTestId("substitutions-report");
  await report.scrollIntoViewIfNeeded();
  await expect(report).toContainText("Benjie", { timeout: 30000 });
  await shot(report, "substitution-report");
  writeFileSync(join(OUT, "report-text.txt"), await report.innerText());

  // The 13th month (Accountant → 13th month, preview only: nothing is processed).
  await as(page, "accountant", "ac-13th");
  await settle(page);
  await main(page).getByTestId("thirteenth-generate").click();
  const preview = page.getByTestId("thirteenth-preview");
  await expect(preview).toBeVisible({ timeout: 60000 });
  await settle(page);
  const benjieRow = preview.locator("tr", { hasText: "Benjie" }).first();
  await expect(benjieRow).toBeVisible();
  await shot(preview, "thirteenth-month-preview");
  writeFileSync(join(OUT, "thirteenth-text.txt"), await benjieRow.innerText());
  await page.keyboard.press("Escape");
  writeFileSync(join(OUT, "entries.json"), JSON.stringify({ first: b1.id, second: b2.id }));
});
