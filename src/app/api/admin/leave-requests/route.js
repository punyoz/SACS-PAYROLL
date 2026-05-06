import { NextResponse } from "next/server";
import { readAllLeaveRequests, updateLeaveRequestStatus } from "@/lib/leave-requests/store";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const status = String(url.searchParams.get("status") || "pending_admin").trim().toLowerCase();

    const allRequests = await readAllLeaveRequests();
    // Admin sees requests that have been forwarded by the accountant.
    const pendingRequests = allRequests.filter((row) => row.status === "pending_admin");
    const historyRequests = allRequests.filter(
      (row) => row.status !== "pending_admin" && row.status !== "pending_accountant",
    );

    let requests;
    if (status === "all") {
      requests = allRequests;
    } else if (status === "history") {
      requests = historyRequests;
    } else {
      requests = allRequests.filter((row) => row.status === status);
    }

    return NextResponse.json({
      requests,
      pending_requests: pendingRequests,
      history_requests: historyRequests,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const id = String(body.id || "").trim();
    const action = String(body.action || "").trim().toLowerCase();

    if (!id) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json({ error: "action must be approve or reject." }, { status: 400 });
    }

    // Verify current status before acting
    const allRequests = await readAllLeaveRequests();
    const current = allRequests.find((row) => row.id === id);

    if (!current) {
      return NextResponse.json({ error: "Leave request not found." }, { status: 404 });
    }

    if (current.status !== "pending_admin") {
      return NextResponse.json(
        { error: `Cannot ${action} a leave request with status: ${current.status}.` },
        { status: 400 },
      );
    }

    const nextStatus = action === "approve" ? "approved" : "rejected";
    const result = await updateLeaveRequestStatus(id, nextStatus);

    if (!result.found) {
      return NextResponse.json({ error: "Leave request not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true, request: result.request });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
