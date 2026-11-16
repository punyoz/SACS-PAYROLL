/**
 * Server side of payroll runs (src/lib/payroll/runs.js): what each branch's
 * run looks like to the Accountant, and submitting one for HR approval.
 * The database functions (20261014010000_payroll_run_approval.sql,
 * 20261115010000_approval_flow_fixes.sql) make the final checks; these build
 * what they need and turn their refusals into messages.
 *
 * Who a run is about comes from src/lib/payroll/run-roster.js, the one
 * definition the batch table and the run card share.
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
import { LEFT_OUT_AS, LEFT_OUT_LABELS, branchRoster, expectedInRun, firstHalfChange, firstHalfLabelOf } from "@/lib/payroll/run-roster";

export { expectedInRun };

/** Longest note the Accountant may give for leaving an employee out (payroll_run_exclusions.reason). */
export const EXCLUSION_REASON_MAX = 500;

const ENTRY_COLUMNS = "id,employee_id,employee_name,employee_code,employee_type,branch_id,pay_period,status,payroll,payslip_no,run_id,updated_at";
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const peso = (value) => Math.round(num(value) * 100) / 100;

async function readEntries(supabase, branchIds, labels) {
  const result = await fetchAllRows(() => supabase.from("payroll_entries")
    .select(ENTRY_COLUMNS)
    .in("branch_id", branchIds)
    .in("pay_period", labels)
    .order("id", { ascending: true }));
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

/**
 * The tax table rows the "1st half changed" flag uses to say what the month
 * changes if the 2nd half is recomputed (display only). [] on any error: the
 * flag then shows the 1st half's own change only.
 */
export async function loadFlagTaxRows(supabase) {
  try {
    const { data, error } = await supabase.from("payroll_tax_brackets").select("version_id,effective_date,bracket_over,base_tax,rate_pct,created_at");
    return error ? [] : data || [];
  } catch {
    return [];
  }
}

/** The 1st halves of these employees for a 2nd-half period: Map employee_id -> entry (or nothing for a 1st half). */
async function firstHalvesFor(supabase, periodLabel, employeeIds) {
  const firstLabel = firstHalfLabelOf(periodLabel);
  const ids = [...new Set((employeeIds || []).filter(Boolean))];
  if (!firstLabel || !ids.length) return { firstLabel, byEmployee: new Map() };
  const result = await fetchAllIn(() => supabase.from("payroll_entries").select(ENTRY_COLUMNS)
    .eq("pay_period", firstLabel).order("id", { ascending: true }), "employee_id", ids);
  if (result.error) throw new Error(result.error.message);
  return { firstLabel, byEmployee: new Map((result.data || []).map((e) => [e.employee_id, e])), taxRows: await loadFlagTaxRows(supabase) };
}

/** A 2nd half whose 1st half changed since it was computed, or null. */
function recomputeOf(entry, firsts) {
  if (!firsts.firstLabel) return null;
  return firstHalfChange(entry, firsts.byEmployee.get(entry.employee_id) || null, { taxRows: firsts.taxRows });
}

/** One payslip row of the run card. */
function entryRow(entry, change = null) {
  const t = entry.payroll?.totals || {};
  return {
    entry_id: entry.id,
    employee_id: entry.employee_id,
    employee_name: entry.employee_name || "Employee",
    employee_code: entry.employee_code || null,
    employee_type: entry.employee_type || null,
    period_label: entry.pay_period,
    payslip_no: entry.payslip_no || null,
    status: entry.status === "paid" ? "final" : "draft",
    gross_pay: peso(num(t.gross_pay) + num(t.total_incentives)),
    total_deductions: peso(t.total_deductions),
    net_pay: peso(Math.max(0, num(t.net_pay))),
    needs_recompute: change ? change.reason : null,
  };
}

/** One row of a submitted run, from its snapshot (what HR received). */
function itemRow(item, entry, change = null) {
  return {
    entry_id: item.entry_id,
    employee_id: item.employee_id,
    employee_name: item.employee_name || "Employee",
    employee_code: item.employee_code || null,
    employee_type: entry?.employee_type || null,
    period_label: entry?.pay_period || null,
    payslip_no: item.payslip_no || null,
    status: "final",
    gross_pay: peso(item.gross_pay),
    total_deductions: peso(item.total_deductions),
    net_pay: peso(item.net_pay),
    needs_recompute: change ? change.reason : null,
  };
}

const sumRows = (rows) => rows.reduce((acc, row) => ({
  gross: peso(acc.gross + row.gross_pay),
  deductions: peso(acc.deductions + row.total_deductions),
  net: peso(acc.net + row.net_pay),
}), { gross: 0, deductions: 0, net: 0 });

/** Left out of a run: active employees with no Final payslip (a Draft is left out too). */
function leftOutOf(roster) {
  const draftFor = new Set(roster.drafts.map((e) => String(e.employee_id)));
  return roster.missing.map((person) => ({
    id: person.id,
    name: person.full_name,
    code: person.employee_id,
    left_out_as: draftFor.has(String(person.id)) ? LEFT_OUT_AS.draft : LEFT_OUT_AS.not_processed,
  }));
}

/**
 * The runs of each branch for a period, as cards for the Accountant:
 *
 *   - the open card (Draft / Rejected run, a new supplemental run, or no run
 *     yet): its Included payslips, Drafts, Left out and, apart, Final
 *     payslips outside the branch's active list (in the run only if ticked);
 *   - every submitted run of the period (Pending HR Approval, Paid), read
 *     only, with exactly the payslips HR received.
 *
 * Each card says on the server why it cannot be submitted (blockers).
 */
export async function describeBranchRuns(supabase, guard, periodLabel, { branches = [], staff = null } = {}) {
  const period = periodFromLabel(periodLabel);
  if (!period) return [];
  const people = staff || await loadPayrollStaff(supabase, guard);
  const branchIds = [...new Set(branches.map((b) => String(b.id)))].filter(Boolean);
  if (!branchIds.length) return [];

  const [runsResult, entries] = await Promise.all([
    supabase.from("payroll_run_summaries").select("*").in("branch_id", branchIds).eq("period_label", period.label),
    readEntries(supabase, branchIds, [period.label]),
  ]);
  const available = !runsResult.error;
  const allRuns = [...(runsResult.data || [])].sort((a, b) => (Number(a.run_no) || 1) - (Number(b.run_no) || 1)).map(shapeRun);
  const runIds = allRuns.map((r) => r.id);
  const [exclusionsResult, historyResult, itemsResult, firsts] = await Promise.all([
    available && runIds.length
      ? fetchAllIn(() => supabase.from("payroll_run_exclusions").select("id,run_id,submission_no,employee_id,employee_name,employee_code,reason,acknowledged_by_name,created_at,left_out_as").order("id", { ascending: true }), "run_id", runIds)
      : { data: [] },
    available && runIds.length
      ? fetchAllIn(() => supabase.from("payroll_approval_history").select("*").order("created_at", { ascending: true }).order("id", { ascending: true }), "run_id", runIds)
      : { data: [] },
    available && runIds.length
      ? fetchAllIn(() => supabase.from("payroll_run_items").select("run_id,submission_no,entry_id,employee_id,employee_name,employee_code,payslip_no,gross_pay,total_deductions,net_pay").order("employee_name", { ascending: true }).order("id", { ascending: true }), "run_id", runIds)
      : { data: [] },
    firstHalvesFor(supabase, period.label, entries.map((e) => e.employee_id)),
  ]);
  const entryById = new Map(entries.map((e) => [String(e.id), e]));
  const cutoffType = period.start_key.endsWith("-01") ? "first" : "second";

  const cards = [];
  for (const branch of branches) {
    const id = String(branch.id);
    const branchRuns = allRuns.filter((r) => String(r.branch_id) === id);
    const latest = branchRuns[branchRuns.length - 1] || null;
    const roster = branchRoster({ staff: people, branchId: id, period, entries });
    const waiting = roster.finals.filter((e) => !e.run_id);
    const supplemental = latest?.status === "approved" && (waiting.length > 0 || roster.drafts.length > 0);
    const exclusionsOf = (run) => (exclusionsResult.data || []).filter((x) => x.run_id === run.id && Number(x.submission_no) === Number(run.submission_no)).map(shapeExclusion);
    const historyOf = (run) => (historyResult.data || []).filter((h) => h.run_id === run.id);
    const base = {
      available,
      branch_id: id,
      branch_name: branch.name,
      period_label: period.label,
      cutoff_type: cutoffType,
      expected_count: roster.active.length,
      // Active employees with a Final payslip in any run of the period.
      processed_count: roster.processed.length,
      draft_count: roster.drafts.length,
    };

    // The open card: what the Accountant can still submit.
    const openRun = latest && isEditableRun(latest) ? latest : null;
    if (!latest || openRun || supplemental) {
      const eligible = roster.finals.filter((e) => !e.run_id || e.run_id === openRun?.id);
      const activeIds = new Set(roster.active.map((p) => String(p.id)));
      const included = eligible.filter((e) => activeIds.has(String(e.employee_id))).map((e) => entryRow(e, recomputeOf(e, firsts)));
      const outside = eligible.filter((e) => !activeIds.has(String(e.employee_id))).map((e) => entryRow(e, recomputeOf(e, firsts)));
      const drafts = roster.drafts.map((e) => entryRow(e, recomputeOf(e, firsts)));
      const recompute = [...included, ...outside].filter((r) => r.needs_recompute);
      const blockers = [];
      if (!available) blockers.push("Payroll approval is not set up yet: apply supabase/migrations/20261014010000_payroll_run_approval.sql.");
      if (!included.length && !outside.length) blockers.push("No Final payslip in this run yet: process at least one employee as Final.");
      if (recompute.length) blockers.push(`${recompute.length} 2nd-half payslip${recompute.length === 1 ? " needs" : "s need"} recompute (the 1st half changed): ${recompute.map((r) => r.employee_name).join(", ")}. Recompute ${recompute.length === 1 ? "it" : "them"} first.`);
      cards.push({
        ...base,
        key: openRun ? openRun.id : `open-${id}${supplemental ? `-${(Number(latest.run_no) || 1) + 1}` : ""}`,
        run: openRun ? { ...openRun } : null,
        status: openRun?.status || "draft",
        status_label: RUN_STATUS_LABELS[openRun?.status || "draft"],
        editable: true,
        locked: false,
        supplemental,
        run_no: supplemental ? (Number(latest.run_no) || 1) + 1 : Number(openRun?.run_no) || 1,
        approved_run: supplemental ? { ...latest } : null,
        final_count: included.length,
        included,
        drafts,
        outside,
        missing: leftOutOf(roster),
        exclusions: openRun ? exclusionsOf(openRun) : [],
        totals_preview: sumRows(included),
        recompute_count: recompute.length,
        blockers,
        can_submit: blockers.length === 0,
        history: openRun ? historyOf(openRun) : [],
      });
    }

    // Every submitted run of the period, newest first, read only.
    [...branchRuns].reverse().filter((run) => run.status === "pending" || run.status === "approved").forEach((run) => {
      const items = (itemsResult.data || []).filter((i) => i.run_id === run.id && Number(i.submission_no) === Number(run.submission_no));
      const rows = items.map((item) => {
        const entry = entryById.get(String(item.entry_id)) || null;
        return itemRow(item, entry, entry ? recomputeOf(entry, firsts) : null);
      });
      cards.push({
        ...base,
        key: run.id,
        run: { ...run },
        status: run.status,
        status_label: RUN_STATUS_LABELS[run.status],
        editable: false,
        locked: true,
        supplemental: false,
        run_no: Number(run.run_no) || 1,
        approved_run: null,
        final_count: rows.length,
        included: rows,
        drafts: [],
        outside: [],
        missing: [],
        exclusions: exclusionsOf(run),
        totals_preview: sumRows(rows),
        recompute_count: rows.filter((r) => r.needs_recompute).length,
        blockers: [run.status === "pending" ? "Submitted: waiting for HR. HR can reject it to reopen it." : "Paid: approved by HR and locked."],
        can_submit: false,
        history: historyOf(run),
      });
    });
  }
  return cards;
}

function shapeExclusion(row) {
  return {
    employee_id: row.employee_id,
    employee_name: row.employee_name,
    employee_code: row.employee_code || null,
    reason: row.reason || null,
    left_out_as: row.left_out_as || null,
    left_out_label: LEFT_OUT_LABELS[row.left_out_as] || null,
    acknowledged_by_name: row.acknowledged_by_name || null,
    at: row.created_at || null,
  };
}

/**
 * Submit (or resubmit) a branch's run. Drafts never block: an employee with
 * only a Draft is left out like one not processed (2026-11-15). Anyone left
 * out must be confirmed (acknowledgeExclusions) after the Accountant saw the
 * list; the list, with any note per employee, is stored with the snapshot and
 * shown to HR. A Final payslip outside the branch's active list goes in only
 * when ticked (includeOutside: entry ids); otherwise it is listed as left out.
 * @param {{ branchId: string, periodLabel: string, acknowledgeExclusions?: boolean, exclusionNotes?: Record<string,string>, includeOutside?: string[] }} input
 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
 */
export async function submitRun(supabase, guard, { branchId, periodLabel, acknowledgeExclusions = false, exclusionNotes = {}, includeOutside = [] }) {
  const period = periodFromLabel(periodLabel);
  if (!period) return { ok: false, status: 400, body: { error: "Choose a valid pay period." } };
  if (!guard.branchExempt && String(guard.branchId || "") !== String(branchId || "")) {
    return { ok: false, status: 403, body: { error: "That is another branch's payroll." } };
  }

  const staff = await loadPayrollStaff(supabase, guard);
  const entries = await readEntries(supabase, [branchId], [period.label]);
  const roster = branchRoster({ staff, branchId, period, entries });
  const ticked = new Set((Array.isArray(includeOutside) ? includeOutside : []).map(String));
  const activeIds = new Set(roster.active.map((p) => String(p.id)));
  const leftOut = leftOutOf(roster);
  // Unticked Final payslips outside the active list (counted once the run is known).
  const outsideLeft = (runId) => roster.outside.filter((e) => (!e.run_id || e.run_id === runId) && !ticked.has(String(e.id)));

  const notes = exclusionNotes && typeof exclusionNotes === "object" ? exclusionNotes : {};
  if (Object.values(notes).some((note) => String(note || "").trim().length > EXCLUSION_REASON_MAX)) {
    return { ok: false, status: 400, body: { code: "invalid_exclusion_note", error: `A note can be at most ${EXCLUSION_REASON_MAX} characters.` } };
  }
  // Leaving employees out is allowed, never silently: the Accountant must
  // have seen this list and confirmed it (2026-10-29).
  const unconfirmed = [...leftOut.map((p) => ({ id: p.id, name: p.name, code: p.code, left_out_as: p.left_out_as })),
    ...outsideLeft(null).map((e) => ({ id: e.employee_id, name: e.employee_name, code: e.employee_code, left_out_as: LEFT_OUT_AS.outside_list }))];
  if (unconfirmed.length && acknowledgeExclusions !== true) {
    return {
      ok: false, status: 409,
      body: {
        code: "exclusions_unacknowledged",
        error: `${unconfirmed.length} employee${unconfirmed.length === 1 ? " is" : "s are"} not in this run: ${unconfirmed.map((p) => p.name).join(", ")}. Confirm they are intentionally left out, or process them first.`,
        missing: unconfirmed,
      },
    };
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
  // This run's payslips: the active list's Final ones not in another run, and any ticked from outside it.
  const eligible = roster.finals.filter((entry) => !entry.run_id || entry.run_id === run.id);
  const finals = eligible.filter((entry) => activeIds.has(String(entry.employee_id)) || ticked.has(String(entry.id)));
  if (!finals.length) return { ok: false, status: 409, body: { code: "nothing_processed", error: "No Final payslip in this run yet." } };

  // A 2nd half whose 1st half changed since is recomputed first (2026-11-15).
  const firsts = await firstHalvesFor(supabase, period.label, finals.map((e) => e.employee_id));
  const stale = finals.map((entry) => ({ entry, change: recomputeOf(entry, firsts) })).filter((x) => x.change);
  if (stale.length) {
    return {
      ok: false, status: 409,
      body: {
        code: "needs_recompute",
        error: `Recompute first: ${stale.map((x) => `${x.entry.employee_name} (${x.change.reason})`).join("; ")}.`,
        needs_recompute: stale.map((x) => ({ entry_id: x.entry.id, employee_name: x.entry.employee_name, reason: x.change.reason })),
      },
    };
  }

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

  const note = (id) => String(notes[id] || "").trim() || null;
  const exclusions = [
    ...leftOut.map((p) => ({ employee_id: p.id, employee_name: p.name, employee_code: p.code || null, reason: note(p.id), left_out_as: p.left_out_as })),
    ...outsideLeft(run.id).map((e) => ({ employee_id: e.employee_id, employee_name: e.employee_name, employee_code: e.employee_code || null, reason: note(e.employee_id), left_out_as: LEFT_OUT_AS.outside_list })),
  ];
  const submitted = await supabase.rpc("submit_payroll_run", { p_run_id: run.id, p_actor: guard.userId, p_items: items, p_exclusions: exclusions });
  if (submitted.error) {
    const failure = describeRunError(submitted.error);
    return { ok: false, status: failure.status, body: failure };
  }
  const saved = Array.isArray(submitted.data) ? submitted.data[0] : submitted.data;
  return { ok: true, status: 200, body: { success: true, run: shapeRun(saved || run), items: items.length, excluded: exclusions.length } };
}

/** follow_up values of the left-out list, as the screens say them. */
export const FOLLOW_UP_LABELS = Object.freeze({
  not_processed: "Not processed yet",
  draft: "Draft, not finalized",
  processed_not_submitted: "Processed, not submitted",
  supplemental_pending: "In supplemental run, Pending HR Approval",
  supplemental_rejected: "Left out again: supplemental run rejected by HR",
});

/**
 * Paid 2nd halves that need a correction (2026-11-16): their 1st half changed
 * after they were computed, and no correction is filed for them yet (Pending
 * or Approved). A Rejected correction shows the warning again. Payroll
 * Records and the payslip view show it inline; nothing is listed elsewhere.
 *
 * rows: records already scoped to the caller ({ id, employee_id, pay_period,
 * run_status }). Returns Map(entry id -> { reason, kind, amount, period_label }).
 * @returns {Promise<Map<string, object>>}
 */
export async function correctionsDue(supabase, rows) {
  const candidates = (rows || []).filter((r) => r?.id && r.run_status === "approved" && firstHalfLabelOf(r.pay_period));
  const out = new Map();
  if (!candidates.length) return out;
  const seconds = await fetchAllIn(() => supabase.from("payroll_entries").select(ENTRY_COLUMNS).order("id", { ascending: true }), "id", candidates.map((r) => r.id));
  if (seconds.error) throw new Error(seconds.error.message);
  const firstLabels = [...new Set((seconds.data || []).map((e) => firstHalfLabelOf(e.pay_period)))];
  const firsts = await fetchAllIn(() => supabase.from("payroll_entries").select(ENTRY_COLUMNS).in("pay_period", firstLabels).order("id", { ascending: true }),
    "employee_id", [...new Set((seconds.data || []).map((e) => e.employee_id))]);
  if (firsts.error) throw new Error(firsts.error.message);
  const firstOf = new Map((firsts.data || []).map((e) => [`${e.employee_id}|${e.pay_period}`, e]));
  const taxRows = await loadFlagTaxRows(supabase);
  const changed = (seconds.data || [])
    .map((entry) => ({ entry, change: firstHalfChange(entry, firstOf.get(`${entry.employee_id}|${firstHalfLabelOf(entry.pay_period)}`) || null, { taxRows }) }))
    .filter((x) => x.change);
  if (!changed.length) return out;
  const filed = await fetchAllIn(() => supabase.from("payroll_corrections").select("entry_id,status").in("status", ["pending", "approved"]).order("id", { ascending: true }),
    "entry_id", changed.map((x) => x.entry.id));
  if (filed.error) throw new Error(filed.error.message);
  const done = new Set((filed.data || []).map((c) => String(c.entry_id)));
  changed.filter((x) => !done.has(String(x.entry.id))).forEach(({ entry, change }) => {
    out.set(String(entry.id), {
      reason: change.reason,
      // The month settles against the 1st half: a larger 1st half means this 2nd half paid too much.
      kind: change.difference > 0 ? "overpayment" : "underpayment",
      amount: Math.abs(change.difference),
      period_label: entry.pay_period,
    });
  });
  return out;
}

/**
 * Employees left out of a submitted run who are not paid for that period
 * yet: the follow-up list (Accountant: own branch; HR: every branch). They
 * stay until a run holding their payslip is Paid (2026-11-15); while that
 * run is Pending they show "In supplemental run, Pending HR Approval", and
 * if HR rejects it they show as left out again.
 * @returns {Promise<Array<object>>}
 */
export async function listOpenExclusions(supabase, guard) {
  let runsQuery = supabase.from("payroll_run_summaries").select("id,branch_id,branch_name,period_label,period_start,submission_no,run_no,status,submitted_at")
    .gt("excluded_employees", 0);
  if (!guard.branchExempt) runsQuery = runsQuery.eq("branch_id", guard.branchId || "00000000-0000-0000-0000-000000000000");
  const runsResult = await runsQuery.order("period_start", { ascending: false }).limit(200);
  if (runsResult.error || !(runsResult.data || []).length) return [];
  const runs = new Map(runsResult.data.map((r) => [r.id, r]));
  const excl = await fetchAllIn(() => supabase.from("payroll_run_exclusions").select("run_id,submission_no,employee_id,employee_name,employee_code,reason,acknowledged_by_name,created_at,left_out_as").order("created_at", { ascending: true }), "run_id", [...runs.keys()]);
  if (excl.error) throw new Error(excl.error.message);
  // Only the current snapshot of each run (a resubmission replaces the list).
  const current = (excl.data || []).filter((x) => Number(x.submission_no) === Number(runs.get(x.run_id)?.submission_no));
  if (!current.length) return [];
  const labels = [...new Set(current.map((x) => runs.get(x.run_id).period_label))];
  const ids = [...new Set(current.map((x) => x.employee_id))];
  const found = await fetchAllIn(() => supabase.from("payroll_entries").select("employee_id,pay_period,run_id,status").in("pay_period", labels).order("id", { ascending: true }), "employee_id", ids);
  if (found.error) throw new Error(found.error.message);
  const runIds = [...new Set((found.data || []).map((e) => e.run_id).filter(Boolean))];
  const runStatus = new Map();
  if (runIds.length) {
    const statuses = await fetchAllIn(() => supabase.from("payroll_runs").select("id,status,run_no").order("id", { ascending: true }), "id", runIds);
    (statuses.data || []).forEach((r) => runStatus.set(r.id, r));
  }
  const out = [];
  const seen = new Set();
  for (const x of current) {
    const r = runs.get(x.run_id);
    const key = `${x.employee_id}|${r.period_label}`;
    if (seen.has(key)) continue;
    const entry = (found.data || []).find((e) => e.employee_id === x.employee_id && e.pay_period === r.period_label) || null;
    const inRun = entry?.run_id ? runStatus.get(entry.run_id) || null : null;
    if (inRun?.status === "approved") continue; // paid: followed up
    // Still listed by this very run's current snapshot: the payslip is not in it.
    const follow = !entry ? "not_processed"
      : entry.status === "draft" ? "draft"
        : inRun?.status === "pending" ? "supplemental_pending"
          : inRun?.status === "rejected" ? "supplemental_rejected"
            : "processed_not_submitted";
    seen.add(key);
    out.push({
      ...shapeExclusion(x),
      run_id: r.id, run_no: Number(r.run_no) || 1, run_status: r.status,
      branch_id: r.branch_id, branch_name: r.branch_name, period_label: r.period_label, period_start: String(r.period_start).slice(0, 10),
      follow_up: follow,
      follow_up_label: FOLLOW_UP_LABELS[follow],
      supplemental_run_no: inRun && entry.run_id !== x.run_id ? Number(inRun.run_no) || null : null,
    });
  }
  return out.sort((a, b) => b.period_start.localeCompare(a.period_start) || a.employee_name.localeCompare(b.employee_name));
}
