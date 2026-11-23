/**
 * The Super Admin's CSV backup (Backup & Recovery, 2026-11-15): one format
 * for every file, from "Download everything" down to one table.
 *
 *   - UTF-8 with a BOM, comma separated, one header row, CRLF line ends.
 *   - Readable columns first (Employee ID, name, branch, payslip number),
 *     then the data, then the internal UUIDs at the end ("... UUID").
 *   - Dates YYYY-MM-DD; date-times YYYY-MM-DD HH:MM:SS in Asia/Manila; times
 *     HH:MM; amounts with 2 decimals, no separators, no symbol; Yes / No;
 *     statuses as words (on_time -> On Time); JSON columns as JSON text.
 *   - Text starting with = + - @ tab or CR gets a leading ' (no formula runs).
 *
 * Read-only: rows come from the Super Admin-only database functions
 * (full-backup.js -> public.backup_export_page), nothing is written back.
 * Payslip amounts are the stored ones: the payslip's own record
 * (payroll_entries.payroll) read with the same rules the database uses to
 * fill the amount columns (payroll_entries_columns_from_payroll,
 * 20261029020000); the column itself when the record has no value.
 */

import { createHash } from "node:crypto";
import { zipWriter } from "@/lib/export/xlsx-stream";
import { TABLE_COLUMNS } from "./schema";

export const BOM = "﻿";

/* ── Values ───────────────────────────────────────────────────────────── */

const MANILA = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** YYYY-MM-DD HH:MM:SS in Asia/Manila; text that is not a date is kept. */
export function manilaDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : MANILA.format(date).replace("T", " ");
}

/** The Manila calendar day of a timestamp or a date (for the date filter). */
export function manilaDay(value, kind) {
  if (value === null || value === undefined || value === "") return "";
  return kind === "tstz" ? manilaDateTime(value).slice(0, 10) : String(value).slice(0, 10);
}

/** An amount with at least 2 decimals, never rounded (6436.8 -> 6436.80). */
export function money(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const text = String(n);
  if (/e/i.test(text)) return n.toFixed(2);
  const [whole, fraction = ""] = text.split(".");
  return fraction.length <= 2 ? `${whole}.${fraction.padEnd(2, "0")}` : text;
}

/** Rounded to centavos, half away from zero, as PostgreSQL ROUND(x, 2) does. */
export function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.sign(n) * Number(`${Math.round(Number(`${Math.abs(n)}e2`))}e-2`);
}

const LABELS = {
  first: "1st cutoff", second: "2nd cutoff", on_time: "On Time", hr: "HR", super_admin: "Super Admin", awol: "AWOL",
  sss: "SSS", sss_ec: "SSS EC", philhealth: "PhilHealth", pagibig: "Pag-IBIG", withholding_tax: "Withholding Tax", rfid: "RFID",
};

/** A status or type code as the words the app shows (on_time -> On Time). */
export function label(value) {
  const text = String(value);
  if (LABELS[text.toLowerCase()]) return LABELS[text.toLowerCase()];
  if (!/^[a-z0-9_]+$/.test(text)) return text;
  return text.split("_").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const NUMERIC = new Set(["money", "num", "int"]);

/** A value as CSV text, by column kind. Empty stays empty (never "null"). */
export function formatValue(value, kind) {
  if (value === null || value === undefined) return "";
  switch (kind) {
    case "money": return money(value);
    case "num": case "int": return Number.isFinite(Number(value)) && value !== "" ? String(Number(value)) : String(value);
    case "date": return String(value).slice(0, 10);
    case "tstz": return value === "" ? "" : manilaDateTime(value);
    case "time": return String(value).slice(0, 5);
    case "bool": return value === true || value === "true" ? "Yes" : value === false || value === "false" ? "No" : String(value);
    case "label": return value === "" ? "" : label(value);
    default: return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

/** One CSV field: formula guard on text, quotes when needed. */
export function csvCell(value, kind) {
  let text = formatValue(value, kind);
  if (!NUMERIC.has(kind) && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (values, columns) => `${values.map((v, i) => csvCell(v, columns[i]?.kind)).join(",")}\r\n`;

/* ── Columns of a database table ──────────────────────────────────────── */

const WORDS = {
  id: "ID", ids: "IDs", uid: "UID", sss: "SSS", ec: "EC", philhealth: "PhilHealth", pagibig: "Pag-IBIG", tin: "TIN", prc: "PRC", rfid: "RFID",
  ip: "IP", bir: "BIR", msc: "MSC", pct: "%", awol: "AWOL", ot: "OT", er: "employer", last4: "last 4", cp: "mobile", no: "number",
};
export const words = (key) => {
  const text = key.split("_").filter(Boolean).map((w) => WORDS[w] ?? w).join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// Numbers that are not pesos.
const NOT_MONEY = /(pct|percent|hours|minutes|days|quantity|offset|years|count|payrolls|months|_no$|^rate$|^value$|^version)/;
// Text codes shown as words.
const LABEL_COLUMN = /^(status|.*_status|type|.*_type|kind|stage|outcome|cutoff|role|.*_role|decision|day_part|correction_type|resolution|left_out_as)$/;
// Readable columns moved to the front, in this order.
const FRONT = ["payslip_no", "employee_code", "employee_name", "name", "code", "title", "period_label", "pay_period", "uid_last4"];

const ENTITY = {
  payroll_entries: "Payslip", profiles: "Employee profile", branches: "Branch", attendance_logs: "Attendance log", audit_logs: "Audit log",
  leave_requests: "Leave request", overtime_requests: "Overtime request", payroll_runs: "Payroll run", payroll_records: "Payroll record", rfid_cards: "RFID card", payroll_loans: "Loan",
};

/** Header and meaning overrides where the column name alone would mislead. */
const OVERRIDES = {
  "profiles.employee_id": ["Employee ID", "text", "Readable employee number (for example SACS-001)."],
  "profiles.basic_salary": ["Monthly salary (PHP)", "money", "Monthly salary as stored on the profile."],
  "profiles.rfid_uid": ["RFID card UID (legacy field)", "text"],
  "payroll_rate_configs.value": ["Value (PHP, or % for a percentage rate type)", "num", "Pesos for a daily/hourly rate; a percentage for a % rate type."],
  "payroll_deductions.rate": ["Rate per unit", "num", "PHP per day/minute, or the salary base for a % line."],
  "payroll_incentives.rate": ["Rate per unit", "num", "PHP per unit."],
  "attendance_logs.change_token": ["Change check (edit conflict marker)", "text", "Internal marker that stops two edits overwriting each other. Not a security secret."],
};

const UUID_HEADER = { employee_id: "Employee profile UUID", user_id: "Employee profile UUID", branch_id: "Branch UUID" };

function schemaOf(table) {
  const spec = TABLE_COLUMNS[table];
  return spec ? spec.split(",").map((pair) => { const [key, type] = pair.split(":"); return { key, type }; }) : [];
}

const typeOfValue = (v) => (typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : v && typeof v === "object" ? "json"
  : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(v)) ? "tstz" : "text");

function meaningOf(kind, header) {
  if (kind === "uuid") return "Internal ID; links this row to the other files.";
  return {
    money: "Amount in PHP, 2 decimals, as stored.", tstz: "Date and time, Asia/Manila.", date: "Date (YYYY-MM-DD).", time: "Time of day (HH:MM).",
    bool: "Yes or No.", json: "Stored details, as JSON text.", array: "List, as JSON text.", label: "Status or type, in words.",
  }[kind] || (header.endsWith("UUID") ? "Internal ID." : "As stored.");
}

/**
 * The columns of one table's CSV: [{ key, header, kind, meaning, get(row, ctx) }].
 * The table's own columns (schema, plus any newer column in the first row),
 * readable first, UUIDs last; Employee ID / name / Branch added from the
 * linked profile and branch when the table only holds their UUID.
 */
export function tableColumns(table, firstRow = null) {
  const schema = schemaOf(table);
  const known = new Set(schema.map((c) => c.key));
  Object.keys(firstRow || {}).forEach((key) => { if (!known.has(key)) schema.push({ key, type: typeOfValue(firstRow[key]) }); });
  const has = (key) => schema.some((c) => c.key === key);
  const link = schema.find((c) => (c.key === "employee_id" || c.key === "user_id") && c.type === "uuid")?.key;

  // Derived columns (no `column`): shown for reading, not loaded by a restore.
  const derived = [];
  if (link && !has("employee_code")) derived.push({ key: "@employee_code", header: "Employee ID", kind: "text", meaning: "Readable employee number of the linked profile.", get: (r, ctx) => ctx.profile(r[link])?.code || "" });
  if (link && !has("employee_name")) derived.push({ key: "@employee_name", header: "Employee name", kind: "text", meaning: "Name on the linked profile.", get: (r, ctx) => ctx.profile(r[link])?.name || "" });
  if (has("branch_id")) derived.push({ key: "@branch", header: "Branch", kind: "text", meaning: "Branch name.", get: (r, ctx) => ctx.branchName(r.branch_id) });
  if (link) derived.push({ key: "@is_demo", header: "Is demo", kind: "bool", meaning: IS_DEMO_MEANING, get: (r, ctx) => Boolean(ctx.isDemo?.(r[link])) });

  const column = ({ key, type }) => {
    const override = OVERRIDES[`${table}.${key}`];
    if (override) return { key, column: key, type, header: override[0], kind: override[1], meaning: override[2] || meaningOf(override[1], override[0]), get: (r) => r[key] };
    let kind = type;
    if (type === "num" && !NOT_MONEY.test(key)) kind = "money";
    if (type === "text" && LABEL_COLUMN.test(key)) kind = "label";
    if (type === "array" && /_ids$/.test(key)) kind = "json";
    let header;
    if (type === "array" && /_ids$/.test(key)) header = `${words(key.replace(/_ids$/, ""))} UUIDs`;
    else if (type === "uuid") header = key === "id" ? `${ENTITY[table] || "Row"} UUID` : UUID_HEADER[key] || `${words(key.replace(/_id$/, ""))} UUID`;
    else if (key === "id") header = `${ENTITY[table] || "Row"} ID`;
    else if (key === "employee_code") header = "Employee ID";
    else header = words(key) + (kind === "money" ? " (PHP)" : kind === "tstz" ? " (Asia/Manila)" : "");
    if (key === "is_demo") header = "Is demo";
    // A status in words is not loaded back: its "(database code)" column is.
    return { key, column: kind === "label" ? undefined : key, type, header, kind, meaning: key === "employee_code" ? "Readable employee number." : key === "is_demo" ? IS_DEMO_MEANING : meaningOf(kind, header), get: (r) => r[key] };
  };

  const own = schema.map(column);
  // The exact stored value of every status / type column, for a restore.
  const codes = own.filter((c) => c.kind === "label").map((c) => ({ key: `${c.key}#code`, column: c.key, type: c.type, header: `${c.header} (database code)`, kind: "text", meaning: CODE_MEANING, get: (r) => r[c.key] }));
  const isEnd = (c) => c.kind === "uuid" || c.key === "id" || (c.kind === "json" && /_ids$/.test(c.key));
  // A readable code / name the table holds itself (profiles.employee_id is text, SACS-001).
  const code = own.find((c) => c.key === "employee_code" || (c.key === "employee_id" && c.kind !== "uuid"));
  const name = own.find((c) => c.key === "employee_name" || (table === "profiles" && c.key === "full_name"));
  const front = FRONT.map((key) => own.find((c) => c.key === key && c.kind !== "uuid")).filter((c) => c && c !== code && c !== name);
  const pick = (key) => derived.filter((c) => c.key === key);
  const ownDemo = own.find((c) => c.key === "is_demo");
  const readable = [...front.filter((c) => c.key === "payslip_no"), ...(code ? [code] : pick("@employee_code")), ...(name ? [name] : pick("@employee_name")),
    ...pick("@branch"), ...(ownDemo ? [ownDemo] : pick("@is_demo")), ...front.filter((c) => c.key !== "payslip_no")];
  const middle = own.filter((c) => !readable.includes(c) && !isEnd(c));
  const end = own.filter(isEnd).sort((a, b) => (a.key === "id" ? -1 : b.key === "id" ? 1 : 0));
  return [...readable, ...middle, ...codes, ...end];
}

const IS_DEMO_MEANING = "Yes for a demo person (or a row of one), from the demo seed. Filter on No to leave demo data out.";
const CODE_MEANING = "The value exactly as stored in the database (the column before shows it in words). A restore loads this one.";

/* ── Payslips (payroll_entries) ───────────────────────────────────────── */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const pad = (n) => String(n).padStart(2, "0");

/** "October 16-31, 2026" -> { start, end, label: "Oct 16–31, 2026" }; null when not a period label. */
export function parsePayPeriod(text) {
  const m = /^([A-Za-z]+)\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),\s*(\d{4})$/.exec(String(text || "").trim());
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (month < 0) return null;
  const [d1, d2, year] = [Number(m[2]), Number(m[3]), m[4]];
  const short = m[1].charAt(0).toUpperCase() + m[1].slice(1, 3).toLowerCase();
  return { start: `${year}-${pad(month + 1)}-${pad(d1)}`, end: `${year}-${pad(month + 1)}-${pad(d2)}`, label: `${short} ${d1}–${d2}, ${year}` };
}

const jsonAmount = (v) => (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) ? round2(v) : null);
const first = (...values) => values.find((v) => v !== null && v !== undefined) ?? null;

/** The stored amounts of one payslip, read as payroll_entries_columns_from_payroll does. */
export function payslipAmounts(e) {
  const p = e.payroll && typeof e.payroll === "object" && !Array.isArray(e.payroll) ? e.payroll : {};
  const t = p.totals || {};
  const lines = p.final_pay?.breakdown?.deductions;
  const kindSum = (kind) => round2(lines.filter((l) => l?.kind === kind).reduce((s, l) => s + (jsonAmount(l.amount) ?? 0), 0));
  const share = (kind, path) => (Array.isArray(lines) ? kindSum(kind) : first(jsonAmount(p.deductions?.[path]), e[path]));
  const net = jsonAmount(t.net_pay);
  const er = p.employer_contributions?.employer || {};
  return {
    monthly_salary: first(jsonAmount(p.basic_salary), e.basic_salary),
    basic_pay: jsonAmount(p.basic_earned),
    overtime_pay: first(jsonAmount(t.overtime_pay), e.overtime_pay),
    holiday_pay: jsonAmount(t.holiday_pay),
    total_incentives: jsonAmount(t.total_incentives),
    bonus: e.bonus,
    gross_pay: first(jsonAmount(p.monthly?.cutoff?.gross_pay), jsonAmount(t.gross_pay), e.gross_pay),
    absence_deduction: first(jsonAmount(t.absence_deduction), e.absences_deduction),
    late_deduction: jsonAmount(t.late_deduction),
    undertime_deduction: jsonAmount(t.undertime_deduction),
    half_day_deduction: jsonAmount(t.half_day_deduction),
    leave_without_pay_deduction: jsonAmount(t.leave_without_pay_deduction),
    sss: share("sss", "sss"),
    philhealth: share("philhealth", "philhealth"),
    pagibig: share("pagibig", "pagibig"),
    withholding_tax: share("withholding_tax", "withholding_tax"),
    cash_advance: first(jsonAmount(t.cash_advance_deduction), e.cash_advance),
    loan_deduction: jsonAmount(t.loan_deduction),
    total_deductions: first(jsonAmount(t.total_deductions), e.total_deductions),
    net_pay: net === null ? e.net_pay : Math.max(0, net),
    er_sss: jsonAmount(er.sss), er_sss_ec: jsonAmount(er.sss_ec), er_philhealth: jsonAmount(er.philhealth), er_pagibig: jsonAmount(er.pagibig), er_total: jsonAmount(er.total),
  };
}

// `column`: the payroll_entries column a restore loads the value into (none = shown only).
const M = (key, header, meaning, column) => ({ key, header, kind: "money", meaning, column, type: "num", get: (r) => r.$amounts[key] });
const C = (key, header, kind, meaning, get) => ({ key, header, kind, meaning, get: get || ((r) => r[key]),
  column: key.startsWith("@") || kind === "label" ? undefined : key, type: KIND_TYPE[kind] || "text" });
const CODE = (key, header) => ({ key: `${key}#code`, header: `${header} (database code)`, kind: "text", meaning: CODE_MEANING, column: key, type: "text", get: (r) => r[key] });
const KIND_TYPE = { money: "num", num: "num", int: "int", date: "date", tstz: "tstz", time: "time", bool: "bool", json: "json", uuid: "uuid" };

export const PAYSLIP_COLUMNS = [
  C("payslip_no", "Payslip number", "text", "Readable payslip number (PS-YYYYMM-NNNN)."),
  C("employee_code", "Employee ID", "text", "Readable employee number, as printed on the payslip."),
  C("employee_name", "Employee name", "text", "Name as printed on the payslip."),
  C("@branch", "Branch", "text", "Branch the payslip belongs to.", (r, ctx) => ctx.branchName(r.branch_id)),
  C("@is_demo", "Is demo", "bool", "Yes for a demo person's payslip (from the demo seed). Filter on No to leave demo data out.", (r, ctx) => Boolean(ctx.isDemo?.(r.employee_id))),
  C("employee_type", "Category", "label", "Teaching / Non-Teaching at the time of the payslip."),
  C("position", "Position", "text", "Position at the time of the payslip."),
  C("@period", "Pay period", "text", "Readable pay period (for example Oct 16–31, 2026), or the stored label.", (r) => r.$period?.label || r.pay_period || ""),
  C("@period_start", "Pay period start", "date", "First day of the pay period (empty when the label is not a date range, such as final pay).", (r) => r.$period?.start || ""),
  C("@period_end", "Pay period end", "date", "Last day of the pay period.", (r) => r.$period?.end || ""),
  C("pay_period", "Pay period (as stored)", "text", "The pay period label exactly as stored."),
  C("cutoff", "Cutoff", "label", "1st cutoff (1–15) or 2nd cutoff (16–end of month)."),
  C("status", "Status", "label", "Payslip status (Pending, Approved, Paid, ...)."),
  M("monthly_salary", "Monthly salary (PHP)", "Monthly salary the payslip was computed from.", "basic_salary"),
  M("basic_pay", "Basic pay earned this cutoff (PHP)", "Basic pay earned in this pay period (empty on payslips made before it was recorded)."),
  M("overtime_pay", "Overtime pay (PHP)", undefined, "overtime_pay"),
  M("holiday_pay", "Holiday pay (PHP)"),
  M("total_incentives", "Incentives total (PHP)"),
  M("bonus", "Bonus (PHP)", undefined, "bonus"),
  M("gross_pay", "Gross pay (PHP)", "Gross pay of this pay period.", "gross_pay"),
  M("absence_deduction", "Absence deduction (PHP)", undefined, "absences_deduction"),
  M("late_deduction", "Late deduction (PHP)"),
  M("undertime_deduction", "Undertime deduction (PHP)"),
  M("half_day_deduction", "Half-day deduction (PHP)"),
  M("leave_without_pay_deduction", "Leave without pay deduction (PHP)"),
  M("sss", "SSS employee share (PHP)", "Deducted from the employee.", "sss"),
  M("philhealth", "PhilHealth employee share (PHP)", "Deducted from the employee.", "philhealth"),
  M("pagibig", "Pag-IBIG employee share (PHP)", "Deducted from the employee.", "pagibig"),
  M("withholding_tax", "Withholding tax (PHP)", undefined, "withholding_tax"),
  M("cash_advance", "Cash advance deduction (PHP)", undefined, "cash_advance"),
  M("loan_deduction", "Loan deduction (PHP)"),
  M("total_deductions", "Total deductions (PHP)", undefined, "total_deductions"),
  M("net_pay", "Net pay (PHP)", "Take-home pay (never below 0).", "net_pay"),
  M("er_sss", "SSS employer share (PHP)", "Paid by the school, not deducted (empty on older payslips)."),
  M("er_sss_ec", "SSS EC employer share (PHP)", "Employees' Compensation, paid by the school."),
  M("er_philhealth", "PhilHealth employer share (PHP)", "Paid by the school."),
  M("er_pagibig", "Pag-IBIG employer share (PHP)", "Paid by the school."),
  M("er_total", "Employer share total (PHP)", "Sum of the employer shares."),
  C("transport_allowance", "Transport allowance (PHP, legacy column)", "money", "Old column, kept for a complete restore."),
  C("rice_allowance", "Rice allowance (PHP, legacy column)", "money", "Old column, kept for a complete restore."),
  C("submitted_at", "Submitted at (Asia/Manila)", "tstz"),
  C("approved_at", "Approved at (Asia/Manila)", "tstz"),
  C("created_at", "Created at (Asia/Manila)", "tstz"),
  C("updated_at", "Updated at (Asia/Manila)", "tstz"),
  C("rejection_reason", "Rejection reason", "text"),
  C("approval_id", "Approval reference", "text"),
  C("created_in_testing_mode", "Made in testing mode", "bool", "Yes when made while the payroll window was switched off for testing."),
  C("payroll", "Payslip details (JSON, as stored)", "json", "The full stored payslip record; a restore needs it."),
  CODE("employee_type", "Category"),
  CODE("cutoff", "Cutoff"),
  CODE("status", "Status"),
  C("id", "Payslip UUID", "uuid", "Internal ID of the payslip."),
  C("employee_id", "Employee profile UUID", "uuid", "Links to the Employees and profiles files."),
  C("branch_id", "Branch UUID", "uuid", "Links to the branches file."),
  C("run_id", "Payroll run UUID", "uuid", "Links to payroll_runs."),
  C("payroll_period_id", "Legacy payroll period UUID", "uuid"),
  C("submitted_by", "Submitted by UUID", "uuid"),
  C("approved_by", "Approved by UUID", "uuid"),
];

/** A payslip row with its period and amounts worked out once. */
export function preparePayslip(row) {
  return { ...row, $period: parsePayPeriod(row.pay_period), $amounts: payslipAmounts(row) };
}

/* ── Filters ──────────────────────────────────────────────────────────── */

/**
 * The column the date filter reads, per table ([start, end] = the row's
 * range overlaps the filter). Tables not listed are not filtered by date.
 */
export const DATE_FILTER = {
  attendance_logs: "log_date", attendance_logs_history: "changed_at", attendance_taps: "log_date", attendance_blocked_taps: "log_date",
  attendance_corrections: "log_date", attendance_overtime_approvals: "log_date", attendance_holidays: "holiday_date",
  school_break_periods: ["start_date", "end_date"], holiday_duty_assignments: "holiday_date", holiday_duty_history: "holiday_date",
  holiday_work_reviews: "holiday_date", early_bird_winners: "period_start", attendance_data_gaps: "gap_date", automation_actions: "created_at",
  leave_requests: ["start_date", "end_date"],
  overtime_requests: "request_date",
  substitutions: "sub_date",
  payroll_entries: "@period_start", payroll_records: "period_start", payroll_runs: "period_start", payroll_run_items: "created_at",
  payroll_run_exclusions: "created_at", payroll_approval_history: "created_at", payroll_corrections: "requested_at",
  payroll_final_overrides: "created_at", payroll_review_flags: "created_at", payroll_tax_annualizations: "created_at", payroll_bir_exports: "generated_at",
  payroll_final_pay_submissions: "submitted_at",
  audit_logs: "created_at",
};

const kindIn = (table, key) => schemaOf(table).find((c) => c.key === key)?.type;

/** Validated filters: { from, to, branch } (YYYY-MM-DD, branch UUID); throws a 400. */
export function parseFilters(input = {}, branchIds = null) {
  const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  const date = (v, name) => {
    if (v === undefined || v === null || v === "") return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) bad(`${name} must be a date (YYYY-MM-DD).`);
    return String(v);
  };
  const from = date(input.from, "From");
  const to = date(input.to, "To");
  if (from && to && from > to) bad("The From date is after the To date.");
  const branch = input.branch ? String(input.branch) : null;
  if (branch && branchIds && !branchIds.has(branch)) bad("Unknown branch.");
  return { from, to, branch };
}

export const hasFilters = (f) => Boolean(f && (f.from || f.to || f.branch));

/** Does a row pass the filters? Rows with no branch link (settings, rate tables) are kept. */
export function rowMatches(table, row, filters, ctx) {
  if (filters.branch) {
    const link = row.employee_id && kindIn(table, "employee_id") === "uuid" ? row.employee_id : row.user_id;
    const branch = table === "branches" ? row.id : row.branch_id ?? ctx.profile(link)?.branch_id;
    if (branch !== undefined && String(branch ?? "") !== filters.branch) return false;
  }
  const on = DATE_FILTER[table];
  if (on && (filters.from || filters.to)) {
    const [startKey, endKey] = Array.isArray(on) ? on : [on, on];
    const day = (key) => (key === "@period_start" ? row.$period?.start || manilaDay(row.created_at, "tstz") : manilaDay(row[key], kindIn(table, key)));
    const start = day(startKey);
    const end = day(endKey) || start;
    if (!start) return false;
    if (filters.from && end < filters.from) return false;
    if (filters.to && start > filters.to) return false;
  }
  return true;
}

export function dateFilterHeader(table) {
  const on = DATE_FILTER[table];
  if (!on) return null;
  if (on === "@period_start") return "Pay period start (or created date when the period is not a date range)";
  const cols = tableColumns(table);
  const name = (key) => cols.find((c) => c.key === key)?.header || key;
  return Array.isArray(on) ? `${name(on[0])} to ${name(on[1])} (overlapping)` : name(on);
}

/* ── File names ───────────────────────────────────────────────────────── */

const slug = (text) => String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

/** sacs-payroll_<what>_<YYYY-MM-DD_HHMM>[_branch][_from-to].<ext> (Manila time). */
export function backupFileName(what, { at = new Date(), filters = {}, branchName = "", ext = "csv", label = "" } = {}) {
  const stamp = manilaDateTime(at).slice(0, 16).replace(" ", "_").replace(":", "");
  const parts = [`sacs-payroll_${what}_${stamp}`];
  if (filters.branch) parts.push(slug(branchName) || "branch");
  if (filters.from || filters.to) parts.push(`${filters.from || "start"}-to-${filters.to || "today"}`);
  return `${label ? `${label}_` : ""}${parts.join("_")}.${ext}`;
}

/* ── Writing ──────────────────────────────────────────────────────────── */

/**
 * Write the files the async generator yields, as one CSV (single: true) or
 * a ZIP of CSVs with README.txt last. Each file: { name, title, description,
 * columns, rows: AsyncIterable<Array>, dateFilter }. `readme(summary)`
 * returns the README text. Resolves with per-file rows and SHA-256.
 */
export async function writeCsvBackup(files, push, { single = false, readme } = {}) {
  const encoder = new TextEncoder();
  const written = [];
  const queue = [];
  const zip = single ? null : zipWriter((buffer) => queue.push(buffer));
  const drain = async () => { while (queue.length) await push(queue.shift()); };

  for await (const file of files()) {
    const hash = createHash("sha256");
    const entry = zip ? zip.entry(file.name) : null;
    const out = async (text) => {
      const bytes = encoder.encode(text);
      hash.update(bytes);
      if (entry) { entry.write(Buffer.from(bytes)); await drain(); } else await push(Buffer.from(bytes));
    };
    await out(`${BOM}${file.columns.map((c) => csvCell(c.header, "text")).join(",")}\r\n`);
    let rows = 0;
    let batch = "";
    for await (const values of file.rows) {
      rows += 1;
      batch += csvLine(values, file.columns);
      if (batch.length >= 256 * 1024) { await out(batch); batch = ""; }
    }
    if (batch) await out(batch);
    if (entry) entry.end();
    await drain();
    written.push({ ...file, rows, sha256: hash.digest("hex"), columns: file.columns });
    if (single) break;
  }
  if (zip) {
    const text = readme ? readme(written) : "";
    const entry = zip.entry("README.txt");
    entry.write(Buffer.from(encoder.encode(`${BOM}${text.replace(/\r?\n/g, "\r\n")}`)));
    entry.end();
    zip.finish();
    await drain();
  }
  return { files: written.map(({ name, title, rows, sha256, key }) => ({ name, title, rows, sha256, key })) };
}

/** Parents before children (foreign keys among the backup tables, 2026-11-15). */
export const RESTORE_ORDER = Object.freeze([
  "branches", "profiles", "employee_positions", "employee_classification_changes", "employee_hr_reminders", "leave_credit_rules",
  "leave_credit_overrides", "statutory_leave_types", "employee_pay_rules", "leave_requests", "overtime_requests", "substitutions", "attendance_blocked_taps", "attendance_logs", "attendance_corrections", "attendance_holidays",
  "attendance_logs_history", "attendance_overtime_approvals", "rfid_terminals", "attendance_taps", "audit_logs", "branch_admin_requests",
  "branch_announcements", "early_bird_winners", "attendance_data_gaps", "automation_actions", "employee_awol_cases", "employee_branch_assignments", "employee_license_alerts",
  "employee_license_documents", "employee_license_changes", "employee_salary_changes", "employee_status_changes", "holiday_duty_assignments",
  "holiday_duty_history", "holiday_work_reviews", "payroll_runs", "payroll_approval_history", "payroll_bir_exports", "payroll_cash_advances",
  "payroll_contribution_amounts", "payroll_entries", "payroll_subsidy_settings", "payroll_subsidy_balances", "payroll_loans",
  "payroll_monthly_incentives", "payroll_corrections", "payroll_rate_configs", "payroll_records", "payroll_deductions",
  "payroll_final_overrides", "payroll_final_pay_submissions", "payroll_incentives", "payroll_loan_payments", "payroll_review_flags", "payroll_run_exclusions",
  "payroll_run_items", "payroll_schedule_settings", "payroll_setting_changes", "payroll_sss_msc_brackets", "payroll_subsidy_adjustments",
  "payroll_subsidy_requests", "payroll_tax_annualizations", "payroll_tax_brackets", "payroll_thirteenth_month", "payroll_window_enforcement",
  "payroll_window_enforcement_changes", "rfid_cards", "rfid_card_events", "role_permissions", "school_break_periods", "system_config", "remark_presets",
  "tenure_protection_grants", "tenure_protection_applications", "tenure_protection_policies", "transfer_requests",
  "work_schedule_assignments", "work_schedules",
]);

/** Tables with only a UUID and no readable identifier of their own (known item, after the defense). */
export const UUID_ONLY_TABLES = Object.freeze(["payroll_approval_history", "payroll_window_enforcement", "payroll_window_enforcement_changes"]);

/** The restore guide: in every README and in docs/restore-from-csv-backup.md. */
export const RESTORE_GUIDE = [
  "There is no import screen in the app. A restore is done by the developer, with the",
  "local tool scripts/backup/restore-csv-local.mjs as the worked example (local stack only).",
  "",
  "1. When the whole database is lost, first restore the latest daily database backup in the",
  "   Supabase dashboard. Use these CSV files for what changed after that backup, or when no",
  "   database backup is left: then start from an empty database built from the migrations.",
  "2. Sign-in accounts first: users_and_accounts.csv gives each account's User UUID and email.",
  "   Create each account with that same UUID (Supabase Auth admin API), then send password",
  "   resets. Passwords are never in a backup.",
  "3. Load the table files in the LOAD ORDER below (parents before children), in one database",
  "   session with triggers and foreign-key checks off (SET session_replication_role = replica),",
  "   so stored values are not recomputed. profiles and employee_license_documents point at",
  "   each other; with the checks off, the order below loads both.",
  "4. The column guide says where each value goes: [loads into: <column> (<type>)]. Columns",
  "   marked [shown only] are for reading (names, branch names, statuses in words) and are not",
  "   loaded; the \"(database code)\" column holds the stored status. Turn the formats back:",
  "   date-times are Asia/Manila (+08:00), Yes/No are true/false, an empty cell is NULL (or ''",
  "   for a required text column), a leading ' before = + - @ is removed, JSON stays JSON.",
  "   Payslip amount columns load the amounts of the stored payslip record.",
  "5. Not in the files, redo by hand: the encrypted government ID numbers (re-enter them from",
  "   employees.csv), uploaded files (photos, leave proofs, license scans), bell notifications.",
  "   employees.csv, users_and_accounts.csv, leave_balances.csv and pay_rates.csv are",
  "   summaries: never load them as tables.",
  "6. Check after loading: every table's row count equals \"Rows\" below; the SHA-256 of each",
  "   file matches; 3 payslips per branch show the same amounts (to the centavo) as in",
  "   payroll_entries.csv; staff can sign in after their password reset.",
];

/** README.txt: what is inside, who made it, the filters, every file's column guide, and how to restore. */
export function readmeText(files, { exportedAt, exportedBy, filters, branchName, version, environment, groups }) {
  const line = "=".repeat(72);
  const loads = (c) => (c.column ? `[loads into: ${c.column} (${c.type || KIND_TYPE[c.kind] || "text"})]` : "[shown only]");
  const out = [
    "SACS Payroll data backup (CSV)", line,
    `Exported at (Asia/Manila): ${manilaDateTime(exportedAt)}`,
    `Exported by: ${exportedBy}`,
    `Environment: ${environment === "production" ? "Production (real data)" : `${String(environment).toUpperCase()} (NOT real data)`}`,
    `App version: ${version}`,
    `Groups: ${groups.join("; ")}`,
    `Filters: branch = ${filters.branch ? branchName : "every branch"}; dates = ${filters.from || filters.to ? `${filters.from || "the beginning"} to ${filters.to || "today"}` : "everything"}`,
    "  The date filter applies to attendance, leave, payroll and audit log files (the column used is named per file below).",
    "  The branch filter keeps rows of that branch; files with no branch (settings, rate tables, roles) are complete.",
    "",
    "PRIVACY: this archive contains salary and personal data, including government ID numbers",
    "(Data Privacy Act of 2012). Store it encrypted and offline; never email or share it.",
    "",
    "FORMAT (every file): UTF-8 with BOM, comma separated, one header row. Dates YYYY-MM-DD;",
    "date-times YYYY-MM-DD HH:MM:SS in Asia/Manila; times HH:MM; amounts in PHP with 2 decimals,",
    "no thousands separator. Statuses are shown as words (On Time = on_time in the database).",
    "Text starting with = + - @ has a leading ' so a spreadsheet never runs it as a formula.",
    "ID numbers (TIN, SSS, PhilHealth, Pag-IBIG, card UIDs) are text with leading zeros kept;",
    "open the file with Excel's Data > From Text/CSV and set those columns to Text to keep them.",
    "",
    "LINKS: the columns ending in \"UUID\" are the database's internal IDs. They link the files",
    "together (for example Employee profile UUID in attendance_logs.csv = Employee profile UUID",
    "in employees.csv) and are needed to rebuild the links in a restore.",
    "",
    "DEMO DATA: demo people (from the demo seed) and their rows ARE included while the demo data",
    "is live. Every file with a person in it has an \"Is demo\" column (Yes / No): filter on No",
    "to leave demo data out.",
    "",
    "PAYSLIPS OF 0.00: a payslip with 0.00 gross and net pay can be valid: it means no paid days",
    "in that cutoff (for example every day absent). Amounts are exactly as stored on the payslip.",
    "",
    "NOT INCLUDED: passwords, password hashes, sign-in tokens, sign-in/reset codes, API keys;",
    "sign-in throttling; bell notifications; uploaded files (photos, leave proofs, license scans);",
    "the encrypted copies of government ID numbers (employees.csv has them decrypted).",
    "Not backed up: temporary or rebuildable: hr_queue_claims (HR's short-lived queue claims),",
    "notification_channels (realtime topics the app recreates).",
    "",
    `KNOWN ITEM (after the defense): ${UUID_ONLY_TABLES.join(", ")} have only a`,
    "UUID and no readable identifier of their own; read them by their dates and names.",
    "",
    "HOW TO RESTORE", line, ...RESTORE_GUIDE, "",
    `LOAD ORDER: ${RESTORE_ORDER.join(", ")}`,
    "",
    "FILES", line,
  ];
  for (const f of files) {
    out.push(`${f.name}`, `  What it holds: ${f.title}. ${f.description || ""}`.trimEnd(), `  Rows: ${f.rows}`, `  SHA-256: ${f.sha256}`);
    out.push(`  Date filter on: ${f.dateFilter || "not filtered by date"}`);
    out.push("  Columns:");
    f.columns.forEach((c) => out.push(`    ${c.header} - ${c.meaning || meaningOf(c.kind, c.header)} ${loads(c)}`));
    out.push("");
  }
  return out.join("\n");
}
