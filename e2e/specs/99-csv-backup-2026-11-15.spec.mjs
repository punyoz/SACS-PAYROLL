// 2026-11-15: the Super Admin's CSV backup (one Backup section), local stack only.
//   access: only the Super Admin, on every download endpoint (API)
//   password re-entry, the download limit (5 per 15 minutes), an audit entry per download
//   row counts: every CSV = the database = the page = the README, with and without filters
//   payslips: 3 per branch, every amount = the stored payslip to the centavo
//   files: no password / hash / token / code, no null / undefined / [object Object],
//          "=1+1" exported as "'=1+1", BOM, ₱ and ñ intact, leading zeros kept
//   screenshots at 1366 and 390 px
//
//   E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test e2e/specs/99-csv-backup-2026-11-15.spec.mjs --project=desktop

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { profileByEmail, psql } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_MAIN, BRANCH_NORTH } from "../accounts.mjs";

test.use({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });

const OUT = join(process.cwd(), "screenshots", "2026-11-15");
mkdirSync(OUT, { recursive: true });
const BOM = "﻿";
const results = [];
function check(where, ok, text) {
  results.push({ where, ok, text });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${where}: ${text}`);
  expect.soft(ok, `${where}: ${text}`).toBe(true);
  return ok;
}
const count = (sql) => Number(psql(sql)) || 0;

/** A whole CSV text into rows of cells (quotes, doubled quotes, line breaks inside quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i += 1; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** ZIP (central directory) -> { name: Buffer }. */
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
    files[name] = inflateRawSync(buffer.subarray(start, start + packed));
    at += 46 + nameLength + skip;
  }
  return files;
}

/** A CSV file: BOM check, header, data rows, and the shape (every row as wide as the header). */
function csvOf(buffer) {
  const text = buffer.toString("utf8");
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const [header, ...data] = rows;
  return { text, bom: text.startsWith(BOM), header, data, ragged: data.filter((r) => r.length !== header.length).length, at: (name) => header.indexOf(name) };
}

/** README: file name -> { rows, sha256 }. */
function readmeOf(text) {
  const out = {};
  const blocks = text.split(/\r?\n(?=[a-z0-9_]+\.csv\r?\n)/);
  for (const b of blocks) {
    const name = /^([a-z0-9_]+\.csv)/.exec(b)?.[1];
    if (name) out[name] = { rows: Number(/Rows: (\d+)/.exec(b)?.[1]), sha256: /SHA-256: ([0-9a-f]{64})/.exec(b)?.[1] };
  }
  return out;
}

const COMPUTED = { users: "users_and_accounts.csv", employees: "employees.csv", leave_balances: "leave_balances.csv", pay_rates: "pay_rates.csv" };
const fileName = (key) => COMPUTED[key] || `${key}.csv`;

/** Database counts as the backup defines them (demo people included since 2026-11-15). */
function dbCount(key) {
  if (key === "users") return count("select (select count(*) from auth.users) + (select count(*) from profiles p where not exists (select 1 from auth.users u where u.id = p.id))");
  if (key === "employees") return count("select count(*) from profiles where lower(role::text) <> 'super_admin'");
  if (key === "leave_balances") return 2 * dbCount("employees");
  if (key === "pay_rates") return 1 + count("select count(*) from branches");
  return count(`select count(*) from public.${key}`);
}

// Employee share: the final-pay lines when the payslip has them, else deductions.<kind>, else the column.
const share = (kind) => `coalesce(case when jsonb_typeof(e.payroll #> '{final_pay,breakdown,deductions}') = 'array'
  then (select coalesce(sum(public.payroll_json_amount(l -> 'amount')), 0) from jsonb_array_elements(e.payroll #> '{final_pay,breakdown,deductions}') l where l ->> 'kind' = '${kind}')
  else public.payroll_json_amount(e.payroll #> '{deductions,${kind}}') end, e.${kind})`;
// Payslip amounts the database's own rule gives (payroll_entries_columns_from_payroll).
const STORED = `
  coalesce(public.payroll_json_amount(e.payroll #> '{monthly,cutoff,gross_pay}'), public.payroll_json_amount(e.payroll #> '{totals,gross_pay}'), e.gross_pay)::text || '|' ||
  coalesce(greatest(0, public.payroll_json_amount(e.payroll #> '{totals,net_pay}')), e.net_pay)::text || '|' ||
  coalesce(public.payroll_json_amount(e.payroll #> '{totals,total_deductions}'), e.total_deductions)::text || '|' ||
  ${share("sss")}::text || '|' || ${share("philhealth")}::text || '|' || ${share("pagibig")}::text || '|' ||
  coalesce(public.payroll_json_amount(e.payroll #> '{employer_contributions,employer,sss}')::text, '')`;
const SPOT = ["Gross pay (PHP)", "Net pay (PHP)", "Total deductions (PHP)", "SSS employee share (PHP)", "PhilHealth employee share (PHP)", "Pag-IBIG employee share (PHP)", "SSS employer share (PHP)"];

test("2026-11-15: Super Admin CSV backup", async ({ page, monitor }) => {
  test.setTimeout(600_000);
  // The refusals below are on purpose.
  monitor.allow(/40\d (GET|POST) \/api\/admin\/backup\//, /429 POST \/api\/admin\/backup\/full/, /status of 40\d/, /status of 429/, /^401 GET /);
  const branches = Object.fromEntries(psql("select name || '|' || id from branches").split("\n").map((l) => l.split("|")));
  const north = branches[BRANCH_NORTH];
  const employee3 = await profileByEmail(ACCOUNTS.employee3.email);
  const original = psql(`select coalesce(full_name,'') || '|' || coalesce(address,'') || '|' || coalesce(cp_number,'') from profiles where id = '${employee3.id}'`);

  await step(page, "Setup: test values and 3 paid payslips per branch with stale amount columns (local only)", async () => {
    // A name that looks like a formula, ₱ and ñ, a leading zero.
    psql(`update profiles set full_name = '=1+1', address = 'Brgy. Santo Niño, ₱ test', cp_number = '09170000001', is_demo = true where id = '${employee3.id}'`);
    // Like the October payslips: the record holds the amounts, the columns 0 (written before the 2026-10-29 trigger).
    psql(`set session_replication_role = replica;
      insert into payroll_entries (employee_id, employee_name, employee_code, employee_type, position, pay_period, cutoff, status, basic_salary, gross_pay, sss, philhealth, pagibig, withholding_tax, total_deductions, net_pay, branch_id, payslip_no, payroll, created_at, updated_at, approved_at)
      select p.id, p.full_name, p.employee_id, p.employee_type, p.position, 'August 1-15, 2026', 'first', 'paid', 0, 0, 0, 0, 0, 0, 0, 0, p.branch_id, 'E2E-CSV-' || p.employee_id,
        jsonb_build_object('basic_salary', 12000, 'basic_earned', 6000,
          'totals', jsonb_build_object('gross_pay', 6000.5 + p.rn, 'total_deductions', 436.8, 'net_pay', 5563.7 + p.rn),
          'deductions', jsonb_build_object('sss', 300, 'philhealth', 75.4, 'pagibig', 61.4, 'withholding_tax', 0),
          'employer_contributions', jsonb_build_object('employer', jsonb_build_object('sss', 600, 'sss_ec', 10, 'philhealth', 75.4, 'pagibig', 200, 'total', 885.4))),
        now(), now(), now()
      from (select q.*, row_number() over (partition by q.branch_id order by q.employee_id) rn from profiles q
            where lower(q.role::text) <> 'super_admin' and q.branch_id is not null and q.employee_id is not null) p
      where p.rn <= 3 and not exists (select 1 from payroll_entries e where e.payslip_no = 'E2E-CSV-' || p.employee_id);`);
    check("Setup", count("select count(*) from payroll_entries where payslip_no like 'E2E-CSV-%'") >= 3, "test payslips in place");
  });

  try {
    await step(page, "Only the Super Admin, on every download endpoint", async () => {
      for (const role of ["accountant", "hr", "admin", "employee"]) {
        await as(page, role);
        const get = await api(page, "GET", "/api/admin/backup/full");
        const post = await api(page, "POST", "/api/admin/backup/full", { password: ACCOUNTS[role].password, groups: ["all"] });
        const file = await api(page, "POST", "/api/admin/backup/full", { password: ACCOUNTS[role].password, file: "payroll_entries" });
        check(role, [get.status, post.status, file.status].every((s) => s === 403), `refused (${get.status}/${post.status}/${file.status})`);
      }
      const gone = await api(page, "GET", "/api/admin/backup/payroll");
      check("Old endpoint", gone.status === 404 || gone.status === 403, `the old payroll export is gone (${gone.status})`);
      let refused = false;
      const accountant = await profileByEmail(ACCOUNTS.accountant.email);
      try { psql(`select count(*) from public.backup_export_page('${accountant.id}', 'payroll_entries')`); } catch { refused = true; }
      check("Database", refused, "the database refuses a non-Super Admin as actor");
    });

    await as(page, "super_admin", "sa-backup");
    const downloads = () => count("select count(*) from audit_logs where action = 'backup_full_download'");
    const completed = () => count("select count(*) from audit_logs where action = 'backup_full_completed'");
    const post = (body) => page.request.post("/api/admin/backup/full", { data: { password: ACCOUNTS.super_admin.password, ...body } });

    await step(page, "Password re-entry; the page and the API show the real counts", async () => {
      const failedBefore = count("select count(*) from audit_logs where action = 'backup_password_failed'");
      const before = downloads();
      const wrong = await api(page, "POST", "/api/admin/backup/full", { password: "wrong-password-1", groups: ["all"] });
      const none = await api(page, "POST", "/api/admin/backup/full", { groups: ["all"] });
      check("Password", wrong.status === 400 && wrong.data?.code === "wrong_password" && none.status === 400, `wrong / missing password refused (${wrong.status}/${none.status})`);
      check("Password", count("select count(*) from audit_logs where action = 'backup_password_failed'") >= failedBefore + 1 && downloads() === before, "a refusal is audited and does not count as a download");

      const info = (await api(page, "GET", "/api/admin/backup/full")).data;
      const wrongCounts = Object.entries(info.counts).filter(([k, n]) => k !== "audit_logs" && dbCount(k) !== n).map(([k, n]) => `${k} ${n}≠${dbCount(k)}`);
      check("Counts", !wrongCounts.length, wrongCounts.length ? wrongCounts.join(", ") : `all ${Object.keys(info.counts).length} files: API count = database`);
      const users = info.groups.find((g) => g.key === "users");
      check("Users", users.rows === dbCount("users") && users.rows > 0, `Users and accounts: ${users.rows} rows (database ${dbCount("users")}), ${users.files} file`);

      await page.reload();
      await settle(page);
      const card = main(page).locator('[data-testid="backup"]');
      await expect(card.getByTestId("backup-total")).toContainText("rows", { timeout: 60000 });
      for (const g of info.groups) {
        const text = await card.getByTestId(`backup-group-${g.key}`).getByTestId("backup-group-count").innerText();
        check("Page", text.startsWith(`${g.files} file${g.files === 1 ? "" : "s"} · ${g.rows.toLocaleString("en-PH")} rows`), `${g.label}: "${text}"`);
      }
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: join(OUT, "backup-1366.png") });
      check("Page", (await main(page).getByText("Manual data export").count()) === 0 && (await main(page).getByText(/\.xlsx/).count()) === 0, "one Backup section; no Manual data export, no .xlsx");
    });

    let zip;
    await step(page, "Download everything (ZIP): password dialog, counts = database = README, checksums", async () => {
      const before = downloads();
      const card = main(page).locator('[data-testid="backup"]');
      await card.getByRole("button", { name: /Download everything/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.locator("#backup-password").fill(ACCOUNTS.super_admin.password);
      await dialog.getByRole("checkbox").click();
      const started = Date.now();
      const pending = page.waitForEvent("download", { timeout: 300000 });
      await dialog.getByRole("button", { name: "Download" }).click();
      const download = await pending;
      const path = join(OUT, download.suggestedFilename());
      await download.saveAs(path);
      await expect(dialog).toBeHidden({ timeout: 60000 });
      const { readFileSync } = await import("node:fs");
      zip = unzip(readFileSync(path));
      console.log(`  everything: ${Object.keys(zip).length} files, ${((Date.now() - started) / 1000).toFixed(1)} s, ${download.suggestedFilename()}`);
      check("File name", /^(LOCAL-TEST_|DEMO_)?sacs-payroll_everything_\d{4}-\d{2}-\d{2}_\d{4}\.zip$/.test(download.suggestedFilename()), download.suggestedFilename());
      check("Audit", downloads() === before + 1, "one audit entry for the download");

      const readme = zip["README.txt"].toString("utf8");
      const listed = readmeOf(readme);
      const info = (await api(page, "GET", "/api/admin/backup/full")).data;
      const bad = [];
      for (const [key, apiCount] of Object.entries(info.counts)) {
        const name = fileName(key);
        if (!zip[name]) { bad.push(`${name} missing`); continue; }
        const csv = csvOf(zip[name]);
        const sha = createHash("sha256").update(zip[name]).digest("hex");
        const db = dbCount(key);
        // audit_logs only grows while the run goes on (this download, other specs): never more rows than the database.
        const exact = key === "audit_logs" ? csv.data.length <= apiCount && apiCount <= db : csv.data.length === db && apiCount === db;
        if (!exact || listed[name]?.rows !== csv.data.length || listed[name]?.sha256 !== sha || !csv.bom || csv.ragged) {
          bad.push(`${name}: file ${csv.data.length} / README ${listed[name]?.rows} / page ${apiCount} / db ${db}${csv.ragged ? ` / ${csv.ragged} ragged rows` : ""}${csv.bom ? "" : " / no BOM"}`);
        }
      }
      check("Everything", Object.keys(zip).length === Object.keys(info.counts).length + 1, `${Object.keys(zip).length - 1} CSV files + README`);
      check("Counts", !bad.length, bad.length ? bad.join("; ") : "every CSV: rows = database = page = README; checksums match; BOM; every row as wide as its header");
      // Batch 3 (2026-11-23): the new correction and transfer fields are in the backup (not silently dropped).
      const headerOf = (key) => (zip[fileName(key)] ? csvOf(zip[fileName(key)]).header : []);
      const corr = headerOf("attendance_corrections");
      const tr = headerOf("transfer_requests");
      const missingCols = [
        ...["fix_type", "reason_code", "attachment_path", "pay_effect", "pay_correction_id"].filter((c) => !corr.includes(c)).map((c) => `attendance_corrections.${c}`),
        ...["effective_date", "applied_at"].filter((c) => !tr.includes(c)).map((c) => `transfer_requests.${c}`),
      ];
      check("New fields", !missingCols.length, missingCols.length ? `missing: ${missingCols.join(", ")}` : "attendance_corrections and transfer_requests carry the new fields");
      check("README", /Exported at \(Asia\/Manila\): \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(readme) && /Exported by: .+/.test(readme) && !/@/.test(/Exported by: (.+)/.exec(readme)[1]) && /Filters: branch = every branch; dates = everything/.test(readme) && /App version: /.test(readme), "README: time, who (no email), filters, version");
      check("README", /UUID/.test(readme) && /Columns:/.test(readme), "README has a column guide and explains the UUID links");
      check("README", /^Exported by: .+ \(Super Admin\)/m.test(readme), `exported by name and role: "${/Exported by: (.+)/.exec(readme)[1]}"`);
      check("README", /DEMO DATA: demo people .* ARE included/.test(readme) && /PAYSLIPS OF 0\.00/.test(readme) && /KNOWN ITEM \(after the defense\): payroll_approval_history, payroll_window_enforcement, payroll_window_enforcement_changes/.test(readme),
        "README: demo included, 0.00 payslip note, the 3 UUID-only tables as a known item");
      check("README", /HOW TO RESTORE/.test(readme) && /^LOAD ORDER: branches, profiles, /m.test(readme) && /\[loads into: gross_pay \(num\)\]/.test(readme) && /\[shown only\]/.test(readme),
        "README: restore guide, load order (parents first) and where each column loads");
    });

    await step(page, "Files: no secrets, no null/undefined/[object Object], formula guard, ₱ ñ, leading zeros, column order", async () => {
      const all = Object.entries(zip).filter(([n]) => n.endsWith(".csv"));
      const text = all.map(([, b]) => b.toString("utf8")).join("\n");
      const passwords = [...new Set(Object.values(ACCOUNTS).map((a) => a.password).filter(Boolean))];
      const leaks = [["bcrypt hash", /\$2[aby]\$\d\d\$/], ["encrypted_password", /encrypted_password/], ["JWT", /eyJhbGciOi/], ["code_hash", /code_hash/],
        ["refresh / access token", /refresh_token|access_token/], ["service key", /service_role_key|SUPABASE_SERVICE|sb_secret_/i], ["encrypted ID column", /_number_enc/]];
      for (const [name, pattern] of leaks) check("Secrets", !pattern.test(text), `no ${name}`);
      check("Secrets", passwords.every((p) => !text.includes(p)), `none of the ${passwords.length} test passwords appear`);
      const badCells = [];
      for (const [name, buffer] of all) {
        const csv = csvOf(buffer);
        csv.data.forEach((r) => r.forEach((c) => { if (c === "null" || c === "undefined" || c.includes("[object Object]") || /^[=+@\t\r]/.test(c)) badCells.push(`${name}: ${c.slice(0, 30)}`); }));
        csv.header.forEach((h) => { if (!h) badCells.push(`${name}: empty header`); });
        const firstUuid = csv.header.findIndex((h) => /UUID$/.test(h));
        if (firstUuid >= 0 && csv.header.slice(firstUuid).some((h) => !/UUIDs?\)?$/.test(h))) badCells.push(`${name}: a column after the UUIDs`);
      }
      check("Values", !badCells.length, badCells.length ? badCells.slice(0, 5).join("; ") : "no null / undefined / [object Object], no cell that starts like a formula; UUID columns last");
      const employees = csvOf(zip["employees.csv"]);
      const row = employees.data.find((r) => r[employees.at("Employee profile UUID")] === employee3.id);
      check("Formula", row?.[employees.at("Full name")] === "'=1+1", `"=1+1" exported as ${JSON.stringify(row?.[employees.at("Full name")])}`);
      check("Formula", !/(^|,)=/.test(text.split("\n").filter((l) => !l.startsWith('"')).join("\n")), "no unquoted cell starts with =");
      check("Encoding", row?.[employees.at("Address")] === "Brgy. Santo Niño, ₱ test", "₱ and ñ intact");
      check("Leading zeros", row?.[employees.at("Mobile number")] === "09170000001", "mobile number 09170000001 kept as text");
      check("Is demo", row?.[employees.at("Is demo")] === "Yes" && employees.data.filter((r) => r[employees.at("Is demo")] === "Yes").length === count("select count(*) from profiles where is_demo and lower(role::text) <> 'super_admin'"),
        `Is demo = Yes on exactly the demo people (${employees.data.filter((r) => r[employees.at("Is demo")] === "Yes").length})`);
      const demoFiles = ["users_and_accounts.csv", "employees.csv", "profiles.csv", "attendance_logs.csv", "payroll_entries.csv", "leave_requests.csv"];
      check("Is demo", demoFiles.every((f) => csvOf(zip[f]).header.includes("Is demo")), `"Is demo" column in ${demoFiles.join(", ")}`);
      const logs = csvOf(zip["attendance_logs.csv"]);
      check("Database codes", logs.header.includes("Status (database code)") && logs.data.every((r) => r[logs.at("Status (database code)")] === "" || !/ /.test(r[logs.at("Status (database code)")]) || r[logs.at("Status")] === r[logs.at("Status (database code)")]),
        "statuses in words, and the stored value in the \"(database code)\" column");
      const profiles = csvOf(zip["profiles.csv"]);
      check("Order", profiles.header[0] === "Employee ID" && employees.header.slice(0, 3).join() === "Employee ID,Full name,Branch", `readable first: ${employees.header.slice(0, 3).join(", ")}`);
      const att = csvOf(zip["attendance_logs.csv"]);
      const sample = att.data[0] || [];
      check("Formats", (!sample.length || /^\d{4}-\d{2}-\d{2}$/.test(sample[att.at("Log date")])) && att.data.every((r) => !r[att.at("Time in (Asia/Manila)")] || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r[att.at("Time in (Asia/Manila)")])), "dates YYYY-MM-DD, date-times YYYY-MM-DD HH:MM:SS (Asia/Manila)");
      check("Formats", att.data.every((r) => !r[att.at("Status")] || !/_/.test(r[att.at("Status")])), "statuses as words");
      const pay = csvOf(zip["payroll_entries.csv"]);
      const money = SPOT.map((h) => pay.at(h));
      check("Formats", pay.data.every((r) => money.every((i) => !r[i] || /^-?\d+\.\d{2,}$/.test(r[i]))), "amounts with 2 decimals, no separators or symbol");
    });

    await step(page, "Payslips: 3 per branch, every amount = the stored payslip to the centavo", async () => {
      const pay = csvOf(zip["payroll_entries.csv"]);
      for (const [name] of Object.entries(branches)) {
        const rows = pay.data.filter((r) => r[pay.at("Branch")] === name).slice(0, 3);
        if (!rows.length) { check("Spot check", name !== BRANCH_MAIN && name !== BRANCH_NORTH, `${name}: no payslips`); continue; }
        for (const r of rows) {
          const stored = psql(`select ${STORED} from payroll_entries e where e.id = '${r[pay.at("Payslip UUID")]}'`).split("|");
          const inFile = SPOT.map((h) => r[pay.at(h)]);
          const same = stored.every((v, i) => (v === "" ? inFile[i] === "" : Number(v).toFixed(2) === Number(inFile[i]).toFixed(2) && /^-?\d+\.\d{2}/.test(inFile[i])));
          check("Spot check", same, `${name} ${r[pay.at("Payslip number")]}: ${inFile.join(" / ")}${same ? "" : ` ≠ stored ${stored.join(" / ")}`}`);
        }
      }
      const stale = pay.data.find((r) => r[pay.at("Payslip number")].startsWith("E2E-CSV-"));
      check("Stale columns", stale && Number(stale[pay.at("Gross pay (PHP)")]) > 6000 && stale[pay.at("SSS employer share (PHP)")] === "600.00",
        `a payslip whose amount columns are 0 shows the stored record: gross ${stale?.[pay.at("Gross pay (PHP)")]}, SSS employer ${stale?.[pay.at("SSS employer share (PHP)")]}`);
      check("Stored payslips", count("select count(*) from payroll_entries where payslip_no like 'E2E-CSV-%' and gross_pay = 0") >= 3, "the export changed no stored payslip (columns still 0)");
    });

    await step(page, "Filters: branch + dates; counts = database; names and README say so", async () => {
      const from = "2026-10-01";
      const to = "2026-10-31";
      const filters = { from, to, branch: north };
      const info = (await api(page, "GET", `/api/admin/backup/full?from=${from}&to=${to}&branch=${north}`)).data;
      const res = await post({ groups: ["attendance"], filters });
      const files = unzip(await res.body());
      const name = /filename="([^"]+)"/.exec(res.headers()["content-disposition"])[1];
      check("Filter name", /_north[^_]*_2026-10-01-to-2026-10-31\.zip$/.test(name) || /_2026-10-01-to-2026-10-31\.zip$/.test(name), name);
      const dbAtt = count(`select count(*) from attendance_logs t where coalesce(t.branch_id::text, (select p.branch_id::text from profiles p where p.id = t.employee_id), '') = '${north}' and t.log_date between '${from}' and '${to}'`);
      const att = csvOf(files["attendance_logs.csv"]);
      check("Filtered counts", att.data.length === dbAtt && info.counts.attendance_logs === dbAtt, `attendance_logs North, October: file ${att.data.length} = page ${info.counts.attendance_logs} = database ${dbAtt}`);
      check("Filtered rows", att.data.every((r) => r[att.at("Branch")] === BRANCH_NORTH && r[att.at("Log date")] >= from && r[att.at("Log date")] <= to), "every row is North and in October");
      const readme = files["README.txt"].toString("utf8");
      check("Filter README", readme.includes(`branch = ${BRANCH_NORTH}; dates = ${from} to ${to}`), "README names the filters");
      const listed = readmeOf(readme);
      const mismatched = Object.keys(listed).filter((f) => listed[f].rows !== csvOf(files[f]).data.length || info.counts[f.replace(/\.csv$/, "")] !== listed[f].rows);
      check("Filtered counts", !mismatched.length, mismatched.length ? mismatched.join(", ") : `all ${Object.keys(listed).length} attendance files: file = README = page`);

      const payRes = await post({ groups: ["payroll"], file: "payroll_entries", filters: { branch: north } });
      const pay = csvOf(await payRes.body());
      const dbPay = count(`select count(*) from payroll_entries e where e.branch_id = '${north}'`);
      const infoBranch = (await api(page, "GET", `/api/admin/backup/full?branch=${north}`)).data;
      check("Filtered counts", pay.data.length === dbPay && infoBranch.counts.payroll_entries === dbPay && payRes.headers()["content-type"].startsWith("text/csv"), `payroll_entries North (one CSV): file ${pay.data.length} = page ${infoBranch.counts.payroll_entries} = database ${dbPay}`);
      const users = (await api(page, "GET", `/api/admin/backup/full?branch=${north}`)).data.counts.users;
      check("Filtered counts", users === count(`select count(*) from profiles p where p.branch_id = '${north}'`), `Users North: ${users}`);
      const bad = await api(page, "GET", "/api/admin/backup/full?from=2026-11-02&to=2026-11-01");
      check("Filter validation", bad.status === 400, `To before From refused (${bad.status})`);
    });

    await step(page, "Quick download = the full backup's main CSV; the 6th download within 15 minutes is refused", async () => {
      const card = main(page).locator('[data-testid="backup"]');
      await card.getByRole("button", { name: "Download Payroll (payslips) CSV" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.locator("#backup-password").fill(ACCOUNTS.super_admin.password);
      await dialog.getByRole("checkbox").click();
      const pending = page.waitForEvent("download", { timeout: 120000 });
      await dialog.getByRole("button", { name: "Download" }).click();
      const download = await pending;
      const path = join(OUT, download.suggestedFilename());
      await download.saveAs(path);
      const { readFileSync } = await import("node:fs");
      const quick = csvOf(readFileSync(path));
      const full = csvOf(zip["payroll_entries.csv"]);
      check("Quick download", quick.header.join() === full.header.join() && quick.data.length === full.data.length, `same columns (${quick.header.length}) and rows (${quick.data.length}) as payroll_entries.csv in the ZIP`);

      const used = (await api(page, "GET", "/api/admin/backup/full")).data.limit.used;
      const statuses = [];
      for (let i = used; i <= 5; i += 1) statuses.push((await post({ groups: ["announcements"] })).status());
      check("Rate limit", statuses.slice(0, -1).every((s) => s === 200) && statuses.at(-1) === 429, `${used} used before; then ${statuses.join(", ")} (the 6th refused)`);
      check("Audit", count("select count(*) from audit_logs where action = 'backup_full_download' and created_at > now() - interval '15 minutes'") === 5 && completed() >= 5, "5 downloads in the audit log, each completed");
      const meta = psql("select metadata::text from audit_logs where action = 'backup_full_completed' order by created_at desc limit 1");
      check("Audit", !/'?=1\+1|Santo Niño|09170000001/.test(meta), "the audit log holds counts and checksums, never file contents");
    });

    await step(page, "Phone width: the Backup section fits at 390 px", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await settle(page);
      const card = main(page).locator('[data-testid="backup"]');
      await expect(card.getByTestId("backup-total")).toContainText("rows", { timeout: 60000 });
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: join(OUT, "backup-390.png") });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check("Phone", overflow <= 1, `no sideways scroll (${overflow}px)`);
    });
  } finally {
    const [name, address, cp] = original.split("|");
    psql(`update profiles set full_name = ${name ? `'${name.replace(/'/g, "''")}'` : "null"}, address = ${address ? `'${address.replace(/'/g, "''")}'` : "null"}, cp_number = ${cp ? `'${cp}'` : "null"}, is_demo = false where id = '${employee3.id}'`);
    psql("set session_replication_role = replica; delete from payroll_entries where payslip_no like 'E2E-CSV-%';");
    writeFileSync(join(OUT, "csv-backup-results.json"), JSON.stringify(results, null, 2));
  }
});
