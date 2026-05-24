import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { readAllLeaveRequests } from "@/lib/leave-requests/store";

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

export async function GET() {
  try {
    const supabase = getAdminClient();

    // Fetch all users
    const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersResult.error) throw new Error(usersResult.error.message);

    const allUsers = usersResult.data.users || [];
    const employees = allUsers.filter((u) => {
      const role = String(u.user_metadata?.role || "employee").toLowerCase();
      return (role === "employee" || role === "accountant") && !u.user_metadata?.archived;
    });

    const totalEmployees = employees.length;

    // Attendance today
    const today = getDateKey();
    let presentToday = 0;
    let lateToday = 0;
    let absentToday = 0;

    try {
      const { data: attRows } = await supabase
        .from("attendance_logs")
        .select("employee_id, status")
        .eq("date", today);

      if (Array.isArray(attRows)) {
        const seenEmployees = new Set();
        attRows.forEach((row) => {
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
      pendingLeaves = allLeaves.filter((r) => r.status === "pending_admin").length;
    } catch { /* ignore */ }

    // Recent attendance logs (last 10)
    let recentActivity = [];
    try {
      const { data: recent } = await supabase
        .from("attendance_logs")
        .select("employee_id, employee_name, date, time_in, time_out, status")
        .order("created_at", { ascending: false })
        .limit(10);
      recentActivity = recent || [];
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
