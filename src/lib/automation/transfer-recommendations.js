/**
 * Part E step 5 (2026-11-23): transfer endorsements. For a pending transfer the
 * system checks the rules and fills the leaving branch's Admin's endorsement
 * (a proposal on the Automation card; the Admin's own Endorse / Not endorse
 * sends it on); HR decides. Applying on the effective date is in the database
 * (20261124070000_transfer_automation.sql).
 */
const dayKey = (v) => String(v || "").slice(0, 10);

/** Pure part (tested): the recommendation from the facts. */
export function transferRecommendationFrom({ employee, destination, effectiveDate, today, openAwol = false, leaveOnDate = false, ownSchedule = false, runInProgress = false }) {
  const reasons = [];
  const warnings = [];
  if (!employee || employee.archived || ["Separated", "Inactive"].includes(employee.employee_status)) warnings.push("The employee is not active");
  else reasons.push("The employee is active");
  if (!destination || String(destination.status || "Active").toLowerCase() !== "active") warnings.push("The destination branch is not active");
  else reasons.push(`Destination ${destination.name} is active`);
  if (effectiveDate < today) warnings.push(`The effective date ${effectiveDate} has passed`);
  else reasons.push(effectiveDate === today ? "Effective today" : `Effective ${effectiveDate}`);
  if (openAwol) warnings.push("An AWOL case is open");
  if (leaveOnDate) warnings.push("On leave on the effective date");
  if (runInProgress) warnings.push("The leaving branch's payroll for that cutoff is with HR: the days are split per branch on one payslip");
  if (ownSchedule) warnings.push("Has their own work schedule: HR checks it fits the new branch");
  return { decision: "endorse", label: warnings.length ? "Recommend endorsing, with warnings" : "Recommend endorsing", reasons, warnings };
}

/** Log the system's endorsement for the leaving branch's Admin (once per transfer). Never throws. */
export async function logTransferRecommendation(supabase, transfer) {
  try {
    const existing = await supabase.from("automation_actions").select("id").eq("module", "transfer_endorsements").eq("entity_type", "transfer_request").eq("entity_id", String(transfer.id)).limit(1);
    if ((existing.data || []).length) return null;
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const effectiveDate = dayKey(transfer.effective_date) || today;
    const cutoffStart = `${effectiveDate.slice(0, 8)}${Number(effectiveDate.slice(8)) <= 15 ? "01" : "16"}`;
    const [{ data: employee }, { data: destination }, awol, leave, own, run] = await Promise.all([
      supabase.from("profiles").select("id,full_name,archived,employee_status").eq("id", transfer.employee_id).maybeSingle(),
      supabase.from("branches").select("id,name,status").eq("id", transfer.to_branch_id).maybeSingle(),
      supabase.from("employee_awol_cases").select("id").eq("employee_id", transfer.employee_id).neq("stage", "closed").limit(1),
      supabase.from("leave_requests").select("id").eq("employee_id", transfer.employee_id).in("status", ["approved", "pending_admin", "pending_accountant"])
        .lte("start_date", effectiveDate).gte("end_date", effectiveDate).limit(1),
      supabase.from("work_schedule_assignments").select("id").eq("employee_id", transfer.employee_id).not("schedule_key", "is", null).lte("effective_from", effectiveDate).limit(1),
      supabase.from("payroll_runs").select("id").eq("branch_id", transfer.from_branch_id).eq("period_start", cutoffStart).in("status", ["pending", "approved"]).limit(1),
    ]);
    const rec = transferRecommendationFrom({ employee, destination, effectiveDate, today,
      openAwol: Boolean((awol.data || []).length), leaveOnDate: Boolean((leave.data || []).length),
      ownSchedule: Boolean((own.data || []).length), runInProgress: Boolean((run.data || []).length) });
    const { data } = await supabase.rpc("automation_log", {
      p_module: "transfer_endorsements", p_rule: "active employee and branch, effective date, open cases, leave, payroll in progress, own schedule",
      p_kind: "proposal", p_summary: `${employee?.full_name || "Employee"} to ${destination?.name || "another branch"} from ${effectiveDate}. ${rec.label}`,
      p_data: { transfer_id: transfer.id, decision: rec.decision, label: rec.label, reasons: rec.reasons, warnings: rec.warnings, effective_date: effectiveDate },
      p_employee: transfer.employee_id, p_branch: transfer.from_branch_id, p_entity_type: "transfer_request", p_entity_id: String(transfer.id),
      p_effective_on: effectiveDate,
    });
    return data || null;
  } catch {
    return null;
  }
}

/** HR decided: close the system's endorsement. Never throws. */
export async function closeTransferRecommendation(supabase, transferId, decision) {
  try {
    const { data } = await supabase.from("automation_actions").select("id").eq("module", "transfer_endorsements").eq("entity_type", "transfer_request").eq("entity_id", String(transferId)).maybeSingle();
    if (data?.id) await supabase.rpc("automation_close", { p_id: data.id, p_note: `HR ${decision === "approve" ? "approved" : "rejected"} it` });
  } catch { /* never fails the decision */ }
}

/** The system's endorsements for these transfers (HR's list). */
export async function transferRecommendationsFor(supabase, ids) {
  const list = [...new Set((ids || []).map(String))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const { data } = await supabase.from("automation_actions").select("entity_id,status,data,admin_note,admin_noted_by_name")
      .eq("module", "transfer_endorsements").eq("entity_type", "transfer_request").in("entity_id", list.slice(i, i + 100));
    for (const r of data || []) out.set(r.entity_id, { status: r.status, label: r.data?.label, reasons: r.data?.reasons || [], warnings: r.data?.warnings || [], admin_note: r.admin_note, admin_noted_by_name: r.admin_noted_by_name });
  }
  return out;
}
