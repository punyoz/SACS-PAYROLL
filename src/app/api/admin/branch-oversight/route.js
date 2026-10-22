/**
 * The branch Admin's oversight (20261020020000): the Admin recommends, HR
 * decides. Every read and write is the caller's own branch (guard.branchId);
 * a record, employee, leave or transfer of another branch is refused as not
 * found. Salaries and payslips are never returned.
 *
 *   GET ?view=dashboard                today's attendance, not tapped in yet,
 *                                      pending leaves, headcount, recent activity
 *   GET ?view=attendance&from&to       attendance logs (read-only) + their flags
 *   GET ?view=leaves                   leave requests + this branch's recommendation
 *   GET ?view=transfers                transfers in / out of the branch + endorsement
 *   GET ?view=payroll                  approved runs: totals per period only
 *   GET ?view=reports&from&to[&format=pdf]
 *                                      attendance rate, lateness, leave usage
 *   GET ?view=requests&kind=a,b        the branch's requests of those kinds
 *   GET ?view=employees                the branch's employees (names only)
 *   GET ?view=cutoffs                  the incentive cutoff of this and next month
 *   POST { action: "file", kind, employee_id?, ref_id?, decision?, note, details }
 *
 * The Accountant (branch_oversight read) reaches only view=requests with
 * kind=overtime_confirmation: it reads the Admin's confirmations before paying.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";
import { attendanceBucket } from "@/lib/attendance/status";
import { manilaDateKey, dateKeysBetween } from "@/lib/payroll/periods";
import { loadPayslipSchedule } from "@/lib/payroll/schedule";
import { lockDateKey, monthInfo, shiftMonth } from "@/lib/payroll/semi-monthly";
import { roundPeso } from "@/lib/payroll/money";
import { buildTablePdf } from "@/lib/export/table-pdf";
import {
  INCIDENT_TYPES,
  OVERTIME_TYPES,
  REQUEST_KINDS,
  RFID_ISSUE_TYPES,
  SCHEDULE_REQUEST_TYPES,
  STATUS_LABELS,
  historyEntry,
  shapeRequest,
} from "@/lib/branch-requests";
import { hrAccountIds, loadBranchStaff, notify, superAdminIds } from "@/lib/branch-requests-server";

const NOT_READY = "Branch oversight is not set up yet: apply 20261020020000_admin_branch_oversight.sql.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDateKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const LEAVE_PENDING = ["pending_admin", "pending_accountant"];
// The request labels used on every screen (Pending / Approved / Rejected);
// the column says it is HR's decision.
const LEAVE_LABELS = { pending_admin: "Pending", pending_accountant: "Pending", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled" };
const ATTENDED = new Set(["present", "late"]);

function actorName(guard) {
  return normalizeText(guard.session?.full_name, guard.session?.email) || "Branch Admin";
}

function addDays(key, days) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDateKey(key) {
  const [y, m, d] = String(key || "").split("-").map(Number);
  if (!y || !m || !d) return String(key || "");
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function range(url, { days = 0 } = {}) {
  const today = manilaDateKey();
  let from = normalizeText(url.searchParams.get("from"));
  let to = normalizeText(url.searchParams.get("to"));
  if (!isDateKey(to)) to = today;
  if (!isDateKey(from)) from = days ? addDays(to, -days) : to;
  if (from > to) [from, to] = [to, from];
  // At most a year at a time.
  if (dateKeysBetween(from, to).length > 366) from = addDays(to, -365);
  return { from, to };
}

async function branchRequests(supabase, branchId, kinds) {
  let query = supabase.from("branch_admin_requests").select("*").eq("branch_id", branchId);
  if (kinds?.length) query = query.in("kind", kinds);
  const result = await query.order("created_at", { ascending: false }).limit(1000);
  if (result.error) return { error: NOT_READY, rows: [] };
  return { rows: result.data || [] };
}

async function attendanceLogs(supabase, ids, from, to) {
  if (!ids.length) return [];
  const result = await fetchAllIn(() => supabase.from("attendance_logs")
    .select("id,employee_id,employee_name,log_date,time_in,time_out,status,late_minutes,undertime_minutes,total_hours,is_half_day")
    .gte("log_date", from).lte("log_date", to).eq("archived_duplicate", false)
    .order("log_date", { ascending: false }).order("id", { ascending: true }), "employee_id", ids);
  if (result.error) throw new Error(result.error.message);
  return (result.data || []).sort((a, b) => String(b.log_date).localeCompare(String(a.log_date)) || String(a.id).localeCompare(String(b.id)));
}

async function branchLeaves(supabase, branchId, ids) {
  const result = await supabase.from("leave_requests")
    .select("id,employee_id,employee_name,leave_type,start_date,end_date,reason,status,pay_status,submitted_at,decided_at,decided_by_name,branch_id")
    .order("submitted_at", { ascending: false }).limit(1000);
  if (result.error) throw new Error(result.error.message);
  const mine = new Set(ids);
  return (result.data || []).filter((r) => String(r.branch_id || "") === String(branchId) || mine.has(r.employee_id));
}

/** The incentive cutoff of a month: the day before its 2nd-half payslip day. */
async function cutoffsFor(supabase, monthKeys) {
  const schedule = await loadPayslipSchedule(supabase).catch(() => null);
  return Object.fromEntries(monthKeys.map((key) => {
    const cutoff = schedule ? lockDateKey(key, schedule.lockDayFor(key)) : `${key}-${String(new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate() - 1).padStart(2, "0")}`;
    return [key, { month_label: monthInfo(key).label, cutoff_date: cutoff, cutoff_label: formatDateKey(cutoff), payslip_day_label: formatDateKey(addDays(cutoff, 1)), next_month_label: monthInfo(shiftMonth(key, 1)).label }];
  }));
}

/* ── GET views ─────────────────────────────────────────────────────────── */

async function dashboardView(supabase, branchId, staff) {
  const today = manilaDateKey();
  const ids = staff.filter((p) => !p.archived).map((p) => p.id);
  const [logs, leaves, requests, announcements, holidays] = await Promise.all([
    attendanceLogs(supabase, ids, today, today),
    branchLeaves(supabase, branchId, ids),
    branchRequests(supabase, branchId, null),
    supabase.from("branch_announcements").select("id,title,category,created_at,created_by_name").eq("branch_id", branchId).eq("archived", false).order("created_at", { ascending: false }).limit(5),
    supabase.from("attendance_holidays").select("holiday_date,name,day_part").eq("holiday_date", today),
  ]);
  const byEmployee = new Map(logs.map((l) => [l.employee_id, l]));
  const onLeaveToday = new Set(leaves.filter((l) => l.status === "approved" && l.start_date <= today && l.end_date >= today).map((l) => l.employee_id));
  const counts = { present: 0, late: 0, absent: 0, on_leave: 0, not_tapped: 0 };
  const notTapped = [];
  const weekend = [0, 6].includes(new Date(`${today}T00:00:00Z`).getUTCDay());
  const holiday = (holidays.data || []).find((h) => h.day_part === "whole" || !h.day_part) || null;
  staff.filter((p) => !p.archived).forEach((person) => {
    const log = byEmployee.get(person.id);
    const bucket = log ? attendanceBucket(log.status) : null;
    if (onLeaveToday.has(person.id) || bucket === "leave") { counts.on_leave += 1; return; }
    if (log?.time_in) {
      if (bucket === "late") counts.late += 1;
      counts.present += 1;
      return;
    }
    if (bucket === "absent") { counts.absent += 1; return; }
    if (weekend || holiday || bucket === "holiday") return;
    counts.not_tapped += 1;
    notTapped.push({ id: person.id, full_name: person.full_name, employee_code: person.employee_code, employee_type: person.employee_type });
  });
  const pendingLeaves = leaves.filter((l) => LEAVE_PENDING.includes(l.status));
  const activity = [
    ...requests.rows.flatMap((r) => (r.history || []).map((h) => ({ at: h.at, text: `${REQUEST_KINDS[r.kind]?.label || r.kind}: ${STATUS_LABELS[h.status] || h.status}${h.by_name ? ` by ${h.by_name}` : ""}${r.details?.employee_name ? ` · ${r.details.employee_name}` : ""}` }))),
    ...leaves.slice(0, 30).map((l) => ({ at: l.decided_at || l.submitted_at, text: `Leave ${l.decided_at ? (LEAVE_LABELS[l.status] || l.status).toLowerCase() : "filed"}: ${l.employee_name} (${l.leave_type}, ${l.start_date}${l.end_date !== l.start_date ? ` to ${l.end_date}` : ""})` })),
    ...(announcements.data || []).map((a) => ({ at: a.created_at, text: `Announcement posted: ${a.title}` })),
  ].filter((a) => a.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12);
  const active = staff.filter((p) => !p.archived);
  return {
    today,
    rest_day: weekend ? "Weekend" : holiday ? holiday.name : null,
    attendance: counts,
    not_tapped: notTapped,
    headcount: {
      total: active.length,
      teaching: active.filter((p) => p.employee_type !== "Non-Teaching").length,
      non_teaching: active.filter((p) => p.employee_type === "Non-Teaching").length,
    },
    pending_leaves: pendingLeaves.slice(0, 8).map((l) => ({ id: l.id, employee_name: l.employee_name, leave_type: l.leave_type, start_date: l.start_date, end_date: l.end_date })),
    pending_leave_count: pendingLeaves.length,
    open_requests: requests.rows.filter((r) => r.status === "pending").length,
    recent_activity: activity,
  };
}

async function attendanceView(supabase, branchId, staff, url) {
  const { from, to } = range(url);
  const ids = staff.map((p) => p.id);
  const [logs, flags] = await Promise.all([attendanceLogs(supabase, ids, from, to), branchRequests(supabase, branchId, ["attendance_flag"])]);
  const flagByLog = new Map();
  flags.rows.forEach((f) => { if (f.ref_id && !flagByLog.has(f.ref_id)) flagByLog.set(f.ref_id, shapeRequest(f)); });
  const names = new Map(staff.map((p) => [p.id, p]));
  return {
    from, to,
    logs: logs.map((l) => ({
      ...l,
      employee_name: names.get(l.employee_id)?.full_name || l.employee_name,
      employee_code: names.get(l.employee_id)?.employee_code || "",
      flag: flagByLog.get(l.id) || null,
    })),
    flags: flags.rows.map((f) => shapeRequest(f)),
  };
}

async function leavesView(supabase, branchId, staff) {
  const ids = staff.map((p) => p.id);
  const [leaves, recs] = await Promise.all([branchLeaves(supabase, branchId, ids), branchRequests(supabase, branchId, ["leave_endorsement"])]);
  const recBy = new Map(recs.rows.map((r) => [r.ref_id, shapeRequest(r)]));
  return {
    leaves: leaves.map((l) => ({
      ...l,
      pending: LEAVE_PENDING.includes(l.status),
      hr_status_label: LEAVE_LABELS[l.status] || l.status,
      recommendation: recBy.get(l.id) || null,
    })),
  };
}

async function transfersView(supabase, branchId, staff) {
  const result = await supabase.from("transfer_requests").select("*").order("created_at", { ascending: false }).limit(1000);
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data || []).filter((t) => String(t.from_branch_id || "") === String(branchId) || String(t.to_branch_id || "") === String(branchId));
  const [recs, branches, people] = await Promise.all([
    branchRequests(supabase, branchId, ["transfer_endorsement"]),
    supabase.from("branches").select("id,name"),
    rows.length ? supabase.from("profiles").select("id,full_name").in("id", [...new Set(rows.map((t) => t.employee_id))]) : Promise.resolve({ data: [] }),
  ]);
  const recBy = new Map(recs.rows.map((r) => [r.ref_id, shapeRequest(r)]));
  const branchName = new Map((branches.data || []).map((b) => [String(b.id), b.name]));
  const personName = new Map((people.data || []).map((p) => [p.id, p.full_name]));
  return {
    transfers: rows.map((t) => ({
      id: t.id,
      employee_name: personName.get(t.employee_id) || staff.find((p) => p.id === t.employee_id)?.full_name || "Employee",
      direction: String(t.to_branch_id) === String(branchId) ? "incoming" : "outgoing",
      from_branch: branchName.get(String(t.from_branch_id)) || "—",
      to_branch: branchName.get(String(t.to_branch_id)) || "—",
      status: t.status,
      status_label: t.status === "pending" ? "Pending" : t.status === "approved" ? "Approved" : "Rejected",
      remarks: t.remarks || null,
      created_at: t.created_at,
      reviewed_at: t.reviewed_at,
      endorsement: recBy.get(t.id) || null,
    })),
  };
}

async function payrollView(supabase, branchId) {
  const result = await supabase.from("payroll_run_summaries")
    .select("id,period_label,period_start,cutoff_type,status,total_employees,total_gross,total_deductions,total_net,reviewed_at,reviewed_by_name")
    .eq("branch_id", branchId).eq("status", "approved").order("period_start", { ascending: false });
  if (result.error) return { available: false, periods: [] };
  // Run totals only: never an employee's figures.
  return {
    available: true,
    periods: (result.data || []).map((r) => ({
      id: r.id,
      period_label: r.period_label,
      period_start: String(r.period_start).slice(0, 10),
      cutoff: r.cutoff_type === "first" ? "1st cutoff (1–15)" : "2nd cutoff (16–end)",
      employees: Number(r.total_employees) || 0,
      total_gross: roundPeso(r.total_gross),
      total_deductions: roundPeso(r.total_deductions),
      total_net: roundPeso(r.total_net),
      approved_at: r.reviewed_at,
      approved_by: r.reviewed_by_name || null,
    })),
  };
}

async function reportsView(supabase, branchId, staff, url) {
  const { from, to } = range(url, { days: 29 });
  const ids = staff.map((p) => p.id);
  const [logs, leaves] = await Promise.all([attendanceLogs(supabase, ids, from, to), branchLeaves(supabase, branchId, ids)]);
  const byMonth = new Map();
  const byEmployee = new Map(staff.map((p) => [p.id, { name: p.full_name, code: p.employee_code, attended: 0, late: 0, absent: 0, late_minutes: 0, leave_days: 0, records: 0 }]));
  let attended = 0;
  let expected = 0;
  let lateDays = 0;
  logs.forEach((log) => {
    const bucket = attendanceBucket(log.status);
    if (bucket === "holiday" || bucket === "leave") return;
    expected += 1;
    const month = String(log.log_date).slice(0, 7);
    const m = byMonth.get(month) || { month, label: monthInfo(month).label, expected: 0, attended: 0, late: 0, late_minutes: 0 };
    m.expected += 1;
    const e = byEmployee.get(log.employee_id);
    if (e) e.records += 1;
    if (ATTENDED.has(bucket) || (bucket === "unresolved" && log.time_in)) {
      attended += 1; m.attended += 1; if (e) e.attended += 1;
    } else if (bucket === "absent" && e) {
      e.absent += 1;
    }
    if (bucket === "late") {
      lateDays += 1; m.late += 1; m.late_minutes += Number(log.late_minutes) || 0;
      if (e) { e.late += 1; e.late_minutes += Number(log.late_minutes) || 0; }
    }
    byMonth.set(month, m);
  });
  // Leave usage: approved leave days that fall in the range.
  const leaveByType = new Map();
  leaves.filter((l) => l.status === "approved").forEach((l) => {
    const start = l.start_date > from ? l.start_date : from;
    const end = l.end_date < to ? l.end_date : to;
    if (!isDateKey(start) || !isDateKey(end) || start > end) return;
    const days = dateKeysBetween(start, end).filter((k) => ![0, 6].includes(new Date(`${k}T00:00:00Z`).getUTCDay())).length;
    if (!days) return;
    const t = leaveByType.get(l.leave_type) || { leave_type: l.leave_type, requests: 0, days: 0 };
    t.requests += 1; t.days += days;
    leaveByType.set(l.leave_type, t);
    const e = byEmployee.get(l.employee_id);
    if (e) e.leave_days += days;
  });
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    from, to,
    summary: {
      attendance_rate: pct(attended, expected),
      attended_days: attended,
      expected_days: expected,
      late_days: lateDays,
      leave_days: [...leaveByType.values()].reduce((s, t) => s + t.days, 0),
      employees: staff.filter((p) => !p.archived).length,
    },
    months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ ...m, attendance_rate: pct(m.attended, m.expected) })),
    leave_usage: [...leaveByType.values()].sort((a, b) => b.days - a.days),
    employees: [...byEmployee.values()].filter((e) => e.records || e.leave_days).map((e) => ({ ...e, attendance_rate: pct(e.attended, e.records) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function reportPdf(report, branchName) {
  const pdf = buildTablePdf({
    title: `Branch Report — ${branchName}`,
    subtitle: `${formatDateKey(report.from)} to ${formatDateKey(report.to)}`,
    summary: [
      ["Attendance rate", `${report.summary.attendance_rate}%`],
      ["Days attended / expected", `${report.summary.attended_days} / ${report.summary.expected_days}`],
      ["Late days", String(report.summary.late_days)],
      ["Leave days", String(report.summary.leave_days)],
      ...report.leave_usage.map((t) => [`Leave: ${t.leave_type}`, `${t.days} day(s), ${t.requests} request(s)`]),
    ],
    columns: [
      { header: "Employee", width: 150 }, { header: "Attended", width: 55, align: "right" }, { header: "Absent", width: 50, align: "right" },
      { header: "Late days", width: 55, align: "right" }, { header: "Late min", width: 55, align: "right" },
      { header: "Leave days", width: 60, align: "right" }, { header: "Rate", width: 50, align: "right" },
    ],
    rows: report.employees.map((e) => [e.name, String(e.attended), String(e.absent), String(e.late), String(e.late_minutes), String(e.leave_days), `${e.attendance_rate}%`]),
    footer: `SACS Payroll · Branch Reports · ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}`,
  });
  return new NextResponse(pdf, {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="branch-report-${report.from}-to-${report.to}.pdf"`, "Cache-Control": "no-store" },
  });
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "read");
    if (guard.denied) return guard.denied;
    const url = new URL(request.url);
    const view = normalizeText(url.searchParams.get("view")).toLowerCase() || "dashboard";
    const supabase = getAdminClient();
    const branchId = guard.branchId;
    if (!branchId) return NextResponse.json({ error: "Your account has no branch." }, { status: 403 });

    // The Accountant reads the Admin's overtime / substitute confirmations only.
    if (guard.role !== "admin") {
      if (guard.role !== "accountant" || view !== "requests") {
        return NextResponse.json({ error: "You do not have permission to perform this action." }, { status: 403 });
      }
      const { rows, error } = await branchRequests(supabase, branchId, ["overtime_confirmation"]);
      if (error) return NextResponse.json({ available: false, error, requests: [] });
      return NextResponse.json({ available: true, requests: rows.map((r) => shapeRequest(r)) });
    }

    const staff = await loadBranchStaff(supabase, branchId, { includeArchived: view === "reports" });
    if (view === "dashboard") return NextResponse.json(await dashboardView(supabase, branchId, staff));
    if (view === "attendance") return NextResponse.json(await attendanceView(supabase, branchId, staff, url));
    if (view === "leaves") return NextResponse.json(await leavesView(supabase, branchId, staff));
    if (view === "transfers") return NextResponse.json(await transfersView(supabase, branchId, staff));
    if (view === "payroll") return NextResponse.json(await payrollView(supabase, branchId));
    if (view === "employees") return NextResponse.json({ employees: staff });
    if (view === "cutoffs") {
      const month = manilaDateKey().slice(0, 7);
      return NextResponse.json({ cutoffs: await cutoffsFor(supabase, [month, shiftMonth(month, 1)]), month, today: manilaDateKey() });
    }
    if (view === "reports") {
      const report = await reportsView(supabase, branchId, staff, url);
      if (normalizeText(url.searchParams.get("format")).toLowerCase() === "pdf") {
        const branch = await supabase.from("branches").select("name").eq("id", branchId).maybeSingle();
        return reportPdf(report, branch.data?.name || "Branch");
      }
      return NextResponse.json(report);
    }
    if (view === "requests") {
      const kinds = normalizeText(url.searchParams.get("kind")).split(",").map((k) => k.trim()).filter((k) => REQUEST_KINDS[k]);
      const { rows, error } = await branchRequests(supabase, branchId, kinds.length ? kinds : null);
      if (error) return NextResponse.json({ available: false, error, requests: [] });
      const month = manilaDateKey().slice(0, 7);
      return NextResponse.json({
        available: true,
        requests: rows.map((r) => shapeRequest(r)),
        employees: staff,
        cutoffs: kinds.includes("incentive_endorsement") ? await cutoffsFor(supabase, [month, shiftMonth(month, 1)]) : undefined,
      });
    }
    return NextResponse.json({ error: "Unknown view." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

/* ── POST: the Admin files, endorses or confirms ─────────────────────────── */

const ENDORSE = { endorse: "endorsed", not_endorse: "not_endorsed" };

function bad(message, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "create");
    if (guard.denied) return guard.denied;
    if (guard.role !== "admin") return bad("Only the branch Admin files these.", 403);
    const branchId = guard.branchId;
    if (!branchId) return bad("Your account has no branch.", 403);
    const body = await request.json().catch(() => ({}));
    if (normalizeText(body.action) !== "file") return bad("Unknown action.");
    const kind = normalizeText(body.kind);
    if (!REQUEST_KINDS[kind]) return bad("Choose what you are sending.");
    const note = normalizeText(body.note).slice(0, 1000);
    if (note.length < 3) return bad("Write a remark for HR.");
    const supabase = getAdminClient();
    const staff = await loadBranchStaff(supabase, branchId);
    const person = body.employee_id ? staff.find((p) => p.id === normalizeText(body.employee_id)) : null;
    if (body.employee_id && !person) return bad("That employee is not in your branch.", 404);
    const d = body.details && typeof body.details === "object" ? body.details : {};
    const today = manilaDateKey();
    let refId = null;
    let employeeId = person?.id || null;
    let status = "pending";
    let details = {};
    let outcomeRef = null;

    if (kind === "attendance_flag") {
      const log = UUID.test(String(body.ref_id || "")) ? (await supabase.from("attendance_logs").select("id,employee_id,log_date,status,time_in,time_out").eq("id", body.ref_id).maybeSingle()).data : null;
      const owner = log ? staff.find((p) => p.id === log.employee_id) : null;
      if (!log || !owner) return bad("Attendance record not found in your branch.", 404);
      const open = await supabase.from("branch_admin_requests").select("id").eq("kind", kind).eq("ref_id", log.id).eq("status", "pending").maybeSingle();
      if (open.data) return bad("This record is already flagged and waiting for HR.", 409);
      refId = log.id; employeeId = owner.id;
      details = { employee_name: owner.full_name, log_date: log.log_date, log_status: log.status, time_in: log.time_in, time_out: log.time_out };
    } else if (kind === "leave_endorsement") {
      const leave = (await supabase.from("leave_requests").select("id,employee_id,employee_name,leave_type,start_date,end_date,status,branch_id").eq("id", normalizeText(body.ref_id)).maybeSingle()).data;
      const owner = leave ? staff.find((p) => p.id === leave.employee_id) : null;
      if (!leave || (!owner && String(leave.branch_id || "") !== String(branchId))) return bad("Leave request not found in your branch.", 404);
      if (!LEAVE_PENDING.includes(leave.status)) return bad("HR has already decided this leave request.", 409);
      if (!ENDORSE[body.decision]) return bad("Choose Endorse or Not endorse.");
      refId = leave.id; employeeId = leave.employee_id; status = ENDORSE[body.decision];
      details = { employee_name: owner?.full_name || leave.employee_name, leave_type: leave.leave_type, start_date: leave.start_date, end_date: leave.end_date };
    } else if (kind === "transfer_endorsement") {
      const transfer = UUID.test(String(body.ref_id || "")) ? (await supabase.from("transfer_requests").select("*").eq("id", body.ref_id).maybeSingle()).data : null;
      if (!transfer || (String(transfer.from_branch_id || "") !== String(branchId) && String(transfer.to_branch_id || "") !== String(branchId))) return bad("Transfer not found for your branch.", 404);
      if (transfer.status !== "pending") return bad("HR has already decided this transfer.", 409);
      if (!ENDORSE[body.decision]) return bad("Choose Endorse or Not endorse.");
      const who = (await supabase.from("profiles").select("full_name").eq("id", transfer.employee_id).maybeSingle()).data;
      refId = transfer.id; employeeId = transfer.employee_id; status = ENDORSE[body.decision];
      details = { employee_name: who?.full_name || "Employee", direction: String(transfer.to_branch_id) === String(branchId) ? "incoming" : "outgoing" };
    } else if (kind === "incident_report") {
      if (!person) return bad("Choose the employee.");
      const type = INCIDENT_TYPES[d.incident_type] ? d.incident_type : null;
      const date = normalizeText(d.incident_date);
      if (!type) return bad("Choose the kind of incident.");
      if (!isDateKey(date) || date > today) return bad("Choose the date it happened (not in the future).");
      details = { employee_name: person.full_name, incident_type: type, incident_type_label: INCIDENT_TYPES[type], incident_date: date };
      if (type === "no_show") {
        // It lands in HR's AWOL Cases queue: an open case, or a new flagged one.
        const open = await supabase.from("employee_awol_cases").select("id").eq("employee_id", person.id).neq("stage", "closed").maybeSingle();
        if (open.data?.id) {
          outcomeRef = open.data.id;
        } else {
          const created = await supabase.from("employee_awol_cases").insert({
            employee_id: person.id, branch_id: branchId, first_absent_on: date, stage: "flagged",
            notes: `Reported by branch Admin ${actorName(guard)}: ${note}`.slice(0, 1000),
          }).select("id").maybeSingle();
          if (created.error && String(created.error.code) !== "23505") throw new Error(created.error.message);
          outcomeRef = created.data?.id || null;
        }
      }
    } else if (kind === "schedule_request") {
      if (!person) return bad("Choose the employee.");
      const type = SCHEDULE_REQUEST_TYPES[d.request_type] ? d.request_type : null;
      const effective = normalizeText(d.effective_from);
      const requested = normalizeText(d.requested).slice(0, 500);
      if (!type) return bad("Choose a schedule or class-load change.");
      if (!isDateKey(effective) || effective < today) return bad("Choose when it should start (today or later).");
      if (requested.length < 3) return bad("Describe the change you are asking for.");
      details = { employee_name: person.full_name, request_type: type, request_type_label: SCHEDULE_REQUEST_TYPES[type], effective_from: effective, requested };
    } else if (kind === "rfid_issue") {
      const type = RFID_ISSUE_TYPES[d.issue_type] ? d.issue_type : null;
      if (!type) return bad("Choose the kind of problem.");
      details = { employee_name: person?.full_name || null, issue_type: type, issue_type_label: RFID_ISSUE_TYPES[type], device: normalizeText(d.device).slice(0, 120) || null };
    } else if (kind === "overtime_confirmation") {
      if (!person) return bad("Choose the employee.");
      const type = OVERTIME_TYPES[d.work_type] ? d.work_type : null;
      const date = normalizeText(d.work_date);
      const hours = Number(d.hours);
      if (!type) return bad("Choose overtime or substitute teaching.");
      if (!isDateKey(date) || date > today) return bad("Choose the day it happened (not in the future).");
      if (!(Number.isFinite(hours) && hours > 0 && hours <= 24)) return bad("Enter the hours (more than 0, at most 24).");
      if (!ENDORSE[body.decision]) return bad("Confirm (Endorse) or Not endorse.");
      status = ENDORSE[body.decision];
      details = { employee_name: person.full_name, work_type: type, work_type_label: OVERTIME_TYPES[type], work_date: date, hours: Math.round(hours * 100) / 100, covered_for: normalizeText(d.covered_for).slice(0, 120) || null };
    } else if (kind === "incentive_endorsement") {
      if (!person) return bad("Choose the employee.");
      const itemKind = d.kind === "overload" ? "overload" : d.kind === "incentive" ? "incentive" : null;
      const date = normalizeText(d.item_date);
      const amount = Number(d.amount);
      const hours = Number(d.hours);
      const description = normalizeText(d.description).slice(0, 200);
      if (!itemKind) return bad("Choose incentive or overload.");
      if (!isDateKey(date) || date < "2026-10-01") return bad("Choose the date it is for (from Oct 1, 2026).");
      if (itemKind === "incentive" && !(Number.isFinite(amount) && amount > 0 && amount <= 9999999.99)) return bad("Enter an amount greater than 0.");
      if (itemKind === "overload" && !(Number.isFinite(hours) && hours > 0 && hours <= 744)) return bad("Enter overload hours greater than 0.");
      if (!description) return bad("Describe what it is for.");
      details = { employee_name: person.full_name, kind: itemKind, item_date: date, amount: itemKind === "incentive" ? roundPeso(amount) : null, hours: itemKind === "overload" ? Math.round(hours * 100) / 100 : null, description };
    }

    const entry = historyEntry({ action: REQUEST_KINDS[kind].endorsement ? "endorse" : "file", status, by: guard.userId, byName: actorName(guard), role: "admin", note });
    let saved;
    if (REQUEST_KINDS[kind].endorsement && refId) {
      // One per record: a second answer changes it, with history.
      const existing = (await supabase.from("branch_admin_requests").select("*").eq("kind", kind).eq("ref_id", refId).eq("branch_id", branchId).maybeSingle()).data;
      if (existing) {
        const updated = await supabase.from("branch_admin_requests").update({
          status, admin_note: note, details: { ...existing.details, ...details },
          created_by: guard.userId, created_by_name: actorName(guard),
          history: [...(existing.history || []), { ...entry, action: "change" }],
        }).eq("id", existing.id).select("*").maybeSingle();
        if (updated.error) throw new Error(updated.error.message);
        saved = updated.data;
      }
    }
    if (!saved) {
      const inserted = await supabase.from("branch_admin_requests").insert({
        branch_id: branchId, kind, employee_id: employeeId, ref_id: refId, details, admin_note: note, status,
        created_by: guard.userId, created_by_name: actorName(guard), outcome_ref: outcomeRef, history: [entry],
      }).select("*").maybeSingle();
      if (inserted.error) {
        if (String(inserted.error.code) === "42P01") return bad(NOT_READY, 503);
        throw new Error(inserted.error.message);
      }
      saved = inserted.data;
    }

    const label = REQUEST_KINDS[kind].label;
    const subject = details.employee_name ? ` · ${details.employee_name}` : "";
    const recipients = [...await hrAccountIds(supabase), ...(kind === "rfid_issue" ? await superAdminIds(supabase) : [])];
    await notify(supabase, recipients, {
      kind: `branch_${kind}`,
      title: `${label}${subject}`,
      body: `${actorName(guard)} (branch Admin): ${STATUS_LABELS[status]}. ${note}`,
      link_page: kind === "leave_endorsement" ? "hr-leaves" : kind === "transfer_endorsement" ? "hr-transfers" : kind === "incident_report" ? "hr-awol" : "hr-branch-requests",
    });
    await appendAuditLog({
      actor: guard, module: "branch_oversight", action: `branch_${kind}`, entity_type: "branch_admin_request", entity_id: saved?.id || null,
      status: "success", source: "api", description: `${label}${subject}: ${STATUS_LABELS[status]} (${note}).`,
      metadata: { kind, ref_id: refId, employee_id: employeeId, status, outcome_ref: outcomeRef },
    });
    return NextResponse.json({ success: true, request: shapeRequest(saved) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
