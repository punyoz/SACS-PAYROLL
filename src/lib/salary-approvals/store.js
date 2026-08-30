/**
 * Persistent salary-approval storage — backed solely by the Supabase
 * `salary_approvals` table (see supabase/migrations/20260401_backfill_core_schema.sql
 * and 20260513_add_payroll_breakdown_to_salary_approvals.sql). No ephemeral
 * fallback: a real database error is thrown, not swallowed into temporary storage.
 */

import { createClient } from "@supabase/supabase-js";

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

export function normalizeSalaryApproval(row) {
  let payrollBreakdown = row.payroll_breakdown || null;
  if (typeof payrollBreakdown === "string") {
    try { payrollBreakdown = JSON.parse(payrollBreakdown); } catch { payrollBreakdown = null; }
  }

  return {
    id: String(row.id || ""),
    employee_id: String(row.employee_id || ""),
    employee_name: String(row.employee_name || "Unknown Employee"),
    employee_code: String(row.employee_code || ""),
    employee_type: String(row.employee_type || "Teaching"),
    position: String(row.position || "Employee"),
    current_salary: Number(row.current_salary || 0),
    proposed_salary: Number(row.proposed_salary || 0),
    reason: String(row.reason || "No reason provided."),
    submitted_by: String(row.submitted_by || "Accountant"),
    submitted_at: row.submitted_at || new Date().toISOString(),
    status: String(row.status || "pending").toLowerCase(),
    decided_at: row.decided_at || null,
    payroll_breakdown: payrollBreakdown,
  };
}

const FULL_SELECT =
  "id,employee_id,employee_name,employee_code,employee_type,position," +
  "current_salary,proposed_salary,reason,submitted_by,submitted_at,status,decided_at,payroll_breakdown";

const BASE_SELECT =
  "id,employee_id,employee_name,employee_code,employee_type,position," +
  "current_salary,proposed_salary,reason,submitted_by,submitted_at,status,decided_at";

function isNewColumnMissing(error) {
  return String(error?.message || "").toLowerCase().includes("payroll_breakdown");
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function readAllSalaryApprovals() {
  const supabase = getAdminClient();

  let { data, error } = await supabase
    .from("salary_approvals")
    .select(FULL_SELECT)
    .order("submitted_at", { ascending: false });

  // The payroll_breakdown migration may not have run yet — retry without it
  // rather than treating this as a fatal error.
  if (error && isNewColumnMissing(error)) {
    const retry = await supabase
      .from("salary_approvals")
      .select(BASE_SELECT)
      .order("submitted_at", { ascending: false });
    data = retry.data;
    error = retry.error;
  }

  if (error) throw new Error(error.message);

  return (data || []).map(normalizeSalaryApproval);
}

// ─── Update Status ────────────────────────────────────────────────────────────

export async function updateSalaryApprovalStatus(id, nextStatus) {
  const nowIso = new Date().toISOString();
  const supabase = getAdminClient();

  let lookupResult = await supabase
    .from("salary_approvals")
    .select(FULL_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (lookupResult.error && isNewColumnMissing(lookupResult.error)) {
    lookupResult = await supabase
      .from("salary_approvals")
      .select(BASE_SELECT)
      .eq("id", id)
      .maybeSingle();
  }

  if (lookupResult.error) throw new Error(lookupResult.error.message);
  if (!lookupResult.data) return { found: false, approval: null };

  // Try the UPDATE with decided_at first; if that column is somehow missing,
  // retry with just status rather than failing the whole request.
  const { error: err1 } = await supabase
    .from("salary_approvals")
    .update({ status: nextStatus, decided_at: nowIso })
    .eq("id", id);

  if (err1) {
    const msg = String(err1.message || "").toLowerCase();
    if (msg.includes("decided_at")) {
      const { error: err2 } = await supabase
        .from("salary_approvals")
        .update({ status: nextStatus })
        .eq("id", id);
      if (err2) throw new Error(err2.message);
    } else {
      throw new Error(err1.message);
    }
  }

  const updated = normalizeSalaryApproval({
    ...lookupResult.data,
    status: nextStatus,
    decided_at: nowIso,
  });

  return { found: true, approval: updated };
}
