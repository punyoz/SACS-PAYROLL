/**
 * HR → Payroll Records: every processed payslip, read-only.
 *
 *   GET                         every employee's processed payslips (drafts excluded)
 *   GET ?entry_id=…             one payslip, as the Accountant's Pay Record shows it
 *   GET ?entry_id=…&format=pdf  the same payslip as a PDF
 *
 * Module payroll_records (the list) and payslips (one payslip) in
 * src/lib/rbac/permissions.js: HR reads every branch; Admin its own branch;
 * Super Admin every branch. There is no write method: nobody changes a
 * figure here. Accountants keep using /api/accountant/payroll.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";
import { loadPayrollStaff } from "@/lib/payroll/staff";
import { floorNetPay } from "@/lib/payroll/net-pay";
import { buildPayslipPdf } from "@/lib/payroll/payslip-pdf";
import { loadOrgName } from "@/lib/org-name";
import { buildPayslipDetails, payslipSeal } from "@/lib/payroll/payslip-details";

const RUN_LABELS = { pending: "Pending HR approval", approved: "Approved", rejected: "Rejected" };

const amount = (value) => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** A stored row with the payroll object filled in, as buildPayslipDetails reads it. */
function normalizeEntry(row) {
  let payroll = row.payroll;
  if (typeof payroll === "string") {
    try { payroll = JSON.parse(payroll); } catch { payroll = null; }
  }
  payroll = payroll && typeof payroll === "object" ? payroll : {};
  return {
    ...row,
    status: normalizeText(row.status, "draft").toLowerCase(),
    payroll: { ...payroll, totals: payroll.totals || {}, deductions: payroll.deductions || {}, incentives: payroll.incentives || {} },
  };
}

const LIST_COLUMNS = "id,employee_id,employee_name,employee_code,branch_id,pay_period,payslip_no,status,submitted_at,updated_at,created_at,"
  + "run_id,gross_pay,total_deductions,net_pay,basic_salary,totals:payroll->totals,cutoff_gross:payroll->monthly->cutoff->gross_pay";
const PAGE_SIZES = [10, 15, 25, 50, 100];

/** A search word made safe for a PostgREST or() filter (no commas, parentheses or wildcards). */
function searchTerm(value) {
  return normalizeText(value).replace(/[,()*%\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * One page of processed payslips, filtered and searched in the database.
 * Every payslip ever made (5 years: ~140k, ~9 KB each) used to be read and
 * filtered in the browser, which ran the server out of memory (scale test
 * 2026-10-22). Branch-scoped callers see their own branch's only.
 */
function listQuery(supabase, guard, { period, branch, q }) {
  let query = supabase.from("payroll_entries").select(LIST_COLUMNS, { count: "exact" }).neq("status", "draft");
  if (period) query = query.eq("pay_period", period);
  if (!guard.branchExempt) query = query.eq("branch_id", guard.branchId || "00000000-0000-0000-0000-000000000000");
  else if (branch) query = query.eq("branch_id", branch);
  if (q) query = query.or(`employee_name.ilike.*${q}*,employee_code.ilike.*${q}*,payslip_no.ilike.*${q}*,pay_period.ilike.*${q}*`);
  return query;
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const entryId = normalizeText(url.searchParams.get("entry_id"));
    // payroll_records always: an Employee's own-payslip grant must not reach
    // this route (its payslips wait for HR approval on /api/employee/payslips).
    const guard = await requirePermission(request, "payroll_records", "read");
    if (guard.denied) return guard.denied;
    if (entryId) {
      const payslipGuard = await requirePermission(request, "payslips", "read");
      if (payslipGuard.denied) return payslipGuard.denied;
    }

    const supabase = getAdminClient();

    // One payslip (and its PDF).
    if (entryId) {
      const found = await supabase.from("payroll_entries").select("*").eq("id", entryId).neq("status", "draft").maybeSingle();
      if (found.error) throw new Error(found.error.message);
      let entry = found.data ? normalizeEntry(found.data) : null;
      if (entry && !guard.branchExempt) {
        const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
        if (!staff.some((person) => person.id === entry.employee_id)) entry = null;
      }
      if (!entry) return NextResponse.json({ error: "Payslip not found." }, { status: 404 });
      const details = buildPayslipDetails(entry);
      if (normalizeText(url.searchParams.get("format")).toLowerCase() === "pdf") {
        const pdf = buildPayslipPdf(details, { seal: payslipSeal(), orgName: await loadOrgName() });
        const fileName = `payslip-${(entry.payslip_no || entry.employee_code || "record").replace(/[^\w-]/g, "")}-${String(entry.pay_period || "").replace(/[^\w-]+/g, "-")}.pdf`;
        return new NextResponse(pdf, {
          status: 200,
          headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${fileName}"`, "Cache-Control": "no-store" },
        });
      }
      return NextResponse.json({ payslip: details });
    }

    // The list: one page, filtered, with the filters' totals.
    const filters = {
      period: normalizeText(url.searchParams.get("period")),
      branch: normalizeText(url.searchParams.get("branch")),
      q: searchTerm(url.searchParams.get("q")),
    };
    const pageSize = PAGE_SIZES.includes(Number(url.searchParams.get("page_size"))) ? Number(url.searchParams.get("page_size")) : 15;
    const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
    const from = (page - 1) * pageSize;
    const [list, totals, branches, runs] = await Promise.all([
      listQuery(supabase, guard, filters).order("updated_at", { ascending: false }).order("id", { ascending: true }).range(from, from + pageSize - 1),
      supabase.rpc("payroll_entries_totals", {
        p_period: filters.period || null,
        p_branch: guard.branchExempt ? (filters.branch || null) : (guard.branchId || "00000000-0000-0000-0000-000000000000"),
        p_q: filters.q || null,
      }),
      supabase.from("branches").select("id,name").order("name", { ascending: true }),
      // The periods there are (newest first), from the runs: a few hundred rows.
      fetchAllRows(() => {
        let query = supabase.from("payroll_runs").select("id,period_label,period_start");
        if (!guard.branchExempt) query = query.eq("branch_id", guard.branchId || "00000000-0000-0000-0000-000000000000");
        return query.order("period_start", { ascending: false }).order("id", { ascending: true });
      }),
    ]);
    if (list.error) throw new Error(list.error.message);

    const rows = list.data || [];
    const runIds = [...new Set(rows.map((row) => row.run_id).filter(Boolean))];
    const runStatus = new Map(((runIds.length
      ? (await fetchAllIn(() => supabase.from("payroll_runs").select("id,status").order("id", { ascending: true }), "id", runIds)).data
      : []) || []).map((r) => [r.id, r.status]));
    const branchName = new Map((branches.data || []).map((b) => [b.id, b.name]));

    const records = rows.map((row) => {
      const run = row.run_id ? runStatus.get(row.run_id) || null : null;
      const rowTotals = row.totals || {};
      return {
        id: row.id,
        employee_id: row.employee_id,
        employee_name: row.employee_name || "—",
        employee_code: row.employee_code || "",
        branch_id: row.branch_id || null,
        branch_name: branchName.get(row.branch_id) || "—",
        pay_period: row.pay_period,
        payslip_no: row.payslip_no || null,
        processed_at: row.submitted_at || row.updated_at || row.created_at,
        // Per-cutoff payslips: the cutoff's gross, incentives and subsidy included.
        gross_pay: amount(row.cutoff_gross ?? rowTotals.gross_pay ?? row.gross_pay ?? row.basic_salary),
        total_deductions: amount(rowTotals.total_deductions ?? row.total_deductions),
        net_pay: floorNetPay(rowTotals.net_pay ?? row.net_pay ?? 0),
        run_status: run,
        run_label: run ? RUN_LABELS[run] || run : null,
      };
    });
    const sums = Array.isArray(totals.data) ? totals.data[0] : totals.data;

    return NextResponse.json({
      records,
      total: list.count ?? records.length,
      page,
      page_size: pageSize,
      totals: {
        gross: amount(sums?.gross),
        deductions: amount(sums?.deductions),
        net: amount(sums?.net),
        available: !totals.error,
      },
      // Submitted periods (runs), and any on this page not submitted yet.
      periods: [...new Set([...(runs.data || []).map((r) => r.period_label), ...records.map((r) => r.pay_period)].filter(Boolean))],
      branches: guard.branchExempt ? (branches.data || []) : (branches.data || []).filter((b) => b.id === guard.branchId),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
