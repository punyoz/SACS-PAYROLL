/**
 * The Super Admin's data backup (Backup & Recovery; CSV since 2026-11-15):
 * the groups, and what goes into each group's CSV files. The CSV format
 * itself is src/lib/backup/csv-backup.js.
 *
 * Every table is read through public.backup_export_page() (20261108010000),
 * which refuses anyone but an active Super Admin and strips secrets and file
 * blobs, in primary-key order, 1,000 rows at a time -- so a year of
 * attendance for 500+ employees never sits in memory at once.
 *
 * Never in a backup: passwords, password hashes, tokens and API keys (the
 * auth schema is never read; the Users file lists named fields only),
 * sign-in code hashes (auth_email_otps), sign-in throttling (auth_throttle),
 * bell notifications, and whole files (license scans, leave proofs, profile
 * photos -- these live in Storage).
 */

import { fetchProfilesPii } from "@/lib/employees/pii";
import { loadSalaryChanges, salaryOn } from "@/lib/employees/salary-history";
import { summarizeLeaveBalance, DEFAULT_ANNUAL_LEAVE_WITH_PAY_DAYS, allotmentForYear, readLeaveWithPayDays } from "@/lib/leave-requests/store";
import { leaveBalances } from "@/lib/employees/classification-server";
import { branchPayRates, derivedHourly, loadRateConfigs, resolveRate, resolveRates } from "@/lib/payroll/rates";
import { manilaDateKey, nextPeriod, periodForDateKey } from "@/lib/payroll/periods";
import { loadDemoIds } from "@/lib/demo";
import { PAYSLIP_COLUMNS, dateFilterHeader, hasFilters, preparePayslip, rowMatches, tableColumns, words } from "./csv-backup";

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
    description: "Employee records with salary, daily and hourly rate, contact details, government ID numbers, RFID card, tenure protection and status; salary, status and license history; schedules, transfers and the positions list; category, status and type history and HR reminders.",
    computed: ["employees"],
    tables: ["profiles", "employee_salary_changes", "employee_status_changes", "employee_awol_cases", "employee_license_changes",
      "employee_license_alerts", "employee_license_documents", "tenure_protection_policies", "tenure_protection_grants",
      "tenure_protection_applications", "rfid_cards", "rfid_card_events", "work_schedules", "work_schedule_assignments", "transfer_requests",
      "employee_positions", "employee_classification_changes", "employee_hr_reminders"],
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
    description: "Every leave request, each employee's leave balance for this year and last year, the leave credit rules and overrides, and the statutory leave settings.",
    computed: ["leave_balances"], tables: ["leave_requests", "overtime_requests", "substitutions", "leave_credit_rules", "leave_credit_overrides", "statutory_leave_types"],
  },
  {
    key: "payroll", label: "Payroll records and payslips",
    description: "Every payslip (amounts exactly as stored), payroll runs, approvals, corrections, overrides, year-end tax and BIR files.",
    computed: [],
    tables: ["payroll_entries", "payroll_records", "payroll_runs", "payroll_run_items", "payroll_run_exclusions", "payroll_approval_history",
      "payroll_corrections", "payroll_final_overrides", "payroll_review_flags", "payroll_tax_annualizations", "payroll_bir_exports",
      "payroll_final_pay_submissions"],
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
      "payroll_setting_changes", "payroll_window_enforcement", "payroll_window_enforcement_changes", "system_config", "employee_pay_rules", "remark_presets"],
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
  ["Passwords, password hashes, sign-in tokens, API keys", "Security secrets. Never read: the auth schema is not exported; the Users file has named fields only."],
  ["auth_email_otps (sign-in codes)", "One-time code hashes; security secrets that expire in minutes."],
  ["auth_throttle (sign-in throttling)", "Short-lived counters; rebuilt automatically."],
  ["notifications (bell messages)", "Copies of events already in the other tables; regenerated by the app."],
  ["hr_queue_claims, notification_channels", "Not backed up: temporary or rebuildable (HR's short-lived queue claims; realtime topics the app recreates)."],
  ["License scans (employee_license_documents.data_url)", "Whole image files, not table data. The file names and dates are kept."],
  ["Leave proof files (leave_requests.proof_url, leave-proofs bucket)", "Whole files; kept in Supabase Storage, not in the database rows. The proof path is kept."],
  ["Profile photos", "Files in Supabase Storage. The photo path is kept."],
  ["Encrypted ID columns (*_enc)", "Replaced by the decrypted numbers in employees.csv."],
]);

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


/** Everything the computed files share, read once. */
export async function loadContext(supabase, actorId) {
  const profiles = [];
  for await (const row of tableRows(supabase, actorId, "profiles")) profiles.push(row);
  const branches = [];
  for await (const row of tableRows(supabase, actorId, "branches")) branches.push(row);
  // Demo people are included while the demo data is live (2026-11-15); every
  // file with a person in it says which rows are demo ("Is demo").
  const demoIds = await loadDemoIds(supabase);
  const byId = new Map(profiles.map((p) => [String(p.id), { code: p.employee_id || p.staff_id || "", name: fullName(p), branch_id: p.branch_id ?? null, role: p.role || "" }]));
  const branchNames = new Map(branches.map((b) => [String(b.id), b.name]));
  return {
    profiles, branches, demoIds, branchNames,
    profile: (id) => (id ? byId.get(String(id)) : undefined),
    isDemo: (id) => Boolean(id) && demoIds.has(String(id)),
    branchName: (id) => (id ? branchNames.get(String(id)) || "Unknown branch" : ""),
  };
}

const statusOf = (p) => (p.archived ? "Archived" : p.separated_on ? `Separated ${p.separated_on}` : "Active");
const fullName = (p) => p.full_name || [p.first_name, p.middle_name, p.last_name, p.suffix].filter(Boolean).join(" ") || p.email || "";
const inBranch = (filters, branchId) => !filters?.branch || String(branchId || "") === filters.branch;
const col = (header, kind = "text", meaning = "") => ({ header, kind, meaning });
const DEMO = "Yes for a demo person (from the demo seed). Filter on No to leave demo data out.";

/** Everyone the backup lists as a person (not the Super Admin), in the branch filter. */
export const peopleOf = (context, filters) => context.profiles.filter((p) => String(p.role || "").toLowerCase() !== "super_admin" && inBranch(filters, p.branch_id));

/**
 * Users and accounts: every sign-in account (demo ones included) plus any
 * profile without one. Only these named fields are taken from each auth user.
 */
export async function listAccounts(supabase, context, filters) {
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Could not list sign-in accounts: ${error.message}`);
    const list = data?.users || [];
    list.forEach((u) => users.push({ id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at, email_confirmed_at: u.email_confirmed_at, banned_until: u.banned_until || null }));
    if (list.length < 1000) break;
  }
  const seen = new Set(users.map((u) => u.id));
  context.profiles.filter((p) => !seen.has(p.id)).forEach((p) => users.push({ id: p.id, email: p.email, created_at: p.created_at, missing_login: true }));
  const byId = new Map(context.profiles.map((p) => [p.id, p]));
  return users.filter((u) => inBranch(filters, byId.get(u.id)?.branch_id));
}

export function usersFile(context, accounts) {
  const byId = new Map(context.profiles.map((p) => [p.id, p]));
  const columns = [
    col("Employee ID", "text", "Readable employee or staff number."), col("Full name"), col("Role", "label"), col("Branch"), col("Is demo", "bool", DEMO), col("Status", "text", "Active, Archived or Separated (with the date)."),
    col("Email"), col("Account created (Asia/Manila)", "tstz"), col("Last sign-in (Asia/Manila)", "tstz"), col("Email confirmed", "bool"),
    col("Sign-in blocked until (Asia/Manila)", "tstz"), col("Note"), col("User UUID", "uuid", "Sign-in account ID = Employee profile UUID in the other files."), col("Branch UUID", "uuid"),
  ];
  function* rows() {
    for (const u of accounts) {
      const p = byId.get(u.id) || {};
      yield [p.employee_id || p.staff_id || "", fullName(p), p.role || "", context.branchName(p.branch_id), context.isDemo(u.id), p.id ? statusOf(p) : "No profile",
        u.email || p.email || "", u.created_at || "", u.last_sign_in_at || "", Boolean(u.email_confirmed_at), u.banned_until || "",
        u.missing_login ? "Profile without a sign-in account" : "", u.id, p.branch_id || ""];
    }
  }
  return { key: "users", name: "users_and_accounts.csv", title: "Users and accounts", description: "Every sign-in account. No passwords, hashes or tokens.", columns, rows: rows() };
}

/** Employees: one row per person, everything needed to rebuild the record. */
export async function employeesFile(supabase, actorId, context, filters) {
  const today = manilaDateKey();
  const periodStart = periodForDateKey(today).start_key;
  const people = peopleOf(context, filters);
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

  const columns = [
    col("Employee ID", "text", "Readable employee number (for example SACS-001)."), col("Full name"), col("Branch"), col("Is demo", "bool", DEMO), col("First name"), col("Middle name"), col("Last name"), col("Suffix"),
    col("Role", "label"), col("Category", "label"), col("Level", "label"), col("Position"), col("Record status", "text", "Active, Archived or Separated (with the date)."),
    col("Employment status", "label"), col("Date hired", "date"), col("Separated on", "date"), col("Separation reason"),
    col("Monthly salary (PHP, as of export date)", "money", "Salary in force on the export date (salary history applied)."),
    col("Daily rate (PHP, as of export date)", "money", "Daily rate payroll uses for this pay period."),
    col("Hourly rate (PHP, daily ÷ 8, as of export date)", "money", "Always the daily rate ÷ 8."),
    col("Rate source", "text", "Where the daily rate comes from."),
    col("Email"), col("Mobile number"), col("Address"), col("Emergency contact"), col("Emergency relationship"), col("Emergency number"), col("Emergency address"),
    col("TIN", "text", "As stored, leading zeros kept."), col("SSS number", "text", "As stored, leading zeros kept."), col("PhilHealth number", "text", "As stored, leading zeros kept."),
    col("Pag-IBIG number", "text", "As stored, leading zeros kept."), col("Licensed teacher", "bool"), col("PRC license (last 4)"), col("License expires", "date"),
    col("RFID card UID", "text", "Full card UID, as stored."), col("RFID card status", "label"), col("Tenure protection"), col("Payroll hold", "bool"), col("Payroll hold reason"),
    col("Employee profile UUID", "uuid", "Links to every file with an Employee profile UUID."), col("Branch UUID", "uuid"),
  ];
  function* rows() {
    for (const p of people) {
      const monthly = salaryOn(salary.rows || [], p.id, today, Number(p.basic_salary) || 0);
      const rates = resolveRates(configs, { employeeId: p.id, branchId: p.branch_id, position: p.position, monthlySalary: monthly }, periodStart);
      const ids4 = pii.get(p.id) || {};
      const card = cardOf.get(p.id);
      const grant = grantOf.get(p.id);
      yield [
        p.employee_id || p.staff_id || "", fullName(p), context.branchName(p.branch_id), context.isDemo(p.id), p.first_name || "", p.middle_name || "", p.last_name || "", p.suffix || "",
        p.role || "", p.employee_type || "", p.employee_level || "", p.position || "", statusOf(p), p.employee_status || "", p.date_hired || "",
        p.separated_on || "", p.separation_reason || "", monthly || 0, Number(rates.daily.value) || 0, Number(rates.hourly.value) || 0,
        rates.daily.source === "salary" ? "Salary × 12 ÷ working days" : `${rates.daily.scope} rate${rates.daily.source === "default" ? " (built-in)" : ""}`,
        p.email || "", p.cp_number || "", p.address || "", p.emergency_contact_name || "", p.emergency_contact_relationship || "",
        p.emergency_contact_number || "", p.emergency_contact_address || "",
        ids4.tin_number || "", ids4.sss_number || "", ids4.philhealth_number || "", ids4.pagibig_number || "",
        Boolean(p.is_licensed_teacher), p.prc_license_no_last4 || "", p.license_expires_on || "",
        card?.uid || "", card?.status || "", grant ? `Granted from ${grant.effective_from}` : "Not granted",
        Boolean(p.payroll_hold), p.payroll_hold_reason || "", p.id, p.branch_id || "",
      ];
    }
  }
  return { key: "employees", name: "employees.csv", title: "Employees", description: "One row per person with salary, rates, contact details and government ID numbers (decrypted).", columns, rows: rows() };
}

/** Leave balances: this year and last year, per employee (approved leave only). */
export async function leaveBalancesFile(supabase, actorId, context, filters) {
  const requests = [];
  for await (const row of tableRows(supabase, actorId, "leave_requests")) {
    requests.push({ ...row, status: String(row.status || "").toLowerCase(), pay_status: String(row.pay_status || "").toLowerCase().includes("without") ? "without_pay" : String(row.pay_status || "").toLowerCase().includes("with") ? "with_pay" : row.pay_status });
  }
  const year = Number(manilaDateKey().slice(0, 4));
  const setting = await readLeaveWithPayDays(supabase);
  const people = peopleOf(context, filters);
  // From 2026: per leave type, from the classification rules (20261121010000); before: the one yearly pool.
  const perType = {};
  for (const y of [year, year - 1]) if (y >= 2026) perType[y] = await leaveBalances(supabase, people.map((p) => p.id), y, { requests });
  const columns = [col("Employee ID"), col("Full name"), col("Branch"), col("Is demo", "bool", DEMO), col("Year", "int"), col("Leave with pay allotment (days)", "num"), col("Leave with pay used (days)", "num"),
    col("Leave with pay remaining (days)", "num"), col("Leave without pay used (days)", "num"), col("Employee profile UUID", "uuid")];
  function* rows() {
    for (const y of [year, year - 1]) {
      for (const p of people) {
        const b = perType[y]?.[p.id] || summarizeLeaveBalance(requests, p.id, y, allotmentForYear(y, setting));
        yield [p.employee_id || p.staff_id || "", fullName(p), context.branchName(p.branch_id), context.isDemo(p.id), y,
          b.with_pay_allotment ?? DEFAULT_ANNUAL_LEAVE_WITH_PAY_DAYS, b.with_pay_used, b.with_pay_remaining, b.without_pay_used, p.id];
      }
    }
  }
  return { key: "leave_balances", name: "leave_balances.csv", title: "Leave balances", description: `This year and last year (${year} and ${year - 1}), approved leave only. Not filtered by date.`, columns, rows: rows() };
}

/** Pay rates as payroll uses them now: default and per branch, daily and hourly (÷ 8). */
export async function payRatesFile(supabase, context, filters) {
  const { configs } = await loadRateConfigs(supabase);
  const today = manilaDateKey();
  const current = periodForDateKey(today);
  const upcoming = nextPeriod(today);
  const dailyNow = resolveRate(configs, "daily", {}, current.start_key);
  const dailyNext = resolveRate(configs, "daily", {}, upcoming.start_key);
  const columns = [col("Applies to"), col("Daily rate this period (PHP)", "money"), col("Hourly rate this period (PHP, daily ÷ 8)", "money"), col("Effective from"),
    col("Daily rate next period (PHP)", "money"), col("Hourly rate next period (PHP, daily ÷ 8)", "money"), col("Uses system default", "bool"), col("Branch UUID", "uuid")];
  const branches = context.branches.filter((b) => !filters?.branch || String(b.id) === filters.branch);
  function* rows() {
    yield ["System default", dailyNow.value, derivedHourly(dailyNow).value, dailyNow.effective_date || "built-in", dailyNext.value, derivedHourly(dailyNext).value, null, ""];
    for (const b of branchPayRates(configs, branches, current.start_key, upcoming.start_key)) {
      yield [b.name, b.current.value, b.hourly_current, b.current.effective_date || "built-in", b.next_period.value, b.hourly_next, b.uses_default, b.branch_id];
    }
  }
  return { key: "pay_rates", name: "pay_rates.csv", title: "Pay rates (now)", description: "The system default and each branch's daily and hourly rate, this period and next.", columns, rows: rows() };
}

/* ── Files of the chosen groups ───────────────────────────────────────── */

/** Each group's main file: the quick shortcuts on the page. */
export const MAIN_FILE = { users: "users", employees: "employees", attendance: "attendance_logs", leave: "leave_requests", payroll: "payroll_entries", announcements: "branch_announcements", audit: "audit_logs" };

const COMPUTED = ["users", "employees", "leave_balances", "pay_rates"];
const TITLES = { payroll_entries: "Payslips" };

/** The file keys of the groups, in file order (computed first, as on the page). */
export const fileKeysOf = (groups) => groups.flatMap((g) => [...g.computed, ...g.tables]);

/** Rows of one table, as CSV values, filtered. */
async function* tableValues(supabase, actorId, table, columns, filters, context) {
  for await (const raw of tableRows(supabase, actorId, table)) {
    const row = table === "payroll_entries" ? preparePayslip(raw) : raw;
    if (!rowMatches(table, row, filters, context)) continue;
    yield columns.map((c) => c.get(row, context));
  }
}

/** One table as a file. The columns come from the schema (and the first row, for a newer column). */
export async function tableFile(supabase, actorId, table, filters, context) {
  let columns = PAYSLIP_COLUMNS;
  if (table !== "payroll_entries") {
    const firstPage = await readPage(supabase, actorId, table, null);
    columns = tableColumns(table, firstPage[0]?.row_data || null);
  }
  return {
    key: table, name: `${table}.csv`, title: TITLES[table] || words(table),
    description: table === "payroll_entries" ? "Every payslip; amounts exactly as stored on the payslip record." : `The ${table} table, as stored.`,
    dateFilter: dateFilterHeader(table), columns, rows: tableValues(supabase, actorId, table, columns, filters, context),
  };
}

/** Every file of the chosen keys, one at a time (async). */
export async function* backupFiles(supabase, actorId, keys, filters, context) {
  for (const key of keys) {
    if (key === "users") yield usersFile(context, await listAccounts(supabase, context, filters));
    else if (key === "employees") yield await employeesFile(supabase, actorId, context, filters);
    else if (key === "leave_balances") yield await leaveBalancesFile(supabase, actorId, context, filters);
    else if (key === "pay_rates") yield await payRatesFile(supabase, context, filters);
    else yield await tableFile(supabase, actorId, key, filters, context);
  }
}

/**
 * Rows per file key, as the files will hold them. Tables without filters:
 * the database's count (backup_export_counts, demo rows excluded as in the
 * file). With filters, each table is read and filtered as the download does.
 * shortcut: a filtered count reads the whole table; fine at school scale
 * (tens of thousands of rows), move the filter into SQL past ~1M rows.
 */
export async function countFiles(supabase, actorId, keys, filters, context) {
  const counts = {};
  const tables = keys.filter((k) => !COMPUTED.includes(k));
  if (!hasFilters(filters)) Object.assign(counts, await countTables(supabase, actorId, tables));
  else {
    for (const table of tables) {
      let n = 0;
      for await (const raw of tableRows(supabase, actorId, table)) {
        if (rowMatches(table, table === "payroll_entries" ? preparePayslip(raw) : raw, filters, context)) n += 1;
      }
      counts[table] = n;
    }
  }
  if (keys.includes("users")) counts.users = (await listAccounts(supabase, context, filters)).length;
  if (keys.includes("employees")) counts.employees = peopleOf(context, filters).length;
  if (keys.includes("leave_balances")) counts.leave_balances = peopleOf(context, filters).length * 2;
  if (keys.includes("pay_rates")) counts.pay_rates = 1 + context.branches.filter((b) => !filters?.branch || String(b.id) === filters.branch).length;
  return counts;
}
