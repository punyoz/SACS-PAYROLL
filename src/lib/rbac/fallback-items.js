/**
 * What waits on the Super Admin as the fallback approver (2026-11-09 Part D),
 * for /api/super-admin/fallback and the Super Admin dashboard's
 * "Pending actions" card (a real count, never a hard-coded 0).
 */
import { readAllLeaveRequests } from "@/lib/leave-requests/store";
import { activeHrIds, coveringHr } from "@/lib/rbac/routing";
import { shapeRun } from "@/lib/payroll/runs";
import { fetchAllIn } from "@/lib/supabase/fetch-all";

export const PENDING_LEAVE = ["pending_admin", "pending_accountant"];

/** Everything waiting on the fallback right now. */
export async function loadFallbackItems(supabase) {
  const hr = await activeHrIds(supabase);
  const items = [];

  // An HR's own pending leave, when no OTHER HR is active.
  const pending = await readAllLeaveRequests({ statuses: PENDING_LEAVE });
  if (pending.length) {
    const owners = await supabase.from("profiles").select("id,role,full_name,branch_id").in("id", [...new Set(pending.map((r) => r.employee_id))].slice(0, 500));
    const hrOwners = new Map((owners.data || []).filter((p) => p.role === "hr").map((p) => [p.id, p]));
    for (const row of pending) {
      if (!hrOwners.has(row.employee_id)) continue;
      // Another HR who covers their branch decides it (2026-11-23).
      if ((await coveringHr(supabase, { branchId: hrOwners.get(row.employee_id).branch_id, exceptId: row.employee_id })).length) continue;
      items.push({
        item_type: "leave_request", id: row.id, title: `Leave request · ${row.employee_name || hrOwners.get(row.employee_id)?.full_name}`,
        detail: `${row.leave_type || "Leave"}, ${row.start_date} to ${row.end_date}`, owner_name: row.employee_name, owner_id: row.employee_id,
        submitted_at: row.submitted_at, reason: "No other HR account is active.",
      });
    }
  }

  // An HR's own overtime request or attendance correction request (2026-11-23), when no other HR covers their branch.
  const hrProfiles = (await supabase.from("profiles").select("id,full_name,branch_id").eq("role", "hr").eq("archived", false)).data || [];
  const hrById = new Map(hrProfiles.map((p) => [p.id, p]));
  if (hrById.size) {
    const ids = [...hrById.keys()];
    const [ot, corr] = await Promise.all([
      fetchAllIn(() => supabase.from("overtime_requests").select("id,employee_id,request_date,planned_start,planned_end,created_at").eq("status", "pending").order("id"), "employee_id", ids),
      fetchAllIn(() => supabase.from("attendance_corrections").select("id,employee_id,log_date,fix_type,requested_at").eq("status", "pending").not("fix_type", "is", null).order("id"), "employee_id", ids),
    ]);
    for (const row of ot.data || []) {
      const owner = hrById.get(row.employee_id);
      if ((await coveringHr(supabase, { branchId: owner.branch_id, exceptId: owner.id })).length) continue;
      items.push({ item_type: "overtime_request", id: row.id, title: `Overtime request · ${owner.full_name}`, detail: `${row.request_date}, ${row.planned_start}-${row.planned_end}`,
        owner_name: owner.full_name, owner_id: owner.id, submitted_at: row.created_at, reason: "No other HR officer covers their branch." });
    }
    for (const row of corr.data || []) {
      const owner = hrById.get(row.employee_id);
      if ((await coveringHr(supabase, { branchId: owner.branch_id, exceptId: owner.id })).length) continue;
      items.push({ item_type: "attendance_correction", id: row.id, title: `Attendance correction request · ${owner.full_name}`, detail: `${String(row.log_date).slice(0, 10)} (${row.fix_type.replace(/_/g, " ")})`,
        owner_name: owner.full_name, owner_id: owner.id, submitted_at: row.requested_at, reason: "No other HR officer covers their branch." });
    }
  }

  // Pending payroll runs no active HR may decide.
  const runs = await supabase.from("payroll_run_summaries").select("*").eq("status", "pending");
  const pendingRuns = (runs.data || []).map(shapeRun);
  if (pendingRuns.length) {
    const runItems = await fetchAllIn(() => supabase.from("payroll_run_items").select("id,run_id,submission_no,employee_id,employee_name,processed_by").order("id", { ascending: true }), "run_id", pendingRuns.map((r) => r.id));
    for (const run of pendingRuns) {
      const its = (runItems.data || []).filter((i) => i.run_id === run.id && (!run.submission_no || i.submission_no === run.submission_no));
      const barred = (id) => id === run.processed_by || id === run.submitted_by || its.some((i) => i.employee_id === id || i.processed_by === id);
      if (hr.some((id) => !barred(id))) continue;
      const ownerItem = its.find((i) => hr.includes(i.employee_id));
      items.push({
        item_type: "payroll_run", id: run.id, title: `Payroll run · ${run.branch_name || "Branch"}, ${run.period_label}`,
        detail: `${run.total_employees || its.length} payslip${(run.total_employees || its.length) === 1 ? "" : "s"}${ownerItem ? `, including ${ownerItem.employee_name}'s own` : ""}`,
        owner_name: ownerItem?.employee_name || null, owner_id: ownerItem?.employee_id || null, submitted_at: run.submitted_at,
        reason: hr.length ? "Every active HR has a payslip in this run, so none of them may decide it." : "No HR account is active.",
      });
    }
  }
  // Pending final pay no active HR of the employee's branch may decide (20261120010000).
  const finalPay = await supabase.from("payroll_final_pay_submissions").select("id,employee_id,employee_name,branch_id,submitted_by,submitted_at,separated_on").eq("status", "pending");
  if ((finalPay.data || []).length) {
    const hrRows = hr.length ? (await supabase.from("profiles").select("id,branch_id").in("id", hr)).data || [] : [];
    for (const row of finalPay.data) {
      if (hrRows.some((h) => (!h.branch_id || h.branch_id === row.branch_id) && h.id !== row.submitted_by && h.id !== row.employee_id)) continue;
      items.push({
        item_type: "final_pay", id: row.id, title: `Final pay · ${row.employee_name}`, detail: `Separated ${row.separated_on}`,
        owner_name: row.employee_name, owner_id: row.employee_id, submitted_at: row.submitted_at,
        reason: "No active HR of the employee's branch may decide it.",
      });
    }
  }
  items.sort((a, b) => String(a.submitted_at || "").localeCompare(String(b.submitted_at || "")));
  const counts = { leave: items.filter((i) => i.item_type === "leave_request").length, payroll_run: items.filter((i) => i.item_type === "payroll_run").length, final_pay: items.filter((i) => i.item_type === "final_pay").length,
    overtime: items.filter((i) => i.item_type === "overtime_request").length, attendance_correction: items.filter((i) => i.item_type === "attendance_correction").length };
  return { items, counts: { ...counts, total: items.length } };
}

