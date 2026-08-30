/**
 * Persistent leave-request storage — backed solely by the Supabase
 * `leave_requests` table (see supabase/migrations/20260827_add_pay_status_to_leave_requests.sql).
 * No ephemeral fallback: a real database error is thrown, not swallowed into
 * temporary storage.
 */

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

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

export function normalizeLeaveRequest(row) {
  return {
    id: String(row.id || crypto.randomUUID()),
    employee_id: String(row.employee_id || ""),
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
    updated_at: row.updated_at || row.submitted_at || new Date().toISOString(),
  };
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function readAllLeaveRequests() {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*")
    .order("submitted_at", { ascending: false });

  if (error) throw new Error(error.message);

  return (data || []).map(normalizeLeaveRequest);
}

// ─── Insert ───────────────────────────────────────────────────────────────────

export async function insertLeaveRequest(newRequest) {
  const normalized = normalizeLeaveRequest(newRequest);
  const supabase = getAdminClient();

  const { error } = await supabase.from("leave_requests").insert(normalized);
  if (error) throw new Error(error.message);

  return normalized;
}

// ─── Update Status ────────────────────────────────────────────────────────────

export async function updateLeaveRequestStatus(id, nextStatus) {
  const nowIso = new Date().toISOString();
  const supabase = getAdminClient();

  const lookupResult = await supabase
    .from("leave_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (lookupResult.error) throw new Error(lookupResult.error.message);
  if (!lookupResult.data) return { found: false, request: null };

  const { error } = await supabase
    .from("leave_requests")
    .update({ status: nextStatus, decided_at: nowIso, updated_at: nowIso })
    .eq("id", id);

  if (error) throw new Error(error.message);

  const updated = normalizeLeaveRequest({
    ...lookupResult.data,
    status: nextStatus,
    decided_at: nowIso,
    updated_at: nowIso,
  });

  return { found: true, request: updated };
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

// Summarizes an employee's Leave With Pay / Without Pay balance from their
// approved leave requests only (pending/rejected requests don't count).
export function summarizeLeaveBalance(requests, employeeId) {
  const approved = requests.filter(
    (r) => r.status === "approved" && (r.employee_id === employeeId || !employeeId),
  );

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
