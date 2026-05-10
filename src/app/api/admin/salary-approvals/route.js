import { NextResponse } from "next/server";
import { readAllSalaryApprovals } from "@/lib/salary-approvals/store";
import { PATCH as patchDashboardData } from "@/app/api/admin/dashboard/route";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const status = String(url.searchParams.get("status") || "pending").toLowerCase();

    const allApprovals = await readAllSalaryApprovals();
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
