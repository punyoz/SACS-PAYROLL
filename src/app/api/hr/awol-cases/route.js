/**
 * AWOL cases for HR (docs/payroll-schedule-loans-awol.md §5).
 *
 *   GET    open cases (and the last 60 days of closed ones), with each case's
 *          attendance summary, and the staff HR may open a case for
 *   POST   { employee_id, first_absent_on, last_present_on, notes }
 *          open a case by hand (the nightly job opens most of them)
 *   PATCH  { case_id, action, ... }
 *          confirm        { note }                       → AWOL, pay held
 *          first_notice   { sent_on, reply_by }          Return-to-Work Order + Notice to Explain
 *          second_notice  { sent_on, reply_by, conference_on }
 *          record_reply   { employee_reply }               → the automation stops (HR decides)
 *          confirm_send   { remark? }                      → AWOL (pay held) + 1st notice, one button (2026-11-24)
 *          stop_automation { remark }  / resume_automation { remark? }   (2026-11-24)
 *          separate       { separation_effective, grounds } → Separated; HR decides, no Admin approval
 *          close          { outcome: false_alarm | returned | excused_by_leave,
 *                           returned_on, leave_request_id, note } → Active, pay released
 *
 * HR decides every case; the Admin has no approval step.
 */

import { refuseOwnItem } from "@/lib/rbac/routing";
import { notify } from "@/lib/branch-requests-server";
import { remarkClient, resolveRemark } from "@/lib/remarks/presets";
import { NextResponse } from "next/server";
import { RECEIVED_HOW, REPLY_REASONS, saveReplyFiles } from "@/lib/awol/replies";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { manilaDateKey } from "@/lib/payroll/periods";
import { actorName, loadPayrollStaff, personLabel } from "@/lib/payroll/staff";
import {
  OUTCOME_LABELS,
  REPLY_DAYS,
  TRANSITIONS,
  addDays,
  canTransition,
  isDateKey,
  setEmployeeStatus,
  shapeCase,
} from "@/lib/awol/cases";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { AWOL_RECORD_MAX, textLimitError } from "@/lib/input-limits";

// The longest text each box takes; the form boxes match.
const TEXT_CAPS = { notes: [1000, "The notes"], note: [1000, "The note"], employee_reply: [AWOL_RECORD_MAX, "The employee's reply"], grounds: [AWOL_RECORD_MAX, "The grounds"] };

const NOT_READY = "AWOL cases are not set up yet: apply 20261009010000_payslip_schedule_loans_awol_subsidy.sql.";
const HR_CLOSE_OUTCOMES = ["false_alarm", "returned", "excused_by_leave"];

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "awol_cases", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
    const byId = new Map(staff.map((person) => [person.id, person]));

    const since = addDays(manilaDateKey(), -60);
    const result = await supabase.from("employee_awol_cases").select("*").order("flagged_at", { ascending: false });
    if (result.error) return NextResponse.json({ available: false, error: NOT_READY, cases: [] });
    const rows = (result.data || [])
      .filter((row) => byId.has(row.employee_id))
      .filter((row) => row.stage !== "closed" || String(row.updated_at || row.created_at || "").slice(0, 10) >= since);

    // Absences since each open case began (the evidence on the screen).
    const openIds = rows.filter((row) => row.stage !== "closed").map((row) => row.employee_id);
    const absences = new Map();
    if (openIds.length) {
      const earliest = rows.reduce((min, row) => (row.first_absent_on < min ? row.first_absent_on : min), "9999-12-31");
      const logs = await fetchAllIn(() => supabase.from("attendance_logs").select("employee_id,log_date,status,id")
        .gte("log_date", earliest).eq("status", "Absent").order("id", { ascending: true }), "employee_id", openIds);
      (logs.data || []).forEach((log) => {
        const list = absences.get(log.employee_id) || [];
        list.push(String(log.log_date).slice(0, 10));
        absences.set(log.employee_id, list);
      });
    }

    // 2026-11-24 (AWOL fully automatic): each open case's guard results (checked now when the case has none
    // stored, e.g. a case opened before the automation) and the notices sent on each case.
    const yesterday = addDays(manilaDateKey(), -1);
    const guardsOf = new Map();
    await Promise.all(rows.filter((row) => row.stage !== "closed").map(async (row) => {
      if (row.guards) { guardsOf.set(row.id, row.guards); return; }
      const { data } = await supabase.rpc("awol_case_guards", { p_employee: row.employee_id, p_from: row.first_absent_on, p_through: yesterday < row.first_absent_on ? row.first_absent_on : yesterday });
      if (data) guardsOf.set(row.id, { ...data, live: true });
    }));
    const caseIds = rows.map((row) => row.id);
    const notices = caseIds.length
      ? (await supabase.from("awol_notices").select("id,case_id,kind,title,sent_on,reply_by,separation_on,sent_by_name,inapp_at,emailed_at,email_error,pdf_path").in("case_id", caseIds).order("created_at", { ascending: true })).data || []
      : [];
    // The replies (employee or recorded by HR), with their attachments (2026-11-24).
    const replies = caseIds.length
      ? (await supabase.from("awol_replies").select("id,case_id,kind,reason_code,explanation,return_on,received_on,received_how,attachments,author_name,created_at").in("case_id", caseIds).order("created_at", { ascending: true })).data || []
      : [];
    const cases = rows.map((row) => {
      const days = (absences.get(row.employee_id) || []).filter((day) => day >= row.first_absent_on).sort();
      return {
        ...shapeCase(row, byId.get(row.employee_id)), absent_days: days.length, last_absent_on: days[days.length - 1] || null,
        automation: row.automation || "auto", automation_reason: row.automation_reason || null, automation_changed_at: row.automation_changed_at || null,
        separation_scheduled_on: row.separation_scheduled_on || null, guards: guardsOf.get(row.id) || row.guards || null,
        notices: notices.filter((n) => n.case_id === row.id).map(({ case_id: _c, ...n }) => n),
        replies: replies.filter((r) => r.case_id === row.id).map(({ case_id: _c, ...r }) => r),
      };
    });

    return NextResponse.json({
      available: true,
      cases,
      people: staff.filter((person) => !person.archived && person.employee_status === "Active")
        .map((person) => ({ id: person.id, full_name: person.full_name, employee_id: person.employee_id })),
      summary: {
        open: cases.filter((c) => c.open).length,
        flagged: cases.filter((c) => c.stage === "flagged").length,
        for_decision: cases.filter((c) => c.stage === "second_notice" || c.stage === "for_decision").length,
        held: staff.filter((person) => person.payroll_hold).length,
      },
      can_edit: guard.role === "hr" || guard.role === "super_admin",
      reply_days: REPLY_DAYS,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "awol_cases", "create");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    // Over-long text is refused, not cut short (input limits).
    const tooLong = textLimitError(body, TEXT_CAPS);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
    const supabase = getAdminClient();
    const staff = await loadPayrollStaff(supabase, guard);
    const person = staff.find((p) => p.id === normalizeText(body.employee_id));
    if (!person) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    if (String(person.id) === String(guard.userId)) return await refuseOwnItem(guard, { module: "awol_cases", entityType: "awol_case", entityId: person.id, what: "AWOL case" });
    const firstAbsent = normalizeText(body.first_absent_on);
    if (!isDateKey(firstAbsent) || firstAbsent > manilaDateKey()) return NextResponse.json({ error: "Choose the first day of absence (not in the future)." }, { status: 400 });
    const lastPresent = normalizeText(body.last_present_on);
    if (lastPresent && (!isDateKey(lastPresent) || lastPresent >= firstAbsent)) return NextResponse.json({ error: "The last day present must be before the first absence." }, { status: 400 });

    const result = await supabase.from("employee_awol_cases").insert({
      employee_id: person.id,
      branch_id: person.branch_id || null,
      first_absent_on: firstAbsent,
      last_present_on: lastPresent || null,
      stage: "flagged",
      notes: normalizeText(body.notes).slice(0, 1000) || null,
    }).select("id").maybeSingle();
    if (result.error) {
      if (String(result.error.code) === "23505") return NextResponse.json({ error: `${person.full_name} already has an open AWOL case.` }, { status: 409 });
      return NextResponse.json({ error: sanitizeError(result.error) }, { status: 500 });
    }
    await appendAuditLog({
      actor: guard, module: "hr", action: "awol_case_open", entity_type: "employee_awol_case", entity_id: result.data?.id || person.id,
      status: "success", source: "api", description: `AWOL case opened for ${personLabel(person)} (absent from ${firstAbsent}).`,
      metadata: { employee_id: person.id, first_absent_on: firstAbsent },
    });
    return NextResponse.json({ success: true, id: result.data?.id || null });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "awol_cases", "update");
    if (guard.denied) return guard.denied;
    if (guard.role === "admin") return NextResponse.json({ error: "HR manages AWOL cases." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    // Over-long text is refused, not cut short (input limits).
    const tooLong = textLimitError(body, TEXT_CAPS);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
    const action = normalizeText(body.action);
    if (!TRANSITIONS[action]) {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    const supabase = getAdminClient();
    const found = await supabase.from("employee_awol_cases").select("*").eq("id", normalizeText(body.case_id)).maybeSingle();
    if (found.error) return NextResponse.json({ error: NOT_READY }, { status: 503 });
    const row = found.data;
    // Nobody acts on their own AWOL case (2026-11-23).
    if (row && String(row.employee_id) === String(guard.userId)) return await refuseOwnItem(guard, { module: "awol_cases", entityType: "awol_case", entityId: row.id, what: "AWOL case" });
    if (!row) return NextResponse.json({ error: "Case not found." }, { status: 404 });
    const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
    const person = staff.find((p) => p.id === row.employee_id);
    if (!person) return NextResponse.json({ error: "That case belongs to another branch." }, { status: 403 });
    // Part D: a system-opened case's prepared 1st notice is sent from "flagged" (HR reviews it first).
    const sendPrepared = action === "first_notice" && row.stage === "flagged" && row.auto_flagged;
    if (!sendPrepared && !canTransition(action, row.stage)) {
      return NextResponse.json({ error: `This case is "${row.stage.replace("_", " ")}": that step is not open now.` }, { status: 409 });
    }

    const today = manilaDateKey();
    const now = new Date().toISOString();
    const by = { id: guard.userId || null, name: actorName(guard) };
    let closeRemark = null;
    let patch = {};
    let description = "";

    if (action === "stop_automation" || action === "resume_automation") {
      // A preset reason to stop (decision "override"); optional to resume. Separation stays HR's when stopped.
      closeRemark = await resolveRemark(supabase, body.remark, { decision: "override", entityType: "awol_case", required: action === "stop_automation", fallbackText: body.note });
      if (closeRemark.error) return NextResponse.json({ error: closeRemark.error, code: "remark_invalid" }, { status: 400 });
      if (action === "stop_automation" && row.automation !== "auto") return NextResponse.json({ error: "The automation is already stopped on this case." }, { status: 409 });
      if (action === "resume_automation" && row.automation === "auto") return NextResponse.json({ error: "The automation already runs on this case." }, { status: 409 });
      patch = action === "stop_automation"
        ? { automation: "stopped", automation_reason: `Stopped by ${by.name}: ${closeRemark.text}`.slice(0, 500), automation_changed_at: now, automation_changed_by_name: by.name }
        : { automation: "auto", automation_reason: closeRemark.text ? `Resumed by ${by.name}: ${closeRemark.text}`.slice(0, 500) : `Resumed by ${by.name}`, automation_changed_at: now, automation_changed_by_name: by.name, review_reason: null };
      if (!closeRemark.code) closeRemark = null;
      description = `${personLabel(person)}'s AWOL case: automation ${action === "stop_automation" ? "stopped" : "resumed"} by ${by.name}.`;
    } else if (action === "confirm_send" || action === "proceed") {
      // One button: AWOL (pay held) and the 1st notice sent (in-app now; PDF + e-mail by the daily delivery).
      closeRemark = await resolveRemark(supabase, body.remark, { decision: "approve", entityType: "awol_case", required: false, fallbackText: body.note });
      if (closeRemark.error) return NextResponse.json({ error: closeRemark.error, code: "remark_invalid" }, { status: 400 });
      if (!closeRemark.code) closeRemark = null;
      const statusError = await setEmployeeStatus(supabase, {
        employeeId: person.id, status: "AWOL", caseId: row.id, effectiveOn: today, actor: guard,
        reason: `AWOL since ${row.first_absent_on}; confirmed by HR with the 1st notice${closeRemark ? `: ${closeRemark.text}` : ""}`,
      });
      if (statusError) return NextResponse.json({ error: sanitizeError(statusError) }, { status: 500 });
      const replyBy = addDays(today, REPLY_DAYS);
      patch = { stage: "first_notice", confirmed_at: now, confirmed_by: by.id, confirmed_by_name: by.name, first_notice_sent_on: today, first_notice_reply_by: replyBy,
        // "Proceed": the automatic flow runs from here (deadline -> Ready for HR decision).
        automation: "auto", automation_reason: `Proceeded by ${by.name} after review`, automation_changed_at: now, automation_changed_by_name: by.name };
      description = `${personLabel(person)} confirmed AWOL and the 1st notice sent by ${by.name}; reply by ${replyBy}. Pay held.`;
    } else if (action === "confirm") {
      const statusError = await setEmployeeStatus(supabase, {
        employeeId: person.id, status: "AWOL", caseId: row.id, effectiveOn: today, actor: guard,
        reason: normalizeText(body.note, `AWOL since ${row.first_absent_on}; could not be reached`),
      });
      if (statusError) return NextResponse.json({ error: sanitizeError(statusError) }, { status: 500 });
      patch = { stage: "confirmed", confirmed_at: now, confirmed_by: by.id, confirmed_by_name: by.name, notes: normalizeText(body.note).slice(0, 1000) || row.notes };
      description = `${personLabel(person)} confirmed AWOL: pay held until the case is closed.`;
    } else if (action === "first_notice" || action === "second_notice") {
      const sentOn = normalizeText(body.sent_on, today);
      const replyBy = normalizeText(body.reply_by, addDays(sentOn, REPLY_DAYS));
      if (!isDateKey(sentOn) || !isDateKey(replyBy) || replyBy < addDays(sentOn, REPLY_DAYS)) {
        return NextResponse.json({ error: `Give the date sent and a reply date at least ${REPLY_DAYS} days later.` }, { status: 400 });
      }
      if (action === "first_notice") {
        patch = { stage: "first_notice", first_notice_sent_on: sentOn, first_notice_reply_by: replyBy };
        description = `1st notice (Return-to-Work Order + Notice to Explain) sent to ${personLabel(person)}; reply by ${replyBy}.`;
      } else {
        const conference = normalizeText(body.conference_on);
        if (conference && (!isDateKey(conference) || conference < sentOn)) return NextResponse.json({ error: "The conference date must be on or after the notice." }, { status: 400 });
        patch = { stage: "second_notice", second_notice_sent_on: sentOn, second_notice_reply_by: replyBy, conference_on: conference || null };
        description = `2nd notice sent to ${personLabel(person)}; reply by ${replyBy}${conference ? `, conference ${conference}` : ""}.`;
      }
    } else if (action === "record_reply") {
      const reply = normalizeText(body.employee_reply).slice(0, 2000);
      if (reply.length < 3) return NextResponse.json({ error: "Write what the employee said." }, { status: 400 });
      // 2026-11-24: an offline reply (letter, phone, in person): date, how, summary, attachment; kept with the case.
      const how = RECEIVED_HOW[normalizeText(body.received_how)] ? normalizeText(body.received_how) : "other";
      const receivedOn = isDateKey(normalizeText(body.received_on)) ? normalizeText(body.received_on) : today;
      const replyId = crypto.randomUUID();
      const files = await saveReplyFiles(supabase, { caseId: row.id, replyId, files: body.attachments });
      if (files.error) return NextResponse.json({ error: files.error }, { status: 400 });
      const kept = await supabase.from("awol_replies").insert({
        id: replyId, case_id: row.id, employee_id: row.employee_id, kind: "hr_record", reason_code: REPLY_REASONS[body.reason_code] ? body.reason_code : null,
        explanation: reply, received_on: receivedOn, received_how: how, attachments: files.files, author_id: by.id, author_name: by.name, author_role: guard.role,
      });
      if (kept.error) return NextResponse.json({ error: sanitizeError(kept.error) }, { status: 500 });
      // A reply stops the automation (the system never judges a reply): HR decides.
      patch = { employee_reply: reply, ...(row.automation === "auto" ? { automation: "response", automation_reason: "Response received: the employee replied. HR decides.", automation_changed_at: now, automation_changed_by_name: by.name } : {}) };
      description = `Reply recorded for ${personLabel(person)}'s AWOL case.`;
    } else if (action === "separate") {
      // 2026-11-24: HR's decision SENDS the notice of separation (a preset remark: the grounds); the system separates
      // on its effective date (hr.awol_separation_days later) unless the employee responds first.
      closeRemark = await resolveRemark(supabase, body.remark, { decision: "approve", entityType: "awol_case", required: true, fallbackText: body.grounds });
      if (closeRemark.error) return NextResponse.json({ error: closeRemark.error, code: "remark_invalid" }, { status: 400 });
      const { data: sepSetting } = await supabase.from("system_config").select("value").eq("section", "hr").eq("key", "awol_separation_days").maybeSingle();
      const sepDays = Math.max(1, Math.min(30, Number(sepSetting?.value) || 3));
      const effective = addDays(today, sepDays);
      patch = {
        stage: "second_notice", second_notice_sent_on: today, second_notice_reply_by: effective, separation_scheduled_on: effective,
        automation: "auto", automation_reason: `Separation decided by ${by.name}: effective ${effective} unless the employee responds first.`, automation_changed_at: now, automation_changed_by_name: by.name,
        recommendation: closeRemark.text, recommended_at: now, recommended_by: by.id, recommended_by_name: by.name,
      };
      description = `${personLabel(person)}: separation decided by ${by.name} (${closeRemark.text}); notice of separation sent, effective ${effective}.`;
    } else if (action === "close") {
      const outcome = normalizeText(body.outcome);
      if (!HR_CLOSE_OUTCOMES.includes(outcome)) return NextResponse.json({ error: "Choose: false alarm, returned, or excused by leave." }, { status: 400 });
      // Part H: closing is a "resolve" decision; its remark (required here) is audited with the case update.
      closeRemark = await resolveRemark(supabase, body.remark, { decision: "resolve", entityType: "awol_case", required: true, fallbackText: body.note });
      if (closeRemark.error) return NextResponse.json({ error: closeRemark.error, code: "remark_invalid" }, { status: 400 });
      const note = normalizeText(closeRemark.text).slice(0, 1000);
      if (note.length < 5) return NextResponse.json({ error: "Explain why the case is closed (at least 5 characters)." }, { status: 400 });
      const returnedOn = normalizeText(body.returned_on);
      if (outcome === "returned" && (!isDateKey(returnedOn) || returnedOn < row.first_absent_on || returnedOn > today)) {
        return NextResponse.json({ error: "Give the date the employee returned." }, { status: 400 });
      }
      if (person.employee_status === "AWOL") {
        const statusError = await setEmployeeStatus(supabase, {
          employeeId: person.id, status: "Active", caseId: row.id, effectiveOn: returnedOn || today, actor: guard,
          reason: `${OUTCOME_LABELS[outcome]}: ${note}`,
        });
        if (statusError) return NextResponse.json({ error: sanitizeError(statusError) }, { status: 500 });
      }
      patch = {
        stage: "closed", outcome, returned_on: outcome === "returned" ? returnedOn : null,
        leave_request_id: normalizeText(body.leave_request_id) || null,
        notes: [row.notes, note].filter(Boolean).join("\n").slice(0, 1000),
      };
      description = `${personLabel(person)}'s AWOL case closed: ${OUTCOME_LABELS[outcome]}${person.employee_status === "AWOL" ? " — status Active, pay released (held payslips need a Super Admin override)" : ""}.`;
    }

    const remarkDecision = action === "stop_automation" || action === "resume_automation" ? "override" : action === "confirm_send" || action === "proceed" || action === "separate" ? "approve" : "resolve";
    const writer = closeRemark ? remarkClient(closeRemark, { decision: remarkDecision, entityType: "awol_case", module: "hr", table: "employee_awol_cases", ids: [row.id], actor: guard }) : supabase;
    const result = await writer.from("employee_awol_cases").update({ ...patch, updated_at: now }).eq("id", row.id);
    if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 500 });
    await appendAuditLog({
      actor: guard, module: "hr", action: `awol_${action}`, entity_type: "employee_awol_case", entity_id: row.id,
      status: "success", source: "api", description, metadata: { employee_id: person.id, from: row.stage, ...patch },
    });
    if (action === "close") {
      await notify(supabase, [row.employee_id], { kind: "awol_decision", title: "Your attendance case is closed", body: `${OUTCOME_LABELS[patch.outcome] || "Closed"}. See My Notices.`, link_page: "emp-notices" }).catch(() => 0);
    }
    // A notice HR sends is kept like the system's (2026-11-24): the employee is told in-app now; the PDF and the
    // e-mail follow with the daily delivery (/api/cron/awol-notices).
    if (action === "first_notice" || action === "second_notice" || action === "confirm_send" || action === "proceed" || action === "separate") {
      const kind = action === "second_notice" || action === "separate" ? "second" : "first";
      const sentOn = patch.first_notice_sent_on || patch.second_notice_sent_on || today;
      const replyBy = patch.first_notice_reply_by || row.first_notice_reply_by || null;
      const sent = await supabase.rpc("awol_send_notice", { p_case: row.id, p_kind: kind, p_today: sentOn, p_reply_by: replyBy, p_separation: kind === "second" ? patch.separation_scheduled_on || patch.second_notice_reply_by : null });
      if (sent.error) {
        await notify(supabase, [row.employee_id], {
          kind: `awol_${action}`, title: kind === "first" ? "Notice to return to work" : "Second notice",
          body: `Report back to work or explain in writing by ${patch.first_notice_reply_by || patch.second_notice_reply_by}. No decision has been made.`,
          link_page: "emp-dash",
        }).catch(() => 0);
      }
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
