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
 *          record_reply   { employee_reply }
 *          recommend      { recommendation }             → waits for the branch Admin
 *          close          { outcome: false_alarm | returned | excused_by_leave,
 *                           returned_on, leave_request_id, note } → Active, pay released
 *
 * The Admin approves or returns a recommendation on /api/admin/approvals.
 */

import { NextResponse } from "next/server";
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
      const logs = await supabase.from("attendance_logs").select("employee_id,log_date,status")
        .in("employee_id", openIds).gte("log_date", earliest).eq("status", "Absent");
      (logs.data || []).forEach((log) => {
        const list = absences.get(log.employee_id) || [];
        list.push(String(log.log_date).slice(0, 10));
        absences.set(log.employee_id, list);
      });
    }

    const cases = rows.map((row) => {
      const days = (absences.get(row.employee_id) || []).filter((day) => day >= row.first_absent_on).sort();
      return { ...shapeCase(row, byId.get(row.employee_id)), absent_days: days.length, last_absent_on: days[days.length - 1] || null };
    });

    return NextResponse.json({
      available: true,
      cases,
      people: staff.filter((person) => !person.archived && person.employee_status === "Active")
        .map((person) => ({ id: person.id, full_name: person.full_name, employee_id: person.employee_id })),
      summary: {
        open: cases.filter((c) => c.open).length,
        flagged: cases.filter((c) => c.stage === "flagged").length,
        waiting_admin: cases.filter((c) => c.stage === "for_decision").length,
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
    const supabase = getAdminClient();
    const staff = await loadPayrollStaff(supabase, guard);
    const person = staff.find((p) => p.id === normalizeText(body.employee_id));
    if (!person) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
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
    if (guard.role === "admin") return NextResponse.json({ error: "The Admin decides on the Approvals page." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action);
    if (!TRANSITIONS[action] || action === "approve_separation" || action === "return_to_hr") {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    const supabase = getAdminClient();
    const found = await supabase.from("employee_awol_cases").select("*").eq("id", normalizeText(body.case_id)).maybeSingle();
    if (found.error) return NextResponse.json({ error: NOT_READY }, { status: 503 });
    const row = found.data;
    if (!row) return NextResponse.json({ error: "Case not found." }, { status: 404 });
    const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
    const person = staff.find((p) => p.id === row.employee_id);
    if (!person) return NextResponse.json({ error: "That case belongs to another branch." }, { status: 403 });
    if (!canTransition(action, row.stage)) {
      return NextResponse.json({ error: `This case is "${row.stage.replace("_", " ")}": that step is not open now.` }, { status: 409 });
    }

    const today = manilaDateKey();
    const now = new Date().toISOString();
    const by = { id: guard.userId || null, name: actorName(guard) };
    let patch = {};
    let description = "";

    if (action === "confirm") {
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
      patch = { employee_reply: reply };
      description = `Reply recorded for ${personLabel(person)}'s AWOL case.`;
    } else if (action === "recommend") {
      const text = normalizeText(body.recommendation).slice(0, 2000);
      if (text.length < 10) return NextResponse.json({ error: "Explain the recommendation (at least 10 characters)." }, { status: 400 });
      patch = { stage: "for_decision", recommendation: text, recommended_at: now, recommended_by: by.id, recommended_by_name: by.name };
      description = `HR recommends separating ${personLabel(person)} (abandonment); sent to the branch Admin.`;
    } else if (action === "close") {
      const outcome = normalizeText(body.outcome);
      if (!HR_CLOSE_OUTCOMES.includes(outcome)) return NextResponse.json({ error: "Choose: false alarm, returned, or excused by leave." }, { status: 400 });
      const note = normalizeText(body.note).slice(0, 1000);
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

    const result = await supabase.from("employee_awol_cases").update({ ...patch, updated_at: now }).eq("id", row.id);
    if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 500 });
    await appendAuditLog({
      actor: guard, module: "hr", action: `awol_${action}`, entity_type: "employee_awol_case", entity_id: row.id,
      status: "success", source: "api", description, metadata: { employee_id: person.id, from: row.stage, ...patch },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
