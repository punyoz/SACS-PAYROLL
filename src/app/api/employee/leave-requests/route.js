import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { sanitizeError } from "@/lib/api-error";
import {
  readAllLeaveRequests,
  insertLeaveRequest,
  normalizeLeaveRequest,
  summarizeLeaveBalance,
} from "@/lib/leave-requests/store";
import { createClient } from "@supabase/supabase-js";
import { requirePermission, resolveTargetUserId, denyForeignBranch } from "@/lib/rbac/guard";
import { SCOPE_SELF } from "@/lib/rbac/permissions";
import { validateProofUrl } from "@/lib/leave-requests/proof";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The branch an employee is assigned to now (profiles is authoritative). */
async function currentBranchOf(employeeId) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.from("profiles").select("branch_id").eq("id", employeeId).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.branch_id || null;
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "read");
    if (guard.denied) return guard.denied;

    const url = new URL(request.url);

    // Requests are matched on the account id alone. They used to match on id
    // OR employee name, so two employees who share a name saw each other's
    // leave -- reasons, dates and medical proof documents included.
    const employeeId = resolveTargetUserId(guard, url.searchParams.get("employee_id"));
    if (!employeeId || !UUID_PATTERN.test(employeeId)) {
      return NextResponse.json({ requests: [] });
    }

    // A branch-scoped reviewer (Admin) may only look inside its own branch.
    // Previously any employee_id was accepted, whichever branch it was in.
    if (guard.scope !== SCOPE_SELF && !guard.branchExempt) {
      const foreign = denyForeignBranch(guard, await currentBranchOf(employeeId));
      if (foreign) return foreign;
    }

    const requests = await readAllLeaveRequests({ employeeId });

    const balance = summarizeLeaveBalance(requests, employeeId);

    return NextResponse.json({ requests, balance });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "create");
    if (guard.denied) return guard.denied;

    const body = await request.json();

    // Whose request this is comes from the signed session, not the body, so a
    // caller cannot file (or later cancel) leave in a colleague's name.
    const employeeId = resolveTargetUserId(guard, body.employee_id);
    // leave_requests.employee_id is the account's user id (a UUID, with a
    // foreign key to profiles -- 20260926100000_schema_tidy_up.sql), never an
    // employee code.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employeeId)) {
      return NextResponse.json({ error: "Leave can only be filed for an employee account." }, { status: 400 });
    }
    const employeeName = guard.scope === SCOPE_SELF
      ? String(guard.session?.full_name || "").trim()
      : String(body.employee_name || "").trim();
    const position = String(body.position || "Employee").trim();
    const leaveType = String(body.leave_type || "").trim();
    const payStatus = String(body.pay_status || "with_pay").trim().toLowerCase() === "without_pay"
      ? "without_pay"
      : "with_pay";
    const startDate = String(body.start_date || "").trim();
    const endDate = String(body.end_date || "").trim();
    const reason = String(body.reason || "").trim();
    // Only a PDF / PNG / JPEG data URL under 2 MB, the shape the portal
    // itself sends. It used to be stored exactly as sent, and the proof
    // viewer put it straight into HR's page -- a stored XSS any employee
    // could plant (src/lib/leave-requests/proof.js).
    const proof = validateProofUrl(body.proof_url);
    if (!proof.ok) {
      return NextResponse.json({ error: proof.error }, { status: 400 });
    }
    const proofUrl = proof.value;

    if (!employeeName || !leaveType || !startDate || !endDate || !reason) {
      return NextResponse.json(
        { error: "employee_name, leave_type, start_date, end_date, and reason are required." },
        { status: 400 },
      );
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return NextResponse.json({ error: "Dates must be in YYYY-MM-DD format." }, { status: 400 });
    }
    if (leaveType.length > 64 || reason.length > 1000) {
      return NextResponse.json({ error: "Leave type or reason is too long." }, { status: 400 });
    }

    if (startDate > endDate) {
      return NextResponse.json(
        { error: "start_date must not be after end_date." },
        { status: 400 },
      );
    }

    const allRequests = await readAllLeaveRequests({ employeeId });
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
