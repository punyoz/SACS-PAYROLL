/**
 * Attendance correction requests (Batch 3, 2026-11-23), server side. The
 * employee files (own record), the branch Admin checks it (Part E: a proposal
 * the Admin can Note / Object), HR decides with the evidence and the pay
 * difference shown first. The rules live in the database
 * (20261124040000_attendance_correction_requests.sql).
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { notify } from "@/lib/branch-requests-server";
import { remarkClient, resolveRemark } from "@/lib/remarks/presets";
import { LEAVE_PROOF_BUCKET, decodeProofDataUrl, proofPathFor, validateProofUrl } from "@/lib/leave-requests/proof";
import { correctionPayEffect } from "@/lib/attendance/correction-pay";
import { FIX_TYPES, REASON_CODES } from "@/lib/attendance/correction-requests";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const at = (dateKey, hhmm) => (hhmm ? new Date(`${dateKey}T${hhmm}:00+08:00`).toISOString() : null);
const dbError = (error, fallback) => {
  const code = String(error?.code || "");
  if (code === "23505") return NextResponse.json({ error: "There is already an open correction request for this day." }, { status: 409 });
  if (/already been decided/.test(String(error?.message || ""))) return NextResponse.json({ error: "This request has already been decided." }, { status: 409 });
  if (["23514", "P0002", "42501"].includes(code)) return NextResponse.json({ error: String(error.message || fallback) }, { status: code === "42501" ? 403 : 400 });
  return NextResponse.json({ error: sanitizeError(error, fallback) }, { status: 500 });
};

/** POST { log_id, fix_type, time_in?, time_out?, reason_code, reason?, attachment? } — the caller's own day. */
export async function fileCorrectionRequest(supabase, guard, body) {
  const logId = String(body.log_id || "");
  const fixType = String(body.fix_type || "");
  const reasonCode = String(body.reason_code || "");
  if (!logId) return NextResponse.json({ error: "Choose the day to correct." }, { status: 400 });
  if (!FIX_TYPES[fixType]) return NextResponse.json({ error: "Choose what to fix." }, { status: 400 });
  if (!REASON_CODES[reasonCode]) return NextResponse.json({ error: "Choose the reason." }, { status: 400 });
  for (const t of [body.time_in, body.time_out]) if (t && !HHMM.test(String(t))) return NextResponse.json({ error: "Enter times as HH:MM." }, { status: 400 });
  const reason = String(body.reason || "").trim();
  if (reason.length > 450) return NextResponse.json({ error: "Keep the reason under 450 characters." }, { status: 400 });

  const { data: log, error: logError } = await supabase.from("attendance_logs").select("id,employee_id,branch_id,log_date,status,time_in,time_out").eq("id", logId).maybeSingle();
  if (logError) throw new Error(logError.message);
  if (!log || log.employee_id !== guard.userId) return NextResponse.json({ error: "Attendance record not found." }, { status: 404 });

  // Optional attachment (a photo of the logbook, …): the leave-proof rules and private bucket.
  let attachmentPath = null;
  if (body.attachment) {
    const check = validateProofUrl(body.attachment);
    if (!check.ok) return NextResponse.json({ error: check.error.replace(/Proof|proof document/g, "attachment") }, { status: 400 });
    const file = decodeProofDataUrl(check.value);
    if (!file.ok) return NextResponse.json({ error: file.error.replace(/Proof|proof document/g, "attachment") }, { status: 400 });
    attachmentPath = proofPathFor(guard.userId, file.ext, crypto.randomUUID());
    const up = await supabase.storage.from(LEAVE_PROOF_BUCKET).upload(attachmentPath, file.bytes, { contentType: file.mime, upsert: false });
    if (up.error) return NextResponse.json({ error: "The attachment could not be saved." }, { status: 500 });
  }

  const dateKey = String(log.log_date).slice(0, 10);
  const { data, error } = await supabase.rpc("attendance_request_correction_v2", {
    p_log_id: logId, p_employee_id: guard.userId, p_fix_type: fixType,
    p_time_in: at(dateKey, body.time_in), p_time_out: at(dateKey, body.time_out),
    p_reason_code: reasonCode, p_reason: reason || null, p_attachment: attachmentPath,
  });
  if (error) {
    if (attachmentPath) await supabase.storage.from(LEAVE_PROOF_BUCKET).remove([attachmentPath]).catch(() => null);
    return dbError(error, "The request was not filed.");
  }

  // Part E: the system's check for the branch Admin (Note / Object); HR decides.
  const { data: used } = await supabase.rpc("attendance_corrections_used", { p_employee: guard.userId, p_day: dateKey });
  await supabase.rpc("automation_log", {
    p_module: "attendance_corrections", p_rule: "an attendance correction request: checked (filing window, limit, times on the day)",
    p_kind: "proposal", p_summary: `${data.employee_name}, ${dateKey}: ${FIX_TYPES[fixType]} (${REASON_CODES[reasonCode]})`,
    p_data: { correction_id: data.id, fix_type: fixType, reason_code: reasonCode, original_status: data.original_status,
      original_time_in: data.original_time_in, original_time_out: data.original_time_out,
      corrected_time_in: data.corrected_time_in, corrected_time_out: data.corrected_time_out, used_this_cutoff: used },
    p_employee: guard.userId, p_branch: log.branch_id, p_entity_type: "attendance_correction", p_entity_id: data.id,
  });
  await appendAuditLog({ actor: guard, module: "attendance", action: "correction_request", entity_type: "attendance_log", entity_id: logId,
    description: `Attendance correction request for ${dateKey}: ${FIX_TYPES[fixType]}.`, status: "success", source: "api",
    metadata: { correction_id: data.id, fix_type: fixType, reason_code: reasonCode, attachment: Boolean(attachmentPath) } });
  return NextResponse.json({ success: true, correction: data });
}

/** GET ?usage=1&date=YYYY-MM-DD — "2 of 5 used" and the filing window, for the caller. */
export async function correctionUsage(supabase, guard, dateKey) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dateKey || "") ? dateKey : new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const [{ data: used }, { data: cfg }] = await Promise.all([
    supabase.rpc("attendance_corrections_used", { p_employee: guard.userId, p_day: day }),
    supabase.from("system_config").select("key,value").eq("section", "attendance").in("key", ["correction_window_days", "correction_max_per_cutoff"]),
  ]);
  const val = (k, d) => Number((cfg || []).find((r) => r.key === k)?.value) || d;
  return NextResponse.json({ used: Number(used) || 0, max: val("correction_max_per_cutoff", 5), window_days: val("correction_window_days", 3) });
}

/** The evidence HR sees before deciding (also the Admin, for their branch). */
export async function correctionEvidence(supabase, row) {
  const dateKey = String(row.log_date).slice(0, 10);
  const [{ data: preview }, { data: sched }, { data: dayRows }, { data: past }, { data: check }] = await Promise.all([
    supabase.rpc("attendance_preview_correction", { p_correction_id: row.id }),
    supabase.rpc("attendance_schedule_for", { p_employee: row.employee_id, p_branch: row.branch_id, p_day: dateKey }),
    supabase.from("attendance_logs").select("employee_id,time_in,time_out").eq("branch_id", row.branch_id).eq("log_date", dateKey).eq("archived_duplicate", false),
    supabase.from("attendance_corrections").select("id,log_date,status,fix_type").eq("employee_id", row.employee_id).not("fix_type", "is", null).neq("id", row.id)
      .gte("log_date", dateKey.slice(0, 8) + (Number(dateKey.slice(8)) <= 15 ? "01" : "16")).lte("log_date", dateKey.slice(0, 8) + (Number(dateKey.slice(8)) <= 15 ? "15" : "31")),
    supabase.from("automation_actions").select("id,status,admin_note,admin_objected,admin_noted_by_name").eq("module", "attendance_corrections").eq("entity_id", row.id).maybeSingle(),
  ]);
  const people = dayRows || [];
  const tapped = people.filter((p) => p.time_in || p.time_out).length;
  const pay = preview ? await correctionPayEffect(supabase, row, preview) : { processed: false };
  const s = Array.isArray(sched) ? sched[0] : sched;
  // The attachment, if any: a link valid for 5 minutes (private bucket).
  const signed = row.attachment_path ? await supabase.storage.from(LEAVE_PROOF_BUCKET).createSignedUrl(row.attachment_path, 300) : null;
  return {
    preview, pay,
    attachment_url: signed?.data?.signedUrl || null,
    schedule: s ? { name: s.schedule_name || null, work_start: s.work_start, work_end: s.work_end } : null,
    // "Terminal status that day": how many at the branch tapped (none = possibly offline, as the AWOL guard reads it).
    terminal: { scheduled: people.length, tapped, offline_suspected: people.length >= 2 && tapped * 2 <= people.length },
    past_this_cutoff: past || [],
    admin_check: check || null,
  };
}

/** PATCH { correction_id, decision, remark } on a request (fix_type set): HR only. */
export async function decideCorrectionRequest(supabase, guard, row, body, { fallback = false } = {}) {
  // HR decides; the Super Admin only as the stand-in (an HR's own, no other HR covering their branch).
  if (!(guard.role === "hr" || (fallback && guard.role === "super_admin"))) return NextResponse.json({ error: "HR decides attendance correction requests." }, { status: 403 });
  if (String(row.employee_id) === String(guard.userId)) return NextResponse.json({ error: "You cannot decide your own request. Another approver handles it.", code: "own_item" }, { status: 403 });
  const decision = String(body.decision || "");
  if (decision !== "approve" && decision !== "reject") return NextResponse.json({ error: "Approve or reject." }, { status: 400 });
  const remark = await resolveRemark(supabase, body.remark, { decision, entityType: "attendance_correction", fallbackText: body.note });
  if (remark.error) return NextResponse.json({ error: remark.error, code: "remark_invalid" }, { status: 400 });

  // The pay difference HR saw is recomputed here (the source of truth) and recorded with the decision.
  let pay = null;
  if (decision === "approve") {
    const { data: preview, error: pe } = await supabase.rpc("attendance_preview_correction", { p_correction_id: row.id });
    if (pe) return dbError(pe, "The day could not be previewed.");
    const effect = await correctionPayEffect(supabase, row, preview);
    if (effect.processed && effect.amount === null) {
      return NextResponse.json({ error: "The day was on a paid payslip whose rates are not recorded: the Accountant must work out the difference first." }, { status: 409 });
    }
    if (effect.processed && effect.amount > 0) pay = { entry_id: effect.entry_id, kind: effect.kind, amount: effect.amount, line: effect.line, text: effect.text };
  }
  const by = guard.session?.full_name || guard.session?.email || "HR";
  const decider = remarkClient(remark, { decision, entityType: "attendance_correction", module: "attendance", table: "attendance_corrections", ids: [row.id], actor: guard });
  const { data, error } = await decider.rpc("attendance_review_correction_v2", {
    p_correction_id: row.id, p_decision: decision, p_reviewer: guard.userId, p_reviewer_name: by, p_note: remark.text || null, p_pay: pay,
  });
  if (error) return dbError(error, "Not decided.");

  const { data: check } = await supabase.from("automation_actions").select("id").eq("module", "attendance_corrections").eq("entity_id", row.id).maybeSingle();
  if (check?.id) await supabase.rpc("automation_close", { p_id: check.id, p_note: `HR ${decision === "approve" ? "approved" : "rejected"} it` });
  await notify(supabase, [row.employee_id], {
    kind: `attendance_correction_${decision === "approve" ? "approved" : "rejected"}`,
    title: decision === "approve" ? "Attendance correction approved" : "Attendance correction rejected",
    body: `${String(row.log_date).slice(0, 10)}: ${remark.text || (decision === "approve" ? "approved" : "rejected")}${pay ? ` · ${pay.line}` : ""}`,
    link_page: "emp-attendance",
  }).catch(() => 0);
  await appendAuditLog({ actor: guard, module: "attendance", action: `correction_${decision}`, entity_type: "attendance_correction", entity_id: row.id,
    description: `Attendance correction request ${decision === "approve" ? "approved" : "rejected"} for ${String(row.log_date).slice(0, 10)}.`,
    metadata: { employee_id: row.employee_id, pay } });
  return NextResponse.json({ success: true, correction: data, pay });
}
