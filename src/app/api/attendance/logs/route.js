import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { requirePermission } from "@/lib/rbac/guard";
import { can, SCOPE_SELF } from "@/lib/rbac/permissions";
import {
  ATTENDANCE_STATUSES,
  CORRECTABLE_STATUSES,
  UNRESOLVED_STATUSES,
  normalizeAttendanceStatus,
} from "@/lib/attendance/status";
import { isDateKey, manilaDateKey, periodForDateKey, periodFromLabel } from "@/lib/payroll/periods";
import { listNotTapped } from "@/lib/attendance/not-tapped";
import { readApprovedLeave, readBlockedTaps } from "@/lib/attendance/leave";
import { annotateAttendanceRows } from "@/lib/attendance/annotate";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

/**
 * GET /api/attendance/logs — the attendance status board.
 *
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   range (default: the current pay period)
 *   ?period=<pay period label>       alternative to from/to
 *   ?status=<status>|unresolved      one status, or Incomplete + Pending Correction
 *   ?branch_id=<uuid>                (Super Admin / HR only) one branch
 *
 * Employees get their own records only (scope self); Admin its branch; HR and
 * Super Admin every branch. Rows are attributed to the branch the employee is
 * in NOW (profiles.branch_id), the same rule the Attendance page uses.
 *
 * Before reading, the range's finished days are closed
 * (public.attendance_close_days), so an Incomplete or Absent day shows here
 * even if the nightly job has not run.
 */

const LOG_COLUMNS = "id,employee_id,employee_name,employee_type,branch_id,log_date,time_in,time_out,total_hours,status,late_minutes,undertime_minutes,is_half_day,is_early_bird,schedule_id,updated_at";
const MAX_RANGE_DAYS = 62;

function resolveRange(url) {
  const from = normalizeText(url.searchParams.get("from"));
  const to = normalizeText(url.searchParams.get("to"));
  if (isDateKey(from) && isDateKey(to) && from <= to) return { from, to, label: `${from} to ${to}` };

  const period = periodFromLabel(url.searchParams.get("period")) || periodForDateKey(manilaDateKey());
  return { from: period.start_key, to: period.end_key, label: period.label };
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

    // Who this caller may see, by their CURRENT branch.
    let employeeIds = null;
    if (selfOnly) {
      employeeIds = [guard.userId];
    } else {
      const branchFilter = guard.branchExempt ? normalizeText(url.searchParams.get("branch_id")) : guard.branchId;
      if (branchFilter) {
        const roster = await supabase.from("profiles").select("id").eq("branch_id", branchFilter).limit(5000);
        if (roster.error) throw new Error(roster.error.message);
        employeeIds = (roster.data || []).map((row) => row.id);
      }
    }

    const closed = await supabase.rpc("attendance_close_days", { p_from: range.from, p_to: range.to });
    const engineReady = !closed.error;

    if (employeeIds && !employeeIds.length) {
      return NextResponse.json({ range, logs: [], counts: {}, statuses: ATTENDANCE_STATUSES, engine_ready: engineReady });
    }
    const statusFilter = normalizeText(url.searchParams.get("status"));

    // Paged: a 62-day range for ~200 employees is several thousand rows, past
    // PostgREST's max-rows (1000 by default); an unpaged read silently hides
    // the rest, including Incomplete days HR has to resolve.
    const result = await fetchAllRows(() => {
      let query = supabase
        .from("attendance_logs")
        .select(engineReady ? LOG_COLUMNS : "id,employee_id,employee_name,employee_type,branch_id,log_date,time_in,time_out,total_hours,status")
        .gte("log_date", range.from)
        .lte("log_date", range.to)
        .eq("archived_duplicate", false)
        .order("log_date", { ascending: false })
        .order("employee_name", { ascending: true })
        .order("id", { ascending: true });
      if (employeeIds) query = query.in("employee_id", employeeIds);
      if (statusFilter === "unresolved") query = query.in("status", UNRESOLVED_STATUSES);
      else if (statusFilter && statusFilter !== "all") query = query.eq("status", normalizeAttendanceStatus(statusFilter, statusFilter));
      return query;
    });
    if (result.error) throw new Error(result.error.message);

    const logs = (result.data || []).map((row) => ({
      ...row,
      status: normalizeAttendanceStatus(row.status),
    }));

    // Today has no Absent records until the nightly close, so everyone who
    // has not tapped yet is added by name (reviewers only -- an employee's own
    // view does not call them absent before the day is over).
    const today = manilaDateKey();
    const wantsAbsent = !statusFilter || statusFilter === "all" || normalizeAttendanceStatus(statusFilter, "") === "Absent";
    if (!selfOnly && wantsAbsent && today >= range.from && today <= range.to) {
      let todayQuery = supabase
        .from("attendance_logs")
        .select("employee_id")
        .eq("log_date", today)
        .eq("archived_duplicate", false)
        .limit(5000);
      if (employeeIds) todayQuery = todayQuery.in("employee_id", employeeIds);
      const todayRows = await todayQuery;
      const loggedIds = new Set((todayRows.error ? [] : todayRows.data || []).map((row) => String(row.employee_id)));
      logs.push(...await listNotTapped(supabase, { dateKey: today, loggedIds, employeeIds }));
    }

    // Open correction requests, so the board can show "Pending review" and
    // the employee cannot file a second one.
    const pendingByLog = new Map();
    if (engineReady && logs.length) {
      const pending = await supabase
        .from("attendance_corrections")
        .select("id,log_id,corrected_time_out,reason,requested_at,status")
        .eq("status", "pending")
        .in("log_id", logs.map((row) => row.id).filter(Boolean).slice(0, 1000));
      if (!pending.error) (pending.data || []).forEach((row) => pendingByLog.set(row.log_id, row));
    }

    // Reviewers: branch / employee ID each row is grouped and labelled by,
    // and who corrected each Corrected day and why.
    const labelled = selfOnly ? logs : await annotateAttendanceRows(supabase, logs);

    const counts = {};
    logs.forEach((row) => { counts[row.status] = (counts[row.status] || 0) + 1; });

    // What each On Leave day is (type, dates, approver).
    const leaveFor = logs.some((row) => row.status === "On Leave")
      ? await readApprovedLeave(supabase, { employeeIds, from: range.from, to: range.to })
      : () => null;

    // Refused taps (unregistered card, inactive employee, another branch's card,
    // approved leave), for reviewers to see -- by employee, and by where tapped.
    const tapBranch = guard.branchExempt ? normalizeText(url.searchParams.get("branch_id")) : guard.branchId;
    const blockedTaps = selfOnly ? [] : await readBlockedTaps(supabase, { employeeIds, branchId: tapBranch || null, from: range.from, to: range.to });

    return NextResponse.json({
      range,
      logs: labelled.map((row) => ({
        ...row,
        leave: row.status === "On Leave" ? leaveFor(row.employee_id, row.log_date) : null,
        correction: pendingByLog.get(row.id) || null,
        can_request_correction: selfOnly
          && CORRECTABLE_STATUSES.includes(row.status)
          && Boolean(row.time_in)
          && !pendingByLog.has(row.id),
      })),
      counts,
      blocked_taps: blockedTaps,
      statuses: ATTENDANCE_STATUSES,
      engine_ready: engineReady,
      scope: guard.scope,
      can_review: can(guard.role, "attendance_corrections", "update"),
      today: manilaDateKey(),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
