// Year-end tax annualization, BIR Form 2316 and the 1604-C alphalist
// (2026-10-29) on the LOCAL database: the Accountant runs and re-runs the
// annualization, schedules Bea's adjustment, the real payroll engine puts it
// on her October 16-31 payslip as its own line, HR approves, the forms carry
// it; HR and the Super Admin are refused in the UI, the API and the database.
//
// Runs after 20-payroll-flow (October 1-15 processed and approved) and
// 50-hr-management (Bea granted Tenure Pay Protection). January-September are
// planted as Final payslips from before go-live (the system went live in
// October 2026), in the shape the engine stores.
import { createClient } from "@supabase/supabase-js";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, confirm } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";
import { localSupabase } from "../local-env.mjs";

test.describe.configure({ mode: "serial" });

// October 16-31 is generated on the 30th; the test runs before that, so a
// schedule with October's 2nd half on the 29th is planted (triggers off, the
// guard rightly refuses past paydays) and removed afterwards, as in 70.
let planted = null;
test.afterEach(() => {
  if (planted) psql(`set session_replication_role = replica; delete from payroll_schedule_settings where id = '${planted}';`);
  planted = null;
});

const YEAR = 2026;
const OCT1 = "October 1-15, 2026";
const OCT2 = "October 16-31, 2026";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September"];
const LAST = [31, 28, 31, 30, 31, 30, 31, 31, 30];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The BIR annual table (TRAIN, 2023 onward), written out on its own.
function annualTax(taxable) {
  const t = Number(taxable) || 0;
  if (t <= 250000) return 0;
  if (t <= 400000) return r2((t - 250000) * 0.15);
  if (t <= 800000) return r2(22500 + (t - 400000) * 0.2);
  if (t <= 2000000) return r2(102500 + (t - 800000) * 0.25);
  if (t <= 8000000) return r2(402500 + (t - 2000000) * 0.3);
  return r2(2202500 + (t - 8000000) * 0.35);
}
// The monthly table (what each 2nd half withheld).
function monthlyTax(taxable) {
  const t = Number(taxable) || 0;
  if (t <= 20833) return 0;
  if (t <= 33333) return r2((t - 20833) * 0.15);
  return r2(1875 + (t - 33333) * 0.2);
}

/** Bea, January-September: absences in March (2 days), an incentive in June. */
function history(bea) {
  const out = [];
  MONTHS.forEach((month, i) => {
    const absent = month === "March" ? 2758.62 : 0;
    const incentive = month === "June" ? 5000 : 0;
    const taxable = r2(30000 - absent - 2450 + incentive);
    const slip = (label, basic, second) => ({
      employee_id: bea.id, employee_name: bea.full_name, employee_code: bea.employee_id, employee_type: "Non-Teaching", position: bea.position,
      pay_period: label, branch_id: bea.branch_id, payslip_no: `E2E-HIST-${i + 1}${second ? "B" : "A"}`,
      payroll: {
        imported: "before go-live (E2E fixture)",
        basic_salary: 15000, basic_earned: basic,
        deductions: { sss: second ? 1500 : 0, philhealth: second ? 750 : 0, pagibig: second ? 200 : 0, withholding_tax: second ? monthlyTax(taxable) : 0 },
        totals: { gross_pay: 15000, other_incentive: second ? incentive : 0, overtime_pay: 0, holiday_pay: 0, subsidy_pay: 0 },
      },
    });
    out.push(slip(`${month} 1-15, ${YEAR}`, 15000, false), slip(`${month} 16-${LAST[i]}, ${YEAR}`, r2(15000 - absent), true));
  });
  return out;
}

function plant(entries) {
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const values = entries.map((e) => `(${q(e.employee_id)}, ${q(e.employee_name)}, ${q(e.employee_code)}, ${q(e.employee_type)}, ${q(e.position)}, ${q(e.pay_period)}, 'paid', ${q(e.branch_id)}, ${q(e.payslip_no)}, ${q(JSON.stringify(e.payroll))}::jsonb, ${e.payroll.deductions.withholding_tax}, ${e.payroll.deductions.sss}, ${e.payroll.deductions.philhealth}, ${e.payroll.deductions.pagibig})`);
  psql(`begin;
set local session_replication_role = replica;
delete from payroll_entries where payslip_no like 'E2E-HIST-%';
insert into payroll_entries (employee_id, employee_name, employee_code, employee_type, position, pay_period, status, branch_id, payslip_no, payroll, withholding_tax, sss, philhealth, pagibig)
values ${values.join(",\n")};
commit;`);
}

/** Bea's year from the database, summed here on its own (the forms' independent check). */
async function beaYear(beaId, { approvedOnly }) {
  const entries = await rows(db().from("payroll_entries").select("id,pay_period,status,run_id,payroll").eq("employee_id", beaId).eq("status", "paid").like("pay_period", `%, ${YEAR}`));
  const runs = await rows(db().from("payroll_runs").select("id,status"));
  const approved = new Set(runs.filter((r) => r.status === "approved").map((r) => r.id));
  const counted = entries.filter((e) => !approvedOnly || !e.pay_period.startsWith("October") || approved.has(e.run_id));
  const sum = (f) => r2(counted.reduce((s, e) => s + (Number(f(e.payroll)) || 0), 0));
  const basic = sum((p) => p.basic_earned);
  const contributions = sum((p) => (p.deductions?.sss || 0) + (p.deductions?.philhealth || 0) + (p.deductions?.pagibig || 0));
  const incentives = sum((p) => p.totals?.other_incentive);
  const withheld = sum((p) => p.deductions?.withholding_tax);
  const adjustments = sum((p) => p.year_end_tax?.signed);
  const taxable = r2(basic - contributions + incentives + sum((p) => (p.totals?.overtime_pay || 0) + (p.totals?.holiday_pay || 0) + (p.totals?.overload_pay || 0)));
  return { entries: counted, basic, contributions, incentives, withheld, adjustments, taxable, due: annualTax(taxable) };
}

const card = (page) => main(page).locator("[data-slot=card]").filter({ hasText: "Year-end tax annualization" }).first();

test("year-end tax: Accountant annualizes, schedules, payroll applies, forms carry it; HR and Super Admin refused", async ({ page, monitor }) => {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const hr = await profileByEmail(ACCOUNTS.hr.email);
  const sa = await profileByEmail(ACCOUNTS.super_admin.email);
  const accountant = await profileByEmail(ACCOUNTS.accountant.email);
  const oct1 = await rows(db().from("payroll_entries").select("id,status,run_id").eq("employee_id", bea.id).eq("pay_period", OCT1));
  test.skip(!oct1.length || oct1[0].status !== "paid", "needs Bea's October 1-15 payslip from 20-payroll-flow");
  plant(history(bea));
  const before = await rows(db().from("payroll_entries").select("id,pay_period,status,withholding_tax,net_pay,payroll,updated_at").eq("employee_id", bea.id).order("pay_period"));

  await step(page, "Accountant > Payroll Reports > Year-end tax annualization > Run 2026", async () => {
    monitor.at("Accountant > Year-end tax");
    await as(page, "accountant", "ac-reports");
    await settle(page);
    await choose(page, card(page).getByRole("combobox", { name: "Annualization year" }), String(YEAR));
    await settle(page);
    await card(page).getByRole("button", { name: /Run annualization|Run again/ }).click();
    await confirm(page, "Run annualization");
    await expect(card(page).locator("tr", { hasText: "Bea" })).toBeVisible();
    const [record] = await rows(db().from("payroll_tax_annualizations").select("*").eq("employee_id", bea.id).eq("tax_year", YEAR));
    const mine = await beaYear(bea.id, { approvedOnly: true });
    expect(record).toMatchObject({ branch_id: bea.branch_id, status: "computed", run_count: 1 });
    expect(Number(record.taxable_compensation)).toBe(mine.taxable);
    expect(Number(record.tax_withheld)).toBe(mine.withheld);
    expect(Number(record.tax_due)).toBe(mine.due);
    expect(Number(record.balance)).toBe(r2(mine.due - mine.withheld));
    test.info().annotations.push({ type: "run 1 (Jan-Oct 15)", description: JSON.stringify({ taxable: mine.taxable, due: mine.due, withheld: mine.withheld, balance: Number(record.balance) }) });
  });

  await step(page, "Accountant > schedule Bea's adjustment on October 16-31", async () => {
    await choose(page, card(page).getByRole("combobox", { name: /^Schedule the adjustment of Bea/ }), OCT2);
    await confirm(page, "Schedule");
    await expect(card(page).locator("tr", { hasText: "Bea" }).getByText("Scheduled")).toBeVisible();
    const [record] = await rows(db().from("payroll_tax_annualizations").select("status,target_period,scheduled_by").eq("employee_id", bea.id).eq("tax_year", YEAR));
    expect(record).toMatchObject({ status: "scheduled", target_period: OCT2, scheduled_by: accountant.id });
  });

  await step(page, "Accountant > Process Payroll October 16-31 (Bea; an incentive HR approved) > submit to HR", async () => {
    monitor.at("Accountant > process October 16-31");
    // Filed pending, approved by HR through the database's own decision function.
    const [incentive] = await rows(db().from("payroll_monthly_incentives").insert({
      employee_id: bea.id, branch_id: bea.branch_id, item_date: "2026-10-20", kind: "incentive", description: "E2E year-end incentive", amount: 2000,
      archived: false, approval_status: "pending", created_at: "2026-10-20T01:00:00Z",
    }).select("id"));
    const decided = await db().rpc("payroll_adjustment_decide", { p_actor: hr.id, p_kind: "incentive", p_id: incentive.id, p_decision: "approve", p_note: null });
    expect(decided.error?.message).toBeUndefined();
    planted = psql(`set session_replication_role = replica;
      insert into payroll_schedule_settings (effective_from, first_half_day, second_half_day, window_days, note, created_by_name)
      values ('2026-10-16', 15, ${Number(new Date().toLocaleString("en-CA", { timeZone: "Asia/Manila" }).slice(8, 10))}, 5, 'E2E: October 2nd half generated today', 'E2E') returning id;`).split(/\s+/).pop();
    // The whole branch (a run is submitted for every employee).
    const branchPeople = await rows(db().from("payroll_entries").select("employee_id").eq("branch_id", bea.branch_id).eq("pay_period", OCT1));
    const entries = [...new Set(branchPeople.map((r) => r.employee_id))].map((employee_id) => ({ employee_id }));
    const processed = await api(page, "POST", "/api/accountant/payroll", { action: "batch_submit", pay_period: OCT2, entries });
    expect(processed.status, JSON.stringify(processed.data)).toBe(200);
    expect(processed.data.processed, JSON.stringify(processed.data.failed || processed.data)).toHaveLength(entries.length);
    const submitted = await api(page, "PATCH", "/api/accountant/payroll-runs", { action: "submit", branch_id: bea.branch_id, period: OCT2 });
    expect(submitted.status, JSON.stringify(submitted.data)).toBeLessThan(300);
  });

  await step(page, "Database > the October 16-31 payslip carries the adjustment as its own line; nothing earlier changed", async () => {
    const [slip] = await rows(db().from("payroll_entries").select("id,status,withholding_tax,net_pay,total_deductions,payroll").eq("employee_id", bea.id).eq("pay_period", OCT2));
    const p = slip.payroll;
    const year = await beaYear(bea.id, { approvedOnly: false });
    // Tax due on the whole year (this payslip included) less everything withheld (this payslip's regular tax included).
    const expected = r2(year.due - year.withheld);
    expect(p.year_end_tax, JSON.stringify(p.monthly?.cutoff)).toBeTruthy();
    if (expected > 0) expect(r2(p.year_end_tax.amount + p.year_end_tax.shortfall)).toBe(expected);
    else expect(p.year_end_tax.signed).toBe(expected);
    expect(p.year_end_tax.tax_due).toBe(year.due);
    expect(p.year_end_tax.taxable).toBe(year.taxable);
    // The regular withholding tax: the monthly table on the month's taxable income, in its own column and line.
    expect(Number(slip.withholding_tax)).toBe(p.deductions.withholding_tax);
    expect(p.deductions.withholding_tax).toBe(p.monthly.withholding_tax);
    const lines = p.monthly.cutoff.deductions;
    // A withholding tax of 0 has no line (the month's taxable income is under ₱20,833 with the absences).
    expect(lines.find((l) => l.label.startsWith("Withholding tax"))?.amount ?? 0).toBe(p.deductions.withholding_tax);
    // Net pay = this half's net + the refund (or − the collection); the payslip's lines add up.
    expect(p.totals.net_pay).toBe(Math.max(0, r2(p.monthly.second_half_net - p.year_end_tax.signed)));
    expect(r2(p.monthly.cutoff.gross_pay - p.monthly.cutoff.total_deductions)).toBe(p.totals.net_pay);
    const own = lines.find((l) => l.label.startsWith("Year-end tax adjustment 2026"));
    expect(own).toMatchObject({ amount: p.year_end_tax.amount });
    expect(Boolean(own.credit)).toBe(p.year_end_tax.kind === "refund");
    // Stored line rows (the widened CHECKs of 20261029010000 accept them).
    const table = p.year_end_tax.kind === "refund" ? "payroll_incentives" : "payroll_deductions";
    const type = p.year_end_tax.kind === "refund" ? "year_end_tax_refund" : "year_end_tax";
    const stored = await rows(db().from(table).select("type,amount").eq("payroll_entry_id", slip.id).eq("type", type));
    expect(stored.map((r) => Number(r.amount))).toEqual([p.year_end_tax.amount]);
    // Every earlier payslip exactly as it was.
    const after = await rows(db().from("payroll_entries").select("id,pay_period,status,withholding_tax,net_pay,payroll,updated_at").in("id", before.map((b) => b.id)).order("pay_period"));
    expect(after).toEqual(before);
    test.info().annotations.push({ type: "October 16-31 (real engine)", description: JSON.stringify({
      year_taxable: year.taxable, year_due: year.due, withheld_incl_this: year.withheld, adjustment: p.year_end_tax, regular_tax: p.deductions.withholding_tax,
      net_pay: slip.net_pay, tenure_protection: p.audit?.attendance?.tenure_protection || null, cutoff: lines.map((l) => `${l.label}: ${l.credit ? "+" : "-"}${l.amount}`),
    }) });
  });

  await step(page, "HR > Payroll Approval > approve October 16-31 (the adjustment line in the review)", async () => {
    monitor.at("HR > approve October 16-31");
    await as(page, "hr", "hr-payroll-approval");
    const run = await rows(db().from("payroll_runs").select("id,status").eq("branch_id", bea.branch_id).eq("period_label", OCT2).maybeSingle());
    const approved = await api(page, "PATCH", "/api/hr/payroll-runs", { action: "approve", run_id: run.id, remarks: "E2E year-end" });
    expect(approved.status, JSON.stringify(approved.data)).toBe(200);
    expect((await rows(db().from("payroll_runs").select("status").eq("id", run.id).single())).status).toBe("approved");
  });

  await step(page, "Accountant > Run again > Bea balanced at zero; the forms carry the adjustment", async () => {
    monitor.at("Accountant > re-run");
    await as(page, "accountant", "ac-reports");
    await settle(page);
    await choose(page, card(page).getByRole("combobox", { name: "Annualization year" }), String(YEAR));
    await settle(page);
    await card(page).getByRole("button", { name: "Run again" }).click();
    await confirm(page, "Run annualization");
    const row = card(page).locator("tr", { hasText: "Bea" });
    await expect(row.getByText("Balanced")).toBeVisible();
    await expect(row.getByText("On Final payslip")).toBeVisible();
    const [record] = await rows(db().from("payroll_tax_annualizations").select("*").eq("employee_id", bea.id).eq("tax_year", YEAR));
    const year = await beaYear(bea.id, { approvedOnly: true });
    expect(record.run_count).toBe(2);
    expect(Number(record.adjustments_settled)).toBe(year.adjustments);
    expect(Number(record.tax_due)).toBe(year.due);
    expect(Number(record.balance)).toBe(0);
    expect(record.history.map((h) => h.action)).toEqual(["computed", "scheduled", "computed"]);

    const forms = await api(page, "GET", `/api/payroll/bir-forms?year=${YEAR}`);
    const f = forms.data.rows.find((r) => r.employee_id === bea.id);
    expect(f).toMatchObject({ taxable: year.taxable, tax_due: year.due, tax_withheld: r2(year.withheld + year.adjustments), year_end_adjustment: year.adjustments, settlement: "none" });

    // Alphalist: Bea's row = the sum of her payroll records for the year.
    const csv = await page.request.get(`/api/payroll/bir-forms?year=${YEAR}&format=csv`);
    expect(csv.status()).toBe(200);
    const cells = (line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1].replace(/^"|"$/g, "").replace(/""/g, "\"")).slice(0, -1);
    const lines = (await csv.text()).replace(/^﻿/, "").trim().split("\r\n");
    const header = cells(lines[0]);
    const beaRow = cells(lines.find((l) => l.includes(",Reyes,Bea")));
    const col = (name) => Number(beaRow[header.indexOf(name)]);
    expect(col("Total taxable compensation income")).toBe(year.taxable);
    expect(col("Tax due")).toBe(year.due);
    expect(r2(col("Tax withheld January - November") + col("Tax withheld December"))).toBe(year.withheld);
    expect(col("Year-end tax adjustment (+ collected / - refunded)")).toBe(year.adjustments);
    expect(col("Total tax withheld")).toBe(r2(year.withheld + year.adjustments));
    expect(col("SSS, PHIC, Pag-IBIG contributions and union dues")).toBe(year.contributions);

    // Her 2316 alone.
    const pdf = await page.request.get(`/api/payroll/bir-forms?year=${YEAR}&format=pdf&employee_id=${bea.id}`);
    expect(pdf.status()).toBe(200);
    const text = (await pdf.body()).toString("latin1");
    expect(text).toContain("/Count 1");
    for (const field of ["(Reyes, Bea)", `(${bea.position})`, `(${bea.employee_id})`, "(Main Campus)"]) expect(text, field).toContain(field);
    expect(text).toContain(`(${year.due.toLocaleString("en-US", { minimumFractionDigits: 2 })})`);
    test.info().annotations.push({ type: "after HR approval", description: JSON.stringify({ taxable: year.taxable, due: year.due, withheld: year.withheld, adjustments: year.adjustments, balance: Number(record.balance) }) });
  });

  for (const [role, home] of [["hr", "hr-payroll-records"], ["super_admin", "sa-dashboard"]]) {
    await step(page, `${role === "hr" ? "HR" : "Super Admin"} > no year-end section, and every API refused`, async () => {
      monitor.at(`${role} > refused`);
      monitor.allow(/^403 (GET|POST) \/api\/payroll\/(year-end-tax|bir-forms)/, /status of 403/);
      await as(page, role, home);
      await settle(page);
      const shown = await main(page).innerText();
      expect(shown).not.toContain("Year-end tax annualization");
      expect(shown).not.toContain("BIR forms");
      await expect(page.getByText("Payroll Reports", { exact: true })).toHaveCount(0);
      for (const [method, path, body] of [
        ["GET", `/api/payroll/year-end-tax?year=${YEAR}`],
        ["POST", "/api/payroll/year-end-tax", { action: "run", year: YEAR }],
        ["POST", "/api/payroll/year-end-tax", { action: "unschedule", id: "00000000-0000-4000-8000-000000000000" }],
        ["GET", `/api/payroll/bir-forms?year=${YEAR}`],
        ["GET", `/api/payroll/bir-forms?year=${YEAR}&format=pdf`],
        ["GET", `/api/payroll/bir-forms?year=${YEAR}&format=csv`],
        ["GET", `/api/payroll/bir-forms?year=${YEAR}&format=xlsx`],
      ]) {
        expect((await api(page, method, path, body)).status, `${role} ${method} ${path}`).toBe(403);
      }
      // The Accountant's page by URL: stays in its own portal.
      await page.goto("/accountant?page=ac-reports");
      await page.waitForURL((url) => url.pathname.startsWith(ACCOUNTS[role].portal), { timeout: 30000 }).catch(() => {});
      expect(new URL(page.url()).pathname.startsWith(ACCOUNTS[role].portal)).toBe(true);
    });
  }

  await step(page, "Database > the functions refuse HR and the Super Admin; clients cannot reach the table", async () => {
    const [record] = await rows(db().from("payroll_tax_annualizations").select("id").eq("employee_id", bea.id).eq("tax_year", YEAR));
    for (const actor of [hr, sa]) {
      const saved = await db().rpc("payroll_tax_annualization_save", { p_actor: actor.id, p_year: YEAR, p_rows: [{ employee_id: bea.id, tax_due: 1 }] });
      expect(saved.error?.message, actor.role).toMatch(/^forbidden: only the Accountant/);
      const scheduled = await db().rpc("payroll_tax_annualization_schedule", { p_actor: actor.id, p_id: record.id, p_period: "December 16-31, 2026" });
      expect(scheduled.error?.message, actor.role).toMatch(/^forbidden: only the Accountant/);
    }
    // The Accountant cannot put it on a 1st cutoff, or on a Final payslip.
    expect((await db().rpc("payroll_tax_annualization_schedule", { p_actor: accountant.id, p_id: record.id, p_period: "December 1-15, 2026" })).error?.message).toMatch(/^invalid: choose a 2nd-cutoff/);
    expect((await db().rpc("payroll_tax_annualization_schedule", { p_actor: accountant.id, p_id: record.id, p_period: OCT2 })).error?.message).toMatch(/already Final/);
    // Nothing deletes it.
    expect((await db().from("payroll_tax_annualizations").delete().eq("id", record.id)).error).toBeTruthy();
    // Signed-in browser clients (anon key) reach neither the table nor the functions.
    const s = localSupabase();
    const anon = createClient(s.url, s.anonKey, { auth: { persistSession: false } });
    const read = await anon.from("payroll_tax_annualizations").select("id");
    expect(read.error || (read.data || []).length === 0 ? "refused" : "open").toBe("refused");
    expect((await anon.rpc("payroll_tax_annualization_save", { p_actor: accountant.id, p_year: YEAR, p_rows: [] })).error).toBeTruthy();
  });
});
