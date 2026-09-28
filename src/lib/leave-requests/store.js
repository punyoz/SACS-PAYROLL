/**
 * Persistent leave-request storage — backed solely by the Supabase
 * `leave_requests` table (see supabase/migrations/20260827010000_add_pay_status_to_leave_requests.sql).
 * No ephemeral fallback: a real database error is thrown, not swallowed into
 * temporary storage.
 */

import crypto from "node:crypto";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

export function normalizeLeaveRequest(row) {
  return {
    id: String(row.id || crypto.randomUUID()),
    employee_id: String(row.employee_id || ""),
    branch_id: row.branch_id || null,
    employee_name: String(row.employee_name || "Unknown Employee"),
    position: String(row.position || "Employee"),
    leave_type: String(row.leave_type || "Leave"),
    // 'with_pay' | 'without_pay' — defaults to with_pay so requests submitted
    // before this field existed aren't retroactively treated as unpaid.
    pay_status: String(row.pay_status || "with_pay").toLowerCase() === "without_pay" ? "without_pay" : "with_pay",
    start_date: String(row.start_date || ""),
    end_date: String(row.end_date || ""),
    reason: String(row.reason || "No reason provided."),
    // Preserve proof_url exactly — it may be a large base64 data URL.
    proof_url: String(row.proof_url || ""),
    status: String(row.status || "pending_accountant").toLowerCase(),
    submitted_at: row.submitted_at || new Date().toISOString(),
    decided_at: row.decided_at || null,
    // Who approved or rejected it (20260927010000_audit_actor_and_leave_decider.sql).
    decided_by: row.decided_by || null,
    decided_by_name: row.decided_by_name || null,
    cancelled_at: row.cancelled_at || null,
    cancelled_by_name: row.cancelled_by_name || null,
    updated_at: row.updated_at || row.submitted_at || new Date().toISOString(),
  };
}

// ─── Read ─────────────────────────────────────────────────────────────────────

// `status` narrows the query server-side (leave_requests_status_idx already
// exists) for callers that only ever need one status — e.g. payroll only
// cares about approved requests — instead of transferring and re-filtering
// every leave request ever filed, which grows unbounded with no archiving.
//
// `employeeId`, `branchId` and `id` narrow it the same way, so a route that
// only needs one person's, one branch's or one request's rows no longer
// downloads the whole table (and every base64 proof document in it) first.
export async function readAllLeaveRequests({ status, employeeId, branchId, id } = {}) {
  const supabase = getAdminClient();
  let query = supabase
    .from("leave_requests")
    .select("*")
    .order("submitted_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }
  if (employeeId) {
    query = query.eq("employee_id", employeeId);
  }
  if (branchId) {
    query = query.eq("branch_id", branchId);
  }
  if (id) {
    query = query.eq("id", id);
  }

  const { data, error } = await query;

  if (error) throw new Error(error.message);

  return (data || []).map(normalizeLeaveRequest);
}

// ─── Insert ───────────────────────────────────────────────────────────────────

export async function insertLeaveRequest(newRequest) {
  const normalized = normalizeLeaveRequest(newRequest);
  const supabase = getAdminClient();

  // Cancellation fields are only ever written by cancelApprovedLeaveRequest().
  const { cancelled_at: _cancelledAt, cancelled_by_name: _cancelledByName, ...row } = normalized;
  const { error } = await supabase.from("leave_requests").insert(row);
  if (error) throw new Error(error.message);

  return normalized;
}

// ─── Update Status ────────────────────────────────────────────────────────────

/**
 * Decide a leave request.
 *
 * `fromStatuses` makes the decision conditional on the row still being in one
 * of those statuses when the UPDATE runs. Two reviewers deciding the same
 * request at once used to both succeed (the status was only checked in
 * JavaScript beforehand), the later write silently replacing the earlier
 * decision. Now the second one matches no row and gets `conflict: true`.
 *
 * `decidedBy` / `decidedByName` record who made the decision.
 */
export async function updateLeaveRequestStatus(id, nextStatus, { fromStatuses, decidedBy, decidedByName } = {}) {
  const nowIso = new Date().toISOString();
  const supabase = getAdminClient();

  const lookupResult = await supabase
    .from("leave_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (lookupResult.error) throw new Error(lookupResult.error.message);
  if (!lookupResult.data) return { found: false, conflict: false, request: null };

  const patch = { status: nextStatus, decided_at: nowIso, updated_at: nowIso };
  if (decidedBy !== undefined) patch.decided_by = decidedBy || null;
  if (decidedByName !== undefined) patch.decided_by_name = decidedByName || null;

  let query = supabase
    .from("leave_requests")
    .update(patch)
    .eq("id", id);
  if (Array.isArray(fromStatuses) && fromStatuses.length) {
    query = query.in("status", fromStatuses);
  }

  const { data, error } = await query.select("id");

  if (error) throw new Error(error.message);
  if (!data || !data.length) {
    return { found: true, conflict: true, request: normalizeLeaveRequest(lookupResult.data) };
  }

  const updated = normalizeLeaveRequest({
    ...lookupResult.data,
    ...patch,
  });

  return { found: true, conflict: false, request: updated };
}

/**
 * Cancel an approved request. Conditional on it still being approved, like a
 * decision; the approver (decided_by) is kept and the canceller recorded
 * apart (20260928010000_leave_attendance_sync.sql). The database trigger then
 * releases its On Leave days.
 */
export async function cancelApprovedLeaveRequest(id, { cancelledBy, cancelledByName } = {}) {
  const nowIso = new Date().toISOString();
  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from("leave_requests")
    .update({
      status: "cancelled",
      cancelled_at: nowIso,
      cancelled_by: cancelledBy || null,
      cancelled_by_name: cancelledByName || null,
      updated_at: nowIso,
    })
    .eq("id", id)
    .eq("status", "approved")
    .select("id");

  if (error) throw new Error(error.message);
  return { conflict: !data || !data.length };
}

/**
 * Bring the request's attendance days in step with it and report the covered
 * working days that already have a real tap (left as recorded, for HR to
 * resolve). The trigger on leave_requests already ran the sync; this repeats
 * it (it is idempotent) only to read the result. Null when the database
 * function is not there yet.
 */
export async function syncLeaveAttendance(id) {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc("attendance_sync_leave", { p_leave_id: id });
  if (error) return null;
  return {
    marked: Number(data?.marked || 0),
    removed: Number(data?.removed || 0),
    conflicts: Array.isArray(data?.conflicts) ? data.conflicts : [],
  };
}

// ─── Leave Balance ────────────────────────────────────────────────────────────

// Only policy number in this file: annual Leave-With-Pay day allotment per employee.
export const DEFAULT_ANNUAL_LEAVE_WITH_PAY_DAYS = 15;

// Inclusive day count between two YYYY-MM-DD dates.
export function countLeaveDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

/**
 * Find an already-approved leave request for the same employee whose date
 * range overlaps [startDate, endDate]. Without this check, two different
 * approved requests covering the same day both count that day in
 * summarizeLeaveBalance(), silently double-spending the annual allotment (or,
 * for Leave Without Pay, double-deducting the same day from payroll).
 */
export function findOverlappingApprovedLeave(requests, employeeId, startDate, endDate, excludeId = null) {
  return (requests || []).find((r) => {
    if (excludeId && r.id === excludeId) return false;
    if (r.status !== "approved") return false;
    if (!employeeId || r.employee_id !== employeeId) return false;
    return startDate <= (r.end_date || r.start_date) && (r.start_date || "") <= endDate;
  }) || null;
}

// Summarizes an employee's Leave With Pay / Without Pay balance from their
// approved leave requests only (pending/rejected requests don't count), for
// one leave year at a time — the allotment is annual, so a request approved
// in a prior year must not keep counting against this year's balance.
export function summarizeLeaveBalance(requests, employeeId, year = new Date().getFullYear()) {
  const approved = requests.filter((r) => {
    if (r.status !== "approved") return false;
    if (employeeId && r.employee_id !== employeeId) return false;
    const requestYear = Number(String(r.start_date || "").slice(0, 4));
    return requestYear === year;
  });

  const withPayUsed = approved
    .filter((r) => r.pay_status === "with_pay")
    .reduce((sum, r) => sum + countLeaveDays(r.start_date, r.end_date), 0);

  const withoutPayUsed = approved
    .filter((r) => r.pay_status === "without_pay")
    .reduce((sum, r) => sum + countLeaveDays(r.start_date, r.end_date), 0);

  return {
    with_pay_allotment: DEFAULT_ANNUAL_LEAVE_WITH_PAY_DAYS,
    with_pay_used: withPayUsed,
    with_pay_remaining: Math.max(0, DEFAULT_ANNUAL_LEAVE_WITH_PAY_DAYS - withPayUsed),
    without_pay_used: withoutPayUsed,
  };
}
