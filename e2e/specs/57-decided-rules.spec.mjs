// The decided business rules added 2026-10-26/27, checked against the real
// local stack (deployment-readiness audit, 2026-10-27): the Accountant works
// on their own branch only; government deductions are computed and cannot be
// typed; only the Super Admin edits the government rate tables; only HR
// changes a basic salary (effective-dated, with an audit trail); the Super
// Admin holds no HR or payroll decision. Expectations come from the rules,
// not from the code under test. Runs after the payroll flow (Oct 1-15 paid).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { lostLines, main, settle, snapshot } from "../support/portal.mjs";
import { api, choose } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const SECOND = "October 16-31, 2026";
const NOBODY = "00000000-0000-0000-0000-000000000000";

test("Accountant: own branch only, end to end", async ({ page, monitor }) => {
  const carlo = await profileByEmail(ACCOUNTS.employee3.email); // North branch
  const ana = await profileByEmail(ACCOUNTS.employee.email); // Main Campus, the Accountant's branch
  monitor.at("Accountant > branch scope");
  await as(page, "accountant", `ac-process&period=${encodeURIComponent(SECOND)}`);

  await step(page, "Accountant > Process Payroll > lists Ana, never Carlo (North)", async () => {
    const res = await api(page, "GET", `/api/accountant/payroll?period=${encodeURIComponent(SECOND)}`);
    expect(res.status).toBe(200);
    const ids = (res.data.attendance_rows || []).map((r) => r.employee_id);
    expect(ids).toContain(ana.id);
    expect(ids).not.toContain(carlo.id);
    expect(JSON.stringify(res.data)).not.toContain(carlo.id);
    await settle(page);
    await main(page).locator("#pc-employee").click();
    await expect(page.getByRole("option", { name: /Ana/ }).first()).toBeVisible();
    await expect(page.getByRole("option", { name: /Carlo/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  await step(page, "Accountant > another branch's employee: process, draft, incentive, loan are refused", async () => {
    const before = await rows(db().from("payroll_entries").select("id").eq("employee_id", carlo.id));
    for (const body of [
      { action: "submit", employee_id: carlo.id, pay_period: SECOND },
      { action: "save_draft", employee_id: carlo.id, pay_period: SECOND },
      { action: "add_monthly_item", employee_id: carlo.id, kind: "incentive", amount: 500, item_date: "2026-11-10", description: "E2E cross-branch" },
    ]) {
      const res = await api(page, "POST", "/api/accountant/payroll", body);
      expect(res.status, `${body.action} for another branch's employee`).toBe(404);
    }
    const batch = await api(page, "POST", "/api/accountant/payroll", { action: "batch_submit", pay_period: SECOND, entries: [{ employee_id: carlo.id }] });
    expect(batch.data?.processed || []).toHaveLength(0);
    const loan = await api(page, "POST", "/api/accountant/loans", { action: "create_loan", employee_id: carlo.id, loan_type: "salary", principal: 1000, installments: 2, date_granted: "2026-11-10", description: "E2E cross-branch" });
    expect(loan.status).toBe(404);
    const after = await rows(db().from("payroll_entries").select("id").eq("employee_id", carlo.id));
    expect(after.length, "nothing was written for Carlo").toBe(before.length);
  });
});

test("Process Payroll: government deductions are computed and read-only", async ({ page, monitor }) => {
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  monitor.at("Accountant > Process Payroll (2nd half)");
  await as(page, "accountant", `ac-process&period=${encodeURIComponent(SECOND)}`);
  await settle(page);

  await step(page, "Accountant > Process Payroll > the server computes SSS / PhilHealth / Pag-IBIG / tax and locks them", async () => {
    const res = await api(page, "GET", `/api/accountant/payroll?period=${encodeURIComponent(SECOND)}`);
    const row = (res.data.attendance_rows || []).find((r) => r.employee_id === ana.id);
    expect(row?.defaults?.government_locked).toBe(true);
    // From Oct 16: 5% of the SSS salary credit, 2.5% of basic (floor/ceiling), 2% up to the ₱10,000 fund cap.
    const basic = Number(ana.basic_salary);
    const msc = Math.min(35000, Math.max(5000, Math.round(basic / 500) * 500));
    expect(Number(row.defaults.philhealth)).toBeCloseTo(Math.min(100000, Math.max(10000, basic)) * 0.025, 2);
    expect(Number(row.defaults.pagibig)).toBeCloseTo(Math.min(10000, basic) * 0.02, 2);
    expect(Math.abs(Number(row.defaults.sss) - msc * 0.05)).toBeLessThanOrEqual(25); // bracket rounding
  });

  await step(page, "Accountant > Process Payroll > the form shows them as text with Flag for review, no input", async () => {
    await choose(page, main(page).locator("#pc-employee"), /Ana/);
    await settle(page);
    for (const id of ["pc-sss", "pc-philhealth", "pc-pagibig", "pc-tax"]) {
      await expect(main(page).locator(`#${id}`)).toBeVisible();
      await expect(main(page).locator(`input#${id}`)).toHaveCount(0);
    }
    await expect(main(page).getByRole("button", { name: "Flag SSS for review" })).toBeVisible();
  });

  await step(page, "Accountant > a typed SSS amount is refused (government_deduction_locked); nothing saved", async () => {
    const before = await rows(db().from("payroll_entries").select("id").eq("employee_id", ana.id).eq("pay_period", SECOND));
    const res = await api(page, "POST", "/api/accountant/payroll", { action: "save_draft", employee_id: ana.id, pay_period: SECOND, deductions: { sss: 1 } });
    expect(res.status).toBe(422);
    expect(res.data?.code).toBe("government_deduction_locked");
    const after = await rows(db().from("payroll_entries").select("id").eq("employee_id", ana.id).eq("pay_period", SECOND));
    expect(after.length).toBe(before.length);
  });
});

test("Government rate tables: Super Admin edits; Accountant and HR read only; others none", async ({ page, monitor }) => {
  monitor.at("Government rates access");
  const rate = { rate_type: "sss_pct", scope: "global", value: 99, effective_date: "2027-01-01" };
  for (const role of ["accountant", "hr"]) {
    await step(page, `${role} > Government Rates > reads the table, cannot change it`, async () => {
      await as(page, role);
      expect((await api(page, "GET", "/api/payroll/government-rates")).status).toBe(200);
      expect([403, 405]).toContain((await api(page, "POST", "/api/payroll/government-rates", rate)).status);
      expect((await api(page, "POST", "/api/admin/payroll-rates", rate)).status).toBe(403);
      expect((await api(page, "POST", "/api/admin/payroll-settings", { kind: "tax_table", effective_date: "2027-01-01", brackets: [] })).status).toBe(403);
    });
  }
  for (const role of ["admin", "employee"]) {
    await step(page, `${role} > Government Rates > no access`, async () => {
      await as(page, role);
      expect((await api(page, "GET", "/api/payroll/government-rates")).status).toBe(403);
    });
  }
  await step(page, "Super Admin > Government Rates > reads the table (edits in System Configuration)", async () => {
    await as(page, "super_admin");
    expect((await api(page, "GET", "/api/payroll/government-rates")).status).toBe(200);
  });
  const written = await rows(db().from("payroll_rate_configs").select("id").eq("value", 99).eq("effective_date", "2027-01-01"));
  expect(written, "no refused write reached the table").toHaveLength(0);
});

test("HR changes a basic salary: effective-dated, audited; nobody else can", async ({ page, monitor }) => {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const newSalary = Number(bea.basic_salary) + 1234;

  for (const role of ["accountant", "super_admin", "admin", "employee"]) {
    await step(page, `${role} > salary change API is refused`, async () => {
      monitor.at(`${role} > salary change`);
      await as(page, role);
      const res = await api(page, "POST", "/api/hr/salary-changes", { employee_id: bea.id, new_salary: newSalary, effective_date: "2026-12-01", reason: "Promotion" });
      expect([401, 403]).toContain(res.status);
    });
  }

  await step(page, "HR > the general employee edit refuses a different salary (needs a salary change)", async () => {
    monitor.at("HR > User Management");
    await as(page, "hr", "hr-employees");
    const res = await api(page, "PATCH", "/api/admin/employees", { id: bea.id, basic_salary: newSalary });
    expect(res.status).toBe(409);
  });

  await step(page, "HR > User Management > Salary > save a raise from a future month", async () => {
    await settle(page);
    const row = main(page).locator("tr", { hasText: /Bea/ }).first();
    await row.getByRole("button", { name: "Salary", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Change salary/)).toBeVisible();
    await dialog.locator("#sal-new").fill(String(newSalary));
    await dialog.locator("#sal-month").click();
    await page.getByRole("option").last().click();
    await dialog.locator("#sal-reason").click();
    await page.getByRole("option", { name: "Promotion" }).click();
    await dialog.locator("#sal-note").fill("E2E readiness audit raise");
    await dialog.getByRole("button", { name: "Save salary change" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
  });

  await step(page, "HR > the change is stored with its date, old and new salary, and who made it", async () => {
    const changes = await rows(db().from("employee_salary_changes").select("*").eq("employee_id", bea.id).eq("new_salary", newSalary));
    expect(changes).toHaveLength(1);
    const change = changes[0];
    expect(change.effective_date.slice(8, 10), "starts on the 1st of a month").toBe("01");
    expect(change.effective_date > new Date().toISOString().slice(0, 10)).toBe(true);
    expect(Number(change.old_salary)).toBe(Number(bea.basic_salary));
    expect(change.created_by_role).toBe("hr");
    // The audit log names the employee by staff code (entity_id) and keeps the old → new figures.
    const audit = await rows(db().from("audit_logs").select("action,entity_id,metadata").eq("action", "salary_change").eq("entity_id", bea.employee_id || bea.id));
    expect(audit.length).toBeGreaterThan(0);
    expect(Number(audit[0].metadata?.new_salary)).toBe(newSalary);
    expect(Number(audit[0].metadata?.old_salary)).toBe(Number(bea.basic_salary));
    const profile = await profileByEmail(ACCOUNTS.employee2.email);
    expect(Number(profile.basic_salary), "a future change does not touch today's salary").toBe(Number(bea.basic_salary));
  });
});

test("Payslip export: the PDF carries the school seal and the figures stored for it", async ({ page, monitor }) => {
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const paid = await rows(db().from("payroll_entries").select("id,payslip_no,net_pay,status").eq("employee_id", ana.id).eq("pay_period", "October 1-15, 2026"));
  expect(paid.length, "Ana's October 1-15 payslip from the payroll flow").toBeGreaterThan(0);
  const entry = paid[paid.length - 1];
  const pdfOf = async (role, path) => {
    await as(page, role);
    const res = await page.request.get(path);
    return { status: res.status(), type: res.headers()["content-type"], text: res.ok() ? (await res.body()).toString("latin1") : "" };
  };

  await step(page, "Accountant > Pay Record > PDF: seal, org name, payslip no., net pay match the record", async () => {
    monitor.at("Accountant > Pay Record PDF");
    const pdf = await pdfOf("accountant", `/api/accountant/payroll?format=pdf&entry_id=${entry.id}`);
    expect(pdf.status).toBe(200);
    expect(pdf.type).toContain("application/pdf");
    expect(pdf.text.startsWith("%PDF-")).toBe(true);
    expect(pdf.text, "the school seal is embedded").toContain("/DCTDecode");
    expect(pdf.text).toContain("Payroll");
    if (entry.payslip_no) expect(pdf.text).toContain(entry.payslip_no);
    const net = Number(entry.net_pay).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(pdf.text, `net pay ${net}`).toContain(net);
  });

  await step(page, "HR > Payroll Records > the same payslip as PDF, same net pay", async () => {
    monitor.at("HR > Payroll Records PDF");
    const pdf = await pdfOf("hr", `/api/hr/payroll-records?entry_id=${entry.id}&format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.text).toContain("/DCTDecode");
    expect(pdf.text).toContain(Number(entry.net_pay).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  });

  await step(page, "Admin (another role) cannot download it", async () => {
    const pdf = await pdfOf("admin", `/api/accountant/payroll?format=pdf&entry_id=${entry.id}`);
    expect([401, 403, 404]).toContain(pdf.status);
  });
});

// The vanishing-records bug (2026-10-19) came from a later reload narrowing
// the data. Each page sits idle past the employee poll (30 s), gets a
// focus / visibility change, and must still show what it showed.
test("idle pages keep their data (no stale, frozen or vanishing rows)", async ({ page, monitor }) => {
  test.setTimeout(6 * 60 * 1000);
  const PAGES = [
    ["accountant", "ac-records"], ["accountant", "ac-process"], ["hr", "hr-payroll-approval"],
    ["hr", "hr-payroll-records"], ["hr", "hr-employees"], ["employee", "emp-dash"], ["employee", "emp-payslips"],
  ];
  for (const [role, id] of PAGES) {
    await step(page, `${role} > ${id} > idle 35 s, focus change: same rows and lines`, async () => {
      monitor.at(`${role} > ${id} (idle)`);
      await as(page, role, id);
      await settle(page);
      const before = await snapshot(page);
      await page.waitForTimeout(35000);
      await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
      await settle(page);
      const after = await snapshot(page);
      expect(after.rows, `${id}: table rows after idle`).toBe(before.rows);
      expect(lostLines(before, after), `${id}: lines gone after idle`).toEqual([]);
    });
  }
});

test("Super Admin: system functions only, no HR or payroll decisions", async ({ page, monitor }) => {
  monitor.at("Super Admin > decision APIs");
  await as(page, "super_admin");
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const refused = [
    ["PATCH", "/api/hr/adjustment-approvals", { kind: "incentive", id: NOBODY, decision: "approve" }],
    ["POST", "/api/hr/tenure-protection", { action: "grant", employee_id: ana.id }],
    ["POST", "/api/admin/employees", { full_name: "E2E Nobody", email: "nobody@e2e.test", role: "employee" }],
    ["PATCH", "/api/admin/employees", { id: ana.id, position: "E2E" }],
    ["GET", "/api/hr/awol-cases"],
    ["POST", "/api/accountant/loans", { action: "create_loan", employee_id: ana.id, loan_type: "salary", principal: 1000, installments: 2 }],
  ];
  for (const [method, path, body] of refused) {
    await step(page, `Super Admin > ${method} ${path} is refused`, async () => {
      const res = await api(page, method, path, body);
      expect([401, 403], `${method} ${path} answered ${res.status}`).toContain(res.status);
    });
  }
});
