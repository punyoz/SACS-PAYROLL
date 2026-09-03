import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog, listAuditLogs } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";

export async function GET(request) {
  const guard = await requirePermission(request, "audit_logs", "read");
  if (guard.denied) return guard.denied;

  try {
    const url = new URL(request.url);
    const moduleFilter = normalizeText(url.searchParams.get("module"), "all");
    const action = normalizeText(url.searchParams.get("action"), "all");
    const search = normalizeText(url.searchParams.get("search"));
    const limit = Number(url.searchParams.get("limit") || 150);

    // Admin sees their own branch's activity only; Super Admin (branch-exempt)
    // sees every branch plus system-level events.
    const result = await listAuditLogs({
      module: moduleFilter,
      action,
      search,
      limit,
      branch_id: guard.branchExempt ? null : guard.branchId,
    });

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      source_mode: result.source_mode,
      summary: result.summary,
      logs: result.logs,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  // UI-movement logging: any signed-in role may append, but the entry is
  // stamped with the caller's own branch so it stays inside that branch's view.
  const guard = await requirePermission(request, "audit_logs", "read");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json();

    const log = await appendAuditLog({
      branch_id: guard.branchExempt ? (body.branch_id || null) : guard.branchId,
      module: normalizeText(body.module, "ui"),
      action: normalizeText(body.action, "event"),
      entity_type: normalizeText(body.entity_type, "screen"),
      entity_id: normalizeText(body.entity_id),
      description: normalizeText(body.description, "UI movement captured."),
      status: normalizeText(body.status, "success"),
      source: normalizeText(body.source, "ui"),
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    });

    return NextResponse.json({ success: true, log });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
