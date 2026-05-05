import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeText } from "@/lib/auth/normalize";

const runtimeDir = path.join(os.tmpdir(), "bncs-payroll-runtime");
const leaveRequestsStorePath = path.join(runtimeDir, "leave-requests.json");

function normalizeLeaveRequest(row) {
  return {
    id: normalizeText(row.id, crypto.randomUUID()),
    employee_id: normalizeText(row.employee_id),
    employee_name: normalizeText(row.employee_name, "Unknown Employee"),
    position: normalizeText(row.position, "Employee"),
    leave_type: normalizeText(row.leave_type, "Leave"),
    start_date: normalizeText(row.start_date),
    end_date: normalizeText(row.end_date),
    reason: normalizeText(row.reason, "No reason provided."),
    proof_url: normalizeText(row.proof_url, ""),
    status: normalizeText(row.status, "pending_admin").toLowerCase(),
    submitted_at: row.submitted_at || new Date().toISOString(),
    decided_at: row.decided_at || null,
    updated_at: row.updated_at || row.submitted_at || new Date().toISOString(),
  };
}

async function readLeaveRequests() {
  try {
    const raw = await fs.readFile(leaveRequestsStorePath, "utf8");
    const parsed = JSON.parse(raw);
    const requests = Array.isArray(parsed.requests)
      ? parsed.requests.map(normalizeLeaveRequest)
      : [];

    return requests.sort((a, b) => {
      const aTime = new Date(a.submitted_at || 0).getTime();
      const bTime = new Date(b.submitted_at || 0).getTime();
      return bTime - aTime;
    });
  } catch {
    return [];
  }
}

async function writeLeaveRequests(requests) {
  await fs.mkdir(path.dirname(leaveRequestsStorePath), { recursive: true });
  await fs.writeFile(
    leaveRequestsStorePath,
    JSON.stringify({ requests: requests.map(normalizeLeaveRequest) }, null, 2),
    "utf8",
  );
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const status = normalizeText(url.searchParams.get("status"), "pending_admin").toLowerCase();

    const allRequests = await readLeaveRequests();
    const pendingRequests = allRequests.filter((row) => row.status === "pending_admin");
    const historyRequests = allRequests.filter((row) => row.status !== "pending_admin" && row.status !== "pending_accountant");

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
    const id = normalizeText(body.id);
    const action = normalizeText(body.action).toLowerCase();

    if (!id) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json({ error: "action must be approve or reject." }, { status: 400 });
    }

    const requests = await readLeaveRequests();
    const index = requests.findIndex((row) => row.id === id);

    if (index < 0) {
      return NextResponse.json({ error: "Leave request not found." }, { status: 404 });
    }

    if (requests[index].status !== "pending_admin") {
      return NextResponse.json(
        { error: `Cannot ${action} a leave request that is ${requests[index].status}.` },
        { status: 400 }
      );
    }

    const nowIso = new Date().toISOString();
    const nextStatus = action === "approve" ? "approved" : "rejected";

    requests[index] = normalizeLeaveRequest({
      ...requests[index],
      status: nextStatus,
      decided_at: nowIso,
      updated_at: nowIso,
    });

    await writeLeaveRequests(requests);

    return NextResponse.json({
      success: true,
      request: requests[index],
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
