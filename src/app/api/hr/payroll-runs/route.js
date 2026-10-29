/**
 * HR → Payroll Approval (supabase/migrations/20261014010000_payroll_run_approval.sql).
 *
 *   GET   ?count=1                       { pending } for the sidebar badge
 *   GET   [?status=pending|approved|rejected|all][&branch_id][&period][&q]
 *                                        one row per branch per period (submitted runs)
 *   GET   ?run_id=…                      the run: summary, every employee's
 *                                        snapshot row, history, Early Bird winner
 *   GET   ?run_id=…&format=xlsx|pdf      the same as Excel or PDF
 *   GET   ?view=history[&branch_id][&period][&q]
 *   GET   ?view=excluded                 employees left out of a submitted run and
 *                                        not in any run of that period since (follow-up)
 *                                        every approve / reject decision, newest
 *                                        first, each with the submission it
 *                                        decided (kept for good: a rejected run
 *                                        that is resubmitted keeps its rejection)
 *   PATCH { action: "approve", run_ids: [...], remarks? }   HR only; one record per run
 *   PATCH { action: "reject", run_id, remarks }             HR only; remarks required
 *
 * Module payroll_run_approval (src/lib/rbac/permissions.js): HR reads every
 * branch and approves / rejects; Super Admin reads every branch; the
 * Accountant reads its own branch's runs. Only HR reaches PATCH, and the
 * database functions check the role and self-approval again.
 *
 * Every figure comes from payroll_run_items, the snapshot taken at
 * submission: what HR approves never changes afterwards.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";
import { shapeWinner } from "@/lib/payroll/early-bird";
import { money } from "@/lib/payroll/payslip-summary";
import { buildXlsx } from "@/lib/export/xlsx";
import { buildTablePdf } from "@/lib/export/table-pdf";
import { FLAG_LABELS, RUN_STATUS_LABELS, describeRunError, runTotals, shapeRun } from "@/lib/payroll/runs";
import { listOpenExclusions } from "@/lib/payroll/run-service";
import { notify } from "@/lib/branch-requests-server";
import { textLimitError } from "@/lib/input-limits";

// The longest text each box takes; the form boxes match.
const TEXT_CAPS = { remarks: [1000, "The remarks"] };

const NOT_READY = "Payroll Approval is not set up yet: apply supabase/migrations/20261014010000_payroll_run_approval.sql.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMITTED = ["pending", "approved", "rejected"];

const num = (value) => Number(value) || 0;

/**
 * Every decision HR made (payroll_approval_history: approved / rejected),
 * newest first, with the run's period and branch and the submission each
 * decision answered (the latest submitted / resubmitted row before it).
 */
async function loadDecisionHistory(supabase, guard, { branchId, period, q }) {
  const runsResult = await fetchAllRows(() => {
    let query = scopeRuns(supabase.from("payroll_run_summaries").select("*"), guard).in("status", SUBMITTED);
    if (branchId && UUID.test(branchId)) query = query.eq("branch_id", branchId);
    if (period) query = query.eq("period_label", period);
    return query.order("period_start", { ascending: false }).order("id", { ascending: true });
  });
  if (runsResult.error) return { error: NOT_READY };
  const runs = new Map((runsResult.data || []).map((row) => [row.id, shapeRun(row)]));
  if (!runs.size) return { rows: [] };
  const historyResult = await fetchAllRows(() => supabase.from("payroll_approval_history").select("*")
    .in("run_id", [...runs.keys()]).order("created_at", { ascending: true }).order("id", { ascending: true }));
  if (historyResult.error) return { error: NOT_READY };
  const lastSubmission = new Map();
  const rows = [];
  for (const h of historyResult.data || []) {
    if (h.action === "submitted" || h.action === "resubmitted") { lastSubmission.set(h.run_id, h); continue; }
    if (h.action !== "approved" && h.action !== "rejected") continue;
    const run = runs.get(h.run_id);
    const submission = lastSubmission.get(h.run_id) || null;
    rows.push({
      id: h.id,
      run_id: h.run_id,
      period_label: run.period_label,
      period_start: run.period_start,
      cutoff_type: run.cutoff_type,
      branch_id: run.branch_id,
      branch_name: run.branch_name,
      submitted_by_name: submission?.actor_name || run.submitted_by_name || null,
      submitted_at: submission?.created_at || null,
      decision: h.action,
      decision_label: h.action === "approved" ? "Approved" : "Rejected",
      decided_by_name: h.actor_name || null,
      decided_at: h.created_at,
      remarks: h.remarks || null,
      totals: h.totals || {},
      current_status: run.status,
      seq: rows.length,
    });
  }
  // Newest first; the history's own order breaks a tie in time.
  rows.sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at)) || b.seq - a.seq);
  const needle = String(q || "").toLowerCase();
  return {
    rows: needle
      ? rows.filter((r) => [r.branch_name, r.period_label, r.submitted_by_name, r.decided_by_name, r.remarks].some((v) => String(v || "").toLowerCase().includes(needle)))
      : rows,
  };
}

function scopeRuns(query, guard) {
  // HR and Super Admin: every branch. The Accountant: its own.
  return guard.branchExempt ? query : query.eq("branch_id", guard.branchId);
}

function shapeItem(row) {
  return {
    id: row.id,
    entry_id: row.entry_id,
    employee_id: row.employee_id,
    employee_name: row.employee_name,
    employee_code: row.employee_code,
    employee_level: row.employee_level,
    schedule_name: row.schedule_name,
    payslip_no: row.payslip_no,
    basic_pay: num(row.basic_pay),
    gross_pay: num(row.gross_pay),
    total_deductions: num(row.total_deductions),
    net_pay: num(row.net_pay),
    attendance_deduction: num(row.attendance_deduction),
    absence_deduction: num(row.absence_deduction),
    late_deduction: num(row.late_deduction),
    undertime_deduction: num(row.undertime_deduction),
    half_day_deduction: num(row.half_day_deduction),
    leave_without_pay_deduction: num(row.leave_without_pay_deduction),
    withholding_tax: num(row.withholding_tax),
    sss: num(row.sss),
    philhealth: num(row.philhealth),
    pagibig: num(row.pagibig),
    loans: num(row.loans),
    other_deductions: num(row.other_deductions),
    early_bird_incentive: num(row.early_bird_incentive),
    total_incentives: num(row.total_incentives),
    days_worked: num(row.days_worked),
    absent_days: num(row.absent_days),
    late_days: num(row.late_days),
    late_minutes: num(row.late_minutes),
    undertime_minutes: num(row.undertime_minutes),
    half_days: num(row.half_days),
    previous_net_pay: row.previous_net_pay === null || row.previous_net_pay === undefined ? null : num(row.previous_net_pay),
    flags: Array.isArray(row.flags) ? row.flags : [],
    breakdown: row.breakdown || {},
  };
}

async function loadRunDetail(supabase, guard, runId) {
  const runResult = await scopeRuns(supabase.from("payroll_run_summaries").select("*").eq("id", runId), guard).maybeSingle();
  if (runResult.error) return { error: NOT_READY, status: 503 };
  if (!runResult.data) return { error: "Payroll run not found.", status: 404 };
  const run = shapeRun(runResult.data);
  const [items, history, winner, excluded] = await Promise.all([
    fetchAllRows(() => supabase.from("payroll_run_items").select("*")
      .eq("run_id", run.id).eq("submission_no", run.submission_no)
      .order("employee_name", { ascending: true }).order("id", { ascending: true })),
    supabase.from("payroll_approval_history").select("*").eq("run_id", run.id).order("created_at", { ascending: true }),
    supabase.from("early_bird_winners").select("*").eq("period_label", run.period_label).maybeSingle(),
    // Who the Accountant left out of this snapshot, and why (20261029080000).
    supabase.from("payroll_run_exclusions").select("employee_id,employee_name,employee_code,reason,acknowledged_by_name,created_at")
      .eq("run_id", run.id).eq("submission_no", run.submission_no).order("employee_name", { ascending: true }),
  ]);
  if (items.error) throw new Error(items.error.message);
  const rows = (items.data || []).map(shapeItem);
  const totals = runTotals(rows);
  const early = winner.error ? null : shapeWinner(winner.data);
  // Another branch's winner is named only to HR and Super Admin.
  const visibleWinner = early && early.employee_id && !guard.branchExempt && String(early.branch_id || "") !== String(guard.branchId || "")
    ? { ...early, employee_name: "An employee of another branch", employee_id: null }
    : early;
  return {
    run: { ...run, totals },
    items: rows,
    history: history.data || [],
    exclusions: (excluded.data || []).map((x) => ({
      employee_id: x.employee_id, employee_name: x.employee_name, employee_code: x.employee_code || null,
      reason: x.reason || null, acknowledged_by_name: x.acknowledged_by_name || null, at: x.created_at,
    })),
    early_bird: visibleWinner,
    can_review: guard.role === "hr" && run.status === "pending",
  };
}

const COLUMNS = [
  { header: "Employee", key: "employee_name", width: 110 },
  { header: "ID", key: "employee_code", width: 52 },
  { header: "Level", key: "employee_level", width: 62 },
  { header: "Schedule", key: "schedule_name", width: 80 },
  { header: "Days worked", key: "days_worked", width: 40, align: "right" },
  { header: "Gross pay", key: "gross_pay", width: 60, align: "right", money: true },
  { header: "Attendance ded.", key: "attendance_deduction", width: 56, align: "right", money: true },
  { header: "W/tax", key: "withholding_tax", width: 50, align: "right", money: true },
  { header: "SSS", key: "sss", width: 44, align: "right", money: true },
  { header: "PhilHealth", key: "philhealth", width: 48, align: "right", money: true },
  { header: "Pag-IBIG", key: "pagibig", width: 44, align: "right", money: true },
  { header: "Loans", key: "loans", width: 48, align: "right", money: true },
  { header: "Other ded.", key: "other_deductions", width: 48, align: "right", money: true },
  { header: "Early Bird", key: "early_bird_incentive", width: 48, align: "right", money: true },
  { header: "Net pay", key: "net_pay", width: 62, align: "right", money: true },
  { header: "Attention", key: "flags", width: 90 },
];

function exportFile(detail, format) {
  const { run, items } = detail;
  const name = `payroll-${String(run.branch_name || "branch").replace(/[^\w-]+/g, "-")}-${run.period_label.replace(/[^\w-]+/g, "-")}`;
  const flagText = (flags) => flags.map((f) => FLAG_LABELS[f] || f).join("; ");
  const totalsRow = ["TOTAL", "", "", "", "", run.totals.gross, sum(items, "attendance_deduction"), sum(items, "withholding_tax"),
    sum(items, "sss"), sum(items, "philhealth"), sum(items, "pagibig"), sum(items, "loans"), sum(items, "other_deductions"),
    sum(items, "early_bird_incentive"), run.totals.net, ""];
  if (format === "xlsx") {
    const rows = items.map((item) => COLUMNS.map((c) => (c.key === "flags" ? flagText(item.flags) : item[c.key] ?? "")));
    const detailRows = items.flatMap((item) => [
      ...(item.breakdown?.cutoff?.earnings || []).map((line) => [item.employee_name, "Earning", line.label, line.note || "", line.amount]),
      // A credit (the year-end tax refund) is added to the pay: negative here.
      ...(item.breakdown?.cutoff?.deductions || []).map((line) => [item.employee_name, "Deduction", line.label, line.note || "", line.credit ? -line.amount : line.amount]),
      ...(!item.breakdown?.cutoff ? (item.breakdown?.lines?.deductions || []).map((line) => [item.employee_name, "Deduction", line.type, `${line.quantity ?? ""} ${line.unit ?? ""} × ${line.rate ?? ""}`.trim(), Number(line.amount) || 0]) : []),
    ]);
    const file = buildXlsx([
      {
        name: "Payroll",
        columns: COLUMNS.map((c) => ({ header: c.header, width: Math.round(c.width / 5) + 4, integer: c.key === "days_worked" })),
        rows: [...rows, totalsRow],
      },
      { name: "Lines", columns: [{ header: "Employee", width: 28 }, { header: "Kind", width: 11 }, { header: "Line", width: 30 }, { header: "How computed", width: 50 }, { header: "Amount", width: 14 }], rows: detailRows },
      {
        name: "Summary",
        columns: [{ header: "Item", width: 24 }, { header: "Value", width: 40 }],
        rows: [["Branch", run.branch_name || ""], ["Period", run.period_label], ["Cutoff", run.cutoff_type === "first" ? "1st (1–15)" : "2nd (16–end)"],
          ["Status", RUN_STATUS_LABELS[run.status]], ["Employees", run.totals.employees], ["Total gross", run.totals.gross],
          ["Total deductions", run.totals.deductions], ["Total net pay", run.totals.net], ["Submitted by", run.submitted_by_name || ""],
          ["Submitted", run.submitted_at || ""], ["Reviewed by", run.reviewed_by_name || ""], ["Remarks", run.remarks || ""]],
      },
    ]);
    return new NextResponse(file, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const pdf = buildTablePdf({
    title: `Payroll — ${run.branch_name || "Branch"}, ${run.period_label}`,
    subtitle: `${run.cutoff_type === "first" ? "1st cutoff: attendance deductions only" : "2nd cutoff: all deductions"} · ${RUN_STATUS_LABELS[run.status]} · submitted by ${run.submitted_by_name || "—"}`,
    summary: [["Employees", String(run.totals.employees)], ["Total gross", `PHP ${money(run.totals.gross)}`],
      ["Total deductions", `PHP ${money(run.totals.deductions)}`], ["Total net pay", `PHP ${money(run.totals.net)}`]],
    columns: COLUMNS.map((c) => ({ header: c.header, width: c.width, align: c.align })),
    rows: [
      ...items.map((item) => COLUMNS.map((c) => (c.key === "flags" ? flagText(item.flags) : c.money ? money(item[c.key]) : String(item[c.key] ?? "")))),
      { bold: true, cells: totalsRow.map((value, i) => (COLUMNS[i]?.money ? money(value) : String(value ?? ""))) },
    ],
    footer: `SACS Payroll · snapshot ${run.submission_no} · ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}`,
  });
  return new NextResponse(pdf, {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}.pdf"`, "Cache-Control": "no-store" },
  });
}

function sum(items, key) {
  return Math.round(items.reduce((total, item) => total + num(item[key]), 0) * 100) / 100;
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "payroll_run_approval", "read");
    if (guard.denied) return guard.denied;
    const url = new URL(request.url);
    const supabase = getAdminClient();

    if (url.searchParams.get("count")) {
      const result = await scopeRuns(supabase.from("payroll_runs").select("id", { count: "exact", head: true }).eq("status", "pending"), guard);
      return NextResponse.json({ available: !result.error, pending: result.error ? 0 : result.count || 0 });
    }

    if (normalizeText(url.searchParams.get("view")) === "excluded") {
      return NextResponse.json({ excluded: await listOpenExclusions(supabase, guard) });
    }

    const runId = normalizeText(url.searchParams.get("run_id"));
    if (runId) {
      if (!UUID.test(runId)) return NextResponse.json({ error: "Payroll run not found." }, { status: 404 });
      const detail = await loadRunDetail(supabase, guard, runId);
      if (detail.error) return NextResponse.json({ error: detail.error }, { status: detail.status });
      const format = normalizeText(url.searchParams.get("format")).toLowerCase();
      if (format === "xlsx" || format === "pdf") return exportFile(detail, format);
      return NextResponse.json(detail);
    }

    const status = normalizeText(url.searchParams.get("status")).toLowerCase() || "pending";
    const branchId = normalizeText(url.searchParams.get("branch_id"));
    const period = normalizeText(url.searchParams.get("period"));
    const q = normalizeText(url.searchParams.get("q")).toLowerCase();

    const listMeta = async () => {
      const [branches, periods] = await Promise.all([
        supabase.from("branches").select("id,name").order("name", { ascending: true }),
        scopeRuns(supabase.from("payroll_runs").select("period_label,period_start").in("status", SUBMITTED), guard).order("period_start", { ascending: false }),
      ]);
      return {
        branches: (branches.data || []).filter((b) => guard.branchExempt || String(b.id) === String(guard.branchId)),
        periods: [...new Set((periods.data || []).map((p) => p.period_label))],
      };
    };

    if (normalizeText(url.searchParams.get("view")).toLowerCase() === "history") {
      const history = await loadDecisionHistory(supabase, guard, { branchId, period, q });
      if (history.error) return NextResponse.json({ available: false, error: history.error, history: [] });
      return NextResponse.json({ available: true, history: history.rows, can_review: guard.role === "hr", ...(await listMeta()) });
    }
    const build = () => {
      let query = scopeRuns(supabase.from("payroll_run_summaries").select("*"), guard)
        .in("status", status === "all" ? SUBMITTED : [status]);
      if (branchId && UUID.test(branchId)) query = query.eq("branch_id", branchId);
      if (period) query = query.eq("period_label", period);
      return query.order("period_start", { ascending: false }).order("id", { ascending: true });
    };
    const result = await fetchAllRows(build);
    if (result.error) return NextResponse.json({ available: false, error: NOT_READY, runs: [] });
    let runs = (result.data || []).map(shapeRun);

    // Search by branch, the people who handled the run, or an employee in it.
    if (q) {
      const byEmployee = runs.length
        ? await fetchAllIn(() => supabase.from("payroll_run_items").select("id,run_id").ilike("employee_name", `%${q}%`).order("id", { ascending: true }), "run_id", runs.map((r) => r.id))
        : { data: [] };
      const withEmployee = new Set((byEmployee.data || []).map((row) => row.run_id));
      runs = runs.filter((run) => withEmployee.has(run.id)
        || [run.branch_name, run.submitted_by_name, run.reviewed_by_name, run.period_label].some((v) => String(v || "").toLowerCase().includes(q)));
    }

    return NextResponse.json({
      available: true,
      runs,
      can_review: guard.role === "hr",
      ...(await listMeta()),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

/** "Your payslip is ready" to every employee on the run's approved submission. */
async function notifyPayslipsReleased(supabase, runId) {
  const run = await supabase.from("payroll_runs").select("period_label,submission_no").eq("id", runId).maybeSingle();
  if (run.error || !run.data) return;
  const items = await supabase.from("payroll_run_items").select("employee_id")
    .eq("run_id", runId).eq("submission_no", run.data.submission_no);
  if (items.error) return;
  await notify(supabase, (items.data || []).map((i) => i.employee_id), {
    kind: "payslip_released",
    title: "Your payslip is ready",
    body: `Your payslip for ${run.data.period_label} was approved by HR.`,
    link_page: "emp-payslips",
  });
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "payroll_run_approval", "update");
    if (guard.denied) return guard.denied;
    // Only HR decides (Super Admin views; the Accountant never approves).
    if (guard.role !== "hr") return NextResponse.json({ error: "Only HR approves or rejects payroll.", code: "forbidden" }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    // Over-long text is refused, not cut short (input limits).
    const tooLong = textLimitError(body, TEXT_CAPS);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
    const action = normalizeText(body.action).toLowerCase();
    const remarks = normalizeText(body.remarks).slice(0, 1000);
    const supabase = getAdminClient();

    if (action === "reject") {
      const runId = normalizeText(body.run_id);
      if (!UUID.test(runId)) return NextResponse.json({ error: "Payroll run not found." }, { status: 404 });
      if (remarks.length < 5) {
        return NextResponse.json({ error: "Write the reason for rejecting (at least 5 characters).", code: "remarks_required" }, { status: 400 });
      }
      const result = await supabase.rpc("reject_payroll_run", { p_run_id: runId, p_actor: guard.userId, p_remarks: remarks });
      if (result.error) {
        const failure = describeRunError(result.error);
        return NextResponse.json(failure, { status: failure.status });
      }
      return NextResponse.json({ success: true, run: shapeRun(Array.isArray(result.data) ? result.data[0] : result.data) });
    }

    if (action === "approve") {
      const ids = [...new Set((Array.isArray(body.run_ids) ? body.run_ids : [body.run_id]).map(normalizeText))].filter((id) => UUID.test(id));
      if (!ids.length) return NextResponse.json({ error: "Choose at least one payroll run." }, { status: 400 });
      if (ids.length > 50) return NextResponse.json({ error: "Approve at most 50 runs at a time." }, { status: 400 });
      // One decision, one record per branch: each run is approved on its own,
      // so one refusal (self-approval, no longer pending) leaves the others.
      const results = [];
      for (const id of ids) {
        const result = await supabase.rpc("approve_payroll_run", { p_run_id: id, p_actor: guard.userId, p_remarks: remarks || null });
        if (result.error) results.push({ run_id: id, ok: false, ...describeRunError(result.error) });
        else results.push({ run_id: id, ok: true, run: shapeRun(Array.isArray(result.data) ? result.data[0] : result.data) });
      }
      const approved = results.filter((r) => r.ok).length;
      // The bell (2026-10-20 audit): each employee on an approved run is told
      // the payslip is ready. Never fails the approval itself.
      for (const done of results.filter((r) => r.ok)) {
        try {
          await notifyPayslipsReleased(supabase, done.run_id);
        } catch { /* the approval stands; the payslip is visible either way */ }
      }
      const status = approved ? 200 : results[0]?.status || 409;
      return NextResponse.json({ success: approved > 0, approved, results }, { status });
    }

    return NextResponse.json({ error: "Action must be approve or reject." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
