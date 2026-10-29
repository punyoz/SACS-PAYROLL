/**
 * The final-payslip override log (2026-10-29, 20261029040000): one record
 * per override, apart from the ordinary payroll logs. Read by the Super
 * Admin and, for compliance, HR (payroll_override "read", 20261029060000);
 * read-only, the records are never changed. Only the Super Admin overrides.
 *
 *   GET [?employee_id=&limit=]   newest first, each with its review flags
 *
 * The override itself is PATCH /api/accountant/payroll { action:
 * "override_final" }; there is no screen for it.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = "id,entry_id,employee_id,employee_name,branch_id,pay_period,run_id,run_status,reason,old_payslip_no,new_payslip_no,"
  + "old_values,new_values,changed_fields,actor_id,actor_name,actor_role,created_at";
const FLAG_COLUMNS = "id,override_id,kind,ref_id,month,tax_year,message,status,reviewed_by_name,reviewed_at,review_note,created_at";

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "payroll_override", "read");
    if (guard.denied) return guard.denied;

    const url = new URL(request.url);
    const employeeId = normalizeText(url.searchParams.get("employee_id"));
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);

    const supabase = getAdminClient();
    let query = supabase.from("payroll_final_overrides").select(COLUMNS).order("created_at", { ascending: false }).limit(limit);
    if (employeeId) {
      if (!UUID.test(employeeId)) return NextResponse.json({ overrides: [] });
      query = query.eq("employee_id", employeeId);
    }
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    const overrides = result.data || [];

    const ids = overrides.map((row) => row.id);
    const flags = ids.length
      ? await supabase.from("payroll_review_flags").select(FLAG_COLUMNS).in("override_id", ids).order("created_at", { ascending: true })
      : { data: [], error: null };
    if (flags.error) throw new Error(flags.error.message);
    const byOverride = new Map();
    (flags.data || []).forEach((flag) => {
      const list = byOverride.get(flag.override_id) || [];
      list.push(flag);
      byOverride.set(flag.override_id, list);
    });

    return NextResponse.json({
      overrides: overrides.map((row) => ({ ...row, review_flags: byOverride.get(row.id) || [] })),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
