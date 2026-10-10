/**
 * Licensed-teacher fields (docs/payroll-schedule-loans-awol.md §6.6,
 * SACS-Payroll-Permission-Matrix.md row 4a).
 *
 *   GET                         Teaching staff in reach with their license
 *                               status, + open expiry alerts (HR)
 *   GET ?employee_id=…          one teacher: status, last 4, expiry, verifier,
 *                               PRC ID link (HR only) and the change history
 *   GET ?document_id=…          the PRC ID file (HR only)
 *   POST { action, employee_id, reason, prc_license_no, license_expires_on,
 *          document: { data_url, file_name } }
 *        action: turn_on | update_details | verify | turn_off     HR only
 *   POST { action: "acknowledge_alert", alert_id }                 HR only
 *
 * HR edits and verifies; Admin (own branch) and Super Admin read; the
 * Accountant and Employees have no access. Every change goes through
 * employee_license_changes, whose trigger encrypts the number, clears
 * verification on edits and writes the shared change log.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { manilaDateKey } from "@/lib/payroll/periods";
import { validateProofUrl } from "@/lib/leave-requests/proof";
import { actorName, loadPayrollStaff, personLabel } from "@/lib/payroll/staff";
import { DEFAULT_WARNING_DAYS, licenseStatus, maskedLicense, validateLicenseChange } from "@/lib/employees/teacher-license";

const NOT_READY = "Licensed-teacher fields are not set up yet: apply 20261009010000_payslip_schedule_loans_awol_subsidy.sql.";
const LICENSE_COLUMNS = "id,is_licensed_teacher,prc_license_no_last4,license_expires_on,prc_id_document_id,license_verified_by_name,license_verified_at,employee_type";

function dbError(error) {
  const code = String(error?.code || "");
  if (["P0001", "23514", "23505"].includes(code)) {
    return NextResponse.json({ error: String(error.message || "Not saved.").replace(/^ERROR:\s*/, "") }, { status: 400 });
  }
  return NextResponse.json({ error: sanitizeError(error, "Not saved.") }, { status: 500 });
}

async function warningDays(supabase) {
  const row = await supabase.from("system_config").select("value").eq("section", "hr").eq("key", "license_expiry_warning_days").maybeSingle();
  const days = Number(row.data?.value);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_WARNING_DAYS;
}

function shape(person, profile, today, days, { includeDocument }) {
  const status = licenseStatus(profile, today, days);
  return {
    employee_id: person.id,
    full_name: person.full_name,
    employee_code: person.employee_id,
    employee_type: profile?.employee_type || person.employee_type,
    branch_id: person.branch_id,
    is_licensed_teacher: Boolean(profile?.is_licensed_teacher),
    prc_license_masked: maskedLicense(profile?.prc_license_no_last4),
    license_expires_on: profile?.license_expires_on || null,
    verified_by_name: profile?.license_verified_by_name || null,
    verified_at: profile?.license_verified_at || null,
    has_document: Boolean(profile?.prc_id_document_id),
    ...(includeDocument ? { document_id: profile?.prc_id_document_id || null } : {}),
    status,
  };
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "teacher_license", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const url = new URL(request.url);
    const isHr = guard.role === "hr";
    const today = manilaDateKey();

    const documentId = normalizeText(url.searchParams.get("document_id"));
    if (documentId) {
      if (!isHr) return NextResponse.json({ error: "Only HR opens the PRC ID." }, { status: 403 });
      const doc = await supabase.from("employee_license_documents").select("id,employee_id,file_name,data_url,uploaded_at").eq("id", documentId).maybeSingle();
      if (doc.error || !doc.data) return NextResponse.json({ error: "Document not found." }, { status: 404 });
      return NextResponse.json({ document: doc.data });
    }

    const staff = await loadPayrollStaff(supabase, guard);
    const days = await warningDays(supabase);
    const employeeId = normalizeText(url.searchParams.get("employee_id"));
    const targets = employeeId ? staff.filter((p) => p.id === employeeId) : staff.filter((p) => p.employee_type === "Teaching");
    if (employeeId && !targets.length) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    const ids = targets.map((p) => p.id);

    const profiles = ids.length ? await supabase.from("profiles").select(LICENSE_COLUMNS).in("id", ids) : { data: [], error: null };
    if (profiles.error) return NextResponse.json({ available: false, error: NOT_READY, teachers: [] });
    const byId = new Map((profiles.data || []).map((row) => [row.id, row]));
    const teachers = targets.map((person) => shape(person, byId.get(person.id), today, days, { includeDocument: isHr }));

    if (employeeId) {
      const history = await supabase.from("payroll_setting_changes")
        .select("id,changed_at,changed_by_name,changed_by_role,old_value,new_value,reason")
        .eq("setting_type", "teacher_license").eq("employee_id", employeeId).order("changed_at", { ascending: false });
      return NextResponse.json({
        available: true, teacher: teachers[0], warning_days: days, can_edit: isHr,
        history: (history.data || []).map((h) => ({ ...h, action: h.new_value?.action || null })),
      });
    }

    let alerts = [];
    if (isHr) {
      const open = await supabase.from("employee_license_alerts").select("*").is("acknowledged_at", null).order("created_at", { ascending: false });
      const names = new Map(staff.map((p) => [p.id, p.full_name]));
      alerts = (open.data || []).filter((a) => names.has(a.employee_id)).map((a) => ({ ...a, employee_name: names.get(a.employee_id) }));
    }
    return NextResponse.json({ available: true, teachers, alerts, warning_days: days, can_edit: isHr });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "teacher_license", "update");
    if (guard.denied) return guard.denied;
    if (guard.role !== "hr") return NextResponse.json({ error: "Only HR changes licensed-teacher fields." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action);
    const supabase = getAdminClient();

    if (action === "acknowledge_alert") {
      const result = await supabase.from("employee_license_alerts").update({
        acknowledged_at: new Date().toISOString(), acknowledged_by: guard.userId || null, acknowledged_by_name: actorName(guard),
      }).eq("id", normalizeText(body.alert_id));
      if (result.error) return dbError(result.error);
      return NextResponse.json({ success: true });
    }

    const staff = await loadPayrollStaff(supabase, guard);
    const person = staff.find((p) => p.id === normalizeText(body.employee_id));
    if (!person) return NextResponse.json({ error: "Employee not found." }, { status: 404 });

    const today = manilaDateKey();
    const input = {
      reason: normalizeText(body.reason).slice(0, 500),
      prc_license_no: normalizeText(body.prc_license_no),
      license_expires_on: normalizeText(body.license_expires_on),
      document: body.document && body.document.data_url ? body.document : null,
    };
    const invalid = validateLicenseChange(action, input, today);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    if ((action === "turn_on" || action === "update_details") && person.employee_type !== "Teaching") {
      return NextResponse.json({ error: "Only Teaching staff can be licensed teachers." }, { status: 400 });
    }

    // Optional PRC ID scan: the same check leave proofs pass.
    let documentId = null;
    if (input.document && (action === "turn_on" || action === "update_details")) {
      const proof = validateProofUrl(input.document.data_url);
      if (!proof.ok) return NextResponse.json({ error: proof.error.replace(/proof document/i, "PRC ID") }, { status: 400 });
      const doc = await supabase.from("employee_license_documents").insert({
        employee_id: person.id, file_name: normalizeText(input.document.file_name).slice(0, 120) || null,
        data_url: proof.value, uploaded_by: guard.userId || null, uploaded_by_name: actorName(guard),
      }).select("id").maybeSingle();
      if (doc.error) return dbError(doc.error);
      documentId = doc.data?.id || null;
    }

    const row = {
      employee_id: person.id,
      action,
      reason: input.reason,
      changed_by: guard.userId || null,
      changed_by_name: actorName(guard),
      changed_by_role: "hr",
      ...(input.prc_license_no ? { prc_license_no: input.prc_license_no } : {}),
      ...(input.license_expires_on ? { license_expires_on: input.license_expires_on } : {}),
      ...(documentId ? { prc_id_document_id: documentId } : {}),
    };
    const result = await supabase.from("employee_license_changes").insert(row);
    if (result.error) return dbError(result.error);

    const words = { turn_on: "turned on (pending verification)", update_details: "details changed (verification cleared)", verify: "verified", turn_off: "turned off" };
    await appendAuditLog({
      actor: guard, module: "hr", action: `teacher_license_${action}`, entity_type: "profile", entity_id: person.id,
      status: "success", source: "api", description: `Licensed teacher ${personLabel(person)} ${words[action]}: ${input.reason}`,
      // Never the full PRC number in the audit trail.
      metadata: { action, expires_on: input.license_expires_on || null, last4: input.prc_license_no ? input.prc_license_no.slice(-4) : null, document: Boolean(documentId) },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
