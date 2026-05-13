import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readAllSalaryApprovals } from "@/lib/salary-approvals/store";
import { PATCH as patchDashboardData } from "@/app/api/admin/dashboard/route";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) return null;
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Approvals stored before the payroll_breakdown column was added have a null
// breakdown. Enrich them by looking up the matching payroll_entries row via
// approval_id, which always carries the full payroll JSONB.
async function enrichBreakdowns(approvals) {
  const missing = approvals.filter((a) => !a.payroll_breakdown && a.id);
  if (!missing.length) return;

  const supabase = getAdminClient();
  if (!supabase) return;

  try {
    const ids = missing.map((a) => a.id);
    const { data } = await supabase
      .from("payroll_entries")
      .select("approval_id,payroll")
      .in("approval_id", ids);

    if (!data?.length) return;

    const byApprovalId = new Map(
      data.map((e) => {
        const payroll =
          typeof e.payroll === "string" ? JSON.parse(e.payroll) : e.payroll;
        return [e.approval_id, payroll];
      }),
    );

    for (const approval of approvals) {
      if (!approval.payroll_breakdown && byApprovalId.has(approval.id)) {
        const payroll = byApprovalId.get(approval.id);
        if (payroll?.totals) {
          approval.payroll_breakdown = payroll;
        }
      }
    }
  } catch {
    // enrichment is best-effort; don't block the response
  }
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const status = String(url.searchParams.get("status") || "pending").toLowerCase();

    const allApprovals = await readAllSalaryApprovals();

    // Fill in missing breakdowns from payroll_entries (no-op if all already present).
    await enrichBreakdowns(allApprovals);

    const pendingRequests = allApprovals.filter((row) => row.status === "pending");
    const historyRequests = allApprovals.filter((row) => row.status !== "pending");

    let requests;
    if (status === "all") {
      requests = allApprovals;
    } else if (status === "history") {
      requests = historyRequests;
    } else {
      requests = allApprovals.filter((row) => row.status === status);
    }

    return NextResponse.json({
      requests,
      pending_requests: pendingRequests,
      history_requests: historyRequests,
      can_persist: true,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  return patchDashboardData(request);
}
