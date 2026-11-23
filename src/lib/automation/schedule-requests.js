/**
 * Part E step 3 (2026-11-23): schedule requests. HR approves (manual); the
 * system then applies the chosen schedule from the request's start date: a new
 * version in work_schedule_assignments (schedule history is never edited, the
 * newest version for a date wins). Logged "by System" (automation_actions,
 * kind applied); HR may Undo it, which adds a version restoring the schedule
 * the employee had before, from the same date (or today, if it already began).
 */
import { manilaDateKey } from "@/lib/payroll/periods";

/** The employee's own schedule version in force on a date (null = level / school default). */
async function ownScheduleOn(supabase, employeeId, dateKey) {
  const { data } = await supabase.from("work_schedule_assignments").select("schedule_key,effective_from,created_at")
    .eq("employee_id", employeeId).lte("effective_from", dateKey)
    .order("effective_from", { ascending: false }).order("created_at", { ascending: false }).limit(1);
  return data?.[0] || null;
}

export async function applyScheduleRequest(supabase, row, { by, userId }) {
  const d = row.details || {};
  const today = manilaDateKey();
  if (!d.effective_from || d.effective_from < today) {
    return { error: `This request starts ${d.effective_from || "on an unknown date"}, which has passed: past attendance is never recalculated. Reject it with a remark and ask the Admin for a new date.` };
  }
  const { data: off } = await supabase.rpc("automation_off", { p_module: "schedule_requests" });
  if (off !== false) return { skipped: "paused" };
  const before = await ownScheduleOn(supabase, row.employee_id, d.effective_from);
  const inserted = await supabase.from("work_schedule_assignments").insert({
    employee_id: row.employee_id, schedule_key: d.schedule_key, effective_from: d.effective_from,
    note: `Schedule request approved by ${by}; applied by System`.slice(0, 300), created_by: userId || null, created_by_name: "System",
  }).select("id").maybeSingle();
  if (inserted.error) return { error: inserted.error.message };
  const { data: logId } = await supabase.rpc("automation_log", {
    p_module: "schedule_requests", p_rule: "approved schedule request: applied from its start date", p_kind: "applied",
    p_summary: `${d.employee_name || "Employee"}: ${d.schedule_name || "new schedule"} from ${d.effective_from}`,
    p_data: { request_id: row.id, schedule_key: d.schedule_key, schedule_name: d.schedule_name || null, effective_from: d.effective_from,
      before_schedule_key: before?.schedule_key ?? null, approved_by: by },
    p_employee: row.employee_id, p_branch: row.branch_id, p_entity_type: "work_schedule_assignment", p_entity_id: inserted.data?.id || null,
    p_effective_on: d.effective_from,
  });
  return { assignmentId: inserted.data?.id || null, logId: logId || null };
}

/** Undo: a new version restoring the schedule from before (null = back to the level / school default). */
export async function undoScheduleRequest(supabase, row, { actor }) {
  const d = row.data || {};
  const today = manilaDateKey();
  const from = d.effective_from && d.effective_from > today ? d.effective_from : today;
  const restored = await supabase.from("work_schedule_assignments").insert({
    employee_id: row.employee_id, schedule_key: d.before_schedule_key ?? null, effective_from: from,
    note: `Undo of an applied schedule request (${actor?.session?.full_name || "HR"})`.slice(0, 300),
    created_by: actor?.userId || null, created_by_name: actor?.session?.full_name || "HR",
  }).select("id").maybeSingle();
  if (restored.error) return { error: restored.error.message, status: 400 };
  return { reverted: { assignment_id: restored.data?.id || null, from, schedule_key: d.before_schedule_key ?? null } };
}
