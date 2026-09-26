import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission, denyForeignBranch } from "@/lib/rbac/guard";
import { can, SCOPE_SELF } from "@/lib/rbac/permissions";
import { UNRESOLVED_STATUSES, normalizeAttendanceStatus } from "@/lib/attendance/status";
import { loadAttendanceConfig, resolveAttendancePolicy } from "@/lib/attendance/policy";
import { isDateKey, manilaDateKey, periodForDateKey, periodFromLabel } from "@/lib/payroll/periods";

/**
 * Overtime approval.
 *
 *   GET   /api/attendance/overtime?period=<label> | ?from=&to=  [&branch_id=]
 *         Days whose time out is at least OVERTIME_MIN_MINUTES after the
 *         branch's scheduled end, with any decision already made.
 *   PATCH /api/attendance/overtime
 *         { log_id, decision: "approve" | "reject", approved_minutes, note }
 *
 * Payroll pays overtime only for minutes approved here
 * (public.attendance_overtime_approvals, src/lib/payroll/attendance-pay.js);
 * a late tap out alone never pays anything. Scope follows the attendance
 * board: Employees see their own days, an Admin its branch, HR and Super
 * Admin every branch. Deciding needs the attendance "update" permission, and
 * is refused once that employee's pay period has been processed.
 */

/** Minutes past the scheduled end before a day is listed as overtime. */
const OVERTIME_MIN_MINUTES = 30;
const MAX_RANGE_DAYS = 62;
const NOTE_MAX = 300;

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
  return (branchId) => {
    const key = String(branchId || "");
    if (!cache.has(key)) cache.set(key, resolveAttendancePolicy(config, branchId || null));
    return cache.get(key);
  };
}

/** Pay periods already processed for these employees: Set of "employeeId|label". */
async function paidPeriods(supabase, employeeIds) {
  if (!employeeIds.length) return new Set();
  const result = await supabase
    .from("payroll_entries")
    .select("employee_id,pay_period,status")
    .in("employee_id", employeeIds.slice(0, 1000))
    .eq("status", "paid");
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
        const roster = await supabase.from("profiles").select("id").eq("branch_id", branchFilter).limit(5000);
        if (roster.error) throw new Error(roster.error.message);
        employeeIds = (roster.data || []).map((row) => row.id);
      }
    }
    const canReview = !selfOnly && can(guard.role, "attendance", "update");
    if (employeeIds && !employeeIds.length) {
      return NextResponse.json({ range, overtime: [], can_review: canReview, min_minutes: OVERTIME_MIN_MINUTES });
    }

    let query = supabase
      .from("attendance_logs")
      .select("id,employee_id,employee_name,branch_id,log_date,time_in,time_out,status")
      .gte("log_date", range.from)
      .lte("log_date", range.to)
      .eq("archived_duplicate", false)
      .order("log_date", { ascending: false })
      .limit(5000);
    if (employeeIds) query = query.in("employee_id", employeeIds);
    const logsResult = await query;
    if (logsResult.error) throw new Error(logsResult.error.message);

    const logs = (logsResult.data || []).filter((row) => row.time_in && row.time_out
      && !UNRESOLVED_STATUSES.includes(normalizeAttendanceStatus(row.status)));
    const policyFor = await policiesFor(supabase, logs.map((row) => row.branch_id));

    const candidates = logs
      .map((row) => {
        const policy = policyFor(row.branch_id);
        return { row, policy, minutes: overtimeMinutes(row, policy) };
      })
      .filter((item) => item.minutes >= OVERTIME_MIN_MINUTES);

    const approvals = new Map();
    if (candidates.length) {
      const result = await supabase
        .from("attendance_overtime_approvals")
        .select("log_id,approved_minutes,status,note,decided_by_name,decided_at")
        .in("log_id", candidates.map((item) => item.row.id).slice(0, 1000));
      if (result.error) throw new Error(result.error.message);
      (result.data || []).forEach((row) => approvals.set(String(row.log_id), row));
    }
    const paid = await paidPeriods(supabase, [...new Set(candidates.map((item) => item.row.employee_id))]);

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
        locked: paid.has(`${row.employee_id}|${periodForDateKey(String(row.log_date).slice(0, 10)).label}`),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  const guard = await requirePermission(request, "attendance", "update");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    const logId = normalizeText(body.log_id);
    const decision = normalizeText(body.decision).toLowerCase();
    const note = normalizeText(body.note);

    if (!logId) return NextResponse.json({ error: "log_id is required." }, { status: 400 });
    if (decision !== "approve" && decision !== "reject") {
      return NextResponse.json({ error: "Decision must be approve or reject." }, { status: 400 });
    }
    if (note.length > NOTE_MAX) {
      return NextResponse.json({ error: `Keep the note to ${NOTE_MAX} characters or fewer.` }, { status: 400 });
    }

    const supabase = getAdminClient();
    const logResult = await supabase
      .from("attendance_logs")
      .select("id,employee_id,employee_name,branch_id,log_date,time_in,time_out,status,archived_duplicate")
      .eq("id", logId)
      .maybeSingle();
    if (logResult.error) throw new Error(logResult.error.message);
    const log = logResult.data;
    if (!log || log.archived_duplicate === true) {
      return NextResponse.json({ error: "Attendance record not found." }, { status: 404 });
    }

    // The employee's current branch, as every other attendance action.
    const profile = await supabase.from("profiles").select("branch_id").eq("id", log.employee_id).maybeSingle();
    if (profile.error) throw new Error(profile.error.message);
    if (!guard.branchExempt && !profile.data?.branch_id) {
      return NextResponse.json({ error: "That employee is not assigned to your branch." }, { status: 403 });
    }
    const foreign = denyForeignBranch(guard, profile.data?.branch_id || null);
    if (foreign) return foreign;

    if (!log.time_in || !log.time_out || UNRESOLVED_STATUSES.includes(normalizeAttendanceStatus(log.status))) {
      return NextResponse.json({ error: "Overtime can only be decided for a day with both a time in and a time out." }, { status: 400 });
    }

    const policyFor = await policiesFor(supabase, [log.branch_id]);
    const policy = policyFor(log.branch_id);
    const available = overtimeMinutes(log, policy);
    if (available < OVERTIME_MIN_MINUTES) {
      return NextResponse.json(
        { error: `This day has no overtime: the time out is less than ${OVERTIME_MIN_MINUTES} minutes after the ${policy.work_end} end of shift.` },
        { status: 400 },
      );
    }

    let approvedMinutes = 0;
    if (decision === "approve") {
      approvedMinutes = Number(body.approved_minutes);
      if (!Number.isInteger(approvedMinutes) || approvedMinutes < 1 || approvedMinutes > available) {
        return NextResponse.json(
          { error: `Approve a whole number of minutes from 1 to ${available}.` },
          { status: 400 },
        );
      }
    }

    const period = periodForDateKey(String(log.log_date).slice(0, 10));
    const paid = await paidPeriods(supabase, [log.employee_id]);
    if (paid.has(`${log.employee_id}|${period.label}`)) {
      return NextResponse.json(
        { error: `Payroll for ${period.label} has already been processed for this employee, so its overtime can no longer change.` },
        { status: 409 },
      );
    }

    const row = {
      log_id: log.id,
      employee_id: log.employee_id,
      branch_id: log.branch_id || null,
      log_date: String(log.log_date).slice(0, 10),
      overtime_minutes: available,
      approved_minutes: approvedMinutes,
      status: decision === "approve" ? "approved" : "rejected",
      note: note || null,
      decided_by: guard.userId || null,
      decided_by_name: normalizeText(guard.session?.full_name, guard.session?.email) || null,
      decided_at: new Date().toISOString(),
    };
    const saved = await supabase
      .from("attendance_overtime_approvals")
      .upsert(row, { onConflict: "log_id" })
      .select("log_id,approved_minutes,status,note,decided_by_name,decided_at")
      .maybeSingle();
    if (saved.error) throw new Error(saved.error.message);

    await appendAuditLog({
      module: "attendance",
      action: decision === "approve" ? "overtime_approve" : "overtime_reject",
      entity_type: "attendance_log",
      entity_id: log.id,
      description: decision === "approve"
        ? `Overtime of ${approvedMinutes} minute${approvedMinutes === 1 ? "" : "s"} approved for ${log.employee_name} on ${row.log_date}.`
        : `Overtime rejected for ${log.employee_name} on ${row.log_date}.`,
      status: "success",
      source: "api",
      metadata: {
        employee_id: log.employee_id,
        branch_id: log.branch_id || null,
        log_date: row.log_date,
        overtime_minutes: available,
        approved_minutes: approvedMinutes,
        note: note || null,
      },
    });

    return NextResponse.json({ success: true, approval: saved.data || row });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
