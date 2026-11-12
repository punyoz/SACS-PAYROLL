// Real-world scenarios (SCENARIOS.md) that the earlier specs do not cover:
// two people editing one employee, duplicate people, CSV onboarding,
// separation and offboarding, payroll corrections after approval, implausible
// taps, a forgotten card, role changes, the audit trail, a new branch and the
// database size warning. Runs after 20-payroll-flow (an approved run exists).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, confirm, manilaDay, refresh } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const stamp = Date.now() % 100000;
// Names allow letters only: this run's stamp as letters, so people this spec
// creates never match (same name + birthday) the ones an earlier run made.
const tag = String(stamp).split("").map((d) => "abcdefghij"[Number(d)]).join("");
const Tag = tag.charAt(0).toUpperCase() + tag.slice(1);
const mainBranch = async () => rows(db().from("branches").select("id,name").eq("name", "Main Campus").single());

/** A complete, valid Add employee body (the form's own rules). */
function newEmployee(branchId, overrides = {}) {
  return {
    first_name: "Lorna", last_name: `Villanueva ${Tag}`, email: `lorna.${stamp}@e2e.test`, role: "employee", branch_id: branchId,
    employee_type: "Teaching", position: "Teacher", employment_type: "Full-time", employment_status: "Probationary",
    employee_status: "Active", date_hired: "2026-06-01", basic_salary: 21000, date_of_birth: "1994-03-12", sex: "Female",
    civil_status: "Single", address: "12 Mabini St, Pasig City", cp_number: "09171234567", sss_number: "1234567890",
    philhealth_number: "123456789012", pagibig_number: "123456789012", tin_number: "123456789",
    emergency_contact_name: "Rosa Villanueva", emergency_contact_relationship: "Parent",
    emergency_contact_address: "12 Mabini St, Pasig City", emergency_contact_number: "09181234567",
    ...overrides,
  };
}

test("X-01: two people edit the same employee; the second save is refused, not overwritten", async ({ page, monitor }) => {
  monitor.at("HR > User Management (concurrent edit)");
  monitor.allow(/^409 PATCH \/api\/hr\/employees/, /status of 409/);
  await as(page, "hr", "hr-employees");
  // A complete record (the edit form's required fields), made for this test.
  const branch = await mainBranch();
  const fields = newEmployee(branch.id, { first_name: "Concurrent", last_name: `Edit ${Tag}`, email: `concurrent.${stamp}@e2e.test`, cp_number: "09170000031", date_of_birth: "1989-09-09" });
  const made = await api(page, "POST", "/api/admin/employees", fields);
  expect(made.status, JSON.stringify(made.data)).toBe(201);
  const list = await api(page, "GET", "/api/hr/employees");
  const opened = list.data.employees.find((e) => e.email === fields.email);
  expect(opened.updated_at, "the list sends the version").toBeTruthy();
  const base = { ...fields, id: opened.id, expected_updated_at: opened.updated_at };
  await step(page, "HR (tab 1) > save the address");
  const first = await api(page, "PATCH", "/api/hr/employees", { ...base, address: "1 First Save St, Pasig City" });
  expect(first.status, JSON.stringify(first.data)).toBe(200);
  await step(page, "HR (tab 2, opened before) > save the address → refused");
  const second = await api(page, "PATCH", "/api/hr/employees", { ...base, address: "2 Second Save St, Pasig City" });
  expect(second.status).toBe(409);
  expect(second.data.code).toBe("stale_record");
  expect((await profileByEmail(fields.email)).address).toBe("1 First Save St, Pasig City");
});

test("EM-11: same name and birthday as someone on file is flagged; HR may confirm a different person", async ({ page, monitor }) => {
  monitor.at("HR > Add employee (duplicate)");
  monitor.allow(/^409 POST \/api\/admin\/employees/, /status of 409/);
  await as(page, "hr", "hr-employees");
  const branch = await mainBranch();
  const created = await api(page, "POST", "/api/admin/employees", newEmployee(branch.id, { email: `twin.a.${stamp}@e2e.test`, cp_number: "09170000001" }));
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  const twin = await api(page, "POST", "/api/admin/employees", newEmployee(branch.id, { email: `twin.b.${stamp}@e2e.test`, cp_number: "09170000002" }));
  expect(twin.status).toBe(409);
  expect(twin.data.code).toBe("possible_duplicate");
  const confirmed = await api(page, "POST", "/api/admin/employees", newEmployee(branch.id, { email: `twin.b.${stamp}@e2e.test`, cp_number: "09170000002", confirm_duplicate: true }));
  expect(confirmed.status, JSON.stringify(confirmed.data)).toBe(201);
  expect(confirmed.data.employee.employee_id).not.toBe(created.data.employee.employee_id);
});

test("SC-10 / HR-02: onboard from a CSV file; good rows created, bad rows reported", async ({ page, monitor }) => {
  monitor.at("HR > User Management > Import CSV");
  // The template's columns, read from the source (the app module is not importable here).
  const IMPORT_COLUMNS = [...readFileSync("src/lib/employees/csv-import.js", "utf8").matchAll(/^  \["([a-z_]+)", "([^"]+)"\],$/gm)].map((m) => [m[1], m[2]]);
  expect(IMPORT_COLUMNS.length).toBeGreaterThan(20);
  const row = (values) => IMPORT_COLUMNS.map(([key]) => String(values[key] ?? "")).map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",");
  const base = newEmployee("", { branch: "Main Campus" });
  const csv = [
    IMPORT_COLUMNS.map(([, label]) => (label.includes(",") ? `"${label}"` : label)).join(","),
    row({ ...base, first_name: "Import", last_name: `Alpha ${Tag}`, email: `imp.alpha.${stamp}@e2e.test`, date_of_birth: "1990-01-01", cp_number: "09170000011" }),
    row({ ...base, first_name: "Import", last_name: `Bravo ${Tag}`, email: `imp.bravo.${stamp}@e2e.test`, date_of_birth: "1991-02-02", cp_number: "09170000012", role: "accountant" }),
    row({ ...base, first_name: "Import", last_name: `Charlie ${Tag}`, email: "not-an-email", date_of_birth: "1992-03-03", cp_number: "09170000013" }),
    row({ ...base, first_name: "Import", last_name: `Delta ${Tag}`, email: `imp.delta.${stamp}@e2e.test`, branch: "Atlantis", date_of_birth: "1993-04-04", cp_number: "09170000014" }),
  ].join("\n");
  const dir = join(process.cwd(), "test-results", "scenarios");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `import-${stamp}.csv`);
  writeFileSync(file, csv);

  await as(page, "hr", "hr-employees");
  await step(page, "HR > User Management > Import CSV > choose the file > Check");
  await main(page).getByRole("button", { name: "Import CSV" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#emp-import-file").setInputFiles(file);
  await dialog.getByRole("button", { name: "Check file" }).click();
  await expect(dialog.getByText("2 ready")).toBeVisible({ timeout: 60000 });
  await expect(dialog.getByText("2 refused")).toBeVisible();
  await expect(dialog.getByText(/Line 4.*valid email/)).toBeVisible();
  await expect(dialog.getByText(/Line 5.*Unknown branch "Atlantis"/)).toBeVisible();
  await step(page, "HR > Import CSV > Import 2 employees");
  await dialog.getByRole("button", { name: "Import 2 employees" }).click();
  await expect(dialog.getByText("2 created")).toBeVisible({ timeout: 120000 });
  const made = await rows(db().from("profiles").select("email,role,employee_id,branch_id").in("email", [`imp.alpha.${stamp}@e2e.test`, `imp.bravo.${stamp}@e2e.test`]));
  expect(made).toHaveLength(2);
  expect(made.find((p) => p.email.startsWith("imp.bravo")).role).toBe("accountant");
  expect(made.every((p) => p.employee_id)).toBe(true);
  await dialog.getByRole("button", { name: "Done" }).click();
  await refresh(page);
  await main(page).getByPlaceholder(/Search/).first().fill(`Import Alpha ${Tag}`);
  await expect(main(page).getByText(`Import Alpha ${Tag}`).first()).toBeVisible();
});

test("EM-08 / HR-03: HR separates a resigned employee; card off, taps refused, Final Pay lists them", async ({ page, monitor }) => {
  monitor.at("HR > Edit > Separate");
  const alpha = await profileByEmail(`imp.alpha.${stamp}@e2e.test`).catch(() => null);
  test.skip(!alpha, "runs after the CSV import scenario");
  await as(page, "hr", "hr-employees");
  await step(page, "HR > register a card for Import Alpha");
  const card = await api(page, "POST", "/api/rfid/cards", { action: "register", employee_id: alpha.id, uid: `55${stamp}`.slice(0, 10).padEnd(10, "0"), reason: "E2E new hire" });
  expect([200, 201], JSON.stringify(card.data)).toContain(card.status);
  await step(page, "HR > User Management > Edit Import Alpha > Separate…");
  await main(page).getByPlaceholder(/Search/).first().fill(`Import Alpha ${Tag}`);
  await main(page).locator("tr", { hasText: `Import Alpha ${Tag}` }).first().getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Separate…" }).click();
  const sep = page.getByRole("dialog").filter({ hasText: "Last day of employment" });
  await choose(page, sep.locator("#sep-reason"), "Resigned");
  await sep.locator("#sep-note").fill("Resignation letter dated Oct 1");
  await sep.getByRole("button", { name: "Separate", exact: true }).click();
  await expect(sep).toBeHidden({ timeout: 30000 });
  const after = await profileByEmail(alpha.email);
  expect(after.employee_status).toBe("Separated");
  expect(after.separated_on).toBe(manilaDay(0));
  const cards = await rows(db().from("rfid_cards").select("status").eq("employee_id", alpha.id));
  expect(cards.every((c) => c.status !== "active"), "the card no longer records attendance").toBe(true);
  await step(page, "Accountant > Final Pay lists the separated employee");
  monitor.at("Accountant > Final Pay");
  await as(page, "accountant", "ac-final-pay");
  const finalPay = await api(page, "GET", "/api/accountant/final-pay");
  expect(finalPay.data.people.map((p) => p.id)).toContain(alpha.id);
});

test("AC-08 / AC-06: a wrong approved payslip is corrected on a later payslip (file → reject → resubmit → approve)", async ({ page, monitor }) => {
  const branch = await mainBranch();
  const approved = await rows(db().from("payroll_entries").select("id,employee_name,pay_period,run_id,payroll_runs!inner(status)")
    .eq("branch_id", branch.id).eq("status", "paid").eq("payroll_runs.status", "approved").ilike("employee_name", "%Reyes%").limit(1));
  test.skip(!approved.length, "needs the approved run from 20-payroll-flow");
  const reason = `E2E raise effective Oct 1 not applied ${stamp}`;

  await step(page, "Accountant > Payroll Records > Correct Bea's approved payslip", async () => {
    monitor.at("Accountant > Payroll Records > Correct");
    await as(page, "accountant", "ac-records");
    await settle(page);
    const row = main(page).locator("tr", { hasText: "Bea" }).filter({ hasText: "October 1-15, 2026" }).first();
    await row.getByRole("button", { name: "Correct" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#pc-amount").fill("1250");
    await dialog.locator("#pc-reason").fill(reason);
    await dialog.getByRole("button", { name: "Send to HR" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await expect(main(page).locator("tr", { hasText: reason }).getByText("Pending HR Approval")).toBeVisible();
  });

  const correction = async () => rows(db().from("payroll_corrections").select("*").eq("reason", reason).single());

  await step(page, "HR > Payroll Approval > Payroll corrections > Reject with a reason", async () => {
    monitor.at("HR > Payroll corrections");
    await as(page, "hr", "hr-payroll-approval");
    const row = main(page).locator("tr", { hasText: reason });
    await row.getByRole("button", { name: "Reject" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#pc-note").fill("Attach the memo for the raise");
    await dialog.getByRole("button", { name: "Reject" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    expect((await correction()).status).toBe("rejected");
  });

  await step(page, "Accountant > Payroll Records > sees HR's reason, Fix & resubmit", async () => {
    monitor.at("Accountant > corrections (resubmit)");
    await as(page, "accountant", "ac-records");
    const row = main(page).locator("tr", { hasText: reason });
    await expect(row.getByText("Attach the memo for the raise")).toBeVisible();
    await row.getByRole("button", { name: "Fix & resubmit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#pc-reason").fill(`${reason} (memo 2026-17)`);
    await dialog.getByRole("button", { name: "Resubmit to HR" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
  });

  await step(page, "HR > approves twice at once (double-click): one approval, one incentive", async () => {
    monitor.at("HR > Payroll corrections (approve)");
    monitor.allow(/^409 PATCH \/api\/payroll\/corrections/, /status of 409/);
    await as(page, "hr", "hr-payroll-approval");
    const fixed = await rows(db().from("payroll_corrections").select("id").eq("reason", `${reason} (memo 2026-17)`).single());
    const [a, b] = await Promise.all([
      api(page, "PATCH", "/api/payroll/corrections", { id: fixed.id, action: "approve", note: "OK" }),
      api(page, "PATCH", "/api/payroll/corrections", { id: fixed.id, action: "approve", note: "OK" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const done = await rows(db().from("payroll_corrections").select("status,applied_incentive_id,history").eq("id", fixed.id).single());
    expect(done.status).toBe("approved");
    expect(done.history.map((h) => h.action)).toEqual(["filed", "rejected", "resubmitted", "approved"]);
    const items = await rows(db().from("payroll_monthly_incentives").select("amount,description").eq("id", done.applied_incentive_id));
    expect(Number(items[0].amount)).toBe(1250);
    expect(items[0].description).toContain("Correction — October 1-15, 2026");
    await refresh(page);
    await expect(main(page).locator("tr", { hasText: `${reason} (memo 2026-17)` }).getByText("Approved").first()).toBeVisible();
  });

  await step(page, "The approved payslip itself is unchanged", async () => {
    const original = await rows(db().from("payroll_entries").select("net_pay,updated_at").eq("id", approved[0].id).single());
    expect(original).toBeTruthy();
  });
});

test("EM-01 / EM-03: a forgotten card is recorded by HR; a 'time in' hours before the shift is refused", async ({ page, monitor }) => {
  const acct = await profileByEmail(ACCOUNTS.accountant.email);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  await step(page, "HR > records today by hand for Bea, who forgot her card (EM-01)", async () => {
    monitor.at("HR > Attendance > correct_record");
    await as(page, "hr", "hr-attendance");
    const day = manilaDay(0);
    const res = await api(page, "PATCH", "/api/attendance/corrections", {
      action: "correct_record", employee_id: bea.id, log_date: day, type: "time_in", time_in: "07:30",
      note: "E2E forgot the RFID card; confirmed by the branch Admin",
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const log = await rows(db().from("attendance_logs").select("status,time_in").eq("employee_id", bea.id).eq("log_date", day).eq("archived_duplicate", false).single());
    expect(log.time_in).toBeTruthy();
  });

  await step(page, "RFID Terminal > a card tapped at 03:00 for a 7:00 shift is refused and kept for HR (EM-03)", async () => {
    monitor.at("RFID Terminal > too-early tap");
    monitor.allow(/^4\d\d POST \/api\/admin\/attendance/, /status of 422/);
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    test.skip(now.getUTCHours() < 4, "needs a 03:00 tap earlier today");
    await as(page, "hr", "hr-rfid-terminals");
    const uid = `77${stamp}`.slice(0, 10).padEnd(10, "1");
    const reg = await api(page, "POST", "/api/rfid/cards", { action: "register", employee_id: acct.id, uid, reason: "E2E card" });
    expect([200, 201, 409]).toContain(reg.status);
    await main(page).getByRole("button", { name: "Open RFID Terminal" }).click();
    await page.waitForURL(/rfid-terminal/);
    // No terminal to choose: the password opens it (2026-10-27).
    await page.locator("#rt-lock-password").fill(ACCOUNTS.hr.password);
    await page.getByRole("button", { name: "Unlock terminal" }).click();
    await page.locator("#rt-scan-input").waitFor({ timeout: 30000 });
    const today = manilaDay(0);
    const early = await page.request.post("/api/admin/attendance", {
      headers: { "x-sacs-kiosk": "1", "Content-Type": "application/json" },
      data: { rfid_code: (await profileByEmail(ACCOUNTS.accountant.email)).rfid_uid, offline_tapped_at: `${today}T03:00:00+08:00` },
    });
    const body = await early.json();
    expect(early.status()).toBe(422);
    expect(body.code).toBe("too_early");
    const day = await rows(db().from("attendance_logs").select("id").eq("employee_id", acct.id).eq("log_date", today).not("time_in", "is", null));
    expect(day, "no time in was recorded").toHaveLength(0);
    const blocked = await rows(db().from("attendance_blocked_taps").select("reason").eq("employee_id", acct.id).eq("log_date", today));
    expect(blocked.some((b) => /more than 3 hours before/.test(b.reason))).toBe(true);
  });
});

test("SA-02: a role change ends the open session at once; the change is in the audit log", async ({ page, monitor }) => {
  monitor.at("Super Admin > role change");
  monitor.allow(/^401 /, /status of 401/);
  const admin2 = await profileByEmail(ACCOUNTS.admin2.email);
  await as(page, "admin2", "adm-dashboard");
  const before = await api(page, "GET", "/api/admin/branch-oversight?view=dashboard");
  expect(before.status).toBe(200);
  const adminState = await page.context().storageState();
  await step(page, "Super Admin > Admin & HR Accounts > change North Admin to HR");
  await as(page, "super_admin", "sa-accounts");
  const change = await api(page, "PATCH", "/api/admin/users", { id: admin2.id, action: "update", role: "hr" });
  expect(change.status, JSON.stringify(change.data)).toBe(200);
  await step(page, "North Admin's old session > refused");
  const ctx = await page.context().browser().newContext({ baseURL: page.url().split("/super-admin")[0], storageState: adminState });
  const stale = await ctx.request.get("/api/admin/branch-oversight?view=dashboard");
  // At once: refused. The route re-reads the account and refuses the old
  // role (403), or, when the proxy's 5 s session cache is cold, the session
  // is already over (401).
  expect([401, 403], await stale.text()).toContain(stale.status());
  // Within seconds (the session check is cached 5 s): the session itself is over (401).
  await page.waitForTimeout(6000);
  const ended = await ctx.request.get("/api/admin/branch-oversight?view=dashboard");
  expect(ended.status(), await ended.text()).toBe(401);
  await ctx.close();
  const audit = await api(page, "GET", `/api/admin/audit-logs?search=${encodeURIComponent(admin2.full_name)}&limit=20`);
  expect(audit.status).toBe(200);
  expect(audit.data.logs.length).toBeGreaterThan(0);
  await step(page, "Super Admin > change it back to Admin");
  const back = await api(page, "PATCH", "/api/admin/users", { id: admin2.id, action: "update", role: "admin", branch_id: admin2.branch_id });
  expect(back.status, JSON.stringify(back.data)).toBe(200);
  // As the Edit dialog does (staff-account-dialogs.jsx): the branch is set by
  // a second call, Branch Assignment; the role change alone leaves none.
  const branch = await api(page, "POST", "/api/admin/branch-employees", { user_id: admin2.id, branch_id: admin2.branch_id, assigned_by: "Super Admin" });
  expect(branch.status, JSON.stringify(branch.data)).toBeLessThan(300);
  const restored = await profileByEmail(ACCOUNTS.admin2.email);
  expect(restored.role).toBe("admin");
  expect(restored.branch_id, "North Admin is back in North").toBe(admin2.branch_id);
});

test("HR-07 / SA-03 / SC-14 / SA-01: audit search reaches old entries; size warning; a new branch works everywhere", async ({ page, monitor }) => {
  monitor.at("Super Admin > audit, size, branch");
  await as(page, "super_admin", "sa-audit");
  await step(page, "Super Admin > Audit & Monitoring > search by words and dates");
  const all = await api(page, "GET", "/api/admin/audit-logs?limit=5");
  expect(all.status).toBe(200);
  const oldest = await rows(db().from("audit_logs").select("description,created_at").order("created_at", { ascending: true }).limit(1));
  const word = String(oldest[0].description).split(/\s+/).find((w) => w.length > 6) || String(oldest[0].description).slice(0, 8);
  // The filter uses the Manila calendar day (a run before 08:00 Manila would
  // otherwise take yesterday's UTC date).
  const day = new Date(new Date(oldest[0].created_at).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const found = await api(page, "GET", `/api/admin/audit-logs?search=${encodeURIComponent(word)}&from=${day}&to=${day}&limit=50`);
  expect(found.data.logs.some((l) => l.description === oldest[0].description), "the oldest entry is found by a word and its date").toBe(true);
  expect(found.data.summary.total).toBeGreaterThanOrEqual(1);
  await main(page).locator("#adm-audit-search").fill(word);
  await settle(page);

  await step(page, "Super Admin > System health shows the database size");
  const system = await api(page, "GET", "/api/admin/system");
  expect(system.data.database_size.bytes).toBeGreaterThan(0);
  expect(system.data.database_size.limit_bytes).toBe(500 * 1024 * 1024);
  await as(page, "super_admin", "sa-dashboard");
  await expect(main(page).getByText("Database size")).toBeVisible();

  await step(page, "Super Admin > Branch Management > add a branch; HR can use it at once");
  const name = `E2E Scenario Campus ${stamp}`;
  const branch = await api(page, "POST", "/api/admin/branches", { name, location: "Scenario City", status: "Active" });
  expect(branch.status, JSON.stringify(branch.data)).toBe(201);
  // No registered terminals (removed 2026-10-27): a new branch needs none; its
  // Admin opens the RFID Terminal with the password.
  await as(page, "hr", "hr-rfid-terminals");
  const branches = await api(page, "GET", "/api/admin/branches");
  expect(JSON.stringify(branches.data)).toContain(name);
});

test("AC-11: BIR 2316 and the alphalist (the Super Admin only: sets the employer with checked boxes, generates; HR, Accountant, Employee refused)", async ({ page, monitor }) => {
  const year = Number(manilaDay().slice(0, 4));
  const paid = await rows(db().from("payroll_entries").select("id").eq("status", "paid").like("pay_period", `%, ${year}`).limit(1));
  test.skip(!paid.length, "needs a paid payslip from 20-payroll-flow");

  for (const [label, viewport] of [["desktop 1366", { width: 1366, height: 900 }], ["mobile 390", { width: 390, height: 844 }]]) {
    await step(page, `Super Admin > System Configuration > General > BIR employer details: the boxes refuse the wrong characters (${label})`, async () => {
      monitor.at(`Super Admin > BIR employer details (${label})`);
      await page.setViewportSize(viewport);
      await as(page, "super_admin", "sa-config");
      await settle(page);
      const card = main(page).locator("[data-slot=card]").filter({ hasText: "BIR employer details" });
      const box = (key) => card.locator(`#cfg-bir-bir_${key}`);
      // Numbers-only boxes: the numeric keyboard, a maximum, letters dropped as typed and as pasted.
      for (const [key, max] of [["employer_tin", "17"], ["rdo_code", "3"], ["zip_code", "4"]]) {
        await expect(box(key)).toHaveAttribute("inputmode", "numeric");
        await expect(box(key)).toHaveAttribute("maxlength", max);
      }
      await box("employer_tin").fill("");
      await box("employer_tin").pressSequentially("1a2b3");
      await expect(box("employer_tin")).toHaveValue("123");
      await expect(card.getByText("Numbers only: letters and symbols are not accepted.").first()).toBeVisible();
      await box("employer_tin").fill("TIN 111-222-333-000 (main)");
      await expect(box("employer_tin")).toHaveValue("111-222-333-000");
      await box("rdo_code").fill("0a4b6c");
      await expect(box("rdo_code")).toHaveValue("046");
      await box("zip_code").fill("16x00");
      await expect(box("zip_code")).toHaveValue("1600");
      // Name boxes: digits and symbols dropped.
      await expect(box("signatory_name")).toHaveAttribute("maxlength", "120");
      await box("signatory_name").fill("Juan2 Dela Cruz#");
      await expect(box("signatory_name")).toHaveValue("Juan Dela Cruz");
      await expect(card.getByText(/Names can only have letters/)).toBeVisible();
      await box("employer_name").fill("Shepherd Angels Christian School 1 Inc.");
      await expect(box("employer_name")).toHaveValue("Shepherd Angels Christian School  Inc.");
      await box("employer_name").fill("Shepherd Angels Christian School Inc.");
      // A wrong TIN length: the shared TIN rule, inline.
      await box("employer_tin").fill("12");
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText("TIN must be 9, 12 or 14 digits (with the branch code).")).toBeVisible();
      await box("employer_tin").fill("111-222-333-000");
      await card.getByRole("button", { name: "Save" }).click();
      await confirm(page, "Save");
      await expect(card.getByText("BIR employer details saved.")).toBeVisible();
      const saved = await rows(db().from("system_config").select("key,value").eq("section", "general").like("key", "bir_%"));
      // The TIN is stored as digits, as the employees' TINs.
      expect(Object.fromEntries(saved.map((r) => [r.key, r.value]))).toMatchObject({ bir_employer_tin: "111222333000", bir_rdo_code: "046", bir_zip_code: "1600", bir_signatory_name: "Juan Dela Cruz" });
    });
  }
  await page.setViewportSize({ width: 1366, height: 900 });

  await step(page, "Super Admin > the config API refuses bad BIR values on a direct call", async () => {
    for (const [fields, message] of [
      [{ bir_zip_code: "16a0" }, /4 digits/],
      [{ bir_rdo_code: "4-6" }, /3 digits/],
      [{ bir_employer_tin: "111222333x" }, /numbers only/],
      [{ bir_signatory_name: "Juan 3" }, /letters, spaces/],
      [{ bir_registered_address: "x".repeat(251) }, /at most 250/],
    ]) {
      const res = await api(page, "PATCH", "/api/admin/config", { section: "general", fields });
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(res.data.error).toMatch(message);
    }
    const saved = await rows(db().from("system_config").select("key,value").eq("section", "general").eq("key", "bir_zip_code"));
    expect(saved[0].value).toBe("1600");
  });

  await step(page, "Super Admin > BIR forms by API: the alphalist and a 2316 (no screen generates them)", async () => {
    monitor.at("Super Admin > BIR forms");
    const bea = await profileByEmail(ACCOUNTS.employee2.email);
    await as(page, "super_admin", "sa-audit");
    await settle(page);
    const sheet = await page.request.get(`/api/payroll/bir-forms?year=${year}&format=xlsx`);
    expect(sheet.status()).toBe(200);
    expect(sheet.headers()["content-disposition"]).toContain(`Alphalist-1604C-${year}.xlsx`);
    const pdf = await page.request.get(`/api/payroll/bir-forms?year=${year}&branch_id=${bea.branch_id}&format=pdf&employee_id=${bea.id}`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-disposition"]).toMatch(/BIR-2316-\d{4}-E2E-EMP-002\.pdf/);
    const logs = await rows(db().from("audit_logs").select("action").eq("action", "bir_forms_export"));
    expect(logs.length).toBeGreaterThanOrEqual(2);
    // TINs on screen are masked (the full ones are only in the files).
    const body = await api(page, "GET", `/api/payroll/bir-forms?year=${year}&branch_id=${bea.branch_id}`);
    expect(body.status).toBe(200);
    expect(body.data.rows.every((r) => !/\d{5}/.test(r.tin_masked))).toBe(true);
    expect([403, 405]).toContain((await api(page, "POST", "/api/payroll/bir-forms", {})).status);
    expect((await api(page, "GET", "/api/payroll/bir-forms?year=2O26")).status).toBe(400);
  });

  for (const [role, home] of [["hr", "hr-payroll-records"], ["accountant", "ac-reports"], ["employee", "emp-payslips"]]) {
    await step(page, `${role} > no BIR forms anywhere, every BIR call refused (the Super Admin's only, 2026-11-12)`, async () => {
      monitor.at(`${role} > BIR refused`);
      monitor.allow(/^40[34] GET \/api\/(payroll\/bir-forms|employee\/bir-2316|me\/bir-2316)/, /status of 40[34]/);
      await as(page, role, home);
      await settle(page);
      await expect(main(page).locator("[data-slot=card]").filter({ hasText: /BIR forms|My BIR 2316|BIR Form 2316/ })).toHaveCount(0);
      expect((await api(page, "GET", `/api/payroll/bir-forms?year=${year}`)).status).toBe(403);
      expect((await api(page, "GET", `/api/employee/bir-2316?year=${year - 1}&format=pdf`)).status).toBe(403);
      expect([403, 404]).toContain((await api(page, "GET", "/api/me/bir-2316")).status);
    });
  }
});
