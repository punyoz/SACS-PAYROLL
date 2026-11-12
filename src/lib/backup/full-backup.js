/**
 * The Super Admin's full data backup (Backup & Recovery, 2026-11-08): what
 * goes into the Excel workbook, group by group, and how each sheet is read.
 *
 * Every table is read through public.backup_export_page() (20261108010000),
 * which refuses anyone but an active Super Admin and strips secrets and file
 * blobs, in primary-key order, 1,000 rows at a time -- so a year of
 * attendance for 500+ employees never sits in memory at once.
 *
 * Never in a backup: passwords, password hashes, tokens and API keys (the
 * auth schema is never read; the Users sheet lists named fields only),
 * sign-in code hashes (auth_email_otps), sign-in throttling (auth_throttle),
 * bell notifications, and whole files (license scans, leave proofs, profile
 * photos -- these live in Storage).
 */

import { fetchProfilesPii } from "@/lib/employees/pii";
import { loadSalaryChanges, salaryOn } from "@/lib/employees/salary-history";
import { summarizeLeaveBalance, DEFAULT_ANNUAL_LEAVE_WITH_PAY_DAYS, allotmentForYear, readLeaveWithPayDays } from "@/lib/leave-requests/store";
import { branchPayRates, derivedHourly, loadRateConfigs, resolveRate, resolveRates } from "@/lib/payroll/rates";
import { manilaDateKey, nextPeriod, periodForDateKey } from "@/lib/payroll/periods";
import { loadDemoIds } from "@/lib/demo";

export const PAGE_SIZE = 1000;

/** The groups the Super Admin can download, alone or all together. */
export const BACKUP_GROUPS = Object.freeze([
  {
    key: "users", label: "Users and accounts",
    description: "Every sign-in account: name, role, branch, status, email, created date. No passwords, hashes or tokens.",
    computed: ["users"], tables: [],
  },
  {
    key: "employees", label: "Employees",
    description: "Employee records with salary, daily and hourly rate, contact details, government ID numbers, RFID card, tenure protection and status; salary, status and license history; schedules and transfers.",
    computed: ["employees"],
    tables: ["profiles", "employee_salary_changes", "employee_status_changes", "employee_awol_cases", "employee_license_changes",
      "employee_license_alerts", "employee_license_documents", "tenure_protection_policies", "tenure_protection_grants",
      "tenure_protection_applications", "rfid_cards", "rfid_card_events", "work_schedules", "work_schedule_assignments", "transfer_requests"],
  },
  {
    key: "attendance", label: "Attendance",
    description: "Attendance records, taps, corrections, overtime approvals, holidays, school breaks, holiday duty and Early Bird winners.",
    computed: [],
    tables: ["attendance_logs", "attendance_logs_history", "attendance_taps", "attendance_blocked_taps", "attendance_corrections",
      "attendance_overtime_approvals", "attendance_holidays", "school_break_periods", "holiday_duty_assignments", "holiday_duty_history",
      "holiday_work_reviews", "early_bird_winners"],
  },
  {
    key: "leave", label: "Leave requests and balances",
    description: "Every leave request and each employee's leave balance for this year and last year.",
    computed: ["leave_balances"], tables: ["leave_requests"],
  },
  {
    key: "payroll", label: "Payroll records and payslips",
    description: "Every payslip (amounts exactly as stored), payroll runs, approvals, corrections, overrides, year-end tax and BIR files.",
    computed: [],
    tables: ["payroll_entries", "payroll_records", "payroll_runs", "payroll_run_items", "payroll_run_exclusions", "payroll_approval_history",
      "payroll_corrections", "payroll_final_overrides", "payroll_review_flags", "payroll_tax_annualizations", "payroll_bir_exports"],
  },
  {
    key: "benefits", label: "Loans, advances, incentives, subsidy, 13th month",
    description: "Loans and their payments, cash advances, incentives, deductions, contribution amounts, licensed-teacher subsidy and 13th month pay.",
    computed: [],
    tables: ["payroll_loans", "payroll_loan_payments", "payroll_cash_advances", "payroll_incentives", "payroll_monthly_incentives",
      "payroll_deductions", "payroll_contribution_amounts", "payroll_subsidy_requests", "payroll_subsidy_adjustments",
      "payroll_subsidy_balances", "payroll_subsidy_settings", "payroll_thirteenth_month"],
  },
  {
    key: "rates", label: "Rates and settings",
    description: "Government rate tables, pay rates (daily and the automatic hourly rate, per branch), payslip schedule and system settings.",
    computed: ["pay_rates"],
    tables: ["payroll_rate_configs", "payroll_tax_brackets", "payroll_sss_msc_brackets", "payroll_schedule_settings",
      "payroll_setting_changes", "payroll_window_enforcement", "payroll_window_enforcement_changes", "system_config"],
  },
  {
    key: "branches", label: "Branches, roles and permissions",
    description: "Branches, the role and permission matrix, branch assignments, branch requests and RFID terminals.",
    computed: [],
    tables: ["branches", "role_permissions", "employee_branch_assignments", "branch_admin_requests", "rfid_terminals"],
  },
  {
    key: "announcements", label: "Announcements",
    description: "Every announcement, deleted ones included.",
    computed: [], tables: ["branch_announcements"],
  },
  {
    key: "audit", label: "Audit logs",
    description: "Every audit log entry (who did what, when).",
    computed: [], tables: ["audit_logs"],
  },
]);

export const BACKUP_GROUP_KEYS = BACKUP_GROUPS.map((g) => g.key);

/** Left out of every backup, and why (shown in the workbook and on the page). */
export const BACKUP_EXCLUSIONS = Object.freeze([
  ["Passwords, password hashes, sign-in tokens, API keys", "Security secrets. Never read: the auth schema is not exported; the Users sheet has named fields only."],
  ["auth_email_otps (sign-in codes)", "One-time code hashes; security secrets that expire in minutes."],
  ["auth_throttle (sign-in throttling)", "Short-lived counters; rebuilt automatically."],
  ["notifications (bell messages)", "Copies of events already in the other tables; regenerated by the app."],
  ["License scans (employee_license_documents.data_url)", "Whole image files; far beyond an Excel cell. The file names and dates are kept."],
  ["Leave proof files (leave_requests.proof_url, leave-proofs bucket)", "Whole files; kept in Supabase Storage, not in the database rows. The proof path is kept."],
  ["Profile photos", "Files in Supabase Storage. The photo path is kept."],
  ["Encrypted ID columns (*_enc)", "Replaced by the decrypted numbers in the Employees sheet."],
  ["Demo people (profiles.is_demo) and their rows", "Demo data from the demo seed; never part of a real backup (decided 2026-11-08)."],
]);

/** JSON columns that can be long: spread over several cells instead of being cut. */
const PARTS = {
  "payroll_entries.payroll": 4,
  "payroll_records.rate_version_snapshot": 2,
  "payroll_records.attendance_snapshot": 2,
  "payroll_records.deviations": 2,
  "payroll_run_items.breakdown": 2,
  "payroll_bir_exports.rows": 4,
  "audit_logs.metadata": 2,
};

/** Validated group keys; empty or "all" = every group. */
export function pickGroups(requested) {
  const list = Array.isArray(requested) ? requested.map(String) : [];
  if (!list.length || list.includes("all")) return BACKUP_GROUPS;
  const unknown = list.filter((key) => !BACKUP_GROUP_KEYS.includes(key));
  if (unknown.length) throw Object.assign(new Error(`Unknown backup group: ${unknown.join(", ")}.`), { status: 400 });
  return BACKUP_GROUPS.filter((g) => list.includes(g.key));
}

/** One page of a table, through the Super Admin-only database function. */
async function readPage(supabase, actorId, table, after) {
  const { data, error } = await supabase.rpc("backup_export_page", { p_actor: actorId, p_table: table, p_after: after, p_limit: PAGE_SIZE });
  if (error) throw Object.assign(new Error(`Could not read ${table}: ${error.message}`), { status: /forbidden/.test(error.message) ? 403 : 500 });
  return data || [];
}

/** Every row of a table, page by page (async). */
export async function* tableRows(supabase, actorId, table) {
  let after = null;
  for (;;) {
    const page = await readPage(supabase, actorId, table, after);
    for (const row of page) yield row.row_data;
    if (page.length < PAGE_SIZE) return;
    after = page[page.length - 1].row_key;
  }
}

/**
 * Exact row counts (for the progress bar, and checked against the file), in
 * one database call (one call per table failed under load, 2026-11-08). A
 * dropped connection is tried once more.
 */
export async function countTables(supabase, actorId, tables) {
  let result;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    result = await supabase.rpc("backup_export_counts", { p_actor: actorId, p_tables: tables });
    if (!result.error || /forbidden/.test(result.error.message)) break;
    console.error(`[backup] row counts failed (attempt ${attempt}): ${result.error.message}`);
  }
  if (result.error) throw Object.assign(new Error(`Could not count the tables: ${result.error.message}`), { status: /forbidden/.test(result.error.message) ? 403 : 500 });
  const counts = Object.fromEntries(tables.map((t) => [t, 0]));
  (result.data || []).forEach((row) => { counts[row.table_name] = Number(row.row_count) || 0; });
  return counts;
}

const widthFor = (key) => (/(_id|^id)$/.test(key) ? 38 : /(_at|date|_on)$/.test(key) ? 22 : /(json|payroll|metadata|description|body|reason|note)/.test(key) ? 48 : 18);

/** A raw table as a sheet: its own columns, in its own order. */
export async function tableSheet(supabase, actorId, table) {
  const first = await readPage(supabase, actorId, table, null);
  const keys = first.length ? Object.keys(first[0].row_data) : ["(no rows)"];
  const columns = keys.map((key) => ({ header: key, width: widthFor(key), parts: PARTS[`${table}.${key}`] || 1 }));
  async function* rows() {
    let page = first;
    for (;;) {
      for (const row of page) yield keys.map((key) => row.row_data[key]);
      if (page.length < PAGE_SIZE) return;
      page = await readPage(supabase, actorId, table, page[page.length - 1].row_key);
    }
  }
  return { key: table, name: table, columns, rows: rows() };
}

/** Everything the computed sheets share, read once. */
export async function loadContext(supabase, actorId) {
  const profiles = [];
  for await (const row of tableRows(supabase, actorId, "profiles")) profiles.push(row);
  const branches = [];
  for await (const row of tableRows(supabase, actorId, "branches")) branches.push(row);
  // Demo people (is_demo, 2026-11-08) are already out of the tables; the
  // Users sheet reads the sign-in list, so it skips them by id.
  const demoIds = await loadDemoIds(supabase);
  return { profiles, branches, demoIds, branchNames: new Map(branches.map((b) => [String(b.id), b.name])) };
}

const statusOf = (p) => (p.archived ? "Archived" : p.separated_on ? `Separated ${p.separated_on}` : "Active");
const fullName = (p) => p.full_name || [p.first_name, p.middle_name, p.last_name, p.suffix].filter(Boolean).join(" ") || p.email || "";

/** Users and accounts: named fields only (never a password, hash or token). */
export async function usersSheet(supabase, context) {
  const byId = new Map(context.profiles.map((p) => [p.id, p]));
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Could not list sign-in accounts: ${error.message}`);
    const list = data?.users || [];
    // Only these fields are taken from each auth user.
    list.filter((u) => !context.demoIds?.has(String(u.id))).forEach((u) => users.push({ id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at, email_confirmed_at: u.email_confirmed_at, banned_until: u.banned_until || null }));
    if (list.length < 1000) break;
  }
  const seen = new Set(users.map((u) => u.id));
  context.profiles.filter((p) => !seen.has(p.id)).forEach((p) => users.push({ id: p.id, email: p.email, created_at: p.created_at, missing_login: true }));
  const columns = ["User ID", "Full name", "Email", "Role", "Branch", "Status", "Employee ID", "Account created", "Last sign-in", "Email confirmed", "Sign-in blocked until", "Note"]
    .map((header) => ({ header, width: header === "User ID" ? 38 : 22 }));
  function* rows() {
    for (const u of users) {
      const p = byId.get(u.id) || {};
      yield [u.id, fullName(p), u.email || p.email || "", p.role || "", context.branchNames.get(String(p.branch_id || "")) || (p.branch_id ? "Unknown branch" : ""),
        p.id ? statusOf(p) : "No profile", p.employee_id || p.staff_id || "", u.created_at || "", u.last_sign_in_at || "", u.email_confirmed_at ? "Yes" : "No",
        u.banned_until || "", u.missing_login ? "Profile without a sign-in account" : ""];
    }
  }
  return { key: "users", name: "Users and accounts", columns, rows: rows() };
}

/** Employees: one row per person, everything needed to rebuild the record. */
export async function employeesSheet(supabase, actorId, context) {
  const today = manilaDateKey();
  const periodStart = periodForDateKey(today).start_key;
  const people = context.profiles.filter((p) => String(p.role || "").toLowerCase() !== "super_admin");
  const ids = people.map((p) => p.id);
  const [{ configs }, salary, cards, grants] = await Promise.all([
    loadRateConfigs(supabase),
    loadSalaryChanges(supabase, ids).catch(() => ({ rows: [] })),
    (async () => { const out = []; for await (const r of tableRows(supabase, actorId, "rfid_cards")) out.push(r); return out; })(),
    (async () => { const out = []; for await (const r of tableRows(supabase, actorId, "tenure_protection_grants")) out.push(r); return out; })(),
  ]);
  const pii = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const part = await fetchProfilesPii(supabase, ids.slice(i, i + 200));
    part.forEach((value, key) => pii.set(key, value));
  }
  const cardOf = new Map();
  cards.sort((a, b) => String(a.registered_at || "").localeCompare(String(b.registered_at || ""))).forEach((c) => {
    const prior = cardOf.get(c.employee_id);
    if (!prior || c.status === "active" || prior.status !== "active") cardOf.set(c.employee_id, c);
  });
  const grantOf = new Map();
  grants.forEach((g) => { if (!g.revoked_on) grantOf.set(g.employee_id, g); });

  const headers = [
    ["Employee ID", 14], ["Full name", 28], ["First name", 16], ["Middle name", 14], ["Last name", 16], ["Suffix", 8], ["Role", 12],
    ["Employee type", 14], ["Level", 12], ["Position", 22], ["Branch", 22], ["Record status", 18], ["Employment status", 16],
    ["Date hired", 12], ["Separated on", 12], ["Separation reason", 22], ["Monthly salary", 14, "money"], ["Daily rate", 12, "money"],
    ["Hourly rate (daily ÷ 8)", 14, "money"], ["Rate source", 26], ["Email", 28], ["Mobile number", 16], ["Address", 32],
    ["Emergency contact", 22], ["Emergency relationship", 16], ["Emergency number", 16], ["Emergency address", 28],
    ["TIN", 16], ["SSS number", 16], ["PhilHealth number", 18], ["Pag-IBIG number", 18], ["Licensed teacher", 10],
    ["PRC license (last 4)", 12], ["License expires", 12], ["RFID card UID", 18], ["RFID card status", 12],
    ["Tenure protection", 22], ["Payroll hold", 10], ["Payroll hold reason", 22], ["Profile ID", 38],
  ];
  const columns = headers.map(([header, width, kind]) => ({ header, width, money: kind === "money" }));
  function* rows() {
    for (const p of people) {
      const monthly = salaryOn(salary.rows || [], p.id, today, Number(p.basic_salary) || 0);
      const rates = resolveRates(configs, { employeeId: p.id, branchId: p.branch_id, position: p.position, monthlySalary: monthly }, periodStart);
      const ids4 = pii.get(p.id) || {};
      const card = cardOf.get(p.id);
      const grant = grantOf.get(p.id);
      yield [
        p.employee_id || p.staff_id || "", fullName(p), p.first_name || "", p.middle_name || "", p.last_name || "", p.suffix || "", p.role || "",
        p.employee_type || "", p.employee_level || "", p.position || "", context.branchNames.get(String(p.branch_id || "")) || "",
        statusOf(p), p.employee_status || "", p.date_hired || "", p.separated_on || "", p.separation_reason || "",
        monthly || 0, Number(rates.daily.value) || 0, Number(rates.hourly.value) || 0,
        rates.daily.source === "salary" ? "Salary × 12 ÷ working days" : `${rates.daily.scope} rate${rates.daily.source === "default" ? " (built-in)" : ""}`,
        p.email || "", p.cp_number || "", p.address || "", p.emergency_contact_name || "", p.emergency_contact_relationship || "",
        p.emergency_contact_number || "", p.emergency_contact_address || "",
        ids4.tin_number || "", ids4.sss_number || "", ids4.philhealth_number || "", ids4.pagibig_number || "",
        p.is_licensed_teacher ? "Yes" : "No", p.prc_license_no_last4 || "", p.license_expires_on || "",
        card?.uid || "", card?.status || "", grant ? `Granted from ${grant.effective_from}` : "Not granted",
        p.payroll_hold ? "Yes" : "No", p.payroll_hold_reason || "", p.id,
      ];
    }
  }
  return { key: "employees", name: "Employees", columns, rows: rows() };
}

/** Leave balances: this year and last year, per employee (approved leave only). */
export async function leaveBalancesSheet(supabase, actorId, context) {
  const requests = [];
  for await (const row of tableRows(supabase, actorId, "leave_requests")) {
    requests.push({ ...row, status: String(row.status || "").toLowerCase(), pay_status: String(row.pay_status || "").toLowerCase().includes("without") ? "without_pay" : String(row.pay_status || "").toLowerCase().includes("with") ? "with_pay" : row.pay_status });
  }
  const year = Number(manilaDateKey().slice(0, 4));
  const setting = await readLeaveWithPayDays(supabase);
  const people = context.profiles.filter((p) => !["super_admin"].includes(String(p.role || "").toLowerCase()));
  const columns = ["Employee ID", "Full name", "Branch", "Year", "Leave with pay allotment", "Leave with pay used", "Leave with pay remaining", "Leave without pay used"]
    .map((header, i) => ({ header, width: i < 3 ? 24 : 14, integer: i >= 3 }));
  function* rows() {
    for (const y of [year, year - 1]) {
      for (const p of people) {
        const b = summarizeLeaveBalance(requests, p.id, y, allotmentForYear(y, setting));
        yield [p.employee_id || p.staff_id || "", fullName(p), context.branchNames.get(String(p.branch_id || "")) || "", y,
          b.with_pay_allotment ?? DEFAULT_ANNUAL_LEAVE_WITH_PAY_DAYS, b.with_pay_used, b.with_pay_remaining, b.without_pay_used];
      }
    }
  }
  return { key: "leave_balances", name: "Leave balances", columns, rows: rows() };
}

/** Pay rates as payroll uses them now: default and per branch, daily and hourly (÷ 8). */
export async function payRatesSheet(supabase, context) {
  const { configs } = await loadRateConfigs(supabase);
  const today = manilaDateKey();
  const current = periodForDateKey(today);
  const upcoming = nextPeriod(today);
  const dailyNow = resolveRate(configs, "daily", {}, current.start_key);
  const dailyNext = resolveRate(configs, "daily", {}, upcoming.start_key);
  const columns = ["Applies to", "Daily rate (this period)", "Hourly rate (this period, daily ÷ 8)", "Effective", "Daily rate (next period)", "Hourly rate (next period)", "Uses system default"]
    .map((header, i) => ({ header, width: i === 0 ? 26 : 18, money: [1, 2, 4, 5].includes(i) }));
  function* rows() {
    yield ["System default", dailyNow.value, derivedHourly(dailyNow).value, dailyNow.effective_date || "built-in", dailyNext.value, derivedHourly(dailyNext).value, "—"];
    for (const b of branchPayRates(configs, context.branches, current.start_key, upcoming.start_key)) {
      yield [b.name, b.current.value, b.hourly_current, b.current.effective_date || "built-in", b.next_period.value, b.hourly_next, b.uses_default ? "Yes" : "No"];
    }
  }
  return { key: "pay_rates", name: "Pay rates (now)", columns, rows: rows() };
}

/** The first sheet: what this file is, and what it is not. */
export function aboutSheet({ generatedAt, actorName, environment, groups, label }) {
  const columns = [{ header: "Item", width: 34 }, { header: "Details", width: 110 }];
  const lines = [
    ["File", `SACS Payroll data backup${label ? ` — ${label}` : ""}`],
    ["Generated", generatedAt],
    ["Generated by", actorName],
    ["Environment", environment === "production" ? "Production (real data)" : `${environment.toUpperCase()} — NOT real data`],
    ["Groups", groups.map((g) => g.label).join("; ")],
    ["Branches", "All branches"],
    ["Privacy", "Contains salary and personal data, including government ID numbers (Data Privacy Act of 2012). Store it encrypted and offline; never email or share it."],
    ["Amounts", "Exactly as stored in the database. Each table sheet keeps the database column names."],
    ["Row counts", "See the last sheet, \"Row counts\": rows per sheet, checked against the database when the file was made."],
    ["Demo data", "Demo people (profiles.is_demo, set only by the demo seed) and every row that belongs to them are left out. Test files are also labelled by environment."],
    ["Restore", "These sheets rebuild data row by row after a loss (with the database column names, ready to import). They do NOT restore sign-in accounts or passwords, files in Storage (photos, leave proofs, license scans) or the database structure."],
    ...BACKUP_EXCLUSIONS.map(([what, why]) => [`Not included: ${what}`, why]),
  ];
  return { key: "about", name: "About this backup", columns, rows: lines };
}

/** The last sheet: rows written per sheet against the database count. */
export function countsSheet(written, expected) {
  const columns = [{ header: "Sheet", width: 34 }, { header: "Table", width: 34 }, { header: "Rows in file", width: 14, integer: true }, { header: "Rows in database", width: 16, integer: true }, { header: "Match", width: 10 }];
  const SHEET_OF = { users: "Users and accounts", employees: "Employees", leave_balances: "Leave balances", pay_rates: "Pay rates (now)" };
  const rows = written.filter((s) => s.source !== "about").map((s) => {
    const db = expected[s.source];
    const sheet = SHEET_OF[s.source] || String(s.source).slice(0, 31);
    return [sheet, s.source, s.rows, db ?? "", db === undefined ? "computed" : db === s.rows ? "Yes" : "NO"];
  });
  return { key: "row_counts", name: "Row counts", columns, rows };
}
