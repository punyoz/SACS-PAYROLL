/**
 * The Accountant's side of Payroll Approval (src/lib/payroll/run-service.js).
 *
 *   GET   ?period=October 1-15, 2026
 *         each visible branch's run: status, HR's remarks, history, and how
 *         many payslips are Final / Draft / missing.
 *   GET   ?view=excluded
 *         employees left out of a submitted run of the branch and not in any
 *         run of that period since (follow-up).
 *   PATCH { action: "submit", branch_id, period, acknowledge_exclusions?, exclusion_notes? }
 *         Submit (or, after a rejection, resubmit) for HR approval. From then
 *         on the branch's payroll for that period cannot change until HR
 *         rejects it. Employees with no Final payslip may be left out only
 *         with acknowledge_exclusions: true (the Accountant saw the list);
 *         exclusion_notes { employee_id: why } go to HR with the run. After
 *         HR approves, employees processed late are submitted as a
 *         supplemental run. Accountant (own branch) or Super Admin.
 *
 * Mapped to process_payroll in src/proxy.js: HR and Admin have no access here.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { describeBranchRuns, listOpenExclusions, submitRun } from "@/lib/payroll/run-service";

async function visibleBranches(supabase, guard) {
  let query = supabase.from("branches").select("id,name,status").order("name", { ascending: true });
  if (!guard.branchExempt) query = query.eq("id", guard.branchId);
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return (result.data || []).filter((b) => String(b.status || "active").toLowerCase() !== "closed");
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "process_payroll", "read");
    if (guard.denied) return guard.denied;
    const url = new URL(request.url);
    const supabase = getAdminClient();
    if (normalizeText(url.searchParams.get("view")) === "excluded") {
      return NextResponse.json({ excluded: await listOpenExclusions(supabase, guard) });
    }
    const period = normalizeText(url.searchParams.get("period"));
    const runs = await describeBranchRuns(supabase, guard, period, { branches: await visibleBranches(supabase, guard) });
    return NextResponse.json({ period, runs });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "process_payroll", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    if (normalizeText(body.action).toLowerCase() !== "submit") {
      return NextResponse.json({ error: "Action must be submit." }, { status: 400 });
    }
    const result = await submitRun(getAdminClient(), guard, {
      branchId: normalizeText(body.branch_id),
      periodLabel: normalizeText(body.period),
      acknowledgeExclusions: body.acknowledge_exclusions === true,
      exclusionNotes: body.exclusion_notes && typeof body.exclusion_notes === "object" ? body.exclusion_notes : {},
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
