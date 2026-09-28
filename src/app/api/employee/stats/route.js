import { listUsersCached } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission, resolveTargetEmail, denyForeignBranch } from "@/lib/rbac/guard";
import { collapseDailyTaps } from "@/lib/attendance/taps";
import { attendanceBucket } from "@/lib/attendance/status";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { readApprovedLeave } from "@/lib/attendance/leave";

function getCurrentPhilippineMonth() {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const [year, month] = dateStr.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const monthEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const monthLabel = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "long",
    year: "numeric",
  }).format(now);

  return { monthStart, monthEnd, todayKey: dateStr, monthLabel };
}

function formatPeso(amount) {
  const n = Number(amount || 0);
  if (!n) return null;
  return "₱ " + n.toLocaleString("en-PH", { maximumFractionDigits: 0 });
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "dashboard", "read");
    if (guard.denied) return guard.denied;

    // SCOPE_SELF for Employee — pinned to the session, ?email= is ignored.
    const url = new URL(request.url);
    const email = resolveTargetEmail(guard, url.searchParams.get("email"));

    if (!email) {
      return NextResponse.json({ error: "email is required." }, { status: 400 });
    }

    const supabase = getAdminClient();

    // Find the user by email
    const usersResult = await listUsersCached(supabase);
    if (usersResult.error) {
      throw new Error(`Failed to list users: ${usersResult.error.message}`);
    }

    const user = (usersResult.data.users || []).find(
      (u) => String(u.email || "").trim().toLowerCase() === email,
    );

    if (!user) {
      return NextResponse.json({ present: 0, late: 0, absent: 0, on_leave: 0, basic_salary: null, today: null });
    }

    const foreign = denyForeignBranch(guard, user.user_metadata?.branch_id);
    if (foreign) return foreign;

    const { monthStart, monthEnd, todayKey, monthLabel } = getCurrentPhilippineMonth();

    // Fetch this month's attendance for the employee
    let present = 0;
    let late = 0;
    let absent = 0;
    let onLeave = 0;
    let today = null;
    const records = [];

    try {
      const attResult = await supabase
        .from("attendance_logs")
        .select("status, log_date, time_in, time_out")
        .eq("employee_id", user.id)
        .gte("log_date", monthStart)
        .lt("log_date", monthEnd)
        // Folded duplicates and released (cancelled) leave days.
        .eq("archived_duplicate", false)
        .order("log_date", { ascending: true });

      if (!attResult.error && Array.isArray(attResult.data)) {
        // What each On Leave day is, for the calendar and records table.
        const leaveFor = attResult.data.some((row) => row.status === "On Leave")
          ? await readApprovedLeave(supabase, { employeeIds: [user.id], from: monthStart, to: monthEnd })
          : () => null;

        // One record per day (first tap in, last tap out) so a day with a
        // repeated tap is never counted twice.
        for (const row of collapseDailyTaps(attResult.data, { employeeKey: () => user.id })) {
          // Engine statuses (On Time, Early Bird, Undertime, ...) bucketed
          // into present / late / absent (src/lib/attendance/status.js).
          const status = attendanceBucket(row.status);
          if (status === "present") present++;
          else if (status === "late") late++;
          else if (status === "absent") absent++;
          else if (status === "leave") onLeave++;

          records.push({
            date: row.log_date,
            status: row.status || "Absent",
            time_in: row.time_in || null,
            time_out: row.time_out || null,
            leave: status === "leave" ? leaveFor(user.id, row.log_date) : null,
          });

          if (row.log_date === todayKey && !today) {
            today = {
              time_in: row.time_in || null,
              time_out: row.time_out || null,
              status: row.status || "Absent",
            };
          }
        }
      }
    } catch (error) {
      // The dashboard still loads with zero counts, but the failure is no
      // longer invisible: it was swallowed without a trace before.
      console.error("[employee/stats] attendance lookup failed:", error?.message || error);
    }

    // The next approved leave that has not ended yet (today's included).
    let upcomingLeave = null;
    try {
      const leaveResult = await supabase
        .from("leave_requests")
        .select("leave_type,pay_status,start_date,end_date,decided_by_name")
        .eq("employee_id", user.id)
        .eq("status", "approved")
        .gte("end_date", todayKey)
        .order("start_date", { ascending: true })
        .limit(1);
      const next = leaveResult.error ? null : (leaveResult.data || [])[0];
      if (next) {
        upcomingLeave = {
          leave_type: next.leave_type || "Leave",
          pay_status: next.pay_status || "with_pay",
          start_date: next.start_date,
          end_date: next.end_date || next.start_date,
          approved_by: next.decided_by_name || null,
        };
      }
    } catch {
      // Supplementary: the dashboard loads without it.
    }

    // Basic salary from user metadata
    const basicSalary = Number(user.user_metadata?.basic_salary || 0) || null;

    return NextResponse.json({
      present,
      late,
      absent,
      on_leave: onLeave,
      upcoming_leave: upcomingLeave,
      basic_salary: formatPeso(basicSalary),
      today,
      records,
      month_label: monthLabel,
      today_key: todayKey,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
