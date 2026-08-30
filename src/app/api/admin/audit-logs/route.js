import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog, listAuditLogs } from "@/lib/audit/store";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const moduleFilter = normalizeText(url.searchParams.get("module"), "all");
    const action = normalizeText(url.searchParams.get("action"), "all");
    const search = normalizeText(url.searchParams.get("search"));
    const limit = Number(url.searchParams.get("limit") || 150);

    const result = await listAuditLogs({ module: moduleFilter, action, search, limit });

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
  try {
    const body = await request.json();

    const log = await appendAuditLog({
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
