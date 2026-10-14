/**
 * Early Bird incentive settings and winners (src/lib/payroll/early-bird.js).
 *
 *   GET    the settings and the stored winner of each pay period, newest
 *          first. A branch-scoped caller (Admin, Accountant) sees another
 *          branch's winner without the name.
 *   PATCH  { threshold_minutes?, incentive_amount?, exclude_unexcused_absence? }
 *          Super Admin and HR: any of the three. Other roles: 403.
 *
 * Every change is written to Audit & Monitoring with the old and new values.
 * A winner already stored keeps the amount it was stored with; a period whose
 * payroll is finalized is never recomputed.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { can } from "@/lib/rbac/permissions";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { EARLY_BIRD_SECTION, loadEarlyBirdSettings, shapeWinner } from "@/lib/payroll/early-bird";

const NOT_READY = "The Early Bird incentive is not set up yet: apply supabase/migrations/20261013010000_employee_schedules_cutoffs_early_bird.sql.";
const AMOUNT_MAX = 1_000_000;

/** Super Admin and HR change every setting (the route's "update" permission). */
function permissions(guard) {
  const canEdit = can(guard.role, "early_bird_incentive", "update");
  return { can_edit_settings: canEdit, can_edit_amount: canEdit };
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "early_bird_incentive", "read");
    if (guard.denied) return guard.denied;

    const supabase = getAdminClient();
    const settings = await loadEarlyBirdSettings(supabase);
    const result = await supabase.from("early_bird_winners").select("*")
      .order("period_start", { ascending: false }).limit(24);
    if (result.error) return NextResponse.json({ available: false, error: NOT_READY, settings, ...permissions(guard) });

    const winners = (result.data || []).map(shapeWinner).map((winner) => {
      const visible = guard.branchExempt || !winner.employee_id || String(winner.branch_id || "") === String(guard.branchId || "");
      return visible ? winner : {
        ...winner,
        employee_id: null,
        employee_name: "An employee of another branch",
        other_branch: true,
        average_offset_minutes: null,
        ranking: [],
        source_log_ids: [],
      };
    });

    return NextResponse.json({ available: true, settings, winners, ...permissions(guard) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "early_bird_incentive", "update");
    if (guard.denied) return guard.denied;

    const body = await request.json().catch(() => ({}));
    const fields = {};

    if (body.incentive_amount !== undefined) {
      const amount = Number(body.incentive_amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > AMOUNT_MAX) {
        return NextResponse.json({ error: "The incentive amount is ₱0 to ₱1,000,000 (0 switches the incentive off)." }, { status: 400 });
      }
      fields.incentive_amount = String(Math.round(amount * 100) / 100);
    }
    if (body.threshold_minutes !== undefined) {
      const minutes = Number(body.threshold_minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
        return NextResponse.json({ error: "The threshold is 1 to 120 minutes before the employee's own work start." }, { status: 400 });
      }
      fields.threshold_minutes = String(minutes);
    }
    if (body.exclude_unexcused_absence !== undefined) {
      fields.exclude_unexcused_absence = body.exclude_unexcused_absence === true || body.exclude_unexcused_absence === "true" ? "true" : "false";
    }
    if (!Object.keys(fields).length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

    const supabase = getAdminClient();
    const before = await loadEarlyBirdSettings(supabase);
    const now = new Date().toISOString();
    const result = await supabase.from("system_config").upsert(
      Object.entries(fields).map(([key, value]) => ({ section: EARLY_BIRD_SECTION, key, value, updated_at: now })),
      { onConflict: "section,key" },
    );
    if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });
    const after = await loadEarlyBirdSettings(supabase);

    const changes = Object.keys(fields).map((key) => `${key.replaceAll("_", " ")} ${before[key]} → ${after[key]}`).join(", ");
    await appendAuditLog({
      actor: guard,
      module: "early_bird_incentive",
      action: "settings_update",
      entity_type: "system_config",
      entity_id: EARLY_BIRD_SECTION,
      description: `Early Bird incentive settings changed: ${changes}, by ${guard.session?.full_name || guard.session?.email || "unknown"} (${guard.role === "super_admin" ? "Super Admin" : guard.role === "hr" ? "HR" : guard.role}).`,
      status: "success",
      source: "api",
      metadata: { before, after, keys: Object.keys(fields), changed_by_role: guard.role },
    });

    return NextResponse.json({ success: true, settings: after });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
