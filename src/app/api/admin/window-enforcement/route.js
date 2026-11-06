/**
 * Processing window enforcement: the Super Admin's testing switch
 * (System Configuration; src/lib/payroll/window-enforcement.js,
 * supabase/migrations/20261106090000_payroll_window_enforcement_switch.sql).
 *
 *   GET    the switch (as applied, auto-expiry included), the deployment
 *          environment and the change history
 *   POST { enforced: boolean, expires_on?: "YYYY-MM-DD", reason: string, confirm?: boolean }
 *          turn it ON or OFF. A reason is always required. In production,
 *          turning it OFF also needs confirm: true (the Super Admin read
 *          and accepted what it means). Every change goes to the audit log
 *          (who, when, old, new, reason) and the switch's own change log.
 *
 * Super Admin only: system_configuration (Super Admin alone in the matrix)
 * AND the super_admin role, so a changed permission row never opens it to
 * another role. Accountant, HR and Admin get 403 on both methods.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { actorName } from "@/lib/payroll/staff";
import { deploymentEnvironment, loadWindowEnforcement } from "@/lib/payroll/window-enforcement";

const NOT_READY = "The processing window switch is not set up yet: apply 20261106090000_payroll_window_enforcement_switch.sql.";
const REASON_MAX = 500;
const SUPER_ADMIN_ONLY = "Only the Super Admin can see or change processing window enforcement.";

async function guardSuperAdmin(request, action) {
  const guard = await requirePermission(request, "system_configuration", action);
  if (guard.denied) return { denied: guard.denied };
  if (String(guard.role || "").toLowerCase() !== "super_admin") {
    return { denied: NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 }) };
  }
  return { guard };
}

async function history(supabase) {
  const result = await supabase
    .from("payroll_window_enforcement_changes")
    .select("id,old_enforced,new_enforced,old_expires_on,new_expires_on,reason,source,environment,actor_name,changed_at")
    .order("changed_at", { ascending: false })
    .limit(50);
  return result.error ? null : result.data || [];
}

export async function GET(request) {
  try {
    const { denied } = await guardSuperAdmin(request, "read");
    if (denied) return denied;
    const supabase = getAdminClient();
    const [enforcement, changes] = await Promise.all([loadWindowEnforcement(supabase), history(supabase)]);
    if (!enforcement.available || changes === null) return NextResponse.json({ available: false, error: NOT_READY, enforcement, environment: deploymentEnvironment() });
    return NextResponse.json({ available: true, enforcement, environment: deploymentEnvironment(), history: changes });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { guard, denied } = await guardSuperAdmin(request, "update");
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    if (typeof body.enforced !== "boolean") {
      return NextResponse.json({ error: "Choose ON or OFF." }, { status: 400 });
    }
    const reason = normalizeText(body.reason);
    if (!reason) return NextResponse.json({ error: "A reason is required.", code: "reason_required" }, { status: 400 });
    if (reason.length > REASON_MAX) return NextResponse.json({ error: `The reason can be at most ${REASON_MAX} characters.` }, { status: 400 });
    const expiresOn = body.enforced ? null : normalizeText(body.expires_on) || null;
    if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
      return NextResponse.json({ error: "Choose a valid date for the automatic return to ON." }, { status: 400 });
    }
    const environment = deploymentEnvironment();
    // Production: OFF only after the Super Admin confirmed what it means.
    if (!body.enforced && environment === "production" && body.confirm !== true) {
      return NextResponse.json({
        error: "Turning processing window enforcement OFF on the live system needs your confirmation.",
        code: "confirmation_required",
      }, { status: 409 });
    }

    const supabase = getAdminClient();
    const before = await loadWindowEnforcement(supabase);
    if (!before.available) return NextResponse.json({ error: NOT_READY }, { status: 503 });

    const saved = await supabase.rpc("set_payroll_window_enforcement", {
      p_enforced: body.enforced,
      p_expires_on: expiresOn,
      p_reason: reason,
      p_actor: guard.userId || null,
      p_actor_name: actorName(guard),
      p_source: "super_admin",
      p_environment: environment,
    });
    if (saved.error) {
      const message = String(saved.error.message || "");
      const known = /reason|future date|ON or OFF|500 characters/i.test(message);
      return NextResponse.json({ error: known ? message : sanitizeError(saved.error) }, { status: known ? 400 : 500 });
    }
    const after = await loadWindowEnforcement(supabase);

    const label = (on) => (on ? "ON (enforced)" : "OFF (testing mode)");
    await appendAuditLog({
      actor: guard,
      module: "system_configuration",
      action: "payroll_window_enforcement_changed",
      entity_type: "payroll_window_enforcement",
      entity_id: "1",
      status: "success",
      source: "api",
      description: `Processing window enforcement changed from ${label(before.enforced)} to ${label(after.enforced)}${after.expires_on ? `, back ON automatically on ${after.expires_on}` : ""}. Reason: ${reason}`,
      metadata: {
        old_value: { enforced: before.enforced, expires_on: before.expires_on },
        new_value: { enforced: after.enforced, expires_on: after.expires_on },
        reason,
        environment,
        confirmed: body.confirm === true,
      },
    }).catch(() => {});

    return NextResponse.json({ success: true, enforcement: after, environment, history: await history(supabase) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
