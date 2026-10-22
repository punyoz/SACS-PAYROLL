/**
 * Server side of payroll runs (src/lib/payroll/runs.js): what each branch's
 * run looks like to the Accountant, and submitting one for HR approval.
 * The database functions (20261014010000_payroll_run_approval.sql) make the
 * final checks; these build what they need and turn their refusals into
 * messages.
 */

import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";
import { periodFromLabel } from "@/lib/payroll/periods";
import { loadPayrollStaff } from "@/lib/payroll/staff";
import { getEmployeeAttendancePolicy, levelLabel } from "@/lib/attendance/work-schedules";
import {
  RUN_STATUS_LABELS,
  describeRunError,
  isEditableRun,
  previousSameCutoffLabel,
  shapeRun,
  shapeRunItem,
} from "@/lib/payroll/runs";

/** Employees a branch's run must contain: paid staff, active, not held, hired by the period's end. */
export function expectedInRun(staff, branchId, period) {
  return (staff || []).filter((person) => String(person.branch_id || "") === String(branchId || "")
    && !person.archived
    && String(person.employee_status || "active").toLowerCase() !== "inactive"
    && !person.payroll_hold
    && (!person.date_hired || String(person.date_hired).slice(0, 10) <= period.end_key));
}

async function readEntries(supabase, branchIds, periodLabel) {
  const result = await fetchAllRows(() => supabase.from("payroll_entries")
    .select("id,employee_id,employee_name,employee_code,branch_id,pay_period,status,payroll,payslip_no,run_id")
    .in("branch_id", branchIds)
    .eq("pay_period", periodLabel)
    .order("id", { ascending: true }));
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

/**
 * The run of each branch for a period, as the Accountant sees it: its status
 * (Draft when not started), HR's remarks, and how many payslips are Final,
 * still Draft, or missing.
 */
export async function describeBranchRuns(supabase, guard, periodLabel, { branches = [], staff = null } = {}) {
  const period = periodFromLabel(periodLabel);
  if (!period) return [];
  const people = staff || await loadPayrollStaff(supabase, guard);
  const branchIds = [...new Set(branches.map((b) => String(b.id)))].filter(Boolean);
  if (!branchIds.length) return [];

  const [runsResult, entries] = await Promise.all([
    supabase.from("payroll_run_summaries").select("*").in("branch_id", branchIds).eq("period_label", period.label),
    readEntries(supabase, branchIds, period.label),
  ]);
  const available = !runsResult.error;
  const runs = new Map((runsResult.data || []).map((row) => [String(row.branch_id), shapeRun(row)]));
  const historyResult = available && runs.size
    ? await supabase.from("payroll_approval_history").select("*").in("run_id", [...runs.values()].map((r) => r.id)).order("created_at", { ascending: true })
    : { data: [] };

  return branches.map((branch) => {
    const id = String(branch.id);
    const run = runs.get(id) || null;
    const mine = entries.filter((entry) => String(entry.branch_id) === id);
    const finals = mine.filter((entry) => entry.status === "paid");
    const drafts = mine.filter((entry) => entry.status === "draft");
    const expected = expectedInRun(people, id, period);
    const missing = expected.filter((person) => !finals.some((entry) => entry.employee_id === person.id));
    const status = run?.status || "draft";
    return {
      available,
      branch_id: id,
      branch_name: branch.name,
      period_label: period.label,
      cutoff_type: period.start_key.endsWith("-01") ? "first" : "second",
      run: run ? { ...run } : null,
      status,
      status_label: RUN_STATUS_LABELS[status],
      editable: isEditableRun(run),
      final_count: finals.length,
      draft_count: drafts.length,
      expected_count: expected.length,
      missing: missing.map((person) => ({ id: person.id, name: person.full_name, code: person.employee_id })),
      totals_preview: finals.reduce((acc, entry) => {
        const t = entry.payroll?.totals || {};
        return {
          gross: acc.gross + (Number(t.gross_pay) || 0) + (Number(t.total_incentives) || 0),
          deductions: acc.deductions + (Number(t.total_deductions) || 0),
          net: acc.net + Math.max(0, Number(t.net_pay) || 0),
        };
      }, { gross: 0, deductions: 0, net: 0 }),
      can_submit: available && isEditableRun(run) && finals.length > 0 && !drafts.length && !missing.length,
      history: (historyResult.data || []).filter((h) => run && h.run_id === run.id),
    };
  });
}

/**
 * Submit (or resubmit) a branch's run: every expected employee must have a
 * Final payslip; the snapshot is built here and checked by the database.
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
export async function submitRun(supabase, guard, { branchId, periodLabel }) {
  const period = periodFromLabel(periodLabel);
  if (!period) return { ok: false, status: 400, body: { error: "Choose a valid pay period." } };
  if (!guard.branchExempt && String(guard.branchId || "") !== String(branchId || "")) {
    return { ok: false, status: 403, body: { error: "That is another branch's payroll." } };
  }

  const staff = await loadPayrollStaff(supabase, guard);
  const entries = await readEntries(supabase, [branchId], period.label);
  const finals = entries.filter((entry) => entry.status === "paid");
  if (entries.some((entry) => entry.status === "draft")) {
    return { ok: false, status: 409, body: { code: "drafts_open", error: "Some payslips of this run are still Drafts: generate their Final payslips or cancel them first." } };
  }
  const expected = expectedInRun(staff, branchId, period);
  const missing = expected.filter((person) => !finals.some((entry) => entry.employee_id === person.id));
  if (missing.length) {
    return {
      ok: false, status: 409,
      body: {
        code: "missing_payslips",
        error: `Process every employee before submitting. No Final payslip yet: ${missing.map((p) => p.full_name).join(", ")}.`,
        missing: missing.map((p) => ({ id: p.id, name: p.full_name })),
      },
    };
  }
  if (!finals.length) return { ok: false, status: 409, body: { code: "nothing_processed", error: "No Final payslip in this run yet." } };

  // The previous same cutoff (for the "large change" highlight), each
  // employee's level, and the schedule they followed on the period's last day.
  const ids = finals.map((entry) => entry.employee_id);
  const previousLabel = previousSameCutoffLabel(period.label);
  const [previous, profiles] = await Promise.all([
    previousLabel
      ? fetchAllIn(() => supabase.from("payroll_entries").select("employee_id,payroll,status,id").eq("pay_period", previousLabel).eq("status", "paid").order("id", { ascending: true }), "employee_id", ids)
      : Promise.resolve({ data: [] }),
    fetchAllIn(() => supabase.from("profiles").select("id,employee_level,branch_id").order("id", { ascending: true }), "id", ids),
  ]);
  const previousNet = new Map((previous.data || []).map((row) => [row.employee_id, Math.max(0, Number(row.payroll?.totals?.net_pay) || 0)]));
  const profileOf = new Map((profiles.data || []).map((row) => [row.id, row]));
  const schedules = await Promise.all(finals.map(async (entry) => {
    const policy = await getEmployeeAttendancePolicy(supabase, { employeeId: entry.employee_id, branchId, dayKey: period.end_key });
    return policy.schedule_name || (policy.source === "branch" ? "Branch schedule" : "Default schedule");
  }));

  const items = finals.map((entry, index) => shapeRunItem(entry, {
    employeeLevel: levelLabel(profileOf.get(entry.employee_id)?.employee_level) || null,
    scheduleName: schedules[index],
    previousNet: previousNet.has(entry.employee_id) ? previousNet.get(entry.employee_id) : null,
  }));

  const ensured = await supabase.rpc("ensure_payroll_run", { p_branch: branchId, p_period_label: period.label, p_actor: guard.userId });
  if (ensured.error) {
    const failure = describeRunError(ensured.error);
    return { ok: false, status: failure.status, body: failure };
  }
  const run = Array.isArray(ensured.data) ? ensured.data[0] : ensured.data;
  if (!run?.id) return { ok: false, status: 503, body: { code: "not_ready", error: "Payroll approval is not set up yet: apply 20261014010000_payroll_run_approval.sql." } };

  const submitted = await supabase.rpc("submit_payroll_run", { p_run_id: run.id, p_actor: guard.userId, p_items: items });
  if (submitted.error) {
    const failure = describeRunError(submitted.error);
    return { ok: false, status: failure.status, body: failure };
  }
  const saved = Array.isArray(submitted.data) ? submitted.data[0] : submitted.data;
  return { ok: true, status: 200, body: { success: true, run: shapeRun(saved || run), items: items.length } };
}
