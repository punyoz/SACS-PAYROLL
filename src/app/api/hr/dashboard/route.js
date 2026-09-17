import { listUsersCached } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { readAllLeaveRequests } from "@/lib/leave-requests/store";
import { collapseDailyTaps } from "@/lib/attendance/taps";
import { requirePermission } from "@/lib/rbac/guard";
import { SCOPE_SELF } from "@/lib/rbac/permissions";

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

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "dashboard", "read");
    if (guard.denied) return guard.denied;

    // This endpoint returns branch/company-wide aggregates, not one person's
    // own records — a SCOPE_SELF caller (Employee) has "dashboard read" for
    // their own portal's stats endpoint, but that grant does not extend here.
    if (guard.scope === SCOPE_SELF) {
      return NextResponse.json({ error: "You do not have permission to perform this action." }, { status: 403 });
    }

    const supabase = getAdminClient();

    // Fetch all users
    const usersResult = await listUsersCached(supabase);
    if (usersResult.error) throw new Error(usersResult.error.message);

    const allUsers = usersResult.data.users || [];
    const candidateEmployees = allUsers.filter((u) => {
      const role = String(u.user_metadata?.role || "employee").toLowerCase();
      return (role === "employee" || role === "accountant") && !u.user_metadata?.archived;
    });

    let employees = candidateEmployees;
    if (!guard.branchExempt) {
      const userIds = candidateEmployees.map((u) => u.id);
      const branchMap = new Map();
      if (userIds.length) {
        const { data: profileRows } = await supabase
          .from("profiles")
          .select("id,branch_id")
          .in("id", userIds);
        (profileRows || []).forEach((row) => branchMap.set(row.id, row.branch_id));
      }
      employees = candidateEmployees.filter(
        (u) => String(branchMap.get(u.id) || u.user_metadata?.branch_id || "") === String(guard.branchId || ""),
      );
    }

    const totalEmployees = employees.length;

    // Attendance today
    const today = getDateKey();
    let presentToday = 0;
    let lateToday = 0;
    let absentToday = 0;

    try {
      let attQuery = supabase
        .from("attendance_logs")
        .select("employee_id, status, time_in, time_out, log_date")
        .eq("log_date", today);
      if (!guard.branchExempt) attQuery = attQuery.eq("branch_id", guard.branchId);
      const { data: attRows } = await attQuery;

      if (Array.isArray(attRows)) {
        const seenEmployees = new Set();
        // One record per employee: status comes from the day's first tap.
        collapseDailyTaps(attRows, { dateKey: () => today }).forEach((row) => {
          seenEmployees.add(row.employee_id);
          const s = String(row.status || "").toLowerCase();
          if (s === "present") presentToday++;
          else if (s === "late") lateToday++;
        });
        absentToday = Math.max(0, totalEmployees - seenEmployees.size);
      }
    } catch {
      absentToday = totalEmployees;
    }

    // Pending leave requests
    let pendingLeaves = 0;
    try {
      const allLeaves = await readAllLeaveRequests();
      pendingLeaves = allLeaves.filter(
        (r) => (r.status === "pending_admin" || r.status === "pending_accountant")
          && (guard.branchExempt || String(r.branch_id || "") === String(guard.branchId || "")),
      ).length;
    } catch { /* ignore */ }

    // Recent attendance activity (last 10 employee-days). Fetches more raw
    // rows than needed because multiple taps a day share one employee-day
    // slot once collapsed — without this, a single employee's repeat taps
    // could fill the whole "recent" list with duplicates of themselves.
    let recentActivity = [];
    try {
      let recentQuery = supabase
        .from("attendance_logs")
        .select("employee_id, employee_name, log_date, time_in, time_out, status, created_at")
        .order("created_at", { ascending: false })
        .limit(40);
      if (!guard.branchExempt) recentQuery = recentQuery.eq("branch_id", guard.branchId);
      const { data: recent } = await recentQuery;
      const collapsed = collapseDailyTaps(recent || []).sort((a, b) => {
        const aTime = new Date(a.time_out || a.time_in || 0).getTime();
        const bTime = new Date(b.time_out || b.time_in || 0).getTime();
        return bTime - aTime;
      });
      recentActivity = collapsed.slice(0, 10).map((row) => ({
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        date: row.log_date,
        time_in: row.time_in,
        time_out: row.time_out,
        total_hours: row.total_hours,
        status: row.status,
      }));
    } catch { /* ignore */ }

    // Employee type breakdown
    const teaching = employees.filter((u) =>
      String(u.user_metadata?.employee_type || "").toLowerCase() === "teaching"
    ).length;
    const nonTeaching = employees.filter((u) =>
      String(u.user_metadata?.employee_type || "").toLowerCase() === "non-teaching"
    ).length;

    return NextResponse.json({
      total_employees: totalEmployees,
      teaching_staff: teaching,
      non_teaching_staff: nonTeaching,
      present_today: presentToday,
      late_today: lateToday,
      absent_today: absentToday,
      pending_leaves: pendingLeaves,
      recent_activity: recentActivity,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
