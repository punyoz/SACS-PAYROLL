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

/** Longest note the Accountant may give for leaving an employee out (payroll_run_exclusions.reason). */
export const EXCLUSION_REASON_MAX = 500;

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
  // The period's latest run per branch (a supplemental run comes after the first).
  const runs = new Map([...(runsResult.data || [])].sort((a, b) => (Number(a.run_no) || 1) - (Number(b.run_no) || 1))
    .map((row) => [String(row.branch_id), shapeRun(row)]));
  const exclusionsResult = available && runs.size
    ? await supabase.from("payroll_run_exclusions").select("run_id,submission_no,employee_id,employee_name,employee_code,reason,acknowledged_by_name,created_at")
      .in("run_id", [...runs.values()].map((r) => r.id))
    : { data: [] };
  const historyResult = available && runs.size
    ? await supabase.from("payroll_approval_history").select("*").in("run_id", [...runs.values()].map((r) => r.id)).order("created_at", { ascending: true })
    : { data: [] };

  return branches.map((branch) => {
    const id = String(branch.id);
    const latest = runs.get(id) || null;
    const mine = entries.filter((entry) => String(entry.branch_id) === id);
    const allFinals = mine.filter((entry) => entry.status === "paid");
    const drafts = mine.filter((entry) => entry.status === "draft");
    // Processed after the latest run was approved: they go in a supplemental run.
    const waiting = allFinals.filter((entry) => !entry.run_id);
    const supplemental = latest?.status === "approved" && waiting.length > 0;
    const run = supplemental ? null : latest;
    // This run's payslips: the Final ones not in another run of the period.
    const finals = supplemental ? waiting : allFinals.filter((entry) => !entry.run_id || entry.run_id === latest?.id);
    const expected = expectedInRun(people, id, period);
    // Left out: an expected employee with no Final payslip in any run of the period.
    const missing = expected.filter((person) => !allFinals.some((entry) => entry.employee_id === person.id));
    const status = run?.status || "draft";
    const submittedExclusions = latest
      ? (exclusionsResult.data || []).filter((x) => x.run_id === latest.id && Number(x.submission_no) === Number(latest.submission_no))
      : [];
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
      // A new supplemental run (employees processed after the period's run was approved).
      supplemental,
      run_no: supplemental ? (Number(latest.run_no) || 1) + 1 : Number(run?.run_no) || 1,
      approved_run: supplemental ? { ...latest } : null,
      final_count: finals.length,
      draft_count: drafts.length,
      expected_count: expected.length,
      missing: missing.map((person) => ({ id: person.id, name: person.full_name, code: person.employee_id })),
      // Who the latest submitted snapshot left out, with the Accountant's note.
      exclusions: submittedExclusions.map(shapeExclusion),
      totals_preview: finals.reduce((acc, entry) => {
        const t = entry.payroll?.totals || {};
        return {
          gross: acc.gross + (Number(t.gross_pay) || 0) + (Number(t.total_incentives) || 0),
          deductions: acc.deductions + (Number(t.total_deductions) || 0),
          net: acc.net + Math.max(0, Number(t.net_pay) || 0),
        };
      }, { gross: 0, deductions: 0, net: 0 }),
      // Employees may be left out, once the Accountant confirms who and why (submitRun).
      can_submit: available && isEditableRun(run) && finals.length > 0 && !drafts.length,
      history: (historyResult.data || []).filter((h) => run && h.run_id === run.id),
    };
  });
}

function shapeExclusion(row) {
  return {
    employee_id: row.employee_id,
    employee_name: row.employee_name,
    employee_code: row.employee_code || null,
    reason: row.reason || null,
    acknowledged_by_name: row.acknowledged_by_name || null,
    at: row.created_at || null,
  };
}

/**
 * Submit (or resubmit) a branch's run. Employees with no Final payslip may be
 * left out, but only when the Accountant confirms it (acknowledgeExclusions)
 * after seeing who; the list (with any note per employee) is stored with the
 * snapshot and shown to HR. The snapshot is built here and checked by the database.
 * @param {{ branchId: string, periodLabel: string, acknowledgeExclusions?: boolean, exclusionNotes?: Record<string,string> }} input
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
export async function submitRun(supabase, guard, { branchId, periodLabel, acknowledgeExclusions = false, exclusionNotes = {} }) {
  const period = periodFromLabel(periodLabel);
  if (!period) return { ok: false, status: 400, body: { error: "Choose a valid pay period." } };
  if (!guard.branchExempt && String(guard.branchId || "") !== String(branchId || "")) {
    return { ok: false, status: 403, body: { error: "That is another branch's payroll." } };
  }

  const staff = await loadPayrollStaff(supabase, guard);
  const entries = await readEntries(supabase, [branchId], period.label);
  const allFinals = entries.filter((entry) => entry.status === "paid");
  if (entries.some((entry) => entry.status === "draft")) {
    return { ok: false, status: 409, body: { code: "drafts_open", error: "Some payslips of this run are still Drafts: generate their Final payslips or cancel them first." } };
  }
  const expected = expectedInRun(staff, branchId, period);
  const missing = expected.filter((person) => !allFinals.some((entry) => entry.employee_id === person.id));
  // Leaving employees out is allowed, never silently: the Accountant must
  // have seen this list and confirmed it (2026-10-29).
  if (missing.length && acknowledgeExclusions !== true) {
    return {
      ok: false, status: 409,
      body: {
        code: "exclusions_unacknowledged",
        error: `${missing.length} employee${missing.length === 1 ? " has" : "s have"} no Final payslip: ${missing.map((p) => p.full_name).join(", ")}. Confirm they are intentionally left out of this run, or process them first.`,
        missing: missing.map((p) => ({ id: p.id, name: p.full_name, code: p.employee_id })),
      },
    };
  }
  const notes = exclusionNotes && typeof exclusionNotes === "object" ? exclusionNotes : {};
  if (missing.some((p) => String(notes[p.id] || "").trim().length > EXCLUSION_REASON_MAX)) {
    return { ok: false, status: 400, body: { code: "invalid_exclusion_note", error: `A note can be at most ${EXCLUSION_REASON_MAX} characters.` } };
  }

  // The run to submit: the latest of the period, or a new supplemental run
  // when the latest is approved and payslips were processed after it.
  const ensured = await supabase.rpc("ensure_payroll_run", { p_branch: branchId, p_period_label: period.label, p_actor: guard.userId });
  if (ensured.error) {
    const failure = describeRunError(ensured.error);
    return { ok: false, status: failure.status, body: failure };
  }
  const run = Array.isArray(ensured.data) ? ensured.data[0] : ensured.data;
  if (!run?.id) return { ok: false, status: 503, body: { code: "not_ready", error: "Payroll approval is not set up yet: apply 20261014010000_payroll_run_approval.sql." } };
  // This run's payslips: the Final ones not already in another run of the period.
  const finals = allFinals.filter((entry) => !entry.run_id || entry.run_id === run.id);
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

  const exclusions = missing.map((p) => ({
    employee_id: p.id, employee_name: p.full_name, employee_code: p.employee_id || null,
    reason: String(notes[p.id] || "").trim() || null,
  }));
  const submitted = await supabase.rpc("submit_payroll_run", { p_run_id: run.id, p_actor: guard.userId, p_items: items, p_exclusions: exclusions });
  if (submitted.error) {
    const failure = describeRunError(submitted.error);
    return { ok: false, status: failure.status, body: failure };
  }
  const saved = Array.isArray(submitted.data) ? submitted.data[0] : submitted.data;
  return { ok: true, status: 200, body: { success: true, run: shapeRun(saved || run), items: items.length, excluded: exclusions.length } };
}

/**
 * Employees left out of a submitted run who are still not in any run of
 * that period: the follow-up list (Accountant: own branch; HR: every
 * branch). An employee processed since then but not yet submitted shows as
 * "processed, not submitted".
 * @returns {Promise<Array<object>>}
 */
export async function listOpenExclusions(supabase, guard) {
  let runsQuery = supabase.from("payroll_run_summaries").select("id,branch_id,branch_name,period_label,period_start,submission_no,run_no,status,submitted_at")
    .gt("excluded_employees", 0);
  if (!guard.branchExempt) runsQuery = runsQuery.eq("branch_id", guard.branchId || "00000000-0000-0000-0000-000000000000");
  const runsResult = await runsQuery.order("period_start", { ascending: false }).limit(200);
  if (runsResult.error || !(runsResult.data || []).length) return [];
  const runs = new Map(runsResult.data.map((r) => [r.id, r]));
  const excl = await fetchAllIn(() => supabase.from("payroll_run_exclusions").select("run_id,submission_no,employee_id,employee_name,employee_code,reason,acknowledged_by_name,created_at").order("created_at", { ascending: true }), "run_id", [...runs.keys()]);
  if (excl.error) throw new Error(excl.error.message);
  // Only the current snapshot of each run (a resubmission replaces the list).
  const current = (excl.data || []).filter((x) => Number(x.submission_no) === Number(runs.get(x.run_id)?.submission_no));
  if (!current.length) return [];
  const labels = [...new Set(current.map((x) => runs.get(x.run_id).period_label))];
  const ids = [...new Set(current.map((x) => x.employee_id))];
  const paid = await fetchAllIn(() => supabase.from("payroll_entries").select("employee_id,pay_period,run_id,status").in("pay_period", labels).eq("status", "paid").order("id", { ascending: true }), "employee_id", ids);
  if (paid.error) throw new Error(paid.error.message);
  const out = [];
  const seen = new Set();
  for (const x of current) {
    const r = runs.get(x.run_id);
    const key = `${x.employee_id}|${r.period_label}`;
    if (seen.has(key)) continue;
    const entry = (paid.data || []).find((e) => e.employee_id === x.employee_id && e.pay_period === r.period_label);
    if (entry?.run_id) continue; // included in a run since: followed up
    seen.add(key);
    out.push({
      ...shapeExclusion(x),
      run_id: r.id, run_no: Number(r.run_no) || 1, run_status: r.status,
      branch_id: r.branch_id, branch_name: r.branch_name, period_label: r.period_label, period_start: String(r.period_start).slice(0, 10),
      follow_up: entry ? "processed_not_submitted" : "not_processed",
    });
  }
  return out.sort((a, b) => b.period_start.localeCompare(a.period_start) || a.employee_name.localeCompare(b.employee_name));
}
