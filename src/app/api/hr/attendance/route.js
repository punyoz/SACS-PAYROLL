import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { collapseDailyTaps } from "@/lib/attendance/taps";
import { attendanceBucket } from "@/lib/attendance/status";
import { listNotTapped } from "@/lib/attendance/not-tapped";
import { annotateAttendanceRows } from "@/lib/attendance/annotate";
import { requirePermission, denySelfScopeList } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { manilaDateKey as getDateKey } from "@/lib/payroll/periods";
import { checkRange, pageParams } from "@/lib/portal/date-range";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

function getDateLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "2-digit",
    year: "numeric",
  }).format(date);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeRangeBranch(value) {
  const id = String(value || "").trim();
  return UUID_RE.test(id) ? id : null;
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "attendance", "read");
    if (guard.denied) return guard.denied;
    // Employees (own records only) never list colleagues here.
    const selfDenied = denySelfScopeList(guard);
    if (selfDenied) return selfDenied;

    const supabase = getAdminClient();
    const url = new URL(request.url);

    // A date range, paged on the server (alpha test A1 / B3):
    // ?from&to[&branch_id][&q][&page&page_size] -> one page, the total and
    // the summary over the whole range. HR / Super Admin may pick a branch;
    // a branch-scoped caller always gets its own.
    if (url.searchParams.has("from") || url.searchParams.has("to")) {
      const range = checkRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
      if (range.error) return NextResponse.json({ error: range.error }, { status: 400 });
      const { page, size, offset } = pageParams(url, { defaultSize: 25, maxSize: 100 });
      const branchId = guard.branchExempt ? normalizeRangeBranch(url.searchParams.get("branch_id")) : guard.branchId;
      const q = String(url.searchParams.get("q") || "").replace(/[,()*%\\]/g, " ").trim().slice(0, 80);
      if (range.from < getDateKey()) {
        await supabase.rpc("attendance_close_days", { p_from: range.from, p_to: range.to < getDateKey() ? range.to : getDateKey() });
      }
      const scoped = (query) => {
        let next = query.gte("log_date", range.from).lte("log_date", range.to).eq("archived_duplicate", false);
        if (branchId) next = next.eq("branch_id", branchId);
        if (q) next = next.ilike("employee_name", `%${q}%`);
        return next;
      };
      const [pageResult, statuses] = await Promise.all([
        scoped(supabase.from("attendance_logs").select("*", { count: "exact" }))
          .order("log_date", { ascending: false }).order("employee_name", { ascending: true }).order("id", { ascending: true })
          .range(offset, offset + size - 1),
        fetchAllRows(() => scoped(supabase.from("attendance_logs").select("status")).order("id", { ascending: true })),
      ]);
      if (pageResult.error) throw new Error(pageResult.error.message);
      const rows = await annotateAttendanceRows(supabase, (pageResult.data || []).map((row) => ({ ...row, date: row.log_date })));
      const all = statuses.error ? [] : statuses.data || [];
      const bucketCount = (name) => all.filter((r) => attendanceBucket(r.status) === name).length;
      return NextResponse.json({
        logs: rows,
        total: pageResult.count ?? rows.length,
        page,
        page_size: size,
        range: { from: range.from, to: range.to },
        branch_id: branchId || null,
        summary: { present: bucketCount("present"), late: bucketCount("late"), absent: bucketCount("absent"), incomplete: bucketCount("unresolved"), on_leave: bucketCount("leave") },
        generated_at: new Date().toISOString(),
      });
    }

    const dateParam = url.searchParams.get("date") || getDateKey();
    const viewAll = url.searchParams.get("view") === "all";

    let logs = [];

    if (viewAll) {
      let query = supabase
        .from("attendance_logs")
        .select("*")
        .eq("archived_duplicate", false)
        .order("log_date", { ascending: false })
        .order("time_in", { ascending: false })
        .limit(500);
      if (!guard.branchExempt) query = query.eq("branch_id", guard.branchId);
      const { data, error } = await query;
      if (!error) logs = data || [];
    } else {
      // A past day the nightly close has not reached yet: close it now, so
      // its missed tap-outs and absences are real records.
      if (dateParam < getDateKey()) {
        await supabase.rpc("attendance_close_days", { p_from: dateParam, p_to: dateParam });
      }
      let query = supabase
        .from("attendance_logs")
        .select("*")
        .eq("log_date", dateParam)
        .eq("archived_duplicate", false)
        .order("time_in", { ascending: true });
      if (!guard.branchExempt) query = query.eq("branch_id", guard.branchId);
      const { data, error } = await query;
      if (!error) logs = data || [];
    }

    // One record per employee per day: first tap in, last tap out.
    logs = collapseDailyTaps(logs).map((row) => ({ ...row, date: row.log_date }));

    // Today: everyone who has not tapped yet is listed as Absent by name, as
    // the Admin page does (no record exists until the nightly close).
    if (!viewAll && dateParam === getDateKey()) {
      let employeeIds = null;
      if (!guard.branchExempt) {
        const roster = await supabase.from("profiles").select("id").eq("branch_id", guard.branchId).limit(5000);
        employeeIds = roster.error ? [] : (roster.data || []).map((row) => row.id);
      }
      const loggedIds = new Set(logs.map((row) => String(row.employee_id)));
      const notTapped = await listNotTapped(supabase, { dateKey: dateParam, loggedIds, employeeIds });
      logs = [...logs, ...notTapped];
    }

    // Branch, employee ID and "Corrected by" labels for the grouped table.
    logs = await annotateAttendanceRows(supabase, logs);

    // Summary counts
    const present = logs.filter((r) => attendanceBucket(r.status) === "present").length;
    const late = logs.filter((r) => attendanceBucket(r.status) === "late").length;
    const absent = logs.filter((r) => attendanceBucket(r.status) === "absent").length;
    const incomplete = logs.filter((r) => attendanceBucket(r.status) === "unresolved").length;
    const onLeave = logs.filter((r) => attendanceBucket(r.status) === "leave").length;

    return NextResponse.json({
      logs,
      summary: { present, late, absent, incomplete, on_leave: onLeave },
      date: dateParam,
      date_label: getDateLabel(new Date(dateParam + "T00:00:00")),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
