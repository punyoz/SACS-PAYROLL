import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  readAllLeaveRequests,
  insertLeaveRequest,
  normalizeLeaveRequest,
  summarizeLeaveBalance,
} from "@/lib/leave-requests/store";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const employeeId = String(url.searchParams.get("employee_id") || "").trim();
    const employeeName = String(url.searchParams.get("employee_name") || "").trim().toLowerCase();

    if (!employeeId && !employeeName) {
      return NextResponse.json({ requests: [] });
    }

    const allRequests = await readAllLeaveRequests();
    const requests = allRequests.filter((row) => {
      if (employeeId && row.employee_id === employeeId) return true;
      if (employeeName && row.employee_name.toLowerCase() === employeeName) return true;
      return false;
    });

    const balance = summarizeLeaveBalance(requests, employeeId);

    return NextResponse.json({ requests, balance });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();

    const employeeId = String(body.employee_id || "").trim();
    const employeeName = String(body.employee_name || "").trim();
    const position = String(body.position || "Employee").trim();
    const leaveType = String(body.leave_type || "").trim();
    const payStatus = String(body.pay_status || "with_pay").trim().toLowerCase() === "without_pay"
      ? "without_pay"
      : "with_pay";
    const startDate = String(body.start_date || "").trim();
    const endDate = String(body.end_date || "").trim();
    const reason = String(body.reason || "").trim();
    // Preserve proof_url exactly — it may be a large base64 data URL.
    const proofUrl = String(body.proof_url || "");

    if (!employeeName || !leaveType || !startDate || !endDate || !reason) {
      return NextResponse.json(
        { error: "employee_name, leave_type, start_date, end_date, and reason are required." },
        { status: 400 },
      );
    }

    if (startDate > endDate) {
      return NextResponse.json(
        { error: "start_date must not be after end_date." },
        { status: 400 },
      );
    }

    const allRequests = await readAllLeaveRequests();
    const hasDuplicatePending = allRequests.some((row) => {
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
        { error: "This leave request is already submitted and awaiting approval." },
        { status: 409 },
      );
    }

    const nowIso = new Date().toISOString();
    const newRequest = normalizeLeaveRequest({
      id: crypto.randomUUID(),
      employee_id: employeeId,
      employee_name: employeeName,
      position,
      leave_type: leaveType,
      pay_status: payStatus,
      start_date: startDate,
      end_date: endDate,
      reason,
      proof_url: proofUrl,
      status: "pending_admin",
      submitted_at: nowIso,
      decided_at: null,
      updated_at: nowIso,
    });

    const saved = await insertLeaveRequest(newRequest);
    return NextResponse.json({ success: true, request: saved }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
