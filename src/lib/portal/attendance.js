/**
 * Attendance display helpers shared by the Admin, HR and Super Admin
 * portals: pay-period labels, one row per employee per day, branch / day
 * grouping and counts, worked hours, date ranges. Ports of the att* helpers
 * in public/legacy/js/app.js (named in each comment). Display only.
 */

import { ATTENDANCE_STATUS_LIST, manilaDateKey, normalizeAttendanceStatus } from "@/lib/portal/format";

const MANILA = "Asia/Manila";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const todayKey = () => manilaDateKey();

/** "Oct 07, 2026, 08:01 AM" (attFormatDateTime). */
export function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-PH", { timeZone: MANILA, month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true }).format(date);
}

/** "08:01:15 AM": taps can be seconds apart (attFormatTapTime). */
export function formatTapTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-PH", { timeZone: MANILA, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(date);
}

/** "Friday, September 25, 2026" (attFormatDayHeading). */
export function formatDayHeading(key) {
  const date = new Date(`${key}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return key || "—";
  return new Intl.DateTimeFormat("en-PH", { timeZone: MANILA, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date);
}

/** "October 2026" for "2026-10" (attFormatMonthHeading). */
export function formatMonthHeading(key) {
  const [y, m] = String(key || "").split("-").map(Number);
  return y && m ? `${MONTHS[m - 1]} ${y}` : "—";
}

/** "12 min" or "—" (attMinutes). */
export function formatMinutes(value) {
  const minutes = Number(value || 0);
  return minutes > 0 ? `${minutes} min` : "—";
}

/** Worked minutes of a day with both taps; null without a time out (attWorkedMinutes). */
export function workedMinutes(row) {
  if (!row || !row.time_in || !row.time_out) return null;
  const ms = new Date(row.time_out) - new Date(row.time_in);
  if (Number.isFinite(ms)) return Math.max(0, Math.round(ms / 60000));
  return Math.max(0, Math.round(Number(row.total_hours || 0) * 60));
}

/** 122 -> "2h 02m" (attHoursMinutes). */
export function hoursMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}

/** The Hours column (attFormatHours). */
export function formatWorked(row) {
  const minutes = workedMinutes(row);
  return minutes === null ? "—" : hoursMinutes(minutes);
}

/** The current pay period and the ones before it, newest first (attPayPeriodLabels). */
export function payPeriodLabels(count = 6) {
  let [year, month, day] = todayKey().split("-").map(Number);
  let firstHalf = day <= 15;
  const labels = [];
  for (let i = 0; i < count; i += 1) {
    const last = firstHalf ? 15 : new Date(Date.UTC(year, month, 0)).getUTCDate();
    labels.push(`${MONTHS[month - 1]} ${firstHalf ? 1 : 16}-${last}, ${year}`);
    if (firstHalf) {
      firstHalf = false;
      month -= 1;
      if (month === 0) { month = 12; year -= 1; }
    } else {
      firstHalf = true;
    }
  }
  return labels;
}

/** One row per employee per day: a real record wins over a "no tap yet" placeholder (attOneRowPerDay). */
export function oneRowPerDay(rows) {
  const byKey = new Map();
  const loose = [];
  (rows || []).forEach((row) => {
    if (!row?.employee_id || !row?.log_date) { loose.push(row); return; }
    const key = `${row.employee_id}|${row.log_date}`;
    const prev = byKey.get(key);
    if (!prev || ((prev.placeholder || prev.not_yet_tapped) && !(row.placeholder || row.not_yet_tapped))) byKey.set(key, row);
  });
  return [...byKey.values(), ...loose];
}

/** Newest day first; within a day, by employee name (attSortByDay). */
export function sortByDay(rows) {
  return [...(rows || [])].sort((a, b) => {
    const byDay = String(b.log_date || "").localeCompare(String(a.log_date || ""));
    return byDay || String(a.employee_name || "").localeCompare(String(b.employee_name || ""));
  });
}

/**
 * Branch context for grouping: branch names, and each employee's current
 * branch (the branch they are in NOW, which groups their older rows too).
 */
export function branchContext(rows, knownNames = new Map()) {
  const names = new Map(knownNames);
  const employeeBranch = new Map();
  (rows || []).forEach((row) => {
    const branch = String(row.group_branch_id || row.branch_id || "");
    if (row.employee_id && branch) employeeBranch.set(String(row.employee_id), branch);
    if (branch && row.branch_name && !names.has(branch)) names.set(branch, row.branch_name);
  });
  return { names, employeeBranch };
}

/** attRowBranchId */
export function rowBranchId(ctx, row) {
  return String(row?.group_branch_id
    || (row?.employee_id ? ctx?.employeeBranch?.get(String(row.employee_id)) : "")
    || row?.branch_id
    || "");
}

/** attBranchLabel */
export function branchLabel(ctx, branch) {
  return ctx?.names?.get(branch) || (branch ? "Branch" : "No branch assigned");
}

/** Branch name A–Z ("No branch" last), then newest day, then employee A–Z (attSortByBranchDay). */
export function sortByBranchDay(ctx, rows) {
  return [...(rows || [])].sort((a, b) => {
    const ba = rowBranchId(ctx, a);
    const bb = rowBranchId(ctx, b);
    if (ba !== bb) {
      if (!ba) return 1;
      if (!bb) return -1;
      return branchLabel(ctx, ba).localeCompare(branchLabel(ctx, bb)) || ba.localeCompare(bb);
    }
    const byDay = String(b.log_date || "").localeCompare(String(a.log_date || ""));
    return byDay || String(a.employee_name || "").localeCompare(String(b.employee_name || ""));
  });
}

/** Per group key: how many rows, and how many of each status (attDayCounts / attBranchDayCounts). */
export function countBy(rows, keyOf) {
  const counts = new Map();
  (rows || []).forEach((row) => {
    const key = keyOf(row);
    if (!counts.has(key)) counts.set(key, { total: 0, statuses: new Map() });
    const entry = counts.get(key);
    entry.total += 1;
    if (row.status) entry.statuses.set(row.status, (entry.statuses.get(row.status) || 0) + 1);
  });
  return counts;
}

/**
 * Per branch: its latest day up to today, and that day's employees and
 * statuses (attComputeBranchCounts).
 */
export function branchCounts(ctx, rows) {
  const today = todayKey();
  const latest = new Map();
  (rows || []).forEach((row) => {
    const branch = rowBranchId(ctx, row);
    const day = String(row.log_date || "");
    const prev = latest.get(branch);
    const better = prev === undefined
      || (day <= today && (prev > today || day > prev))
      || (day > today && prev > today && day < prev);
    if (better) latest.set(branch, day);
  });
  const counts = new Map();
  latest.forEach((day, branch) => counts.set(branch, { latestDay: day, employees: new Set(), statuses: new Map() }));
  (rows || []).forEach((row) => {
    const branch = rowBranchId(ctx, row);
    const info = counts.get(branch);
    if (!info || String(row.log_date || "") !== info.latestDay) return;
    info.employees.add(String(row.employee_id || row.id || row.employee_name || ""));
    if (row.status) info.statuses.set(row.status, (info.statuses.get(row.status) || 0) + 1);
  });
  return counts;
}

/** "3 On Time · 1 Late" in the canonical status order. */
export function statusBreakdown(statuses) {
  return ATTENDANCE_STATUS_LIST.filter((s) => statuses.get(s)).map((s) => `${statuses.get(s)} ${s}`);
}

/** Whether a row's employee matches the search text: name, employee code, type or RFID card. */
export function matchesEmployee(row, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const text = [row?.employee_name, row?.employee_code, row?.employee_type, row?.rfid_code].filter(Boolean).join(" ").toLowerCase();
  return q.split(/\s+/).every((part) => text.includes(part));
}

/** The selected range as { from, to } for the employee record page (attEmployeeRange). */
export function employeeRange({ range, from, to }) {
  const today = todayKey();
  const [y, m, d] = today.split("-").map(Number);
  const iso = (date) => date.toISOString().slice(0, 10);
  if (range === "this_week") {
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return { from: iso(new Date(Date.UTC(y, m - 1, d - ((weekday + 6) % 7)))), to: today };
  }
  if (range === "last_month") return { from: iso(new Date(Date.UTC(y, m - 2, 1))), to: iso(new Date(Date.UTC(y, m - 1, 0))) };
  if (range === "custom" && from && to) return { from, to };
  return { from: `${today.slice(0, 8)}01`, to: today };
}

/** A record can be corrected unless it is a leave day (attCanCorrect). */
export function canCorrect(row) {
  return Boolean(row?.employee_id && row?.log_date) && normalizeAttendanceStatus(row.status) !== "On Leave";
}

/** A real attendance_logs id, not a synthetic "no tap yet" key (attIsLogId). */
export function isLogId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ""));
}

/** "HH:MM" now in Manila, for the not-in-the-future check. */
export function nowHm() {
  return new Intl.DateTimeFormat("en-GB", { timeZone: MANILA, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

/** The server's rule for a correction reason (attReasonCheck). */
export function reasonError(value) {
  const v = String(value || "").trim();
  if (!v) return "Reason is required.";
  return v.length >= 5 ? "" : "Give a little more detail (at least 5 characters).";
}

/** CSV cell: formula-safe and quoted (toCsvValue, admin.js). */
export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  if (text.includes(",") || text.includes('"') || text.includes("\n")) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** Download rows as a UTF-8 CSV (with BOM, for Excel). */
export function downloadCsv(filename, headers, rows) {
  const lines = [headers.join(","), ...rows.map((row) => row.map(csvCell).join(","))];
  const blob = new Blob([`﻿${lines.join("\n")}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
