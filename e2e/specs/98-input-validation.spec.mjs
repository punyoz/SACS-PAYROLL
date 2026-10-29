// Input TYPE and LENGTH validation on every textbox, live (2026-10-29).
//
// UI: every page and every "Add / New / Edit / …" dialog of all five roles
// is opened; each visible textbox gets, by its expected type, letters
// (number fields), digits and symbols (name fields), letters (digit-only
// fields) and a pasted 1,200-character string; the value it keeps is read
// back. Nothing is submitted.
//
// API: the same wrong-type, oversized and empty values are sent straight to
// the routes (no browser checks in the way). A field passes only when the
// server refuses it (4xx); storing it, whole or cut short, or a 5xx fails.
// Legitimate values (real names, dashed government numbers, boundary
// amounts and text at exactly the limit) must be accepted.
//
// The limits are the reference table of 2026-10-29 (src/lib/input-limits.js).
//
// Results: test-results/validation/{ui,api}.json and a checklist in the terminal.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as, ROLE_LABEL } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { PAGES, main, navTo, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_MAIN } from "../accounts.mjs";

test.use({ viewport: { width: 1280, height: 800 } });

const OUT = join(process.cwd(), "test-results", "validation");
const LONG = "Z".repeat(1200);
const HUGE = "999999999999999";
const clock = () => new Date().toLocaleTimeString("en-PH", { hour12: false, timeZone: "Asia/Manila" });
let n = 0;
const say = (t) => { n += 1; console.log(`  [#${n} ${clock()}] ${t}`); };

// ── Expected type per field (id or label), from the label, the column and real use ──
const NAME_RE = /first[_-]?name|last[_-]?name|middle|emergency_contact_name|contact person/i;
const DIGITS_RE = /cp_number|contact_number|sss_number|philhealth_number|pagibig_number|tin_number|^rf-uid|adm-rfid-input|mobile/i;
const SKIP_RE = /search|login-|reset-identity|^sidebar/i;
function expectedType(id, label, type) {
  if (type === "number") return "number";
  if (NAME_RE.test(id) || NAME_RE.test(label)) return "name";
  if (DIGITS_RE.test(id) || DIGITS_RE.test(label)) return "digits";
  if (/email/i.test(id) || type === "email") return "email";
  return "text";
}

const uiResults = new Map();

async function probeField(page, el, where) {
  const info = await el.evaluate((e) => ({
    id: e.id || "", type: e.type || e.tagName.toLowerCase(), tag: e.tagName.toLowerCase(),
    maxLength: e.maxLength > 0 ? e.maxLength : null, max: e.max || null, min: e.min || null,
    label: (e.labels?.[0]?.innerText || e.getAttribute("aria-label") || e.placeholder || "").trim().slice(0, 60),
    readOnly: e.readOnly || e.disabled,
  }));
  if (info.readOnly || ["date", "time", "file", "checkbox", "radio", "hidden", "month", "password", "search"].includes(info.type)) return;
  if (SKIP_RE.test(info.id) || SKIP_RE.test(info.label)) return;
  const key = `${where.split(" > ").slice(0, 2).join(" > ")} | ${info.id || info.label}`;
  if (uiResults.has(key)) return;
  const kind = expectedType(info.id, info.label, info.type);
  const original = await el.inputValue().catch(() => "");
  const r = { where, id: info.id, label: info.label, html_type: info.type, expected: kind, maxLength: info.maxLength, max: info.max, tests: [] };
  const typeInto = async (text) => { await el.fill("").catch(() => {}); await el.click().catch(() => {}); await page.keyboard.type(text, { delay: 15 }); return el.inputValue().catch(() => ""); };
  try {
    if (kind === "number") {
      const v = await typeInto("abc");
      r.tests.push({ test: "letters typed", kept: v, pass: !/[a-z]/i.test(v) });
      const sym = await typeInto("1e5+-");
      r.tests.push({ test: "e + - typed", kept: sym, pass: !/[eE+-]/.test(sym) });
      // Typing past the max is refused keystroke by keystroke, so the box never holds more.
      const big = await typeInto(HUGE);
      r.tests.push({ test: `${HUGE} typed`, kept: big, pass: Boolean(info.max) && Number(big || 0) <= Number(info.max), note: info.max ? `max=${info.max}` : "no max attribute" });
    } else if (kind === "name") {
      const v = await typeInto("Ana2#");
      r.tests.push({ test: "digits/symbols typed", kept: v, pass: !/[0-9#]/.test(v) });
      const real = await typeInto("Dela Peña-D'Angelo");
      r.tests.push({ test: "real name typed", kept: real, pass: real === "Dela Peña-D'Angelo" });
    } else if (kind === "digits") {
      const v = await typeInto("abc12");
      r.tests.push({ test: "letters typed", kept: v, pass: !/[a-z]/i.test(v) });
    }
    if (kind !== "number") {
      await el.fill("").catch(() => {});
      await el.focus();
      await page.evaluate((t) => document.execCommand("insertText", false, t), LONG);
      const v = await el.inputValue().catch(() => "");
      r.tests.push({ test: "1,200 characters pasted", kept: `${v.length} chars`, pass: v.length < 1200, note: info.maxLength ? `maxLength=${info.maxLength}` : "no maxLength" });
    }
  } catch (err) {
    r.tests.push({ test: "probe", kept: String(err.message).split("\n")[0].slice(0, 120), pass: false });
  }
  await el.fill(original).catch(() => {});
  r.pass = r.tests.every((t) => t.pass);
  uiResults.set(key, r);
  say(`${r.pass ? "PASS" : "FAIL"} UI ${where} · ${info.id || info.label} (${kind}): ${r.tests.map((t) => `${t.test} → ${t.kept}`).join("; ")}`);
}

async function probeVisible(page, scope, where) {
  const fields = scope.locator("input:visible, textarea:visible");
  const count = await fields.count();
  for (let i = 0; i < count; i += 1) await probeField(page, fields.nth(i), where);
}

const OPENER = /^(\+\s*)?(Add|New|Create|Register|File|Request|Edit|Change|Set|Grant|Flag|Correct|Record|Assign)\b/i;
const NEVER = /Delete|Remove|Archive|Deactivate|Reject|Approve|Submit|Process|Generate|Release|Restore|Backup|Reset|Disable|Sign out|Log ?out|Lock|Purge|Revoke|Pay\b|Save|Unlock|Confirm|Send|Endorse|Recommend|Clear|Import|Upload|Print|Retry|Refresh|Run|Separate|Decide|Resolve/i;

async function closeDialogs(page) {
  for (let i = 0; i < 4 && await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count(); i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
}

async function probeDialogs(page, where) {
  const seen = new Set();
  const buttons = main(page).locator("button:visible");
  const count = await buttons.count();
  for (let i = 0; i < count && seen.size < 6; i += 1) {
    const b = buttons.nth(i);
    const name = ((await b.getAttribute("aria-label").catch(() => null)) || (await b.innerText().catch(() => ""))).trim().replace(/\s+/g, " ");
    if (!name || !OPENER.test(name) || NEVER.test(name) || !(await b.isEnabled().catch(() => false))) continue;
    const kind = name.split(" ").slice(0, 2).join(" ");
    if (seen.has(kind)) continue;
    seen.add(kind);
    say(`Opening "${name}" on ${where} to test its fields…`);
    await b.click().catch(() => {});
    await page.waitForTimeout(800);
    const dialog = page.locator('[role="dialog"]:visible').last();
    if (await dialog.count()) await probeVisible(page, dialog, `${where} > "${name}"`);
    await closeDialogs(page);
    await settle(page);
  }
}

for (const role of Object.keys(PAGES)) {
  test(`UI fields: ${ROLE_LABEL[role]}`, async ({ page, monitor }) => {
    test.setTimeout(40 * 60 * 1000);
    // Typing nonsense into a box may make the page ask the server for it (400).
    monitor.allow(/^4\d\d /, /status of 400/);
    await as(page, role);
    for (const [, label] of PAGES[role]) {
      const where = `${ROLE_LABEL[role]} > ${label}`;
      monitor.at(where);
      say(`Navigating to ${where}…`);
      await step(page, `${where} > textboxes`);
      await navTo(page, label).catch(() => {});
      await settle(page);
      const tabs = main(page).locator('[role="tab"]:visible');
      const tabCount = Math.max(1, await tabs.count());
      for (let t = 0; t < tabCount; t += 1) {
        if (await tabs.count()) { await tabs.nth(t).click().catch(() => {}); await settle(page); }
        await probeVisible(page, main(page), where);
        await probeDialogs(page, where);
      }
    }
  });
}

// ── API: straight to the routes ─────────────────────────────────────────────
const apiResults = [];
/** Longest stored value of a column that starts with the probe's marker. */
const storedLength = (table, column, marker) => Number(psql(`select coalesce(max(char_length(${column})), 0) from ${table} where ${column} like '${marker}%';`) || 0);

async function probe(page, { field, where, expected, method = "POST", path, body, table, column, marker, cap, valid = false, ignoredOk = false, noAccount = null }) {
  const res = await api(page, method, path, body);
  let pass;
  let detail = `${res.status}${res.data?.error ? ` ${String(res.data.error).slice(0, 110)}` : ""}`;
  if (res.status >= 500) pass = false;
  else if (valid) pass = res.status < 300;
  else if (res.status >= 400) pass = true;
  else if (table) {
    const len = storedLength(table, column, marker);
    pass = (len > 0 || ignoredOk) && len <= cap;
    detail += ` · stored ${len} chars (cap ${cap})${len === 0 && ignoredOk ? ", value not used" : ""}`;
  } else pass = false;
  if (noAccount) {
    const left = Number(psql(`select count(*) from auth.users where email = '${noAccount}';`) || 0);
    if (left) { pass = false; detail += " · a sign-in account was left behind with no profile"; }
  }
  apiResults.push({ field, where, expected, test: describe(body), status: res.status, detail, pass });
  say(`${pass ? "PASS" : "FAIL"} API ${where} · ${field}: ${detail}`);
}
const describe = (body) => JSON.stringify(body, (k, v) => (typeof v === "string" && v.length > 40 ? `<${v.length} chars>` : v)).slice(0, 160);
const long = (marker, len = 5000) => marker + "x".repeat(len - marker.length);

test("API fields: wrong type, oversized and empty values are refused server-side", async ({ page, monitor }) => {
  test.setTimeout(30 * 60 * 1000);
  monitor.allow(/^4\d\d /, /^5\d\d /);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const branch = await rows(db().from("branches").select("id").eq("name", BRANCH_MAIN).single());
  const entry = (await rows(db().from("payroll_entries").select("id").eq("employee_id", ana.id).eq("status", "paid").limit(1)))[0];
  const loanBase = { action: "create_loan", employee_id: ana.id, loan_type: "salary_loan", principal: 1000, number_of_payrolls: 2, date_granted: "2026-10-20", start_period: "2026-11-16" };
  const empBase = {
    first_name: "Probe", last_name: "Tester", email: "probe.tester@e2e.test", date_of_birth: "1990-01-01", sex: "Male", civil_status: "Single",
    employee_type: "Non-Teaching", employment_type: "Full-time", employment_status: "Regular", employee_status: "Active", position: "Employee",
    date_hired: "2024-01-01", basic_salary: 20000, address: "12 Rizal St, Pasig City", cp_number: "09171234567", sss_number: "1234567890",
    philhealth_number: "123456789012", pagibig_number: "123456789012", tin_number: "123456789", branch_id: branch.id,
    emergency_contact_name: "Maria Tester", emergency_contact_relationship: "Parent", emergency_contact_number: "09181234567", emergency_contact_address: "45 Rizal Ave, Pasig City",
  };

  monitor.at("API > Accountant");
  await as(page, "accountant");
  const A = (o) => probe(page, { where: "Accountant > Loans", path: "/api/accountant/loans", ...o });
  await A({ field: "Loan amount", expected: "number ≤ ₱500,000", body: { ...loanBase, principal: "abc" } });
  await A({ field: "Loan amount", expected: "number ≤ ₱500,000", body: { ...loanBase, principal: "1,000" } });
  await A({ field: "Loan amount", expected: "number ≤ ₱500,000", body: { ...loanBase, principal: 500000.01 } });
  await A({ field: "Loan amount", expected: "number ≤ ₱500,000", body: { ...loanBase, principal: 1e12 } });
  await A({ field: "Loan amount ₱500,000 (valid)", expected: "accepted", body: { ...loanBase, principal: 500000, number_of_payrolls: 100, description: "Probe max loan" }, valid: true });
  await A({ field: "Cash-advance loan amount", expected: "number ≤ ₱50,000", body: { ...loanBase, loan_type: "cash_advance", principal: 50001 } });
  await A({ field: "Loan amortization", expected: "number ≤ total payable", body: { ...loanBase, amortization: 1e12 } });
  await A({ field: "Loan interest %", expected: "0–100", body: { ...loanBase, interest_pct: 500 } });
  await A({ field: "Loan number of payrolls", expected: "1–120", body: { ...loanBase, number_of_payrolls: 9999 } });
  await A({ field: "Loan description", expected: "text ≤ 200", body: { ...loanBase, description: long("PRB-LOAN", 201) } });
  const P = (o) => probe(page, { where: "Accountant > Incentives & Overload", path: "/api/accountant/payroll", ...o });
  const item = { action: "add_monthly_item", employee_id: ana.id, kind: "incentive", amount: 500, item_date: "2026-11-10", description: "probe" };
  await P({ field: "Incentive amount", expected: "number ≤ ₱100,000", body: { ...item, amount: "abc" } });
  await P({ field: "Incentive amount", expected: "number ≤ ₱100,000", body: { ...item, amount: 100000.01 } });
  await P({ field: "Incentive amount ₱100,000 (valid)", expected: "accepted", body: { ...item, amount: 100000, description: "Probe max incentive" }, valid: true });
  await P({ field: "Overload hours", expected: "0–744", body: { ...item, kind: "overload", amount: undefined, hours: 99999 } });
  await P({ field: "Incentive description", expected: "text ≤ 200", body: { ...item, description: long("PRB-INC", 201) } });
  const V = (o) => probe(page, { where: "Accountant > Cash Advances", path: "/api/accountant/payroll", ...o });
  const adv = { action: "add_cash_advance", employee_id: ana.id, principal: 5000, installment_amount: 1000, deduct_on: "both", date_granted: "2026-11-02", start_date: "2026-11-16" };
  await V({ field: "Cash advance amount", expected: "number ≤ ₱50,000", body: { ...adv, principal: "5k" } });
  await V({ field: "Cash advance amount", expected: "number ≤ ₱50,000", body: { ...adv, principal: 50000.01 } });
  await V({ field: "Cash advance note", expected: "text ≤ 200", body: { ...adv, description: long("PRB-ADV", 201) } });
  const D = (o) => probe(page, { where: "Accountant > Process Payroll (draft)", path: "/api/accountant/payroll", ...o });
  const draft = { action: "save_draft", employee_id: ana.id, pay_period: "November 1-15, 2026" };
  await D({ field: "Absent days", expected: "number 0–15 (days in period)", body: { ...draft, deductions: { absences_days: "abc" } } });
  await D({ field: "Absent days", expected: "number 0–15 (days in period)", body: { ...draft, deductions: { absences_days: 9999 } } });
  await D({ field: "Late days", expected: "number 0–15", body: { ...draft, deductions: { late_days: 1e9 } } });
  await D({ field: "Undertime minutes", expected: "number 0–1,440 a day", body: { ...draft, deductions: { undertime_minutes: 15 * 1440 + 1 } } });
  await D({ field: "Half days", expected: "number 0–15", body: { ...draft, deductions: { half_days: 9999 } } });
  await D({ field: "Leave without pay days", expected: "number 0–15", body: { ...draft, deductions: { leave_without_pay_days: "x" } } });
  await D({ field: "SSS amount", expected: "number, no letters", body: { ...draft, deductions: { sss: "12ab" } } });
  await D({ field: "Override reason", expected: "text ≤ 500", body: { ...draft, deductions: { absences_days: 2 }, override_reason: long("PRB-OVR", 501) } });
  await D({ field: "Absent days + 500-char reason (valid)", expected: "accepted", body: { ...draft, deductions: { absences_days: 2 }, override_reason: "Probe: confirmed with the logbook. ".padEnd(500, "x") }, valid: true });
  if (entry) {
    const C = (o) => probe(page, { where: "Accountant > Payroll Records > Correct", path: "/api/payroll/corrections", ...o });
    const corr = { entry_id: entry.id, kind: "underpayment", amount: 100, payrolls: 1, reason: "Probe correction reason" };
    await C({ field: "Correction amount", expected: "number ≤ ₱1,000,000", body: { ...corr, amount: "abc" } });
    await C({ field: "Correction amount", expected: "number ≤ ₱1,000,000", body: { ...corr, amount: 1000000.01 } });
    await C({ field: "Correction payslips", expected: "1–24", body: { ...corr, kind: "overpayment", payrolls: 99 } });
    await C({ field: "Correction reason", expected: "text 5–500", body: { ...corr, reason: long("PRB-CORR", 501) } });
    await C({ field: "Correction reason", expected: "required", body: { ...corr, reason: "" } });
  }

  monitor.at("API > HR");
  await as(page, "hr");
  const S = (o) => probe(page, { where: "HR > Change salary", path: "/api/hr/salary-changes", ...o });
  const sal = { employee_id: ana.id, new_salary: 21000, effective_date: "2027-01-01", reason: "Promotion", note: "probe" };
  await S({ field: "New salary", expected: "number ≤ ₱1,000,000", body: { ...sal, new_salary: "abc" } });
  await S({ field: "New salary", expected: "number ≤ ₱1,000,000", body: { ...sal, new_salary: 1000000.01 } });
  await S({ field: "Salary change reason", expected: "one of the listed reasons", body: { ...sal, reason: "<script>" } });
  await S({ field: "Salary note", expected: "text ≤ 500", body: { ...sal, note: long("PRB-SAL", 501) } });
  const E = (o) => probe(page, { where: "HR > User Management > Add employee", path: "/api/admin/employees", ...o });
  await E({ field: "First name", expected: "letters ≤ 50", body: { ...empBase, first_name: "Ana123" } });
  await E({ field: "First name", expected: "letters ≤ 50", body: { ...empBase, first_name: "A".repeat(51) }, noAccount: "probe.tester@e2e.test" });
  await E({ field: "First name", expected: "required", body: { ...empBase, first_name: "" } });
  await E({ field: "Last name", expected: "letters ≤ 50", body: { ...empBase, last_name: "Cruz#$" } });
  await E({ field: "Middle name", expected: "letters ≤ 50", body: { ...empBase, middle_initial: "B".repeat(51) } });
  await E({ field: "Suffix", expected: "Jr. / Sr. / II-V", body: { ...empBase, suffix: "Esquire the Third" } });
  await E({ field: "Basic salary", expected: "number ≤ ₱1,000,000", body: { ...empBase, basic_salary: "abc" } });
  await E({ field: "Basic salary", expected: "number ≤ ₱1,000,000", body: { ...empBase, basic_salary: 1000000.01 } });
  await E({ field: "Basic salary", expected: "required", body: { ...empBase, basic_salary: "" } });
  await E({ field: "Contact number", expected: "11 digits 09…", body: { ...empBase, cp_number: "abcdefghijk" } });
  await E({ field: "Contact number", expected: "11 digits 09…", body: { ...empBase, cp_number: "0917abc4567" } });
  await E({ field: "SSS number", expected: "10 digits, no letters", body: { ...empBase, sss_number: "12a4567890" } });
  await E({ field: "PhilHealth number", expected: "12 digits", body: { ...empBase, philhealth_number: "12345678901" } });
  await E({ field: "Pag-IBIG number", expected: "12 digits", body: { ...empBase, pagibig_number: "1234567890123" } });
  await E({ field: "TIN", expected: "9 or 12 digits", body: { ...empBase, tin_number: "1".repeat(40) } });
  await E({ field: "TIN", expected: "9 or 12 digits", body: { ...empBase, tin_number: "1234567890" } });
  await E({ field: "Home address", expected: "text 5–200", body: { ...empBase, address: long("PRB-ADDR", 201) } });
  await E({ field: "Email", expected: "email ≤ 254", body: { ...empBase, email: `${"e".repeat(250)}@e2e.test` } });
  await E({ field: "Email", expected: "valid email", body: { ...empBase, email: "not-an-email" } });
  await E({ field: "Emergency contact name", expected: "letters ≤ 100", body: { ...empBase, email: "probe.ec@e2e.test", emergency_contact_name: "Maria 2" } });
  await E({ field: "Emergency contact number", expected: "11 digits, no letters", body: { ...empBase, email: "probe.ec2@e2e.test", emergency_contact_number: "0918abc4567" } });
  await E({
    field: "Real record (valid)", expected: "accepted: Dela Peña, D'Angelo, dashed IDs, spaced number",
    body: { ...empBase, email: "dangelo.delapena@e2e.test", first_name: "Ma. Theresa", middle_initial: "D'Angelo", last_name: "Dela Peña-Santos", suffix: "Jr.",
      sss_number: "12-3456789-0", philhealth_number: "12-345678901-2", pagibig_number: "1234-5678-9012", tin_number: "123-456-789-000", cp_number: "0917 123 4567" },
    valid: true,
  });
  await E({ field: "First name 50 chars (valid)", expected: "accepted", body: { ...empBase, email: "probe.long50@e2e.test", first_name: "A".repeat(50) }, valid: true });
  const added = await profileByEmail("probe.long50@e2e.test");
  if (added) {
    const M = (o) => probe(page, { where: "HR > User Management > Edit employee", method: "PATCH", path: "/api/admin/employees", ...o });
    await M({ field: "SSS number (edit)", expected: "10 digits, refused not cut", body: { id: added.id, action: "update", sss_number: "123456789012345" } });
    await M({ field: "TIN (edit)", expected: "digits only", body: { id: added.id, action: "update", tin_number: "12345678x" } });
    await M({ field: "Contact number (edit)", expected: "11 digits 09…", body: { id: added.id, action: "update", cp_number: "0817123456" } });
  }
  const T = (o) => probe(page, { where: "HR > Tenure Pay Protection", path: "/api/hr/tenure-protection", ...o });
  await T({ field: "Minimum tenure (years)", expected: "0–50", body: { action: "save_policy", branch_id: null, min_tenure_years: "abc" } });
  await T({ field: "Minimum tenure (years)", expected: "0–50", body: { action: "save_policy", branch_id: null, min_tenure_years: 999 } });
  await T({ field: "Break note", expected: "text ≤ 500", body: { action: "save_break", school_year: "2028-2029", kind: "summer", start_date: "2029-04-01", end_date: "2029-05-31", note: long("PRB-BRK", 501) } });
  const R = (o) => probe(page, { where: "HR > RFID Cards", path: "/api/rfid/cards", ...o });
  await R({ field: "RFID card number", expected: "exactly 10 digits", body: { action: "register", employee_id: ana.id, uid: "00012345AB" } });
  await R({ field: "RFID card number", expected: "exactly 10 digits", body: { action: "register", employee_id: ana.id, uid: "123456789" } });
  await R({ field: "RFID card number", expected: "exactly 10 digits", body: { action: "register", employee_id: ana.id, uid: "12345678901" } });
  await R({ field: "RFID card number", expected: "required", body: { action: "register", employee_id: ana.id, uid: "" } });
  await R({ field: "RFID card note", expected: "text ≤ 300", body: { action: "register", employee_id: ana.id, uid: "0009876543", reason: long("PRB-RF", 301) } });
  const W = (o) => probe(page, { where: "HR > Work Schedules", path: "/api/admin/work-schedules", ...o });
  const ws = { action: "save_schedule", name: "Probe shift", work_start: "08:00", work_end: "17:00", grace_minutes: 10, work_hours: 8, working_days: [1, 2, 3, 4, 5] };
  await W({ field: "Schedule name", expected: "text ≤ 80", body: { ...ws, name: long("PRB-WS", 81) } });
  await W({ field: "Late grace (minutes)", expected: "0–120", body: { ...ws, grace_minutes: 9999 } });
  await W({ field: "Work hours / day", expected: "0.5–24", body: { ...ws, work_hours: "abc" } });
  await W({ field: "Schedule note", expected: "text ≤ 500", body: { ...ws, name: "Probe note shift", note: long("PRB-WSN", 501) } });
  const Y = (o) => probe(page, { where: "HR > Work Schedules > Early Bird", path: "/api/admin/early-bird", ...o });
  await Y({ field: "Early bird amount", expected: "number ≤ ₱100,000", body: { incentive_amount: 100000.01, threshold_minutes: 15 } });
  await Y({ field: "Early bird minutes", expected: "1–120", body: { incentive_amount: 100, threshold_minutes: 99999 } });

  monitor.at("API > Super Admin");
  await as(page, "super_admin");
  const G = (o) => probe(page, { where: "Super Admin > Government rates", path: "/api/admin/payroll-rates", ...o });
  const rate = { rate_type: "philhealth_pct", scope: "global", value: 2.5, effective_date: "2028-01-01" };
  await G({ field: "Rate value (%)", expected: "number 0–100", body: { ...rate, value: "abc" } });
  await G({ field: "Rate value (%)", expected: "number 0–100", body: { ...rate, value: 500 } });
  await G({ field: "Rate value (₱)", expected: "number ≤ ₱999,999.99", body: { ...rate, rate_type: "pagibig_max_salary", value: 1000000 } });
  await G({ field: "Rate note", expected: "text ≤ 300", body: { ...rate, effective_date: "2028-02-01", note: long("PRB-RATE", 301) } });
  const X = (o) => probe(page, { where: "Super Admin > Tax table", path: "/api/admin/payroll-settings", ...o });
  const taxRows = [{ bracket_over: 0, base_tax: 0, rate_pct: 0 }, { bracket_over: 20833, base_tax: 0, rate_pct: 15 }];
  await X({ field: "Tax bracket rate %", expected: "0–100", body: { kind: "tax_table", effective_date: "2028-01-01", rows: [taxRows[0], { ...taxRows[1], rate_pct: 500 }] } });
  await X({ field: "Tax bracket 'over'", expected: "number ≤ ₱9,999,999.99", body: { kind: "tax_table", effective_date: "2028-01-01", rows: [taxRows[0], { ...taxRows[1], bracket_over: "abc" }] } });
  await X({ field: "Tax bracket 'over'", expected: "number ≤ ₱9,999,999.99", body: { kind: "tax_table", effective_date: "2028-01-01", rows: [taxRows[0], { ...taxRows[1], bracket_over: 1e15 }] } });
  await X({ field: "Fixed SSS amount", expected: "number ≤ ₱999,999.99", body: { kind: "contribution", employee_id: ana.id, effective_date: "2028-01-01", sss: 1000000, philhealth: 0, pagibig: 0 } });
  const B = (o) => probe(page, { where: "Super Admin > Branch Management", path: "/api/admin/branches", ...o });
  await B({ field: "Branch name", expected: "text ≤ 100", body: { name: long("PRB-BRANCH", 101), location: "Probe City", status: "Active" } });
  await B({ field: "Branch name", expected: "letters, digits, spaces", body: { name: "Main <b>Campus</b>", location: "Probe City", status: "Active" } });
  await B({ field: "Branch name", expected: "required", body: { name: "", location: "Probe City", status: "Active" } });
  await B({ field: "Branch name 100 chars (valid)", expected: "accepted", body: { name: `Sto. Niño Annex 2 ${"B".repeat(82)}`, location: "Probe City", status: "Active" }, valid: true });
  const H = (o) => probe(page, { where: "Super Admin > Holidays", path: "/api/admin/holidays", ...o });
  await H({ field: "Holiday name", expected: "text ≤ 100", body: { holiday_date: "2028-02-02", name: long("PRB-HOL", 101), type: "special" } });
  const U = (o) => probe(page, { where: "Super Admin > Teacher subsidy", path: "/api/admin/teacher-subsidy", ...o });
  await U({ field: "Annual subsidy", expected: "number ≤ ₱1,000,000", body: { annual_amount: 1000000.01, effective_year_start: "2027-06-01", note: "probe change" } });
  await U({ field: "Subsidy change reason", expected: "text ≤ 500", body: { annual_amount: 10000, effective_year_start: "2027-06-01", note: long("PRB-SUB", 501) } });
  const K = (o) => probe(page, { where: "Super Admin > Payslip schedule", path: "/api/admin/payslip-schedule", ...o });
  await K({ field: "1st half day", expected: "1–15", body: { effective_from: "2028-01-01", first_half_day: 99, second_half_day: 30, window_days: 3, note: "probe" } });
  const Q = (o) => probe(page, { where: "Super Admin > Admin & HR Accounts", path: "/api/admin/staff-accounts", ...o });
  const staff = {
    first_name: "Bob", last_name: "Probe", email: "probe.staff@e2e.test", role: "hr", employee_status: "Active", date_of_birth: "1990-01-01", date_hired: "2024-01-01",
    sex: "Male", civil_status: "Single", cp_number: "09171234560", address: "12 Rizal St, Pasig City", password: "Probe-Staff#2026",
    emergency_contact_name: "Maria Probe", emergency_contact_relationship: "Parent", emergency_contact_number: "09181234560", emergency_contact_address: "45 Rizal Ave, Pasig City",
  };
  await Q({ field: "Staff first name", expected: "letters ≤ 50", body: { ...staff, first_name: "Bob99" } });
  await Q({ field: "Staff first name", expected: "letters ≤ 50", body: { ...staff, first_name: "B".repeat(51), email: "probe.staff2@e2e.test" }, noAccount: "probe.staff2@e2e.test" });
  await Q({ field: "Staff address", expected: "text 5–160", body: { ...staff, address: long("PRB-SADDR", 161), email: "probe.staff3@e2e.test" } });
  await Q({ field: "Staff contact number", expected: "11 digits 09…", body: { ...staff, cp_number: "0917abc1234", email: "probe.staff4@e2e.test" } });

  monitor.at("API > Admin");
  await as(page, "admin");
  const N = (o) => probe(page, { where: "Admin > Announcements", path: "/api/announcements", ...o });
  await N({ field: "Announcement title", expected: "text ≤ 150", body: { title: long("PRB-ANT", 151), body: "probe body", category: "general" } });
  await N({ field: "Announcement message", expected: "text ≤ 4000", body: { title: "probe", body: long("PRB-ANB", 4001), category: "general" } });
  const O = (o) => probe(page, { where: "Admin > Profile > Edit account", path: "/api/legacy-auth/update-profile", ...o });
  await O({ field: "TIN (own account)", expected: "digits only", body: { tin_number: "12345678a" } });
  await O({ field: "Contact number (own account)", expected: "digits only", body: { cp_number: "0917-abc-4567" } });

  monitor.at("API > Employee");
  await as(page, "employee");
  const L = (o) => probe(page, { where: "Employee > Leave", path: "/api/employee/leave-requests", ...o });
  const leave = { leave_type: "Vacation Leave", start_date: "2026-12-07", end_date: "2026-12-07", reason: "probe", employee_name: "Ana Lopez" };
  await L({ field: "Leave reason", expected: "text 1–500", body: { ...leave, reason: long("PRB-LV", 501) } });
  await L({ field: "Leave reason", expected: "required", body: { ...leave, reason: "" } });
  await L({ field: "Leave reason 500 chars (valid)", expected: "accepted", body: { ...leave, start_date: "2026-12-08", end_date: "2026-12-08", reason: "R".repeat(500) }, valid: true });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "api.json"), JSON.stringify(apiResults, null, 1));
});

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  const ui = [...uiResults.values()];
  if (ui.length) writeFileSync(join(OUT, "ui.json"), JSON.stringify(ui, null, 1));
  const line = "=".repeat(78);
  if (ui.length) {
    console.log(`\n${line}\n UI TEXTBOX CHECKLIST (${clock()}): ${ui.length} fields, ${ui.filter((r) => r.pass).length} PASS, ${ui.filter((r) => !r.pass).length} FAIL\n${line}`);
    for (const r of ui) console.log(` ${r.pass ? "PASS" : "FAIL"}  ${r.where} · ${r.id || r.label} [${r.expected}${r.maxLength ? `, maxLength ${r.maxLength}` : ""}${r.max ? `, max ${r.max}` : ""}] ${r.tests.filter((t) => !t.pass).map((t) => `${t.test} → ${t.kept}${t.note ? ` (${t.note})` : ""}`).join("; ")}`);
  }
  if (apiResults.length) {
    console.log(`\n${line}\n API CHECKLIST: ${apiResults.length} probes, ${apiResults.filter((r) => r.pass).length} PASS, ${apiResults.filter((r) => !r.pass).length} FAIL\n${line}`);
    for (const r of apiResults) console.log(` ${r.pass ? "PASS" : "FAIL"}  ${r.where} · ${r.field} [${r.expected}] ${r.test} → ${r.detail}`);
  }
  console.log(line);
});
