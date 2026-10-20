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
import { fetchAllRows } from "@/lib/supabase/fetch-all";
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

/** Processed entries the caller may see (branch-scoped callers: their own staff only). */
async function readEntries(supabase, guard) {
  const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
  const byId = new Map(staff.map((person) => [person.id, person]));
  const result = await fetchAllRows(() => supabase
    .from("payroll_entries")
    .select("*")
    .neq("status", "draft")
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true }));
  if (result.error) throw new Error(result.error.message);
  const entries = (result.data || [])
    .filter((row) => guard.branchExempt || byId.has(row.employee_id))
    .map(normalizeEntry);
  return { entries, byId };
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
    const { entries, byId } = await readEntries(supabase, guard);

    // One payslip (and its PDF).
    if (entryId) {
      const entry = entries.find((row) => row.id === entryId);
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

    // The list: branch names and each payslip's Payroll Approval state.
    const branchIds = [...new Set(entries.map((row) => byId.get(row.employee_id)?.branch_id || row.branch_id).filter(Boolean))];
    const runIds = [...new Set(entries.map((row) => row.run_id).filter(Boolean))];
    const [branches, runs] = await Promise.all([
      branchIds.length ? supabase.from("branches").select("id,name").in("id", branchIds) : { data: [] },
      runIds.length ? supabase.from("payroll_runs").select("id,status").in("id", runIds) : { data: [] },
    ]);
    const branchName = new Map((branches.data || []).map((b) => [b.id, b.name]));
    const runStatus = new Map((runs.data || []).map((r) => [r.id, r.status]));

    const records = entries.map((row) => {
      const totals = row.payroll.totals;
      const person = byId.get(row.employee_id);
      const branchId = person?.branch_id || row.branch_id || null;
      const run = row.run_id ? runStatus.get(row.run_id) || null : null;
      return {
        id: row.id,
        employee_id: row.employee_id,
        employee_name: person?.full_name || row.employee_name || "—",
        employee_code: row.employee_code || person?.employee_id || "",
        branch_id: branchId,
        branch_name: branchName.get(branchId) || "—",
        pay_period: row.pay_period,
        payslip_no: row.payslip_no || null,
        processed_at: row.submitted_at || row.updated_at || row.created_at,
        // Per-cutoff payslips: the cutoff's gross, incentives and subsidy included.
        gross_pay: amount(row.payroll?.monthly?.cutoff?.gross_pay ?? totals.gross_pay ?? row.payroll.basic_salary),
        total_deductions: amount(totals.total_deductions),
        net_pay: floorNetPay(totals.net_pay ?? 0),
        run_status: run,
        run_label: run ? RUN_LABELS[run] || run : null,
      };
    });

    return NextResponse.json({
      records,
      periods: [...new Set(records.map((r) => r.pay_period).filter(Boolean))],
      branches: [...new Map(records.filter((r) => r.branch_id).map((r) => [r.branch_id, { id: r.branch_id, name: r.branch_name }])).values()],
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
