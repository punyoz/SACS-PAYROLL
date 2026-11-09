import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { notify, superAdminIds } from "@/lib/branch-requests-server";
import { LEAVE_CONVERSION_KEYS, LEAVE_CONVERSION_SECTION, leaveConversionError, loadLeaveConversion } from "@/lib/payroll/leave-conversion";

/**
 * Unused leave conversion in final pay (decision 2026-11-09 #1).
 *   GET                                  the setting (government_rates read)
 *   PATCH { enabled, max_days?, reason } switch it (HR / Super Admin:
 *                                        government_rates create); a reason is
 *                                        required; audited; the Super Admin is
 *                                        told when HR changes it.
 */

export async function GET(request) {
  const guard = await requirePermission(request, "government_rates", "read");
  if (guard.denied) return guard.denied;
  try {
    return NextResponse.json({ setting: await loadLeaveConversion(getAdminClient()), can_edit: ["hr", "super_admin"].includes(guard.role) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  const guard = await requirePermission(request, "government_rates", "create");
  if (guard.denied) return guard.denied;
  if (!["hr", "super_admin"].includes(guard.role)) return NextResponse.json({ error: "Only HR and the Super Admin change this setting." }, { status: 403 });
  try {
    const body = await request.json().catch(() => ({}));
    const reason = normalizeText(body.reason).slice(0, 300);
    const requested = { enabled: body.enabled, max_days: body.max_days === "" || body.max_days === null || body.max_days === undefined ? null : Number(body.max_days) };
    const invalid = leaveConversionError(requested);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    if (!reason) return NextResponse.json({ error: "Give a reason for the change.", code: "reason_required" }, { status: 400 });

    const supabase = getAdminClient();
    const before = await loadLeaveConversion(supabase);
    const now = new Date().toISOString();
    const result = await supabase.from("system_config").upsert([
      { section: LEAVE_CONVERSION_SECTION, key: LEAVE_CONVERSION_KEYS.enabled, value: String(requested.enabled), updated_at: now },
      { section: LEAVE_CONVERSION_SECTION, key: LEAVE_CONVERSION_KEYS.maxDays, value: requested.max_days === null ? "" : String(requested.max_days), updated_at: now },
    ], { onConflict: "section,key" });
    if (result.error) throw new Error(result.error.message);

    const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
    const describe = (s) => (s.enabled ? `on${s.max_days ? `, up to ${s.max_days} days` : ", no day limit"}` : "off");
    await appendAuditLog({
      actor: guard, module: "config", action: "leave_conversion_setting", entity_type: "system_config", entity_id: LEAVE_CONVERSION_KEYS.enabled,
      description: `Unused leave conversion in final pay: ${describe(before)} → ${describe(requested)}, by ${actorName}. Reason: ${reason}.`,
      status: "success", source: "api", metadata: { before, after: requested, reason, changed_by_role: guard.role },
    });
    if (guard.role !== "super_admin") {
      await notify(supabase, await superAdminIds(supabase), {
        kind: "rate_change", title: `Unused leave conversion turned ${requested.enabled ? "on" : "off"} by ${actorName}`,
        body: `Final pay setting changed. Reason: ${reason}.`, link_page: "sa-config",
      });
    }
    return NextResponse.json({ success: true, setting: requested });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
