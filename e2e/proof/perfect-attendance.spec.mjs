// Perfect Attendance paid automatically (owner decision 2026-11-25). LOCAL stack only; fake data only.
//
//   E2E_TIME_TRAVEL=1 E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test -c playwright.proof.config.mjs e2e/proof/perfect-attendance.spec.mjs
//
// A fake employee "Paz Proof" (₱30,000) taps in on time every working day of December. Through the real screens:
// December 1-15 is processed (on a moved local date, Dec 16) and submitted WITHOUT any HR step for Perfect Attendance;
// HR then undoes that 1st-half Perfect Attendance with a reason; December 16-31 is processed (on Jan 2): it pays its own
// Perfect Attendance automatically and takes back the undone one as a labelled adjustment. Results and screenshots go
// to docs/reports/perfect-attendance-2026-11-25/. Everything planted is removed at the end (PROOF_KEEP=1 keeps it).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { main, settle } from "../support/portal.mjs";
import { confirm, writeRemark } from "../support/flow.mjs";
import { db, psql, rows } from "../support/db.mjs";
import { travelHome, travelTo } from "../support/time-travel.mjs";

const OUT = join(process.cwd(), "docs", "reports", "perfect-attendance-2026-11-25");
const BRANCH = "Attendance Proof Branch";
const FIRST = "December 1-15, 2026";
const SECOND = "December 16-31, 2026";
const PAZ = { email: "paz.proof@e2e.test", first: "Paz", last: "Proof", full: "Paz Proof", code: "PROOF-PA1", salary: 30000 };

test.describe.configure({ mode: "serial" });
test.setTimeout(10 * 60 * 1000);
const ctx = { branch: null, paz: null };
const results = [];
const peso = (n) => Math.round((Number(n) || 0) * 100) / 100;
const check = (what, expected, actual, working = "") => {
  const ok = typeof expected === "number" ? Math.abs(peso(actual) - peso(expected)) < 0.005 : expected === actual;
  results.push({ what, expected, actual, result: ok ? "PASS" : "FAIL", working });
};
const shot = async (locator, name) => {
  await locator.page().addStyleTag({ content: "header { position: static !important; }" }).catch(() => {});
  await locator.page().waitForTimeout(400);
  await locator.screenshot({ path: join(OUT, `${name}.png`) });
};
const docOf = (page) => main(page).locator("[data-print-area]").first();

async function cleanup() {
  psql(`update profiles set branch_id = null where email = 'acct@e2e.test';
        update auth.users set raw_user_meta_data = (raw_user_meta_data - 'branch_id') - 'on_payroll' where email = 'acct@e2e.test';`);
  const ids = (await db().from("profiles").select("id").eq("email", PAZ.email)).data?.map((r) => r.id) || [];
  const branch = (await db().from("branches").select("id").eq("name", BRANCH).maybeSingle()).data;
  if (!ids.length && !branch) return;
  const idList = ids.map((id) => `'${id}'`).join(",") || "null";
  psql(`set session_replication_role = replica;
    do $$ declare r record; ids uuid[] := array[${idList}]::uuid[]; begin
      for r in select table_name, column_name from information_schema.columns
               where table_schema = 'public' and data_type = 'uuid'
                 and column_name in ('employee_id', 'user_id', 'recipient_id', 'actor_id')
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
  const meta = { role: "employee", full_name: PAZ.full, employee_id: PAZ.code, branch_id: ctx.branch, basic_salary: PAZ.salary, position: "Teacher",
    employee_type: "Teaching", employment_status: "Regular", employment_type: "Full-time", date_hired: "2025-06-01" };
  const created = await sb.auth.admin.createUser({ email: PAZ.email, password: `Proof-${Math.random().toString(36).slice(2, 10)}#Aa1`, email_confirm: true, user_metadata: meta });
  if (created.error) throw new Error(created.error.message);
  ctx.paz = created.data.user.id;
  const up = await sb.from("profiles").upsert({ id: ctx.paz, email: PAZ.email, role: "employee", full_name: PAZ.full, first_name: PAZ.first, last_name: PAZ.last,
    employee_id: PAZ.code, branch_id: ctx.branch, basic_salary: PAZ.salary, employee_type: "Teaching", employment_status: "Regular", employment_type: "Full-time",
    position: "Teacher", date_hired: "2025-06-01", employee_status: "Active", employee_level: "grade_school" }, { onConflict: "id" });
  if (up.error) throw new Error(up.error.message);
  // On time every working day (07:00 start; 06:58 is on time, not an Early Bird), no holidays.
  psql(`update profiles set branch_id = '${ctx.branch}' where email = 'acct@e2e.test';
        update auth.users set raw_user_meta_data = raw_user_meta_data || jsonb_build_object('branch_id', '${ctx.branch}', 'on_payroll', false) where email = 'acct@e2e.test';
        insert into attendance_logs (employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out, status)
        select '${ctx.paz}', '${PAZ.full}', 'Teaching', '${ctx.branch}', d::date,
               (d::date + time '06:58') at time zone 'Asia/Manila', (d::date + time '15:10') at time zone 'Asia/Manila', 'On Time'
        from generate_series('2026-11-23'::date, '2026-12-29'::date, '1 day') d
        where extract(isodow from d) < 6 and d::date not in ('2026-11-30', '2026-12-08', '2026-12-24', '2026-12-25');`);
});

test.afterAll(async () => {
  await travelHome();
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
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
  // No HR step for Perfect Attendance: the run is submitted straight away.
  const pending = (await db().from("incentive_recommendations").select("kind,status").eq("employee_id", ctx.paz).eq("pay_period", period).eq("status", "pending")).data || [];
  check(`${period}: nothing waits for HR before submitting`, 0, pending.length, "Perfect Attendance is paid automatically");
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

const entryOf = async (period) => rows(db().from("payroll_entries").select("id,payroll").eq("employee_id", ctx.paz).eq("pay_period", period).neq("status", "draft").single());

test("December 1-15 (on Dec 16): Perfect Attendance paid automatically", async ({ page }) => {
  await page.goto("/api/health");
  await travelTo("2026-12-16", page);
  await processAndApprove(page, FIRST);
  const e = await entryOf(FIRST);
  const rec = await rows(db().from("incentive_recommendations").select("status,decided_by_name,amount").eq("employee_id", ctx.paz).eq("pay_period", FIRST).eq("kind", "perfect_attendance").single());
  check("Dec 1-15: Perfect Attendance on the payslip", 500, e.payroll.totals.perfect_attendance_incentive, "full attendance, rate ₱500");
  check("Dec 1-15: recorded as paid by the system", "approved / System (attendance)", `${rec.status} / ${rec.decided_by_name}`, "no HR approval needed");
  await as(page, "accountant", "ac-records");
  await settle(page);
  await main(page).getByRole("searchbox").first().fill("Paz");
  await page.waitForTimeout(800);
  await main(page).locator("tr", { hasText: FIRST }).filter({ hasText: "Paz" }).first().getByRole("button").filter({ hasText: /Payslip|View|Open/ }).first().click();
  await settle(page);
  await expect(docOf(page)).toContainText("Perfect attendance");
  await shot(docOf(page), "payslip-dec-1-15");
});

test("HR sees it and undoes it with a reason (after the payslip was processed)", async ({ page }) => {
  await page.goto("/api/health");
  await travelTo("2026-12-16", page);
  await as(page, "hr", "hr-adjustment-approvals");
  await settle(page);
  await main(page).getByRole("radio", { name: /Decided/ }).or(main(page).getByRole("tab", { name: /Decided/ })).first().click();
  await settle(page);
  const row = main(page).locator("tr").filter({ hasText: "Paz Proof" }).filter({ hasText: FIRST }).first();
  await expect(row).toContainText("Paid automatically");
  await shot(main(page), "hr-list-paid-automatically");
  await row.getByTestId("undo-rule-incentive").click();
  await writeRemark(page, "adj-remark", "Late on Dec 3, found in an approved time correction");
  await shot(page.getByRole("dialog"), "hr-undo-dialog");
  await page.getByRole("dialog").getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
  // The database's clock is real (only the app server's "today" moves in this test): the undo is dated as if made on
  // the simulated day, Dec 16, as it would be in real use (an undo made on Dec 16 belongs to December's payroll).
  psql(`update payroll_monthly_incentives set item_date = '2026-12-16', created_at = '2026-12-16T10:00:00+08:00', decided_at = '2026-12-16T10:00:00+08:00'
        where employee_id = '${ctx.paz}' and undoes_recommendation_id is not null;`);
  const adj = (await db().from("payroll_monthly_incentives").select("kind,description,amount,non_taxable,approval_status").eq("employee_id", ctx.paz)).data || [];
  check("Undo after processing: a labelled adjustment for the next payslip", "Perfect attendance undone (December 1-15, 2026) / -500 / non-taxable / approved",
    adj[0] ? `${adj[0].description} / ${adj[0].amount} / ${adj[0].non_taxable ? "non-taxable" : "taxable"} / ${adj[0].approval_status}` : "none", "");
  const first = await entryOf(FIRST);
  check("The processed Dec 1-15 payslip is unchanged", 500, first.payroll.totals.perfect_attendance_incentive, "never alter a processed payslip");
});

test("December 16-31 (on Jan 2): its own Perfect Attendance paid; the undone one taken back; tax and ceiling", async ({ page }) => {
  await page.goto("/api/health");
  await travelTo("2027-01-02", page);
  await processAndApprove(page, SECOND);
  const e = await entryOf(SECOND);
  const lines = (e.payroll.audit?.lines?.incentives || []).concat(e.payroll.audit?.lines?.deductions || []);
  const undo = lines.find((l) => /Perfect attendance undone/.test(String(l.note || l.description || "")));
  check("Dec 16-31: its own Perfect Attendance on the payslip", 500, e.payroll.totals.perfect_attendance_incentive, "paid automatically");
  check("Dec 16-31: the undone Dec 1-15 amount taken back", -500, undo ? undo.amount : 0, "the approved adjustment");
  const m = e.payroll.monthly || {};
  check("Dec taxable income leaves out both Perfect Attendance and the take-back", peso(30000 - (Number(e.payroll.deductions.sss) + Number(e.payroll.deductions.philhealth) + Number(e.payroll.deductions.pagibig))),
    m.taxable_income, "₱30,000 − contributions (other benefits are tax-free under the ₱90,000 ceiling)");
  const ledger = (await db().from("payroll_exempt_benefits_paid").select("kind,amount,paid_on").eq("employee_id", ctx.paz).eq("tax_year", 2026)).data || [];
  const bonus = ledger.filter((r) => r.kind === "bonus").reduce((s, r) => s + Number(r.amount), 0);
  check("₱90,000 ledger: Perfect Attendance kept for December", 500, bonus, "₱500 + ₱500 paid − ₱500 taken back");
  writeFileSync(join(OUT, "ledger.json"), JSON.stringify(ledger, null, 2));
  await as(page, "accountant", "ac-records");
  await settle(page);
  await main(page).getByRole("searchbox").first().fill("Paz");
  await page.waitForTimeout(800);
  await main(page).locator("tr", { hasText: SECOND }).filter({ hasText: "Paz" }).first().getByRole("button").filter({ hasText: /Payslip|View|Open/ }).first().click();
  await settle(page);
  await expect(docOf(page)).toContainText("Perfect attendance undone");
  await shot(docOf(page), "payslip-dec-16-31");
  expect(results.filter((r) => r.result === "FAIL")).toEqual([]);
});
