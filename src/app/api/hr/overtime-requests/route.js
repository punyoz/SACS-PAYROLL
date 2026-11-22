import { remarkClient, resolveRemark } from "@/lib/remarks/presets";
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { periodForDateKey } from "@/lib/payroll/periods";
import { getServiceClient } from "@/lib/supabase/admin";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { eligibilityRefusal } from "@/lib/employees/classification-server";
import { hoursText, overtimePaidText } from "@/lib/overtime-requests/rules";

/**
 * HR: overtime requests (Part B, 2026-11-22). The system prepares each one
 * (that day's taps, the shift end, minutes worked past it, overtime already
 * approved in the cutoff, the pay-rule and filing checks); HR approves or
 * rejects it by hand. Approving pays the smaller of the approved minutes and
 * the minutes worked past the shift end (overtime_request_sync, 20261122010000).
 *
 *   GET   ?status=pending|approved|rejected|cancelled|all
 *   PATCH { id, decision: "approve" | "reject", note }   (a rejection needs a note)
 */

const COLUMNS = "id,employee_id,branch_id,request_date,planned_start,planned_end,minutes,reason,status,late_filing,prepared,filed_by_name,created_at,decided_by_name,decided_at,decision_note,cancelled_at";
const STATUSES = ["pending", "approved", "rejected", "cancelled"];
const hhmm = (t) => String(t || "").slice(0, 5);
const manilaTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" }) : null);

async function prepare(supabase, rows) {
  if (!rows.length) return [];
  const employeeIds = [...new Set(rows.map((r) => r.employee_id))];
  const dates = rows.map((r) => r.request_date).sort();
  const from = periodForDateKey(dates[0]).start_key;
  const to = periodForDateKey(dates.at(-1)).end_key;
  const [profiles, logs, approvals] = await Promise.all([
    fetchAllIn(() => supabase.from("profiles").select("id,full_name,employee_id,branch_id"), "id", employeeIds),
    fetchAllIn(() => supabase.from("attendance_logs").select("id,employee_id,branch_id,log_date,time_in,time_out,status").gte("log_date", from).lte("log_date", to), "employee_id", employeeIds),
    fetchAllIn(() => supabase.from("attendance_overtime_approvals").select("employee_id,log_date,approved_minutes,status").eq("status", "approved").gte("log_date", from).lte("log_date", to), "employee_id", employeeIds),
  ]);
  for (const result of [profiles, logs, approvals]) if (result.error) throw result.error;
  const person = new Map(profiles.data.map((p) => [p.id, p]));
  const logOf = new Map(logs.data.map((l) => [`${l.employee_id}|${String(l.log_date).slice(0, 10)}`, l]));
  const out = [];
  for (const r of rows) {
    const log = logOf.get(`${r.employee_id}|${r.request_date}`) || null;
    let shiftEnd = null;
    try {
      const { data } = await supabase.rpc("attendance_schedule_for", { p_employee: r.employee_id, p_branch: log?.branch_id || r.branch_id, p_day: r.request_date });
      const end = Array.isArray(data) ? data[0]?.work_end : data?.work_end;
      if (Number.isFinite(Number(end))) shiftEnd = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
    } catch { /* shown as unknown */ }
    let worked = null;
    if (log?.time_out && shiftEnd) {
      const endAt = Date.parse(`${r.request_date}T${shiftEnd}:00+08:00`);
      worked = Math.max(0, Math.floor((Date.parse(log.time_out) - endAt) / 60000));
    }
    const period = periodForDateKey(r.request_date);
    const approvedInCutoff = approvals.data.filter((a) => a.employee_id === r.employee_id && String(a.log_date).slice(0, 10) >= period.start_key && String(a.log_date).slice(0, 10) <= period.end_key)
      .reduce((sum, a) => sum + (Number(a.approved_minutes) || 0), 0);
    const p = person.get(r.employee_id) || {};
    out.push({
      ...r,
      planned_start: hhmm(r.planned_start),
      planned_end: hhmm(r.planned_end),
      hours_text: hoursText(r.minutes),
      employee_name: p.full_name || r.filed_by_name,
      employee_code: p.employee_id || null,
      facts: {
        time_in: manilaTime(log?.time_in), time_out: manilaTime(log?.time_out), attendance_status: log?.status || null,
        shift_end: shiftEnd, worked_minutes_past_end: worked, period: period.label,
        approved_in_cutoff_text: hoursText(approvedInCutoff),
        pay_text: overtimePaidText(r.minutes, worked, { pending: r.status === "pending" }),
        pay_rule: r.status === "pending" ? (await eligibilityRefusal(supabase, r.employee_id, "overtime", r.request_date)) || "Allowed for this employee's category" : null,
      },
    });
  }
  return out;
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "read");
    if (guard.denied) return guard.denied;
    const status = new URL(request.url).searchParams.get("status") || "pending";
    const supabase = getServiceClient();
    let query = supabase.from("overtime_requests").select(COLUMNS).order("request_date", { ascending: true }).limit(500);
    if (STATUSES.includes(status)) query = query.eq("status", status);
    if (!guard.branchExempt && guard.branchId) query = query.eq("branch_id", guard.branchId);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ requests: await prepare(supabase, data || []) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const decision = body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : null;
    if (!decision || !body.id) return NextResponse.json({ error: "Choose Approve or Reject." }, { status: 400 });
    const supabase = getServiceClient();
    // Part H: a preset remark (required to reject); its code + text are audited with the decision.
    const remark = await resolveRemark(supabase, body.remark, { decision: body.decision, entityType: "overtime_request", fallbackText: body.note });
    if (remark.error) return NextResponse.json({ error: remark.error, code: "remark_invalid" }, { status: 400 });
    const note = remark.text || "";
    if (note.length > 500) return NextResponse.json({ error: "The remark is too long (500 characters at most)." }, { status: 400 });
    const { data: current, error: readError } = await supabase.from("overtime_requests").select("id,employee_id,branch_id,request_date,status").eq("id", body.id).maybeSingle();
    if (readError) throw readError;
    if (!current || (!guard.branchExempt && guard.branchId && String(current.branch_id) !== String(guard.branchId))) {
      return NextResponse.json({ error: "Overtime request not found." }, { status: 404 });
    }
    if (current.status !== "pending") return NextResponse.json({ error: `This request is already ${current.status}.` }, { status: 409 });
    if (String(current.employee_id) === String(guard.userId)) return NextResponse.json({ error: "Your own overtime is decided by another HR account." }, { status: 403 });
    if (decision === "approved") {
      const refusal = await eligibilityRefusal(supabase, current.employee_id, "overtime", current.request_date);
      if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
    }
    const { data: me } = await supabase.from("profiles").select("full_name").eq("id", guard.userId).maybeSingle();
    const by = me?.full_name || "HR";
    const decider = remarkClient(remark, { decision: body.decision, entityType: "overtime_request", module: "attendance", table: "overtime_requests", ids: [current.id], actor: guard });
    const { data, error } = await decider.from("overtime_requests")
      .update({ status: decision, decided_by: guard.userId, decided_by_name: by, decided_at: new Date().toISOString(), decision_note: note || null })
      .eq("id", current.id).eq("status", "pending").select(COLUMNS).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "This request was decided or cancelled at the same time. Refresh." }, { status: 409 });
    await appendAuditLog({ actor: guard, module: "attendance", action: `overtime_request_${decision}`, entity_type: "overtime_request", entity_id: data.id, status: "success", source: "api",
      description: `Overtime for ${data.request_date} (${hoursText(data.minutes)}) ${decision} by ${by}${note ? `: ${note}` : ""}.` });
    const [prepared] = await prepare(supabase, [data]);
    return NextResponse.json({ request: prepared });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
