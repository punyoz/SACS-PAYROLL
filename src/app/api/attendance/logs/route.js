import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { requirePermission } from "@/lib/rbac/guard";
import { can, SCOPE_SELF } from "@/lib/rbac/permissions";
import {
  ATTENDANCE_STATUSES,
  CORRECTABLE_STATUSES,
  PRESENT_FILTER,
  PRESENT_STATUSES,
  UNRESOLVED_STATUSES,
  normalizeAttendanceStatus,
} from "@/lib/attendance/status";
import { isDateKey, manilaDateKey, periodForDateKey, periodFromLabel } from "@/lib/payroll/periods";
import { listNotTapped } from "@/lib/attendance/not-tapped";
import { readHolidayMap } from "@/lib/attendance/holidays";
import { readApprovedLeave, readBlockedTaps } from "@/lib/attendance/leave";
import { annotateAttendanceRows } from "@/lib/attendance/annotate";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";
import { pageParams } from "@/lib/portal/date-range";
import { reportResponse, wantsFile } from "@/lib/export/report-file";
import { loadDemoIds, notDemo } from "@/lib/demo";

/**
 * GET /api/attendance/logs — the attendance status board.
 *
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   range (default: the current pay period)
 *   ?period=<pay period label>       alternative to from/to
 *   ?status=<status>|unresolved      one status, or Incomplete + Pending Correction
 *   ?branch_id=<uuid>                (Super Admin / HR only) one branch
 *   ?q=<text>                        employee name or employee ID (2026-11-09)
 *   ?day=YYYY-MM-DD                  one day of the range (2026-11-09)
 *   ?page=&page_size=                server-side pages (10 / 25 / 50 / 100):
 *                                    `counts` is every status of the range
 *                                    (search, branch and day applied; the
 *                                    status filter not), `total` the rows of
 *                                    the chosen status, `logs` one page.
 *
 * Today's people who have not tapped yet are listed with the status
 * "Not tapped yet" (not Absent): the day is not over (redesign 2026-11-09).
 *
 * Employees get their own records only (scope self); Admin its branch; HR and
 * Super Admin every branch. Rows are attributed to the branch the employee is
 * in NOW (profiles.branch_id), the same rule the Attendance page uses.
 *
 * Before reading, the range's finished days are closed
 * (public.attendance_close_days), so an Incomplete or Absent day shows here
 * even if the nightly job has not run.
 */

const LIGHT_COLUMNS = "id,employee_id,employee_name,log_date,status";
const NOT_TAPPED_YET = "Not tapped yet";
const LOG_COLUMNS = "id,employee_id,employee_name,employee_type,branch_id,log_date,time_in,time_out,total_hours,status,late_minutes,undertime_minutes,is_half_day,is_early_bird,schedule_id,updated_at";
const MAX_RANGE_DAYS = 62;
const MAX_SELF_RANGE_DAYS = 366;

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
    // Two dates the wrong way round are refused with the reason (2026-11-09),
    // not quietly replaced by the current pay period.
    const askedFrom = normalizeText(url.searchParams.get("from"));
    const askedTo = normalizeText(url.searchParams.get("to"));
    if (isDateKey(askedFrom) && isDateKey(askedTo) && askedTo < askedFrom) {
      return NextResponse.json({ error: "The To date is before the From date.", code: "range_reversed" }, { status: 400 });
    }
    const range = resolveRange(url);
    const selfOnly = guard.scope === SCOPE_SELF;
    // An employee's own records: up to a year (alpha test A1). Reviewers'
    // board groups every row of the range, so it stays at 62 days.
    const maxDays = selfOnly ? MAX_SELF_RANGE_DAYS : MAX_RANGE_DAYS;
    const spanDays = (new Date(`${range.to}T00:00:00Z`) - new Date(`${range.from}T00:00:00Z`)) / 86400000;
    if (spanDays + 1 > maxDays) {
      return NextResponse.json({ error: `Choose a range of ${maxDays} days or fewer.` }, { status: 400 });
    }
    const paging = url.searchParams.has("page") ? pageParams(url, { defaultSize: 25, maxSize: 100 }) : null;

    const supabase = getAdminClient();

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
    // Search (name or employee ID) and one day, in the query (2026-11-09).
    const q = normalizeText(url.searchParams.get("q")).slice(0, 80).replace(/[%_,()*\\]/g, " ").trim();
    const dayParam = normalizeText(url.searchParams.get("day"));
    const day = isDateKey(dayParam) && dayParam >= range.from && dayParam <= range.to ? dayParam : "";
    let idsByCode = [];
    if (q && !selfOnly) {
      const byCode = await supabase.from("profiles").select("id").ilike("employee_id", `%${q}%`).limit(200);
      idsByCode = (byCode.data || []).map((row) => row.id);
    }

    // Paged: a 62-day range for ~200 employees is several thousand rows, past
    // PostgREST's max-rows (1000 by default); an unpaged read silently hides
    // the rest, including Incomplete days HR has to resolve.
    const buildLogs = (columns = null) => {
      let query = supabase
        .from("attendance_logs")
        .select(columns || (engineReady ? LOG_COLUMNS : "id,employee_id,employee_name,employee_type,branch_id,log_date,time_in,time_out,total_hours,status"))
        .gte("log_date", range.from)
        .lte("log_date", range.to)
        .eq("archived_duplicate", false)
        .order("log_date", { ascending: false })
        .order("employee_name", { ascending: true })
        .order("id", { ascending: true });
      if (q) query = idsByCode.length ? query.or(`employee_name.ilike.%${q}%,employee_id.in.(${idsByCode.join(",")})`) : query.ilike("employee_name", `%${q}%`);
      if (day) query = query.eq("log_date", day);
      // Paged reads count every status first; the status is chosen below.
      if (paging) return query;
      if (statusFilter === "unresolved") query = query.in("status", UNRESOLVED_STATUSES);
      // "Present": the shared group (decision 2026-11-14), as on the dashboards.
      else if (statusFilter === PRESENT_FILTER) query = query.in("status", PRESENT_STATUSES);
      else if (statusFilter && statusFilter !== "all") query = query.eq("status", normalizeAttendanceStatus(statusFilter, statusFilter));
      return query;
    };
    const matchesStatus = (row) => {
      if (!statusFilter || statusFilter === "all") return true;
      if (statusFilter === "unresolved") return UNRESOLVED_STATUSES.includes(row.status);
      if (statusFilter === NOT_TAPPED_YET) return row.status === NOT_TAPPED_YET;
      if (statusFilter === PRESENT_FILTER) return PRESENT_STATUSES.includes(row.status);
      return row.status === normalizeAttendanceStatus(statusFilter, statusFilter);
    };

    // Server-side pages (2026-11-09): a light read of the whole range for the
    // counts and the order, then the full rows of one page only.
    if (paging) {
      const light = employeeIds ? await fetchAllIn(() => buildLogs(LIGHT_COLUMNS), "employee_id", employeeIds) : await fetchAllRows(() => buildLogs(LIGHT_COLUMNS));
      if (light.error) throw new Error(light.error.message);
      let rows = (light.data || []).map((row) => ({ ...row, status: normalizeAttendanceStatus(row.status) }));
      const todayKey = manilaDateKey();
      if (!selfOnly && todayKey >= range.from && todayKey <= range.to && (!day || day === todayKey)) {
        const buildToday = () => supabase.from("attendance_logs").select("employee_id,id").eq("log_date", todayKey).eq("archived_duplicate", false).order("id", { ascending: true });
        const todayRows = employeeIds ? await fetchAllIn(buildToday, "employee_id", employeeIds) : await fetchAllRows(buildToday);
        const loggedIds = new Set((todayRows.error ? [] : todayRows.data || []).map((row) => String(row.employee_id)));
        const waiting = (await listNotTapped(supabase, { dateKey: todayKey, loggedIds, employeeIds }))
          .map((row) => ({ ...row, status: NOT_TAPPED_YET, not_tapped_yet: true }))
          .filter((row) => !q || String(row.employee_name || "").toLowerCase().includes(q.toLowerCase()) || idsByCode.includes(row.employee_id));
        rows.push(...waiting);
      }
      const counts = {};
      rows.forEach((row) => { counts[row.status] = (counts[row.status] || 0) + 1; });
      const chosen = rows.filter(matchesStatus).sort((a, b) => String(b.log_date).localeCompare(String(a.log_date))
        || String(a.employee_name || "").localeCompare(String(b.employee_name || "")) || String(a.id || "").localeCompare(String(b.id || "")));
      const pageSlice = chosen.slice(paging.offset, paging.offset + paging.size);
      const ids = pageSlice.filter((row) => row.id).map((row) => row.id);
      const full = ids.length
        ? await fetchAllIn(() => supabase.from("attendance_logs").select(engineReady ? LOG_COLUMNS : "id,employee_id,employee_name,employee_type,branch_id,log_date,time_in,time_out,total_hours,status").order("id", { ascending: true }), "id", ids)
        : { data: [] };
      if (full.error) throw new Error(full.error.message);
      const byId = new Map((full.data || []).map((row) => [row.id, { ...row, status: normalizeAttendanceStatus(row.status) }]));
      const pageRows = pageSlice.map((row) => (row.id ? byId.get(row.id) || row : row));
      const pending = new Map();
      if (engineReady && ids.length) {
        const open = await fetchAllIn(() => supabase.from("attendance_corrections").select("id,log_id,corrected_time_out,reason,requested_at,status").eq("status", "pending").order("id", { ascending: true }), "log_id", ids);
        (open.data || []).forEach((row) => pending.set(row.log_id, row));
      }
      const labelledPage = selfOnly ? pageRows : await annotateAttendanceRows(supabase, pageRows);
      const holidays = await readHolidayMap(supabase, range.from, range.to) || new Map();
      const leaveOf = labelledPage.some((row) => row.status === "On Leave")
        ? await readApprovedLeave(supabase, { employeeIds: [...new Set(labelledPage.map((r) => r.employee_id))], from: range.from, to: range.to })
        : () => null;
      return NextResponse.json({
        range, total: chosen.length, page: paging.page, page_size: paging.size, counts, day: day || null, q: q || null,
        logs: labelledPage.map((row) => ({
          ...row,
          leave: row.status === "On Leave" ? leaveOf(row.employee_id, row.log_date) : null,
          holiday_name: holidays.get(row.log_date)?.name || null,
          correction: pending.get(row.id) || null,
          can_request_correction: selfOnly && CORRECTABLE_STATUSES.includes(row.status) && Boolean(row.time_in) && !pending.has(row.id),
        })),
        days: [...new Set(rows.map((row) => row.log_date))].filter(Boolean).sort().reverse(),
        // The Blocked taps queue of the same range and branch.
        blocked_taps: selfOnly ? [] : await readBlockedTaps(supabase, { employeeIds, branchId: (guard.branchExempt ? normalizeText(url.searchParams.get("branch_id")) : guard.branchId) || null, from: range.from, to: range.to }),
        statuses: ATTENDANCE_STATUSES, engine_ready: engineReady, scope: guard.scope,
        can_review: !guard.myAccount && can(guard.role, "attendance_corrections", "update"), today: todayKey,
      });
    }
    // A branch's employees in chunks (the whole id list made the URL too long).
    const result = employeeIds ? await fetchAllIn(buildLogs, "employee_id", employeeIds) : await fetchAllRows(buildLogs);
    if (result.error) throw new Error(result.error.message);
    if (employeeIds) {
      result.data.sort((a, b) => String(b.log_date).localeCompare(String(a.log_date))
        || String(a.employee_name || "").localeCompare(String(b.employee_name || "")) || String(a.id).localeCompare(String(b.id)));
    }

    const logs = (result.data || []).map((row) => ({
      ...row,
      status: normalizeAttendanceStatus(row.status),
    }));

    // Today has no Absent records until the nightly close, so everyone who
    // has not tapped yet is added by name (reviewers only -- an employee's own
    // view does not call them absent before the day is over).
    const today = manilaDateKey();
    const wantsAbsent = !statusFilter || statusFilter === "all" || statusFilter === NOT_TAPPED_YET;
    if (!selfOnly && wantsAbsent && today >= range.from && today <= range.to) {
      const buildToday = () => supabase
        .from("attendance_logs")
        .select("employee_id,id")
        .eq("log_date", today)
        .eq("archived_duplicate", false)
        .order("id", { ascending: true });
      const todayRows = employeeIds ? await fetchAllIn(buildToday, "employee_id", employeeIds) : await fetchAllRows(buildToday);
      const loggedIds = new Set((todayRows.error ? [] : todayRows.data || []).map((row) => String(row.employee_id)));
      // Not Absent yet: the day is not over (redesign 2026-11-09).
      logs.push(...(await listNotTapped(supabase, { dateKey: today, loggedIds, employeeIds }))
        .map((row) => ({ ...row, status: NOT_TAPPED_YET, not_tapped_yet: true }))
        .filter((row) => !q || String(row.employee_name || "").toLowerCase().includes(q.toLowerCase()) || idsByCode.includes(row.employee_id)));
    }

    // Open correction requests, so the board can show "Pending review" and
    // the employee cannot file a second one.
    const pendingByLog = new Map();
    if (engineReady && logs.length) {
      const pending = await fetchAllIn(() => supabase
        .from("attendance_corrections")
        .select("id,log_id,corrected_time_out,reason,requested_at,status")
        .eq("status", "pending")
        .order("id", { ascending: true }), "log_id", logs.map((row) => row.id));
      if (!pending.error) (pending.data || []).forEach((row) => pendingByLog.set(row.log_id, row));
    }

    // Reviewers: branch / employee ID each row is grouped and labelled by,
    // and who corrected each Corrected day and why.
    const labelled = selfOnly ? logs : await annotateAttendanceRows(supabase, logs);

    const counts = {};
    logs.forEach((row) => { counts[row.status] = (counts[row.status] || 0) + 1; });

    // Which holiday or suspension each Holiday / partial-suspension day is.
    const holidayNames = await readHolidayMap(supabase, range.from, range.to) || new Map();

    // What each On Leave day is (type, dates, approver).
    const leaveFor = logs.some((row) => row.status === "On Leave")
      ? await readApprovedLeave(supabase, { employeeIds, from: range.from, to: range.to })
      : () => null;

    // Refused taps (unregistered card, inactive employee, another branch's card,
    // approved leave), for reviewers to see -- by employee, and by where tapped.
    const tapBranch = guard.branchExempt ? normalizeText(url.searchParams.get("branch_id")) : guard.branchId;
    const blockedTaps = selfOnly ? [] : await readBlockedTaps(supabase, { employeeIds, branchId: tapBranch || null, from: range.from, to: range.to });

    // Excel / PDF of the range (reviewers only; alpha test B1 / B6).
    const fileFormat = selfOnly ? null : wantsFile(url);
    if (fileFormat) {
      // Demo people never reach an export (is_demo, 2026-11-08).
      const demoIds = await loadDemoIds(supabase);
      const clock = (v) => (v ? new Date(v).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" }) : "");
      return reportResponse({
        format: fileFormat, fileName: `attendance-${range.from}-to-${range.to}`, title: "Attendance",
        branch: guard.branchExempt && !normalizeText(url.searchParams.get("branch_id")) ? "All branches" : (labelled[0]?.branch_name || "Branch"),
        period: `${range.from} to ${range.to}`,
        filters: [["Status", statusFilter === "unresolved" ? "Incomplete queue" : statusFilter || "All"], ["Search", q], ["Day", day]],
        columns: [{ header: "Employee" }, { header: "Employee ID" }, { header: "Branch" }, { header: "Date" }, { header: "Time in" }, { header: "Time out" },
          { header: "Hours", kind: "number" }, { header: "Status" }, { header: "Late (min)", kind: "number" }, { header: "Undertime (min)", kind: "number" }],
        rows: labelled.filter(notDemo(demoIds)).map((r) => [r.employee_name || "", r.employee_code || "", r.branch_name || "", r.log_date, clock(r.time_in), clock(r.time_out),
          Number(r.total_hours) || 0, r.status || "", Number(r.late_minutes) || 0, Number(r.undertime_minutes) || 0]),
      });
    }

    // One page (?page=&page_size=), with the total, when asked for.
    const total = labelled.length;
    const pageRows = paging ? labelled.slice(paging.offset, paging.offset + paging.size) : labelled;
    return NextResponse.json({
      range,
      total,
      ...(paging ? { page: paging.page, page_size: paging.size } : {}),
      logs: pageRows.map((row) => ({
        ...row,
        leave: row.status === "On Leave" ? leaveFor(row.employee_id, row.log_date) : null,
        holiday_name: holidayNames.get(row.log_date)?.name || null,
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
      can_review: !guard.myAccount && can(guard.role, "attendance_corrections", "update"),
      today: manilaDateKey(),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
