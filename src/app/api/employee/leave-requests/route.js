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
    status: normalizeText(row.status, "pending_accountant").toLowerCase(),
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
    const employeeId = normalizeText(url.searchParams.get("employee_id"));
    const employeeName = normalizeText(url.searchParams.get("employee_name")).toLowerCase();

    if (!employeeId && !employeeName) {
      return NextResponse.json({ requests: [] });
    }

    const allRequests = await readLeaveRequests();
    const requests = allRequests.filter((row) => {
      if (employeeId && row.employee_id === employeeId) return true;
      if (employeeName && row.employee_name.toLowerCase() === employeeName) return true;
      return false;
    });

    return NextResponse.json({ requests });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();

    const employeeId = normalizeText(body.employee_id);
    const employeeName = normalizeText(body.employee_name);
    const position = normalizeText(body.position, "Employee");
    const leaveType = normalizeText(body.leave_type);
    const startDate = normalizeText(body.start_date);
    const endDate = normalizeText(body.end_date);
    const reason = normalizeText(body.reason);
    const proofUrl = body.proof_url || "";

    if (!employeeName || !leaveType || !startDate || !endDate || !reason) {
      return NextResponse.json(
        { error: "employee_name, leave_type, start_date, end_date, and reason are required." },
        { status: 400 },
      );
    }

    if (startDate > endDate) {
      return NextResponse.json({ error: "start_date must not be after end_date." }, { status: 400 });
    }

    const requests = await readLeaveRequests();
    const hasDuplicatePending = requests.some((row) => {
      const isSameEmployee = employeeId
        ? row.employee_id === employeeId
        : row.employee_name.toLowerCase() === employeeName.toLowerCase();

      if (!isSameEmployee) return false;
      if (row.status === "pending_accountant" || row.status === "pending_admin") {
        return row.leave_type === leaveType && row.start_date === startDate && row.end_date === endDate;
      }
      return false;
    });

    if (hasDuplicatePending) {
      return NextResponse.json(
        { error: "This leave request is already submitted and awaiting admin approval." },
        { status: 409 },
      );
    }

    const nowIso = new Date().toISOString();
    const nextRequest = normalizeLeaveRequest({
      id: crypto.randomUUID(),
      employee_id: employeeId,
      employee_name: employeeName,
      position,
      leave_type: leaveType,
      start_date: startDate,
      end_date: endDate,
      reason,
      proof_url: proofUrl,
      status: "pending_accountant",
      submitted_at: nowIso,
      decided_at: null,
      updated_at: nowIso,
    });

    requests.unshift(nextRequest);
    await writeLeaveRequests(requests);

    return NextResponse.json({ success: true, request: nextRequest }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
