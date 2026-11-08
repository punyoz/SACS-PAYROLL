import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { ensurePosition, loadPositions, positionKey } from "@/lib/hr/positions";

/**
 * Positions (alpha test B3, 20261109050000).
 *   GET              every position, A to Z (employee_information read)
 *   POST { name }    add one (employee_information create). 409 with the
 *                    existing spelling when it is already listed, whatever
 *                    the capitals or spaces.
 */

export async function GET(request) {
  const guard = await requirePermission(request, "employee_information", "read");
  if (guard.denied) return guard.denied;
  try {
    const positions = await loadPositions(getAdminClient());
    return NextResponse.json({ positions: positions.map((p) => p.name) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requirePermission(request, "employee_information", "create");
  if (guard.denied) return guard.denied;
  try {
    const body = await request.json().catch(() => ({}));
    const supabase = getAdminClient();
    const before = (await loadPositions(supabase)).find((p) => positionKey(p.name) === positionKey(body.name));
    if (before) return NextResponse.json({ error: `"${before.name}" is already in the list.`, code: "duplicate", name: before.name }, { status: 409 });
    const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
    const result = await ensurePosition(supabase, body.name, { userId: guard.userId, name: actorName });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    if (result.created) {
      await appendAuditLog({
        actor: guard, module: "employee_information", action: "position_added", entity_type: "employee_position", entity_id: result.name,
        description: `Position "${result.name}" added by ${actorName}.`, status: "success", source: "api", metadata: { name: result.name },
      });
    }
    return NextResponse.json({ success: true, name: result.name, created: result.created });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
