import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { manilaDateKey } from "@/lib/payroll/periods";
import { getServiceClient } from "@/lib/supabase/admin";
import { eligibilityRefusal } from "@/lib/employees/classification-server";
import { checkOvertimeRequest, readRequestSettings } from "@/lib/overtime-requests/rules";

/**
 * My overtime requests (Part B, 2026-11-22). Always the signed-in person's
 * own (the body never names someone else); /api/me/overtime-requests is the
 * same handler for staff on payroll.
 *
 *   GET    my requests (newest first) and the limits in effect
 *   POST   { request_date, planned_start "HH:MM", planned_end "HH:MM", reason }
 *   PATCH  { id, action: "cancel" }   (only while pending)
 */

const COLUMNS = "id,request_date,planned_start,planned_end,minutes,reason,status,late_filing,prepared,created_at,decided_by_name,decided_at,decision_note,cancelled_at";
const hhmm = (t) => String(t || "").slice(0, 5);
const shape = (r) => ({ ...r, planned_start: hhmm(r.planned_start), planned_end: hhmm(r.planned_end) });

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "read");
    if (guard.denied) return guard.denied;
    const supabase = getServiceClient();
    const [rows, settings] = await Promise.all([
      supabase.from("overtime_requests").select(COLUMNS).eq("employee_id", guard.userId).order("request_date", { ascending: false }).limit(200),
      readRequestSettings(supabase),
    ]);
    if (rows.error) throw rows.error;
    return NextResponse.json({ requests: (rows.data || []).map(shape), settings });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "create");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const supabase = getServiceClient();
    const employeeId = guard.userId;
    const { data: me } = await supabase.from("profiles").select("full_name,branch_id").eq("id", employeeId).maybeSingle();
    const date = String(body.request_date || "");
    const [settings, open, refusal] = await Promise.all([
      readRequestSettings(supabase),
      supabase.from("overtime_requests").select("request_date,minutes").eq("employee_id", employeeId).in("status", ["pending", "approved"]),
      /^\d{4}-\d{2}-\d{2}$/.test(date) ? eligibilityRefusal(supabase, employeeId, "overtime", date) : null,
    ]);
    if (open.error) throw open.error;
    const checked = checkOvertimeRequest(body, { today: manilaDateKey(), settings, open: open.data || [], refusal });
    if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400 });

    const name = me?.full_name || String(guard.session?.full_name || "").trim() || "Employee";
    const prepared = { filed_on: manilaDateKey(), period: checked.period_label, cutoff_minutes_with_this: checked.cutoff_minutes_after, limits: settings };
    const { data, error } = await supabase.from("overtime_requests").insert({
      employee_id: employeeId, branch_id: me?.branch_id || null, request_date: date,
      planned_start: body.planned_start, planned_end: body.planned_end, minutes: checked.minutes,
      reason: String(body.reason).trim(), late_filing: checked.late_filing, prepared, filed_by: employeeId, filed_by_name: name,
    }).select(COLUMNS).single();
    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: `You already have an overtime request for ${date}.` }, { status: 409 });
      throw error;
    }
    await appendAuditLog({ actor: guard, module: "attendance", action: "overtime_request_filed", entity_type: "overtime_request", entity_id: data.id, status: "success", source: "api",
      description: `${name} filed overtime for ${date}, ${body.planned_start}-${body.planned_end}${checked.late_filing ? " (late filing)" : ""}.` });
    return NextResponse.json({ request: shape(data) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "create");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    if (body.action !== "cancel" || !body.id) return NextResponse.json({ error: "Only cancelling a pending request is allowed here." }, { status: 400 });
    const supabase = getServiceClient();
    const { data, error } = await supabase.from("overtime_requests")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", body.id).eq("employee_id", guard.userId).eq("status", "pending")
      .select(COLUMNS).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Only your own pending requests can be cancelled." }, { status: 409 });
    await appendAuditLog({ actor: guard, module: "attendance", action: "overtime_request_cancelled", entity_type: "overtime_request", entity_id: data.id, status: "success", source: "api",
      description: `Overtime request for ${data.request_date} cancelled by its filer.` });
    return NextResponse.json({ request: shape(data) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
