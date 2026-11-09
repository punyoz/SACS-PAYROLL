// 2026-11-08 batch, desktop (1280x800), local stack only:
//   1 Super Admin payroll export (every branch, read-only, audited); the
//     Accountant still sees only its own branch; HR / Admin / Employee refused
//   2 full data backup (.xlsx): sheets, row counts = database, no secrets,
//     password re-entry, rate limit, audit; 64 demo employees, timed
//   3 Super Admin posts / edits / deletes announcements; HR and Admin rules hold
//   4 toolbar: search first, tabs and dropdowns on the same row
//   5 Add Branch: searchable Region / Province / City / Barangay
//   6 no up / down arrows beside tab rows, no select scroll buttons
//   7 sidebar: no scrollbar, still scrolls (wheel and keyboard)
//   8 toasts top right for every role
//   9 rates: daily only editable, hourly = daily ÷ 8 with the same dates
//
//   E2E_SLOWMO=500 npx playwright test e2e/specs/99-sa-backup-ui-rates.spec.mjs --project=desktop
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle, pageOverflow } from "../support/portal.mjs";
import { api, confirm, pickDate } from "../support/flow.mjs";
import { profileByEmail, psql } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_MAIN, BRANCH_NORTH } from "../accounts.mjs";

test.use({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });

const SHOTS = join(process.cwd(), "screenshots", "2026-11-08", "after");
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name, target) => (target || page).screenshot({ path: join(SHOTS, `${name}.png`), ...(target ? {} : { fullPage: false }) });

const clock = () => new Date().toLocaleTimeString("en-PH", { hour12: false, timeZone: "Asia/Manila" });
let n = 0;
const results = [];
const say = (t) => { n += 1; console.log(`  [#${n} ${clock()}] ${t}`); };
function check(where, ok, text) {
  results.push({ where, ok, text, time: clock() });
  say(`${ok ? "PASS" : "FAIL"} ${where}: ${text}`);
  expect.soft(ok, `${where}: ${text}`).toBe(true);
  return ok;
}
const count = (sql) => Number(psql(sql)) || 0;
const STAMP = Date.now().toString(36).slice(-4);

/** One CSV line into cells (quotes and doubled quotes). */
function csvCells(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** Every part of an unzipped workbook as one text. */
const everythingOf = (files) => Object.values(files).join("\n");

/** A tiny ZIP reader: entry name -> text. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < entries; i += 1) {
    const packed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const skip = buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    files[name] = inflateRawSync(buffer.subarray(start, start + packed)).toString("utf8");
    at += 46 + nameLength + skip;
  }
  return files;
}

/** Sheets of a workbook: [{ name, rows (data rows), xml }]. */
function sheetsOf(files) {
  const names = [...files["xl/workbook.xml"].matchAll(/<sheet name="([^"]+)" sheetId="(\d+)"/g)].map((m) => [m[1].replace(/&amp;/g, "&"), m[2]]);
  return names.map(([name, id]) => {
    const xml = files[`xl/worksheets/sheet${id}.xml`] || "";
    return { name, xml, rows: Math.max(0, (xml.match(/<row /g) || []).length - 1) };
  });
}

/** Two boxes on the same row: their vertical centres within 6 px. */
const sameRow = (a, b) => a && b && Math.abs((a.y + a.height / 2) - (b.y + b.height / 2)) <= 6;

/** The first table toolbar on the page that has filters next to its search. */
async function toolbarOf(page) {
  const bars = main(page).locator('[data-slot="table-toolbar"]:has([data-slot="table-toolbar-tools"])');
  await bars.first().waitFor();
  const bar = bars.first();
  await bar.scrollIntoViewIfNeeded();
  const search = await bar.locator('input[type="search"]').boundingBox();
  const tools = await bar.locator('[data-slot="table-toolbar-tools"]').boundingBox();
  return { bar, search, tools };
}

/** Elements next to a tab list that would draw a scrollbar (the stray ▲▼). */
async function strayScrollbars(page) {
  return page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('[role="tablist"]').forEach((list) => {
      let el = list;
      for (let up = 0; up < 4 && el; up += 1, el = el.parentElement) {
        const style = getComputedStyle(el);
        const scrollY = ["auto", "scroll"].includes(style.overflowY);
        const hidden = style.scrollbarWidth === "none";
        if (scrollY && !hidden && el.scrollHeight > el.clientHeight + 1) bad.push(`${list.getAttribute("aria-label") || list.textContent.slice(0, 40)}`);
      }
    });
    return bad;
  });
}

test("2026-11-08: Super Admin backup, announcements, toolbars, dropdowns, sidebar, toasts, rates", async ({ page, monitor }) => {
  const north = { id: psql(`select id from branches where name = '${BRANCH_NORTH}'`) };
  const mainBranch = { id: psql(`select id from branches where name = '${BRANCH_MAIN}'`) };
  const sa = await profileByEmail(ACCOUNTS.super_admin.email);
  // This spec switches the signed-in role dozens of times (as()): a request
  // the previous role's page still had in flight then comes back 401. Same
  // allowance as 10-access / 12-login-accounts; only for reads.
  monitor.allow(/^401 GET /, /status of 401/);
  const accountant = await profileByEmail(ACCOUNTS.accountant.email);

  await step(page, "Setup: 64 demo employees, a year of attendance, a payslip each (local only)", async () => {
    const out = psql(readFileSync(join(process.cwd(), "e2e", "scale", "demo-60.sql"), "utf8"));
    say(`demo data: ${out.replace(/\n/g, "; ")}`);
    check("Setup", count("select count(*) from profiles where email like '%@demo60.test' and is_demo") >= 64, "64 demo employees on file, flagged is_demo by the demo seed");
    // One ordinary (not demo) paid payslip per branch, so "every branch" has real rows.
    psql(`set session_replication_role = replica;
      insert into payroll_entries (employee_id, employee_name, employee_code, employee_type, position, pay_period, cutoff, status, basic_salary, gross_pay, sss, philhealth, pagibig, withholding_tax, total_deductions, net_pay, branch_id, payslip_no, payroll, created_at, updated_at, approved_at)
      select p.id, p.full_name, p.employee_id, p.employee_type, p.position, 'September 16-30, 2026', 'second', 'paid', 12000, 12000, 0, 0, 0, 0, 0, 12000, p.branch_id, 'E2E-SEP-' || p.employee_id, '{}'::jsonb, now(), now(), now()
      from profiles p where p.email in ('${ACCOUNTS.employee.email}', '${ACCOUNTS.employee3.email}')
        and not exists (select 1 from payroll_entries e where e.employee_id = p.id and e.pay_period = 'September 16-30, 2026');`);
  });

  /* ── 1. Super Admin payroll export ─────────────────────────────────── */
  await step(page, "1. Super Admin exports payroll for every branch (read-only, audited)", async () => {
    monitor.at("Super Admin > Backup & Recovery");
    await as(page, "super_admin", "sa-backup");
    await settle(page);
    await shot(page, "01-backup-page-top");
    await main(page).getByRole("button", { name: /Export Payroll CSV/ }).click();
    const dialog = page.getByRole("alertdialog");
    check("Payroll export", /salary and personal data/i.test(await dialog.innerText()), "confirmation says the file holds salary and personal data");
    await shot(page, "01-payroll-export-confirm");
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export payroll CSV" }).click();
    const download = await downloadPromise;
    const file = join(SHOTS, "..", "payroll-export.csv");
    await download.saveAs(file);
    const lines = readFileSync(file, "utf8").replace(/^﻿/, "").trim().split(/\r\n/);
    const header = lines.find((l) => l.startsWith("Payslip No."));
    const data = lines.slice(lines.indexOf(header) + 1);
    // Demo people's payslips are left out (is_demo, 2026-11-08).
    const dbRows = count("select count(*) from payroll_entries e where not exists (select 1 from profiles d where d.id = e.employee_id and d.is_demo)");
    check("Payroll export", !data.some((l) => l.includes("DEMO-DM-")), "no demo payslip in the file");
    check("Payroll export", data.length === dbRows, `${data.length} rows in the file = ${dbRows} payslips in the database`);
    check("Payroll export", data.some((l) => l.includes(BRANCH_MAIN)) && data.some((l) => l.includes(BRANCH_NORTH)), "both branches are in the file");
    // Amounts exactly as stored: three payslips by number.
    const cols = csvCells(header);
    const at = (name) => cols.indexOf(name);
    for (const line of data.slice(0, 3)) {
      const cells = csvCells(line);
      const stored = psql(`select gross_pay::text || '|' || net_pay::text from payroll_entries where id = '${cells[at("Payslip ID")]}'`).split("|").map(Number);
      check("Payroll export", Number(cells[at("Gross pay")]) === stored[0] && Number(cells[at("Net pay")]) === stored[1], `payslip ${cells[at("Payslip No.")]}: gross ${cells[at("Gross pay")]}, net ${cells[at("Net pay")]} = stored`);
    }
    const audit = psql("select metadata->>'rows' from audit_logs where action = 'backup_payroll_export' order by created_at desc limit 1");
    check("Payroll export", Number(audit) === dbRows, `audit log: backup_payroll_export, ${audit} rows`);
    check("Payroll export", (await api(page, "GET", "/api/accountant/payroll")).status === 403, "the Super Admin still has no Accountant payroll access");
  });

  await step(page, "1. Accountant: own branch only; nobody but the Super Admin uses the backup exports", async () => {
    await as(page, "accountant", "ac-reports");
    const sheet = await api(page, "GET", `/api/accountant/payroll?view=payroll_sheet&period=${encodeURIComponent("October 1-15, 2026")}&branch_id=${north.id}`);
    const names = (sheet.data?.branches || []).map((b) => b.branch_name);
    check("Accountant", !names.includes(BRANCH_NORTH), `payroll sheet asked for North returns only: ${names.join(", ") || "(none)"}`);
    const list = await api(page, "GET", "/api/accountant/payroll?history=all");
    const branchesSeen = new Set([...(list.data?.history_records || []), ...(list.data?.records || [])].map((r) => r.branch_id).filter(Boolean));
    check("Accountant", ![...branchesSeen].includes(north.id), "payroll records list holds no North payslip");
    for (const role of ["accountant", "hr", "admin", "employee"]) {
      await as(page, role);
      const payroll = await api(page, "GET", "/api/admin/backup/payroll");
      const full = await api(page, "GET", "/api/admin/backup/full");
      const post = await api(page, "POST", "/api/admin/backup/full", { password: "x", groups: ["all"] });
      check(role, payroll.status === 403 && full.status === 403 && post.status === 403, `backup exports refused (${payroll.status}/${full.status}/${post.status})`);
    }
    let refused = false;
    try { psql(`select count(*) from public.backup_payroll_export('${accountant.id}')`); } catch { refused = true; }
    check("Database", refused, "backup_payroll_export refuses the Accountant as actor");
  });

  /* ── 2. Full data backup ───────────────────────────────────────────── */
  await step(page, "2. Full data backup (.xlsx): password, sheets, counts, no secrets, audit, timing", async () => {
    monitor.at("Super Admin > Backup & Recovery > Full data backup");
    await as(page, "super_admin", "sa-backup");
    await settle(page);
    const card = main(page).locator('[data-testid="full-backup"]');
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByText(/groups ·/)).toBeVisible({ timeout: 60000 });
    await shot(page, "02-full-backup-card", card);
    // The refusals below are on purpose (400 wrong / missing password, 429 rate limit).
    monitor.allow(/400 POST \/api\/admin\/backup\/full/, /429 POST \/api\/admin\/backup\/full/, /status of 400/, /status of 429/);
    check("Backup", (await api(page, "POST", "/api/admin/backup/full", { groups: ["all"] })).status === 400, "no password: refused");

    await card.getByRole("button", { name: /Download full backup/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#backup-password").fill("wrong-password-1");
    await dialog.getByRole("checkbox").click();
    await dialog.getByRole("button", { name: "Download" }).click();
    await expect(dialog.getByRole("alert")).toContainText(/Incorrect password/i);
    check("Backup", true, "a wrong password is refused, nothing downloads");
    await shot(page, "02-password-dialog");

    await dialog.locator("#backup-password").fill(ACCOUNTS.super_admin.password);
    const started = Date.now();
    const downloadPromise = page.waitForEvent("download", { timeout: 300000 });
    await dialog.getByRole("button", { name: "Download" }).click();
    const download = await downloadPromise;
    const seconds = (Date.now() - started) / 1000;
    const file = join(SHOTS, "..", "full-backup.xlsx");
    await download.saveAs(file);
    await expect(dialog).toBeHidden({ timeout: 60000 });
    const buffer = readFileSync(file);
    const files = unzip(buffer);
    const sheets = sheetsOf(files);
    say(`full backup: ${sheets.length} sheets, ${(buffer.length / 1024 / 1024).toFixed(2)} MB, ${seconds.toFixed(1)} s`);
    writeFileSync(join(SHOTS, "..", "full-backup-timing.json"), JSON.stringify({ seconds, bytes: buffer.length, sheets: sheets.map((s) => [s.name, s.rows]) }, null, 2));
    const names = sheets.map((s) => s.name);
    for (const expected of ["About this backup", "Users and accounts", "Employees", "attendance_logs", "Leave balances", "leave_requests", "payroll_entries",
      "payroll_loans", "payroll_thirteenth_month", "Pay rates (now)", "payroll_rate_configs", "payroll_tax_brackets", "payroll_schedule_settings",
      "branches", "role_permissions", "branch_announcements", "audit_logs", "Row counts"]) {
      check("Backup sheets", names.includes(expected), `sheet "${expected}"`);
    }
    // Row counts = the database, table by table (the "Row counts" sheet names
    // each sheet's table; sheet names are cut at Excel's 31 characters).
    const countsXml = sheets.find((s) => s.name === "Row counts").xml;
    const countRows = [...countsXml.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/g)].slice(1)
      .map(([, , cells]) => [...cells.matchAll(/<t[^>]*>([^<]*)<\/t>|<v>([^<]*)<\/v>/g)].map((m) => m[1] ?? m[2]));
    const mismatched = [];
    let tables = 0;
    for (const [sheet, table, inFile] of countRows) {
      if (!/^[a-z_0-9]+$/.test(table) || ["users", "employees", "leave_balances", "pay_rates"].includes(table)) continue;
      tables += 1;
      // The database count without demo people's rows (is_demo, 2026-11-08).
      const db = count(`select count(*) from public.${table} t where ${psql(`select public.backup_demo_filter('${table}')`)}`);
      const fileRows = Number(inFile);
      const sheetRows = sheets.find((s) => s.name === sheet)?.rows;
      // audit_logs grows while the file is made (the backup's own entries).
      const close = table === "audit_logs" ? Math.abs(db - fileRows) <= 3 : db === fileRows;
      if (!close || sheetRows !== fileRows) mismatched.push(`${table} file ${fileRows} / sheet ${sheetRows} / db ${db}`);
    }
    check("Backup counts", tables >= 60 && !mismatched.length, mismatched.length ? `mismatch: ${mismatched.join(", ")}` : `all ${tables} table sheets: rows in the file = the database`);
    const employees = sheets.find((s) => s.name === "Employees");
    const realPeople = count("select count(*) from profiles where role <> 'super_admin' and not is_demo");
    check("Backup", employees.rows === realPeople && !/DM-0001/.test(employees.xml) && !/demo0\d\d@demo60\.test/.test(everythingOf(files)), `Employees sheet: ${employees.rows} people, the 64 demo employees left out`);
    check("Backup", /TIN<\/t>/.test(employees.xml) && /Hourly rate \(daily ÷ 8\)/.test(employees.xml), "Employees sheet has the ID-number and hourly-rate columns");
    const everything = Object.values(files).join("\n");
    const leaks = [["bcrypt hash", /\$2[aby]\$\d\d\$/], ["encrypted_password", /encrypted_password/], ["JWT", /eyJhbGciOi/], ["code_hash", /code_hash/], ["service role key", /service_role_key|SUPABASE_SERVICE/i], ["encrypted ID column", /_number_enc/]];
    for (const [label, pattern] of leaks) check("Backup secrets", !pattern.test(everything), `no ${label} in the file`);
    check("Backup audit", count("select count(*) from audit_logs where action = 'backup_full_download'") >= 1 && count("select count(*) from audit_logs where action = 'backup_full_completed'") >= 1, "audit log: started + completed");
    check("Backup audit", count("select count(*) from audit_logs where action = 'backup_password_failed'") >= 1, "audit log: the wrong password");
    check("Backup timing", seconds < 120, `${seconds.toFixed(1)} s for ${employees.rows} employees and ${sheets.find((s) => s.name === "attendance_logs")?.rows} attendance rows`);
  });

  await step(page, "2. One group at a time, rate limit, recovery text, service status", async () => {
    const card = main(page).locator('[data-testid="full-backup"]');
    await card.getByRole("button", { name: "Download Payroll records and payslips (.xlsx)" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#backup-password").fill(ACCOUNTS.super_admin.password);
    await dialog.getByRole("checkbox").click();
    const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
    await dialog.getByRole("button", { name: "Download" }).click();
    const one = await downloadPromise;
    const path = join(SHOTS, "..", "group-payroll.xlsx");
    await one.saveAs(path);
    const groupSheets = sheetsOf(unzip(readFileSync(path))).map((s) => s.name);
    check("Group download", groupSheets.includes("payroll_entries") && !groupSheets.includes("attendance_logs"), `payroll group only: ${groupSheets.length} sheets`);
    // Rate limit: 5 downloads in 15 minutes; use what is left, then one more.
    const left = (await api(page, "GET", "/api/admin/backup/full")).data.limit.left;
    const statuses = [];
    for (let i = 0; i <= left; i += 1) {
      const res = await page.request.post("/api/admin/backup/full", { data: { password: ACCOUNTS.super_admin.password, groups: ["announcements"] } });
      statuses.push(res.status());
    }
    check("Rate limit", statuses.slice(0, left).every((s) => s === 200) && statuses[left] === 429, `${left} left: ${statuses.join(", ")} (then refused)`);
    await page.reload();
    await settle(page);
    const recovery = await main(page).getByText("Recovery procedures").locator("xpath=ancestor::*[@data-slot='card'][1]").innerText();
    check("Recovery text", /Not enabled/.test(recovery) && /7 days/.test(recovery) && !/Point-in-time restore via Supabase Dashboard/.test(recovery), "point-in-time recovery shown as not enabled; daily backups, 7 days");
    check("Restore guide", await main(page).locator('[data-testid="restore-guide"]').isVisible(), "restore guide shown");
    check("Restore guide", /Uploaded files are not included in this export and must be backed up separately\./.test(await main(page).locator('[data-testid="uploads-not-included"]').innerText()), "says uploaded files must be backed up separately");
    await expect(main(page).getByText("Supabase database").first()).toBeVisible({ timeout: 30000 });
    check("Service status", await main(page).getByText(/Connection verified|Could not reach|did not answer/).first().isVisible(), "service status shows what the app reaches (no endless loading bars)");
    await shot(page, "02-service-status", main(page).getByText("Service status").locator("xpath=ancestor::*[@data-slot='card'][1]"));
    await main(page).locator('[data-testid="restore-guide"]').scrollIntoViewIfNeeded();
    await shot(page, "02-restore-guide-and-recovery");
  });

  /* ── 3. Announcements ─────────────────────────────────────────────── */
  const T = { sa: `E2E SA school-wide ${STAMP}`, saEdited: `E2E SA edited ${STAMP}`, hr: `E2E HR North ${STAMP}` };
  await step(page, "3. Super Admin posts, edits its own, deletes any; HR and Admin rules hold", async () => {
    monitor.at("Super Admin > Announcements");
    await as(page, "super_admin", "sa-announcements");
    await settle(page);
    await main(page).getByRole("button", { name: "Post announcement" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#an-title").fill(T.sa);
    await dialog.locator("#an-body").fill("Posted by the Super Admin for everyone.");
    await dialog.locator("#an-audience").click();
    await page.getByRole("option", { name: "Whole school", exact: true }).click();
    await dialog.locator("#an-cat").click();
    await page.getByRole("option", { name: "Meeting" }).click();
    await shot(page, "03-sa-post-dialog");
    await dialog.getByRole("button", { name: "Post", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 20000 });
    await settle(page);
    const toaster = page.locator("[data-sonner-toaster]");
    check("Toast (Super Admin)", (await toaster.getAttribute("data-y-position")) === "top" && (await toaster.getAttribute("data-x-position")) === "right", "toast top right");
    await shot(page, "08-toast-super-admin");
    const row = (title) => main(page).locator("tr", { hasText: title }).first();
    await row(T.sa).getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog").locator("#an-title").fill(T.saEdited);
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await settle(page);
    check("Super Admin", await row(T.saEdited).isVisible(), "edited its own announcement");
    check("Audit", count(`select count(*) from audit_logs where action in ('announcement_post','announcement_edit') and actor_role = 'super_admin'`) >= 2, "post + edit in the audit log");

    await as(page, "hr", "hr-announcements");
    const hrPost = await api(page, "POST", "/api/announcements", { title: T.hr, body: "North only", audience: north.id, category: "general" });
    check("HR", hrPost.status === 200, `HR posts to one branch (${hrPost.status})`);
    const saRow = (await api(page, "GET", "/api/announcements?manage=1")).data.announcements.find((a) => a.title === T.saEdited);
    check("HR", saRow?.can_edit === true, "HR may still edit any announcement");
    await as(page, "super_admin", "sa-announcements");
    const hrRow = (await api(page, "GET", "/api/announcements?manage=1")).data.announcements.find((a) => a.title === T.hr);
    check("Super Admin", hrRow?.can_edit === false && hrRow?.can_delete === true, "HR's post: Super Admin may delete, not edit");
    const editOther = await api(page, "PATCH", "/api/announcements", { id: hrRow.id, action: "edit", title: "x", body: "y", category: "general" });
    check("Super Admin", editOther.status === 403, `editing HR's post refused (${editOther.status})`);

    await as(page, "admin", "adm-announcements");
    const adminWide = await api(page, "POST", "/api/announcements", { title: "x", body: "y", audience: "all" });
    const adminNorth = await api(page, "POST", "/api/announcements", { title: "x", body: "y", audience: north.id });
    check("Admin", adminWide.status === 403 && adminNorth.status === 403, `Admin: school-wide ${adminWide.status}, another branch ${adminNorth.status}`);
    const saOwned = (await api(page, "GET", "/api/announcements?manage=1")).data.announcements.find((a) => a.title === T.saEdited);
    check("Admin", saOwned && !saOwned.can_edit && !saOwned.can_delete, "Admin cannot change the Super Admin's post");

    await as(page, "employee", "emp-announcements");
    const mainFeed = (await api(page, "GET", "/api/announcements")).data.announcements.map((a) => a.title);
    check("Employee (Main)", mainFeed.includes(T.saEdited) && !mainFeed.includes(T.hr), "sees the school-wide post, not North's");
    await as(page, "employee3", "emp-announcements");
    const northFeed = (await api(page, "GET", "/api/announcements")).data.announcements.map((a) => a.title);
    check("Employee (North)", northFeed.includes(T.saEdited) && northFeed.includes(T.hr), "sees school-wide and North's");
    check("Employee", (await api(page, "POST", "/api/announcements", { title: "x", body: "y" })).status === 403, "employees cannot post");

    await as(page, "super_admin", "sa-announcements");
    await settle(page);
    await row(T.hr).getByRole("button", { name: "Delete" }).click();
    await confirm(page, "Delete");
    check("Super Admin", /Deleted/.test(await row(T.hr).innerText()), "deleted HR's post (moderation)");
    await shot(page, "03-sa-announcements-list");
  });

  /* ── 4 + 6. Toolbars and stray arrows ─────────────────────────────── */
  const TOOLBAR_PAGES = [
    ["super_admin", "sa-accounts", "Admin & HR logins"],
    ["super_admin", "sa-maintenance", "RFID cards"],
    ["hr", "hr-employees", "HR employees"],
    ["hr", "hr-transfers", "HR transfers"],
    ["hr", "hr-tenure", "HR tenure protection"],
    ["hr", "hr-payroll-records", "HR payroll records"],
    ["hr", "hr-adjustment-approvals", "HR incentive & loan approvals"],
    ["hr", "hr-branch-requests", "HR branch requests"],
    ["hr", "hr-rfid-cards", "HR RFID cards"],
    ["accountant", "ac-monitoring", "Accountant payroll monitoring"],
    ["admin", "adm-leaves", "Admin leave recommendations"],
    ["admin", "adm-attendance", "Admin branch attendance"],
    ["admin", "adm-maintenance", "Admin RFID cards"],
    // Moved to the shared toolbar on 2026-11-08 (decision 4).
    ["hr", "hr-payroll-approval", "HR payroll approval"],
    ["hr", "hr-attendance", "HR attendance status board"],
  ];
  await step(page, "4/6. Search first, tabs and dropdowns on the same row; no arrows beside tabs", async () => {
    for (const [role, pageId, label] of TOOLBAR_PAGES) {
      monitor.at(label);
      await as(page, role, pageId);
      await settle(page);
      const { search, tools } = await toolbarOf(page);
      check(`Toolbar: ${label}`, Boolean(search && tools) && search.x < tools.x && sameRow(search, tools), "search on the left, filters on the same row");
      const stray = await strayScrollbars(page);
      check(`Arrows: ${label}`, stray.length === 0, stray.length ? `scrollbar beside: ${stray.join(", ")}` : "no up / down arrows beside the tabs");
      check(`Overflow: ${label}`, (await pageOverflow(page)) <= 0, "no sideways page scroll");
      await shot(page, `04-toolbar-${pageId}`, main(page).locator('[data-slot="table-toolbar"]:has([data-slot="table-toolbar-tools"])').first());
    }
    for (const [role, pageId] of [["super_admin", "sa-config"], ["hr", "hr-payroll-approval"], ["hr", "hr-attendance"], ["hr", "hr-subsidy-approvals"]]) {
      await as(page, role, pageId);
      await settle(page);
      const stray = await strayScrollbars(page);
      check(`Arrows: ${pageId}`, stray.length === 0, stray.length ? `scrollbar beside: ${stray.join(", ")}` : "no up / down arrows beside the tabs");
    }
    await as(page, "super_admin", "sa-maintenance");
    await settle(page);
    const rfid = main(page).locator('[data-slot="table-toolbar"]').first();
    await rfid.locator('[data-slot="select-trigger"]').first().click().catch(() => {});
    check("Select", (await page.locator('[data-slot="select-scroll-up-button"], [data-slot="select-scroll-down-button"]').count()) === 0, "no scroll arrow buttons in an open dropdown");
    await page.keyboard.press("Escape");
  });

  /* ── 5. Add Branch: searchable location pickers ───────────────────── */
  await step(page, "5. Add Branch: Region → Province → City → Barangay, searchable and on screen", async () => {
    monitor.at("Super Admin > Branch Management > Add branch");
    await as(page, "super_admin", "sa-branches");
    await settle(page);
    await main(page).getByRole("button", { name: "Add branch" }).click();
    // The list's popover is a role=dialog too: the Add branch box by its slot.
    const dialog = page.locator('[data-slot="dialog-content"]');
    await dialog.locator("#sa-branch-name").fill(`E2E Search ${STAMP}`);
    const pick = async (id, typed, option, key) => {
      await dialog.locator(`#${id}`).click();
      const search = page.getByRole("searchbox");
      await search.fill(typed);
      const list = page.getByRole("listbox");
      const box = await list.boundingBox();
      check(`Picker ${id}`, box && box.height <= 320 && box.y >= 0 && box.y + box.height <= 800, `list ${Math.round(box?.height || 0)} px tall, on screen`);
      const modal = await dialog.boundingBox();
      check(`Picker ${id}`, box.y >= modal.y - 2 && box.y + box.height <= modal.y + modal.height + 2, "list kept inside the dialog");
      if (key) { await search.press("ArrowDown"); await search.press("Enter"); } else await page.getByRole("option", { name: option }).first().click();
      await expect(list).toBeHidden();
    };
    await dialog.locator("#sa-branch-region").click();
    await page.getByRole("searchbox").fill("zzzz");
    check("Picker", await page.getByText("No results").isVisible(), "no match: \"No results\"");
    await shot(page, "05-region-no-results");
    await page.getByRole("searchbox").press("Escape");
    await pick("sa-branch-region", "calabarzon", /CALABARZON/);
    await pick("sa-branch-province", "Rizal", /^Rizal$/);
    await pick("sa-branch-city", "antipolo", /^Antipolo City$/);
    await dialog.locator("#sa-branch-barangay").click();
    const all = await page.getByRole("option").count();
    await page.getByRole("searchbox").fill("san");
    const narrowed = await page.getByRole("option").count();
    check("Picker barangay", narrowed > 0 && narrowed < all, `typing "san" filters ${all} barangays to ${narrowed}`);
    await shot(page, "05-barangay-search");
    await page.getByRole("searchbox").press("ArrowDown");
    await page.getByRole("searchbox").press("Enter");
    check("Cascade", /Antipolo/.test(await dialog.locator("#sa-branch-city").innerText()) && !/Select barangay|Choose/.test(await dialog.locator("#sa-branch-barangay").innerText()), "region → province → city → barangay chosen by keyboard");
    await pick("sa-branch-province", "Rizal", /^Rizal$/);
    check("Cascade", /Select city/.test(await dialog.locator("#sa-branch-city").innerText()), "changing the province clears the city (cascade kept)");
    await shot(page, "05-add-branch-dialog");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  /* ── 7. Sidebar scrollbar ─────────────────────────────────────────── */
  await step(page, "7. Sidebar: no visible scrollbar, scrolls with wheel and keyboard, footer stays", async () => {
    await page.setViewportSize({ width: 1280, height: 560 });
    for (const role of ["super_admin", "hr", "accountant", "admin", "employee"]) {
      await as(page, role);
      await settle(page);
      const content = page.locator('[data-sidebar="content"]').first();
      const info = await content.evaluate((el) => ({ width: el.offsetWidth - el.clientWidth, style: getComputedStyle(el).scrollbarWidth, scrollable: el.scrollHeight > el.clientHeight }));
      check(`Sidebar ${role}`, info.width === 0 && info.style === "none", `no scrollbar (gutter ${info.width}px, scrollbar-width ${info.style})`);
      if (info.scrollable) {
        await content.hover();
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(300);
        const scrolled = await content.evaluate((el) => el.scrollTop);
        await content.evaluate((el) => { el.scrollTop = 0; });
        await content.locator("a, button").last().focus();
        const keyboard = await content.evaluate((el) => el.scrollTop);
        check(`Sidebar ${role}`, scrolled > 0 && keyboard > 0, `wheel scrolled ${scrolled}px; keyboard focus scrolled ${keyboard}px`);
      } else {
        check(`Sidebar ${role}`, true, "fits without scrolling at 560 px");
      }
      check(`Sidebar ${role}`, await page.locator('[data-sidebar="footer"]').first().isVisible(), "footer (user menu) visible");
      if (role === "super_admin") await shot(page, "07-sidebar-short-window");
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  /* ── 8. Toasts ────────────────────────────────────────────────────── */
  await step(page, "8. Toasts top right under the header, every role", async () => {
    const toastAt = async (who) => {
      const toast = page.locator('[data-sonner-toast][data-mounted="true"]').first();
      await toast.waitFor({ timeout: 15000 });
      await page.waitForTimeout(700); // the slide-in animation
      const box = await toast.boundingBox();
      const toaster = page.locator("[data-sonner-toaster]").first();
      const ok = (await toaster.getAttribute("data-y-position")) === "top" && (await toaster.getAttribute("data-x-position")) === "right" && box.y >= 56 && box.x + box.width >= 1280 - 40;
      check(`Toast ${who}`, ok, `top right at y=${Math.round(box.y)} (header 56 px), right edge ${Math.round(box.x + box.width)}`);
      await shot(page, `08-toast-${who}`);
      await toast.getByRole("button", { name: /close/i }).click().catch(() => {});
    };
    await as(page, "accountant", "ac-reports");
    await settle(page);
    // Reports load by themselves now (alpha test B4): the toast comes from
    // asking for the payroll sheet with no single period chosen.
    await main(page).locator("#rpt-type").click();
    await page.getByRole("option", { name: "Payroll sheet (school format)" }).click();
    await main(page).getByRole("button", { name: "Refresh report" }).click();
    await toastAt("accountant");
    await as(page, "employee", "emp-timesheet");
    await settle(page);
    // The timesheet loads its range by itself since the alpha test (2026-11-09).
    // The range is one control since the attendance redesign: the Last month preset.
    await main(page).getByRole("combobox", { name: "Date range" }).click();
    await page.getByRole("option", { name: "Last month" }).click();
    await settle(page);
    await main(page).getByRole("button", { name: "Copy" }).click();
    await toastAt("employee");
    for (const role of ["hr", "admin"]) {
      await as(page, role, role === "hr" ? "hr-announcements" : "adm-announcements");
      await settle(page);
      await main(page).getByRole("button", { name: "Post announcement" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.locator("#an-title").fill(`E2E toast ${role} ${STAMP}`);
      await dialog.locator("#an-body").fill("Toast position check");
      if (role === "hr") { await dialog.locator("#an-audience").click(); await page.getByRole("option", { name: BRANCH_MAIN, exact: true }).click(); }
      await dialog.getByRole("button", { name: "Post", exact: true }).click();
      await toastAt(role);
    }
  });

  /* ── 9. Rates ─────────────────────────────────────────────────────── */
  await step(page, "9. Rates: daily editable, hourly automatic, same dates; branch rate isolated; read-only elsewhere", async () => {
    monitor.at("Super Admin > System Configuration > Rates");
    const before = psql("select string_agg(id::text || '=' || coalesce(payroll->'audit'->'rates'->'hourly'->>'value',''), ',' order by id) from payroll_entries where status in ('approved','paid')");
    await as(page, "super_admin", "sa-config");
    await settle(page);
    await main(page).getByRole("tab", { name: "Rates" }).click();
    await settle(page);
    const pair = main(page).locator('[data-testid="rate-pair"]');
    await pair.waitFor();
    await shot(page, "09-rate-pair-before-change", pair);
    check("Rates", (await pair.locator('[data-testid="pair-row-hourly"]').getByRole("button", { name: /Edit/ }).count()) === 0, "the hourly row has no Edit button");
    check("Rates", /Daily rate ÷ 8 \(automatic\)/.test(await pair.locator('[data-testid="pair-row-hourly"]').innerText()), "labelled Daily rate ÷ 8 (automatic)");

    await pair.getByRole("button", { name: "Edit Daily rate" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#sa-rate-value").fill("700");
    await expect(dialog.locator('[data-testid="hourly-preview"]')).toContainText("₱87.50");
    check("Rates dialog", true, "typing ₱700 shows the hourly rate ₱87.50 live");
    await pickDate(page, dialog.locator("#sa-rate-effective"), "2026-12-01");
    await dialog.getByRole("button", { name: "Save new version" }).click();
    await expect(dialog.getByText("Give a reason for the daily rate change.")).toBeVisible();
    check("Rates dialog", true, "a reason is required");
    await dialog.locator("#sa-rate-note").fill(`E2E board resolution ${STAMP}`);
    await shot(page, "09-daily-dialog-live-hourly");
    await dialog.getByRole("button", { name: "Save new version" }).click();
    await confirm(page, "Save");
    await settle(page);
    const daily = await pair.locator('[data-testid="daily-history"]').innerText();
    const hourly = await pair.locator('[data-testid="hourly-history"]').innerText();
    check("Rates history", /₱700\.00[\s\S]*Dec 1, 2026/.test(daily) && /₱87\.50[\s\S]*Dec 1, 2026/.test(hourly), "daily ₱700.00 and hourly ₱87.50 both from Dec 1, 2026");
    const ranges = (text) => text.split("\n").filter((l) => /\d{4}/.test(l)).map((l) => l.replace(/₱[\d,.]+/, "").replace(/·.*$/, "").trim());
    check("Rates history", JSON.stringify(ranges(daily)) === JSON.stringify(ranges(hourly)), "the hourly history has exactly the daily history's dates");
    const audit = JSON.parse(psql("select metadata::text from audit_logs where action = 'rate_version' order by created_at desc limit 1"));
    check("Rates audit", audit.hourly?.new_hourly === 87.5 && audit.reason?.includes("E2E board resolution"), `audit: daily ${audit.previous_value} → ${audit.value}, hourly ${audit.hourly?.previous_hourly} → ${audit.hourly?.new_hourly}, with the reason`);
    // Columns line up: the daily and hourly values right-aligned in one column.
    const d = await pair.locator('[data-testid="daily-current"]').boundingBox();
    const h = await pair.locator('[data-testid="hourly-current"]').boundingBox();
    check("Rates columns", Math.abs((d.x + d.width) - (h.x + h.width)) <= 2, "This period values line up (right edges)");
    await shot(page, "09-rate-pair-after-change", pair);

    const typed = await api(page, "POST", "/api/admin/payroll-rates", { rate_type: "hourly", scope: "global", value: 99, effective_date: "2026-12-01", note: "x" });
    check("Rates API", typed.status === 400 && typed.data?.code === "hourly_rate_derived", `typed hourly refused (${typed.status} ${typed.data?.code})`);
    let dbRefused = false;
    try { psql(`insert into payroll_rate_configs (rate_type, scope, value, effective_date, created_by) values ('hourly', 'global', 99, '2026-12-01', '${sa.id}')`); } catch { dbRefused = true; }
    check("Rates DB", dbRefused, "the database refuses a typed hourly row");

    // A branch daily rate: North only.
    const branchRow = main(page).locator("tr", { hasText: BRANCH_NORTH }).first();
    await branchRow.getByRole("button", { name: /Edit daily rate/ }).click();
    const bDialog = page.getByRole("dialog");
    await bDialog.locator("#sa-rate-value").fill("650");
    await expect(bDialog.locator('[data-testid="hourly-preview"]')).toContainText("₱81.25");
    await pickDate(page, bDialog.locator("#sa-rate-effective"), "2026-12-01");
    await bDialog.locator("#sa-rate-note").fill("E2E North rate");
    await bDialog.getByRole("button", { name: "Save new version" }).click();
    await confirm(page, "Save");
    await settle(page);
    const northText = await main(page).locator("tr", { hasText: BRANCH_NORTH }).first().innerText();
    const mainText = await main(page).locator("tr", { hasText: BRANCH_MAIN }).first().innerText();
    check("Branch rates", /₱650\.00/.test(northText) && /₱81\.25/.test(northText), "North: ₱650.00 daily, ₱81.25 hourly (Dec 1)");
    check("Branch rates", !/₱650\.00/.test(mainText) && /Uses system default/.test(mainText), "Main unaffected: uses the system default");
    await shot(page, "09-branch-rates", main(page).locator("tr", { hasText: BRANCH_NORTH }).first().locator("xpath=ancestor::*[@data-slot='card'][1]"));

    const after = psql("select string_agg(id::text || '=' || coalesce(payroll->'audit'->'rates'->'hourly'->>'value',''), ',' order by id) from payroll_entries where status in ('approved','paid')");
    check("Past payslips", before === after, "approved / paid payslips keep the rates they were made with");

    for (const role of ["admin", "hr", "accountant"]) {
      await as(page, role);
      const post = await api(page, "POST", "/api/admin/payroll-rates", { rate_type: "daily", scope: "global", value: 1, effective_date: "2026-12-01", note: "x" });
      const read = await api(page, "GET", "/api/payroll/pay-rates");
      const names = (read.data?.branches || []).map((b) => b.name);
      const scopedOk = role === "hr" ? names.includes(BRANCH_NORTH) && names.includes(BRANCH_MAIN) : names.length === 1;
      check(`Read-only ${role}`, post.status === 403 && read.status === 200 && read.data.can_edit === false && scopedOk, `edit refused (${post.status}); sees ${names.join(", ")}`);
    }
    await as(page, "admin", "adm-pay-rates");
    await settle(page);
    const panel = main(page).locator('[data-testid="pay-rates-panel"]');
    check("Admin page", (await panel.getByRole("button", { name: /Edit/ }).count()) === 0 && /Main Campus/.test(await panel.innerText()) && !new RegExp(BRANCH_NORTH).test(await panel.innerText()), "Admin: its own branch, read-only");
    await shot(page, "09-admin-pay-rates", panel);
    await as(page, "hr", "hr-gov-rates");
    await settle(page);
    // HR changes the daily rate itself since the alpha test (Part E,
    // 2026-11-09): the editable rates section replaced the read-only panel.
    await expect(main(page).getByRole("button", { name: "Edit Daily rate", exact: true })).toBeVisible();
    await shot(page, "09-hr-pay-rates", main(page).locator('[data-testid="pair-row-daily"]'));
  });

  console.log("\n  ── Summary ──");
  results.forEach((r, i) => console.log(`  ${String(i + 1).padStart(3)}. ${r.ok ? "PASS" : "FAIL"}  ${r.where}: ${r.text}`));
  writeFileSync(join(SHOTS, "..", "desktop-results.json"), JSON.stringify(results, null, 2));
  expect(results.filter((r) => !r.ok).map((r) => `${r.where}: ${r.text}`)).toEqual([]);
});
