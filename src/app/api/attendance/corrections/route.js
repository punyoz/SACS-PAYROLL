import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { SCOPE_BRANCH, SCOPE_SELF } from "@/lib/rbac/permissions";

/**
 * Missed tap-out / disputed record corrections.
 *
 *   GET   ?status=pending|approved|rejected|all
 *         Employee: their own requests. Admin: its branch's. HR / Super
 *         Admin: every branch's.
 *
 *   POST  { log_id, corrected_time: "HH:MM", reason }
 *         Employee (or Accountant) asks to correct the time out of one of
 *         their own Incomplete / Undertime / Half Day records. The record
 *         becomes Pending Correction.
 *
 *   PATCH { correction_id, decision: "approve" | "reject",
 *           resolution?: "incomplete" | "absent" | "half_day", note? }
 *         HR / Admin decide. Approve: the time out is replaced and the record
 *         becomes Corrected. Reject: it stays Incomplete (kept out of payroll),
 *         or is forced to Absent / Half Day.
 *
 * The status changes themselves happen inside the database functions
 * attendance_request_correction / attendance_review_correction
 * (supabase/migrations/20260926010000_attendance_status_engine.sql), the only
 * code allowed to set a status by hand.
 */

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const COLUMNS = "id,log_id,employee_id,employee_name,branch_id,log_date,original_status,original_time_in,original_time_out,corrected_time_out,reason,requested_at,status,resolution,approved_by,approved_by_name,approved_at,review_note";

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Messages raised by the database functions are written for people; others are not. */
function rpcFailure(error, fallback) {
  const code = String(error?.code || "");
  if (code === "23505") {
    return NextResponse.json({ error: "A correction for this record is already waiting for review." }, { status: 409 });
  }
  if (code === "P0002" || code === "23514") {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ error: sanitizeError(error, fallback) }, { status: 500 });
}

/** Ids of the employees currently assigned to a branch. */
async function branchEmployeeIds(supabase, branchId) {
  const roster = await supabase.from("profiles").select("id").eq("branch_id", branchId).limit(5000);
  if (roster.error) throw new Error(roster.error.message);
  return (roster.data || []).map((row) => row.id);
}

export async function GET(request) {
  const guard = await requirePermission(request, "attendance_corrections", "read");
  if (guard.denied) return guard.denied;

  try {
    const url = new URL(request.url);
    const status = normalizeText(url.searchParams.get("status"), "pending").toLowerCase();
    const supabase = getAdminClient();

    let query = supabase
      .from("attendance_corrections")
      .select(COLUMNS)
      .order("requested_at", { ascending: false })
      .limit(500);
    if (status !== "all") query = query.eq("status", status);

    if (guard.scope === SCOPE_SELF) {
      query = query.eq("employee_id", guard.userId);
    } else if (guard.scope === SCOPE_BRANCH) {
      const ids = await branchEmployeeIds(supabase, guard.branchId);
      if (!ids.length) return NextResponse.json({ corrections: [] });
      query = query.in("employee_id", ids);
    }

    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return NextResponse.json({ corrections: result.data || [] });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requirePermission(request, "attendance_corrections", "create");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    const logId = normalizeText(body.log_id);
    const time = normalizeText(body.corrected_time);
    const reason = normalizeText(body.reason);

    if (!logId) return NextResponse.json({ error: "Choose the record to correct." }, { status: 400 });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return NextResponse.json({ error: "Enter the corrected time out (HH:MM)." }, { status: 400 });
    }
    if (reason.length < 5) return NextResponse.json({ error: "Give a reason for the correction." }, { status: 400 });
    if (reason.length > 500) return NextResponse.json({ error: "Keep the reason under 500 characters." }, { status: 400 });

    const supabase = getAdminClient();

    // Always the caller's own record: the database function re-checks that
    // the log belongs to p_employee_id.
    const logResult = await supabase
      .from("attendance_logs")
      .select("id,employee_id,log_date")
      .eq("id", logId)
      .maybeSingle();
    if (logResult.error) throw new Error(logResult.error.message);
    if (!logResult.data || logResult.data.employee_id !== guard.userId) {
      return NextResponse.json({ error: "Attendance record not found." }, { status: 404 });
    }

    // The time is Manila local time on the record's own day.
    const correctedTimeOut = new Date(`${logResult.data.log_date}T${time}:00+08:00`).toISOString();

    const { data, error } = await supabase.rpc("attendance_request_correction", {
      p_log_id: logId,
      p_employee_id: guard.userId,
      p_corrected_time_out: correctedTimeOut,
      p_reason: reason,
    });
    if (error) return rpcFailure(error, "Unable to submit the correction right now.");

    await appendAuditLog({
      module: "attendance",
      action: "correction_request",
      entity_type: "attendance_log",
      entity_id: logId,
      description: `Correction requested for ${logResult.data.log_date}: time out ${time}.`,
      status: "success",
      source: "api",
      metadata: { correction_id: data?.id, employee_id: guard.userId, corrected_time_out: correctedTimeOut, reason },
    });

    return NextResponse.json({ success: true, correction: data });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

/**
 * PATCH { action: "resolve", log_id, resolution: "time_out" | "absent" | "half_day",
 *         time_out?: "HH:MM", note }
 * HR / Admin resolve an Incomplete record nobody filed a request for, so it
 * does not keep that employee out of payroll indefinitely.
 */
async function handleResolve(guard, body) {
  const logId = normalizeText(body.log_id);
  const resolution = normalizeText(body.resolution).toLowerCase();
  const note = normalizeText(body.note).slice(0, 500);
  const time = normalizeText(body.time_out);

  if (!logId) return NextResponse.json({ error: "log_id is required." }, { status: 400 });
  if (!["time_out", "absent", "half_day"].includes(resolution)) {
    return NextResponse.json({ error: "Choose a resolution: record a time out, Absent or Half Day." }, { status: 400 });
  }
  if (resolution === "time_out" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return NextResponse.json({ error: "Enter the time out (HH:MM)." }, { status: 400 });
  }
  if (note.length < 5) return NextResponse.json({ error: "Give a reason for the resolution." }, { status: 400 });

  const supabase = getAdminClient();
  const logResult = await supabase
    .from("attendance_logs")
    .select("id,employee_id,employee_name,log_date,status")
    .eq("id", logId)
    .maybeSingle();
  if (logResult.error) throw new Error(logResult.error.message);
  if (!logResult.data) return NextResponse.json({ error: "Attendance record not found." }, { status: 404 });

  if (guard.scope === SCOPE_BRANCH) {
    const ids = await branchEmployeeIds(supabase, guard.branchId);
    if (!ids.includes(logResult.data.employee_id)) {
      return NextResponse.json({ error: "That record belongs to another branch." }, { status: 403 });
    }
  }
  if (logResult.data.employee_id === guard.userId) {
    return NextResponse.json({ error: "You cannot resolve your own attendance record." }, { status: 403 });
  }

  const timeOut = resolution === "time_out"
    ? new Date(`${logResult.data.log_date}T${time}:00+08:00`).toISOString()
    : null;
  const reviewerName = normalizeText(guard.session?.full_name, guard.session?.email);
  const { data, error } = await supabase.rpc("attendance_resolve_record", {
    p_log_id: logId,
    p_resolution: resolution,
    p_time_out: timeOut,
    p_reviewer: guard.userId,
    p_reviewer_name: reviewerName,
    p_note: note,
  });
  if (error) return rpcFailure(error, "Unable to resolve the record right now.");

  await appendAuditLog({
    module: "attendance",
    action: "incomplete_resolve",
    entity_type: "attendance_log",
    entity_id: logId,
    description: `Incomplete record for ${logResult.data.employee_name || "employee"} on ${logResult.data.log_date} resolved by ${reviewerName}: ${resolution === "time_out" ? `time out ${time}` : resolution.replace("_", " ")}.`,
    status: "success",
    source: "api",
    metadata: { correction_id: data?.id, resolution, time_out: timeOut, note },
  });

  return NextResponse.json({ success: true, correction: data });
}

export async function PATCH(request) {
  const guard = await requirePermission(request, "attendance_corrections", "update");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    if (normalizeText(body.action).toLowerCase() === "resolve") return await handleResolve(guard, body);

    const correctionId = normalizeText(body.correction_id);
    const decision = normalizeText(body.decision).toLowerCase();
    const resolution = normalizeText(body.resolution, "incomplete").toLowerCase();
    const note = normalizeText(body.note).slice(0, 500);

    if (!correctionId) return NextResponse.json({ error: "correction_id is required." }, { status: 400 });
    if (decision !== "approve" && decision !== "reject") {
      return NextResponse.json({ error: "Decision must be approve or reject." }, { status: 400 });
    }
    if (decision === "reject" && !["incomplete", "absent", "half_day"].includes(resolution)) {
      return NextResponse.json({ error: "Choose what the record becomes: Incomplete, Absent or Half Day." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const existing = await supabase
      .from("attendance_corrections")
      .select("id,employee_id,employee_name,log_id,log_date,status")
      .eq("id", correctionId)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) return NextResponse.json({ error: "Correction request not found." }, { status: 404 });

    // Admin: only employees currently in its branch.
    if (guard.scope === SCOPE_BRANCH) {
      const ids = await branchEmployeeIds(supabase, guard.branchId);
      if (!ids.includes(existing.data.employee_id)) {
        return NextResponse.json({ error: "That request belongs to another branch." }, { status: 403 });
      }
    }
    // Nobody reviews their own request.
    if (existing.data.employee_id === guard.userId) {
      return NextResponse.json({ error: "You cannot review your own correction request." }, { status: 403 });
    }

    const reviewerName = normalizeText(guard.session?.full_name, guard.session?.email);
    const { data, error } = await supabase.rpc("attendance_review_correction", {
      p_correction_id: correctionId,
      p_decision: decision,
      p_resolution: decision === "reject" ? resolution : null,
      p_reviewer: guard.userId,
      p_reviewer_name: reviewerName,
      p_note: note,
    });
    if (error) return rpcFailure(error, "Unable to record the decision right now.");

    await appendAuditLog({
      module: "attendance",
      action: decision === "approve" ? "correction_approve" : "correction_reject",
      entity_type: "attendance_log",
      entity_id: existing.data.log_id,
      description: decision === "approve"
        ? `Correction for ${existing.data.employee_name || "employee"} on ${existing.data.log_date} approved by ${reviewerName}.`
        : `Correction for ${existing.data.employee_name || "employee"} on ${existing.data.log_date} rejected by ${reviewerName} (record set to ${resolution.replace("_", " ")}).`,
      status: "success",
      source: "api",
      metadata: { correction_id: correctionId, decision, resolution: data?.resolution, note: note || null },
    });

    return NextResponse.json({ success: true, correction: data });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
