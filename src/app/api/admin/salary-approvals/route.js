import { NextResponse } from "next/server";
import { GET as getDashboardData, PATCH as patchDashboardData } from "@/app/api/admin/dashboard/route";

export async function GET(request) {
  const dashboardResponse = await getDashboardData();
  const payload = await dashboardResponse.json();

  if (!dashboardResponse.ok) {
    return NextResponse.json(payload, { status: dashboardResponse.status });
  }

  const url = new URL(request.url);
  const status = String(url.searchParams.get("status") || "pending").toLowerCase();
  const pendingRequests = Array.isArray(payload.pending_approvals) ? payload.pending_approvals : [];
  const historyRequests = Array.isArray(payload.approval_history) ? payload.approval_history : [];

  let filteredRequests;
  if (status === "history") {
    filteredRequests = historyRequests;
  } else if (status === "all") {
    filteredRequests = [...pendingRequests, ...historyRequests];
  } else {
    filteredRequests = pendingRequests.filter(
      (requestRow) => String(requestRow.status || "pending").toLowerCase() === status,
    );
  }

  return NextResponse.json({
    requests: filteredRequests,
    pending_requests: pendingRequests,
    history_requests: historyRequests,
    can_persist: Boolean(payload.approvals_can_persist),
    generated_at: payload.generated_at,
  });
}

export async function PATCH(request) {
  return patchDashboardData(request);
}
