/**
 * Records flagged for review after a final-payslip override (2026-10-29,
 * 20261029040000): the approved run's totals, the month's remittance, BIR
 * 2316 / alphalist files, the year-end annualization and the 13th month that
 * used the old figures. A flag never changes the record; a person checks it,
 * redoes what is needed and marks the flag reviewed with a note.
 *
 *   GET [?status=open|all]       the flags this role reviews
 *   PATCH { id, note }           mark one reviewed (note: what was done)
 *
 * Who:
 *   Accountant   its branch's remittance, BIR, annualization and 13th month
 *                flags (payroll_reports); reads and marks them
 *   HR           the payroll-run flags of runs it approved (payroll_run_approval)
 *   Super Admin  reads every flag (payroll_override); never marks its own
 *                override's consequences reviewed
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { readSession } from "@/lib/rbac/session";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_BRANCH = "00000000-0000-0000-0000-000000000000";
const COLUMNS = "id,override_id,kind,ref_id,employee_id,branch_id,pay_period,tax_year,month,message,status,"
  + "reviewed_by_name,reviewed_at,review_note,created_at";

const ACCOUNTANT_KINDS = ["remittance", "bir_2316", "bir_alphalist", "tax_annualization", "thirteenth_month"];
const MODULE_FOR = { accountant: "payroll_reports", hr: "payroll_run_approval", super_admin: "payroll_override" };

async function guardFor(request, action) {
  const role = String(readSession(request)?.role || "").toLowerCase();
  const moduleName = MODULE_FOR[role];
  if (!moduleName) return { denied: NextResponse.json({ error: "You do not have permission to perform this action." }, { status: 403 }) };
  return requirePermission(request, moduleName, action);
}

/** The flags a guard may see, as a query. */
function scoped(query, guard) {
  if (guard.role === "hr") return query.eq("kind", "payroll_run");
  if (guard.role === "accountant") return query.in("kind", ACCOUNTANT_KINDS).eq("branch_id", guard.branchId || NO_BRANCH);
  return query;
}

export async function GET(request) {
  try {
    const guard = await guardFor(request, "read");
    if (guard.denied) return guard.denied;

    const status = normalizeText(new URL(request.url).searchParams.get("status"), "open").toLowerCase();
    let query = scoped(getAdminClient().from("payroll_review_flags").select(COLUMNS), guard)
      .order("created_at", { ascending: false }).limit(500);
    if (status !== "all") query = query.eq("status", "open");
    const result = await query;
    if (result.error) throw new Error(result.error.message);

    return NextResponse.json({ flags: result.data || [], can_review: guard.role !== "super_admin" });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await guardFor(request, "update");
    if (guard.denied) return guard.denied;
    if (guard.role === "super_admin") {
      return NextResponse.json({ error: "The records an override affects are reviewed by the Accountant and HR, not the Super Admin." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const id = normalizeText(body?.id);
    const note = normalizeText(body?.note).slice(0, 500);
    if (!UUID.test(id)) return NextResponse.json({ error: "Choose a review flag." }, { status: 400 });
    if (note.length < 5) return NextResponse.json({ error: "Say what was checked or redone (at least 5 characters).", code: "review_note_required" }, { status: 400 });

    const supabase = getAdminClient();
    const found = await scoped(supabase.from("payroll_review_flags").select(COLUMNS), guard).eq("id", id).maybeSingle();
    if (found.error) throw new Error(found.error.message);
    if (!found.data) return NextResponse.json({ error: "Review flag not found." }, { status: 404 });
    if (found.data.status !== "open") return NextResponse.json({ error: "This flag was already reviewed.", code: "already_reviewed" }, { status: 409 });

    const actorName = normalizeText(guard.session?.full_name, guard.session?.email) || null;
    const updated = await supabase.from("payroll_review_flags")
      .update({ status: "reviewed", reviewed_by: guard.userId || null, reviewed_by_name: actorName, reviewed_at: new Date().toISOString(), review_note: note })
      .eq("id", id).eq("status", "open").select(COLUMNS).maybeSingle();
    if (updated.error) throw new Error(updated.error.message);
    if (!updated.data) return NextResponse.json({ error: "This flag was already reviewed.", code: "already_reviewed" }, { status: 409 });

    await appendAuditLog({
      actor: guard,
      module: "payroll_override",
      action: "review_flag_reviewed",
      entity_type: "payroll_review_flag",
      entity_id: id,
      description: `Review flag (${found.data.kind}) for the ${found.data.pay_period} override marked reviewed by ${actorName || "—"}: ${note}`,
      status: "success",
      source: "api",
      metadata: { override_id: found.data.override_id, kind: found.data.kind, ref_id: found.data.ref_id, note },
    });

    return NextResponse.json({ flag: updated.data });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
