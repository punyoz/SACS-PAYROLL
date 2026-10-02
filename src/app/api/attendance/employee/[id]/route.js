import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { requirePermission } from "@/lib/rbac/guard";
import { SCOPE_BRANCH } from "@/lib/rbac/permissions";
import { normalizeAttendanceStatus } from "@/lib/attendance/status";
import { formatPolicyTime12, getBranchAttendancePolicy } from "@/lib/attendance/policy";
import { readApprovedLeave } from "@/lib/attendance/leave";
import { listNotTapped } from "@/lib/attendance/not-tapped";
import { readRawTaps } from "@/lib/attendance/raw-taps";
import { isDateKey, manilaDateKey } from "@/lib/payroll/periods";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

/**
 * GET /api/attendance/employee/:id?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * One employee's attendance record for the Individual Employee Attendance
 * page: profile header, every day in the range (with leave details, the
 * full correction history of each record, and every raw RFID tap).
 *
 * Reviewers only (HR, Admin, Super Admin -- the roles that may correct
 * attendance); an Admin only for employees currently in its branch.
 */

const LOG_COLUMNS = "id,employee_id,employee_name,employee_type,branch_id,log_date,time_in,time_out,total_hours,status,late_minutes,undertime_minutes,is_half_day,is_early_bird,leave_request_id,updated_at";
const CORRECTION_COLUMNS = "id,log_id,log_date,status,resolution,correction_type,original_status,original_time_in,original_time_out,original_total_hours,original_late_minutes,original_undertime_minutes,corrected_time_in,corrected_time_out,corrected_total_hours,corrected_late_minutes,corrected_undertime_minutes,reason,requested_at,requested_by_name,approved_by_name,approved_at,review_note";
const MAX_RANGE_DAYS = 400;

function maskRfid(value) {
  const uid = normalizeText(value);
  if (!uid) return null;
  return uid.length <= 4 ? "•".repeat(uid.length) : `${"•".repeat(Math.min(uid.length - 4, 8))}${uid.slice(-4)}`;
}

export async function GET(request, { params }) {
  const guard = await requirePermission(request, "attendance_corrections", "update");
  if (guard.denied) return guard.denied;

  try {
    const { id } = await params;
    const employeeId = normalizeText(id);
    if (!/^[0-9a-f-]{36}$/i.test(employeeId)) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }

    const url = new URL(request.url);
    const today = manilaDateKey();
    let from = normalizeText(url.searchParams.get("from"));
    let to = normalizeText(url.searchParams.get("to"));
    if (!isDateKey(from) || !isDateKey(to) || from > to) {
      to = today;
      from = `${today.slice(0, 8)}01`;
    }
    const spanDays = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000;
    if (spanDays > MAX_RANGE_DAYS) {
      return NextResponse.json({ error: `Choose a range of ${MAX_RANGE_DAYS} days or fewer.` }, { status: 400 });
    }

    const supabase = getAdminClient();
    const profileResult = await supabase
      .from("profiles")
      .select("id,full_name,role,employee_id,employee_type,position,employee_status,rfid_uid,branch_id,date_hired,archived")
      .eq("id", employeeId)
      .maybeSingle();
    if (profileResult.error) throw new Error(profileResult.error.message);
    const profile = profileResult.data;
    const role = String(profile?.role || "").toLowerCase();
    if (!profile || (role !== "employee" && role !== "accountant")) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }
    if (guard.scope === SCOPE_BRANCH && String(profile.branch_id || "") !== String(guard.branchId || "")) {
      return NextResponse.json({ error: "That employee belongs to another branch." }, { status: 403 });
    }

    // Finished days become real Incomplete / Absent records first, as on the board.
    await supabase.rpc("attendance_close_days", { p_from: from, p_to: to });

    const [branchResult, policy, logsResult, correctionsResult, leaveFor, rawTaps, allBranches, tapFlags] = await Promise.all([
      profile.branch_id
        ? supabase.from("branches").select("id,name").eq("id", profile.branch_id).maybeSingle()
        : Promise.resolve({ data: null }),
      getBranchAttendancePolicy(supabase, profile.branch_id),
      fetchAllRows(() => supabase
        .from("attendance_logs")
        .select(LOG_COLUMNS)
        .eq("employee_id", employeeId)
        .eq("archived_duplicate", false)
        .gte("log_date", from)
        .lte("log_date", to)
        .order("log_date", { ascending: false })
        .order("id", { ascending: true })),
      supabase
        .from("attendance_corrections")
        .select(CORRECTION_COLUMNS)
        .eq("employee_id", employeeId)
        .gte("log_date", from)
        .lte("log_date", to)
        .order("requested_at", { ascending: true })
        .limit(2000),
      readApprovedLeave(supabase, { employeeIds: [employeeId], from, to }),
      readRawTaps(supabase, { employeeId, from, to }),
      supabase.from("branches").select("id,name"),
      // Its own read: the column only exists once the raw-taps migration is in.
      supabase
        .from("attendance_logs")
        .select("id,tap_after_correction_at")
        .eq("employee_id", employeeId)
        .gte("log_date", from)
        .lte("log_date", to)
        .limit(2000),
    ]);
    const branchNames = new Map((allBranches?.error ? [] : allBranches?.data || []).map((row) => [row.id, row.name]));
    const flagByLog = new Map((tapFlags?.error ? [] : tapFlags?.data || [])
      .filter((row) => row.tap_after_correction_at)
      .map((row) => [row.id, row.tap_after_correction_at]));
    const tapsByDay = new Map();
    rawTaps.forEach((tap) => {
      if (!tapsByDay.has(tap.log_date)) tapsByDay.set(tap.log_date, []);
      tapsByDay.get(tap.log_date).push({ ...tap, branch_name: branchNames.get(tap.branch_id) || null });
    });
    if (logsResult.error) throw new Error(logsResult.error.message);

    const historyByLog = new Map();
    (correctionsResult.error ? [] : correctionsResult.data || []).forEach((row) => {
      if (!historyByLog.has(row.log_id)) historyByLog.set(row.log_id, []);
      historyByLog.get(row.log_id).push(row);
    });

    // One row per day (the unique index already guarantees it; kept defensive).
    const byDay = new Map();
    (logsResult.data || []).forEach((row) => {
      if (!byDay.has(row.log_date)) byDay.set(row.log_date, row);
    });
    const logs = [...byDay.values()].map((row) => {
      const history = historyByLog.get(row.id) || [];
      const decided = history.filter((c) => c.status !== "pending");
      return {
        ...row,
        status: normalizeAttendanceStatus(row.status),
        leave: row.leave_request_id || normalizeAttendanceStatus(row.status) === "On Leave"
          ? leaveFor(row.employee_id, row.log_date)
          : null,
        corrections: history,
        last_correction: decided.length ? decided[decided.length - 1] : null,
        taps: tapsByDay.get(row.log_date) || [],
        tap_after_correction_at: flagByLog.get(row.id) || null,
      };
    });

    // Today, before any tap: shown as Absent (no tap yet), like the board.
    if (today >= from && today <= to && !byDay.has(today)) {
      const placeholder = await listNotTapped(supabase, { dateKey: today, loggedIds: new Set(), employeeIds: [employeeId] });
      logs.unshift(...placeholder.map((row) => ({ ...row, corrections: [], last_correction: null, leave: null, taps: tapsByDay.get(today) || [] })));
    }

    return NextResponse.json({
      employee: {
        id: profile.id,
        full_name: normalizeText(profile.full_name, "Employee"),
        employee_code: profile.employee_id || null,
        role,
        branch_id: profile.branch_id || null,
        branch_name: branchResult?.data?.name || null,
        position: profile.position || null,
        employee_type: profile.employee_type || null,
        employee_status: profile.employee_status || "Active",
        archived: profile.archived === true,
        date_hired: profile.date_hired || null,
        rfid_masked: maskRfid(profile.rfid_uid),
        schedule: {
          work_start: formatPolicyTime12(policy.work_start),
          work_end: formatPolicyTime12(policy.work_end),
          grace: policy.grace,
          work_hours: policy.work_hours,
          source: policy.source,
        },
      },
      range: { from, to },
      logs,
      can_correct: true,
      today,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
