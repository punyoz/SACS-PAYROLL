// Cash advances & government loans proof (2026-11-25). LOCAL stack only; fake data only.
//
//   E2E_TIME_TRAVEL=1 E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test -c playwright.proof.config.mjs e2e/proof/government-loans.spec.mjs
//
// Plants a fake branch and a fake employee "Gina Proof" (₱30,000) with taps on every working day. Through the
// real screens: HR encodes an SSS salary loan (the form) and a Pag-IBIG multi-purpose loan; the Accountant files
// a ₱3,000 cash advance (the form shows the salary limit) and HR approves it; Nov 1-15 and (on Dec 1) Nov 16-30
// are processed, submitted and approved. Screenshots go to docs/reports/government-loans-2026-11-25/.
// Everything planted is removed at the end (PROOF_KEEP=1 keeps it).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { main, settle } from "../support/portal.mjs";
import { confirm, writeRemark } from "../support/flow.mjs";
import { db, plantOtp, psql, rows } from "../support/db.mjs";
import { TEST_OTP } from "../accounts.mjs";
import { travelHome, travelTo } from "../support/time-travel.mjs";

const OUT = join(process.cwd(), "docs", "reports", "government-loans-2026-11-25");
const BRANCH = "Loans Proof Branch";
const FIRST = "November 1-15, 2026";
const SECOND = "November 16-30, 2026";
const GINA = { email: "gina.proof@e2e.test", first: "Gina", last: "Proof", full: "Gina Proof", code: "PROOF-GL1", salary: 30000 };
const PASSWORD = `Proof-${Math.random().toString(36).slice(2, 10)}#Aa1`;   // local, never printed

test.describe.configure({ mode: "serial" });
test.setTimeout(10 * 60 * 1000);
const ctx = { branch: null, gina: null };
const shot = async (locator, name) => {
  // The sticky top bar would cover part of a tall element in the picture; dropdowns are closed first.
  await locator.page().addStyleTag({ content: "header, [data-slot=sidebar-inset] > header { position: static !important; }" }).catch(() => {});
  await locator.page().waitForTimeout(400);
  await locator.screenshot({ path: join(OUT, `${name}.png`) });
};
const docOf = (page) => main(page).locator("[data-print-area]").first();

async function cleanup() {
  psql(`update profiles set branch_id = null where email = 'acct@e2e.test';
        update auth.users set raw_user_meta_data = (raw_user_meta_data - 'branch_id') - 'on_payroll' where email = 'acct@e2e.test';`);
  const ids = (await db().from("profiles").select("id").eq("email", GINA.email)).data?.map((r) => r.id) || [];
  const branch = (await db().from("branches").select("id").eq("name", BRANCH).maybeSingle()).data;
  if (!ids.length && !branch) return;
  const idList = ids.map((id) => `'${id}'`).join(",") || "null";
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
    delete from public.profiles where id in (${idList});
    set session_replication_role = origin;
    delete from auth.users where id in (${idList});
    ${branch ? `delete from public.branches where id = '${branch.id}';` : ""}`);
}

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  await cleanup();
  const sb = db();
  ctx.branch = (await rows(sb.from("branches").insert({ name: BRANCH }).select("id").single())).id;
  const meta = { role: "employee", full_name: GINA.full, employee_id: GINA.code, branch_id: ctx.branch, basic_salary: GINA.salary, position: "Teacher",
    employee_type: "Teaching", employment_status: "Regular", employment_type: "Full-time", date_hired: "2025-06-01" };
  const created = await sb.auth.admin.createUser({ email: GINA.email, password: PASSWORD, email_confirm: true, user_metadata: meta });
  if (created.error) throw new Error(created.error.message);
  ctx.gina = created.data.user.id;
  const up = await sb.from("profiles").upsert({ id: ctx.gina, email: GINA.email, role: "employee", full_name: GINA.full, first_name: GINA.first, last_name: GINA.last,
    employee_id: GINA.code, branch_id: ctx.branch, basic_salary: GINA.salary, employee_type: "Teaching", employment_status: "Regular", employment_type: "Full-time",
    position: "Teacher", date_hired: "2025-06-01", employee_status: "Active", employee_level: "grade_school" }, { onConflict: "id" });
  if (up.error) throw new Error(up.error.message);
  psql(`update profiles set branch_id = '${ctx.branch}' where email = 'acct@e2e.test';
        update auth.users set raw_user_meta_data = raw_user_meta_data || jsonb_build_object('branch_id', '${ctx.branch}', 'on_payroll', false) where email = 'acct@e2e.test';
        insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out, status)
        select '${ctx.gina}', '${GINA.full}', 'Teaching', '${ctx.branch}', d::date,
               (d::date + time '06:50') at time zone 'Asia/Manila', (d::date + time '17:10') at time zone 'Asia/Manila', 'On Time'
        from generate_series('2026-10-26'::date, '2026-11-27'::date, '1 day') d
        where extract(isodow from d) < 6 and d::date not in ('2026-11-02', '2026-11-20');`);
});

test.afterAll(async () => {
  await travelHome();
  if (process.env.PROOF_KEEP !== "1") await cleanup();
});

const runCard = (page) => main(page).locator("div.rounded-lg.border", { hasText: BRANCH })
  .filter({ has: page.getByRole("button", { name: /Submit for HR Approval|Resubmit for HR Approval/ }) }).first();

async function processAndApprove(page, period) {
  const processUrl = `ac-process&period=${encodeURIComponent(period)}`;
  await as(page, "accountant", processUrl);
  await settle(page);
  await main(page).getByTestId("process-all").click();
  await confirm(page, "Process payroll");
  await expect(page.getByText(/Payroll processed for \d+ employee/).first()).toBeVisible({ timeout: 120000 });
  // The system's Perfect Attendance recommendation waits for HR; this proof keeps it out (HR rejects, with a remark).
  const recs = (await db().from("incentive_recommendations").select("id").eq("employee_id", ctx.gina).eq("status", "pending")).data || [];
  if (recs.length) {
    await as(page, "hr", "hr-adjustment-approvals");
    for (const r of recs) {
      const res = await page.request.fetch("/api/hr/adjustment-approvals", { method: "PATCH", headers: { "Content-Type": "application/json" },
        data: { kind: "rule_incentive", id: r.id, decision: "reject", note: "Proof run: kept out so the payslip shows the deductions alone" } });
      expect(res.status(), await res.text()).toBe(200);
    }
  }
  await as(page, "accountant", processUrl);
  await settle(page);
  await runCard(page).getByRole("button", { name: /Submit for HR Approval/ }).click();
  await confirm(page, "Submit for HR Approval");
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
}

async function loginGina(page) {
  await page.goto("/api/health");
  await page.context().clearCookies();
  await plantOtp(GINA.email);
  await page.goto("/login");
  await page.locator("#login-identity").waitFor();
  for (let i = 0; i < 5; i += 1) {
    await page.fill("#login-identity", GINA.email);
    await page.fill("#login-password", PASSWORD);
    if ((await page.inputValue("#login-identity")) === GINA.email && (await page.inputValue("#login-password")) === PASSWORD) break;
    await page.waitForTimeout(300);
  }
  await page.locator("form button[type=submit]").first().click();
  await expect(page.getByText("Check your email")).toBeVisible({ timeout: 30000 });
  await page.locator("#login-code").click();
  await page.keyboard.type(TEST_OTP, { delay: 40 });
  await page.waitForURL((url) => url.pathname.startsWith("/employee"), { timeout: 60000 });
}

async function pickEmployee(page, triggerId) {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("searchbox").last().fill("Gina");
  await page.getByRole("option", { name: /Gina Proof/ }).first().click();
}

test("HR encodes the SSS and Pag-IBIG loans; the Accountant files a cash advance (Nov 25)", async ({ page }) => {
  await travelHome(page);
  // HR: Employees → Government loans → Encode a loan (the form), SSS salary loan.
  await as(page, "hr", "hr-gov-loans");
  await settle(page);
  await main(page).getByTestId("encode-government-loan").click();
  const form = page.getByTestId("government-loan-form");
  await expect(form).toBeVisible();
  await pickEmployee(page, "gl-employee");
  await page.locator("#gl-kind").click();
  await page.getByRole("option", { name: "SSS salary loan" }).click();
  await page.fill("#gl-ref", "SSS-0451");
  await page.fill("#gl-total", "24000");
  await page.fill("#gl-per", "1000");
  await page.locator("#gl-start").click();
  await page.getByRole("option", { name: /November 16-30, 2026/ }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await shot(form, "hr-encoding-form");
  await form.getByRole("button", { name: "Encode", exact: true }).click();
  await expect(form).toBeHidden({ timeout: 30000 });
  // The Pag-IBIG loan through the same API.
  const res = await page.request.fetch("/api/hr/government-loans", { method: "POST", headers: { "Content-Type": "application/json" },
    data: { employee_id: ctx.gina, loan_type: "pagibig_loan", loan_kind: "multi-purpose", reference_no: "MPL-2026-77", principal: 9600, amortization: 800, start_period: "2026-11-16" } });
  expect(res.status(), await res.text()).toBe(200);
  await page.reload();
  await settle(page);
  await shot(main(page).getByTestId("government-loans"), "hr-government-loans-list");

  // Accountant: Cash Advances & Subsidies → a ₱3,000 cash advance; the form shows the salary limit.
  await as(page, "accountant", "ac-loans");
  await settle(page);
  await pickEmployee(page, "ac-ln-employee");
  await page.fill("#ac-ln-principal", "3000");
  await page.fill("#ac-ln-payrolls", "3");
  await expect(main(page).getByTestId("loan-limit-summary")).toContainText("Salary limit ₱30,000.00");
  await shot(main(page).locator("#loan-form"), "accountant-cash-advance-form");
  await main(page).getByRole("button", { name: /Add cash advance/ }).click();
  await expect(main(page).getByText(/Cash advance added/)).toBeVisible({ timeout: 30000 });
  // A cash advance above the limit is refused in plain words.
  await page.fill("#ac-ln-principal", "27001");
  await main(page).getByRole("button", { name: /Add cash advance/ }).click();
  await expect(main(page).getByText(/This cash advance would make the total/)).toBeVisible();
  await shot(main(page).locator("#loan-form"), "accountant-cash-advance-refused");
  await shot(main(page), "accountant-cash-advances-page");
  // HR approves the cash advance.
  const advance = await rows(db().from("payroll_loans").select("id").eq("employee_id", ctx.gina).eq("loan_type", "cash_advance").single());
  await as(page, "hr", "hr-adjustment-approvals");
  const ok = await page.request.fetch("/api/hr/adjustment-approvals", { method: "PATCH", headers: { "Content-Type": "application/json" },
    data: { kind: "loan", id: advance.id, decision: "approve", note: "Proof run" } });
  expect(ok.status(), await ok.text()).toBe(200);
});

test("process Nov 1-15 (no deductions) and, on Dec 1, Nov 16-30", async ({ page }) => {
  await travelHome(page);
  await processAndApprove(page, FIRST);
  await page.goto("/api/health");
  await travelTo("2026-12-01", page);
  await processAndApprove(page, SECOND);
});

test("the payslips, the employee's deductions and the remittance", async ({ page }) => {
  await page.goto("/api/health");
  await travelTo("2026-12-01", page);
  const second = await rows(db().from("payroll_entries").select("id,payroll").eq("employee_id", ctx.gina).eq("pay_period", SECOND).neq("status", "draft").single());
  const first = await rows(db().from("payroll_entries").select("id,payroll").eq("employee_id", ctx.gina).eq("pay_period", FIRST).neq("status", "draft").single());
  const lines = (second.payroll.loans || []).map((l) => ({ description: l.description, amount: l.amount, balance_after: l.balance_after, reference_no: l.reference_no || null }));
  writeFileSync(join(OUT, "deductions.json"), JSON.stringify({ first_half_loans: first.payroll.loans || [], second_half_loans: lines,
    gross: second.payroll.monthly?.cutoff?.gross_pay, total_deductions: second.payroll.totals?.total_deductions, net: second.payroll.totals?.net_pay }, null, 2));
  expect((first.payroll.loans || []).length).toBe(0);
  expect(lines.map((l) => l.description)).toEqual(expect.arrayContaining(["SSS loan (salary loan)", "Pag-IBIG loan (multi-purpose)", "Cash advance"]));

  await loginGina(page);
  await page.goto("/employee?page=emp-payslips");
  await settle(page);
  await main(page).locator("tr").filter({ hasText: /16-30|16–30/ }).first().getByRole("button", { name: /View|Showing/ }).click();
  await settle(page);
  await expect(docOf(page)).toContainText("SSS loan (salary loan)");
  await expect(docOf(page)).toContainText("Remaining balance ₱23,000.00 · Ref. SSS-0451");
  await shot(docOf(page), "employee-payslip-2nd-half");
  await page.emulateMedia({ media: "print" });
  await shot(docOf(page), "print-2nd-half");
  await page.emulateMedia({ media: "screen" });
  const pdf = await page.request.get(`/api/employee/payslips?format=pdf&entry_id=${second.id}`);
  expect(pdf.status()).toBe(200);
  writeFileSync(join(OUT, "pdf-2nd-half.pdf"), await pdf.body());
  await page.goto("/employee?page=emp-requests");
  await settle(page);
  await shot(main(page).getByTestId("my-requests"), "employee-my-deductions");

  await as(page, "accountant", "ac-records");
  await settle(page);
  await main(page).getByRole("searchbox").first().fill("Gina");
  await page.waitForTimeout(800);
  await main(page).locator("tr", { hasText: SECOND }).filter({ hasText: "Gina" }).first().getByRole("button").filter({ hasText: /Payslip|View|Open/ }).first().click();
  await settle(page);
  await expect(docOf(page)).toContainText("Pag-IBIG loan (multi-purpose)");
  await shot(docOf(page), "accountant-payslip-2nd-half");

  await as(page, "hr", `hr-payroll-records&pr_period=${encodeURIComponent(SECOND)}`);
  await settle(page);
  await main(page).getByRole("searchbox").first().fill("Gina");
  await page.waitForTimeout(800);
  await main(page).locator("tr", { hasText: SECOND }).filter({ hasText: "Gina" }).first().getByRole("button").filter({ hasText: /Payslip|View|Open/ }).first().click();
  await settle(page);
  await shot(docOf(page), "hr-payslip-2nd-half");

  const remit = await page.request.get("/api/payroll/remittance?month=2026-11");
  const data = await remit.json();
  const row = (data.rows || []).find((r) => r.employee_name === GINA.full);
  writeFileSync(join(OUT, "remittance-row.json"), JSON.stringify({ row, totals: data.totals }, null, 2));
  expect(row).toMatchObject({ sss_loan: 1000, pagibig_loan: 800 });
});
