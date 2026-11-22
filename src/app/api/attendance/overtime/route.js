import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission, denyForeignBranch } from "@/lib/rbac/guard";
import { can, SCOPE_SELF } from "@/lib/rbac/permissions";
import { UNRESOLVED_STATUSES, normalizeAttendanceStatus } from "@/lib/attendance/status";
import { loadAttendanceConfig, resolveAttendancePolicy } from "@/lib/attendance/policy";
import { minutesToHHMM } from "@/lib/attendance/work-schedules";
import { isDateKey, manilaDateKey, periodForDateKey, periodFromLabel } from "@/lib/payroll/periods";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";

/**
 * Late time outs, read only (Part B, 2026-11-22).
 *
 *   GET   /api/attendance/overtime?period=<label> | ?from=&to=  [&branch_id=]
 *         Days whose time out is at least OVERTIME_MIN_MINUTES after the
 *         branch's scheduled end: the overtime request filed for the day (or
 *         "Overtime not filed") and any older approval, kept as history.
 *
 * Overtime is paid only from approved overtime requests
 * (/api/hr/overtime-requests, overtime_request_sync); approving minutes from
 * late taps here was removed on 2026-11-22 (user decision). A late tap out
 * alone never pays anything. Scope follows the attendance
 * board: Employees see their own days, an Admin its branch, HR and Super
 * Admin every branch. Deciding needs the attendance "update" permission, and
 * is refused once that employee's pay period has been processed.
 */

/** Minutes past the scheduled end before a day is listed as overtime. */
const OVERTIME_MIN_MINUTES = 30;
const MAX_RANGE_DAYS = 62;
const NOTE_MAX = 300;

function resolveRange(url) {
  const from = normalizeText(url.searchParams.get("from"));
  const to = normalizeText(url.searchParams.get("to"));
  if (isDateKey(from) && isDateKey(to) && from <= to) return { from, to, label: `${from} to ${to}` };
  const period = periodFromLabel(url.searchParams.get("period")) || periodForDateKey(manilaDateKey());
  return { from: period.start_key, to: period.end_key, label: period.label };
}

/** Whole minutes between the day's scheduled end (Manila) and the time out. */
function overtimeMinutes(log, policy) {
  if (!log?.time_out || !isDateKey(String(log.log_date || "").slice(0, 10))) return 0;
  const end = new Date(`${String(log.log_date).slice(0, 10)}T${policy.work_end}:00+08:00`);
  const out = new Date(log.time_out);
  if (Number.isNaN(end.getTime()) || Number.isNaN(out.getTime())) return 0;
  return Math.max(0, Math.floor((out - end) / 60000));
}

async function policiesFor(supabase, branchIds) {
  const config = await loadAttendanceConfig(supabase, branchIds);
  const cache = new Map();
  return (branchId, log = null) => {
    const key = String(branchId || "");
    if (!cache.has(key)) cache.set(key, resolveAttendancePolicy(config, branchId || null));
    const policy = cache.get(key);
    // The day's own schedule end (the employee's schedule), when recorded.
    const end = log?.shift_end_minutes;
    return end === null || end === undefined || !Number.isFinite(Number(end))
      ? policy
      : { ...policy, work_end: minutesToHHMM(Number(end)) };
  };
}

/** Pay periods already processed for these employees: Set of "employeeId|label". */
async function paidPeriods(supabase, employeeIds) {
  if (!employeeIds.length) return new Set();
  const result = await fetchAllIn(() => supabase
    .from("payroll_entries")
    .select("id,employee_id,pay_period,status")
    .eq("status", "paid")
    .order("id", { ascending: true }), "employee_id", employeeIds);
  if (result.error) throw new Error(result.error.message);
  return new Set((result.data || []).map((row) => `${row.employee_id}|${row.pay_period}`));
}

export async function GET(request) {
  const guard = await requirePermission(request, "attendance", "read");
  if (guard.denied) return guard.denied;

  try {
    const url = new URL(request.url);
    const range = resolveRange(url);
    const spanDays = (new Date(`${range.to}T00:00:00Z`) - new Date(`${range.from}T00:00:00Z`)) / 86400000;
    if (spanDays > MAX_RANGE_DAYS) {
      return NextResponse.json({ error: `Choose a range of ${MAX_RANGE_DAYS} days or fewer.` }, { status: 400 });
    }

    const supabase = getAdminClient();
    const selfOnly = guard.scope === SCOPE_SELF;

    // Who this caller may see, by their CURRENT branch (as the status board).
    let employeeIds = null;
    if (selfOnly) {
      employeeIds = [guard.userId];
    } else {
      const branchFilter = guard.branchExempt ? normalizeText(url.searchParams.get("branch_id")) : guard.branchId;
      if (branchFilter) {
        const roster = await fetchAllRows(() => supabase.from("profiles").select("id").eq("branch_id", branchFilter).order("id", { ascending: true }));
        if (roster.error) throw new Error(roster.error.message);
        employeeIds = (roster.data || []).map((row) => row.id);
      }
    }
    const canReview = !selfOnly && can(guard.role, "attendance", "update");
    if (employeeIds && !employeeIds.length) {
      return NextResponse.json({ range, overtime: [], can_review: canReview, min_minutes: OVERTIME_MIN_MINUTES });
    }

    // Every row of the range, paged (a .limit(5000) silently dropped the rest
    // of a big branch), and a branch's ids in chunks (URL length).
    const buildLogs = () => supabase
      .from("attendance_logs")
      // "*": includes shift_end_minutes, the end of the schedule the day was
      // judged on (20261013010000), when the column exists.
      .select("*")
      .gte("log_date", range.from)
      .lte("log_date", range.to)
      .eq("archived_duplicate", false)
      .order("log_date", { ascending: false })
      .order("id", { ascending: true });
    const logsResult = employeeIds ? await fetchAllIn(buildLogs, "employee_id", employeeIds) : await fetchAllRows(buildLogs);
    if (!logsResult.error) logsResult.data.sort((a, b) => String(b.log_date).localeCompare(String(a.log_date)));
    if (logsResult.error) throw new Error(logsResult.error.message);

    const logs = (logsResult.data || []).filter((row) => row.time_in && row.time_out
      && !UNRESOLVED_STATUSES.includes(normalizeAttendanceStatus(row.status)));
    const policyFor = await policiesFor(supabase, logs.map((row) => row.branch_id));

    const candidates = logs
      .map((row) => {
        const policy = policyFor(row.branch_id, row);
        return { row, policy, minutes: overtimeMinutes(row, policy) };
      })
      .filter((item) => item.minutes >= OVERTIME_MIN_MINUTES);

    const approvals = new Map();
    if (candidates.length) {
      const result = await fetchAllIn(() => supabase
        .from("attendance_overtime_approvals")
        .select("log_id,approved_minutes,status,note,decided_by_name,decided_at")
        .order("log_id", { ascending: true }), "log_id", candidates.map((item) => item.row.id));
      if (result.error) throw new Error(result.error.message);
      (result.data || []).forEach((row) => approvals.set(String(row.log_id), row));
    }
    const paid = await paidPeriods(supabase, [...new Set(candidates.map((item) => item.row.employee_id))]);
    // Part B (2026-11-22): overtime is requested ahead. A late tap out with no
    // pending or approved request is flagged "Overtime not filed" and pays nothing.
    const filed = new Map();
    if (candidates.length) {
      const dates = candidates.map((item) => String(item.row.log_date).slice(0, 10)).sort();
      const result = await fetchAllIn(() => supabase
        .from("overtime_requests")
        .select("employee_id,request_date,status,minutes")
        .in("status", ["pending", "approved"])
        .gte("request_date", dates[0])
        .lte("request_date", dates.at(-1)), "employee_id", [...new Set(candidates.map((item) => item.row.employee_id))]);
      if (result.error) throw new Error(result.error.message);
      (result.data || []).forEach((r) => filed.set(`${r.employee_id}|${r.request_date}`, { status: r.status, minutes: r.minutes }));
    }

    return NextResponse.json({
      range,
      min_minutes: OVERTIME_MIN_MINUTES,
      can_review: canReview,
      overtime: candidates.map(({ row, policy, minutes }) => ({
        log_id: row.id,
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        log_date: row.log_date,
        time_in: row.time_in,
        time_out: row.time_out,
        work_end: policy.work_end,
        overtime_minutes: minutes,
        approval: approvals.get(String(row.id)) || null,
        request: filed.get(`${row.employee_id}|${String(row.log_date).slice(0, 10)}`) || null,
        flag: filed.has(`${row.employee_id}|${String(row.log_date).slice(0, 10)}`) ? null : "Overtime not filed",
        locked: paid.has(`${row.employee_id}|${periodForDateKey(String(row.log_date).slice(0, 10)).label}`),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
