import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { collapseDailyTaps } from "@/lib/attendance/taps";
import { attendanceBucket } from "@/lib/attendance/status";
import { listNotTapped } from "@/lib/attendance/not-tapped";
import { requirePermission } from "@/lib/rbac/guard";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getDateLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "2-digit",
    year: "numeric",
  }).format(date);
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "attendance", "read");
    if (guard.denied) return guard.denied;

    const supabase = getAdminClient();
    const url = new URL(request.url);
    const dateParam = url.searchParams.get("date") || getDateKey();
    const viewAll = url.searchParams.get("view") === "all";

    let logs = [];

    if (viewAll) {
      let query = supabase
        .from("attendance_logs")
        .select("*")
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

    // Summary counts
    const present = logs.filter((r) => attendanceBucket(r.status) === "present").length;
    const late = logs.filter((r) => attendanceBucket(r.status) === "late").length;
    const absent = logs.filter((r) => attendanceBucket(r.status) === "absent").length;
    const incomplete = logs.filter((r) => attendanceBucket(r.status) === "unresolved").length;

    return NextResponse.json({
      logs,
      summary: { present, late, absent, incomplete },
      date: dateParam,
      date_label: getDateLabel(new Date(dateParam + "T00:00:00")),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
