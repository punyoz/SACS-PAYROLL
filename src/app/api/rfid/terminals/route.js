/**
 * RFID terminals (20261021030000_rfid_cards_terminals.sql): the readers, by
 * branch. HR and the Super Admin manage every branch's (and may add one for
 * every branch); an Admin only its own branch's (checked again by the
 * database function).
 *
 *   GET    the terminals in reach, with their last tap
 *   POST   { name, branch_id }                       register a terminal
 *   PATCH  { terminal_id, name?, branch_id?, status?: active | inactive,
 *            reset_key?: true, reason? }             switching it off or resetting
 *                                                    its key locks its kiosks
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { ROLE_LABELS, describeRfidError, terminalHealth } from "@/lib/rfid/cards";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refused(error) {
  const failure = describeRfidError(error);
  return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
}

function shape(t, branchName) {
  const health = terminalHealth(t);
  return {
    id: t.id, name: t.name, branch_id: t.branch_id || null, branch_name: t.branch_id ? branchName.get(t.branch_id) || "—" : "All branches",
    status: t.status, status_label: t.status === "active" ? "Active" : "Inactive", health_label: health.label, health_tone: health.tone,
    last_tap_at: t.last_tap_at || null, last_tap_result: t.last_tap_result || null, status_reason: t.status_reason || null,
    created_by_name: t.created_by_name, created_by_role: ROLE_LABELS[t.created_by_role] || t.created_by_role, created_at: t.created_at,
    updated_by_name: t.updated_by_name || null, updated_at: t.updated_at,
  };
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "rfid_devices", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    let query = supabase.from("rfid_terminals").select("*").order("name", { ascending: true });
    if (!guard.branchExempt) query = query.eq("branch_id", guard.branchId || "00000000-0000-0000-0000-000000000000");
    const result = await query;
    if (result.error) return NextResponse.json({ available: false, terminals: [], branches: [], error: "RFID terminals are not set up yet." });
    const branches = (await supabase.from("branches").select("id,name").order("name")).data || [];
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    return NextResponse.json({
      available: true,
      terminals: (result.data || []).map((t) => shape(t, branchName)),
      branches: guard.branchExempt ? branches : branches.filter((b) => b.id === guard.branchId),
      can_all_branches: Boolean(guard.branchExempt),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "rfid_devices", "create");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const name = normalizeText(body.name).slice(0, 60);
    // An Admin's terminal is always its own branch's.
    const branchId = guard.branchExempt ? (UUID.test(normalizeText(body.branch_id)) ? normalizeText(body.branch_id) : null) : guard.branchId;
    const result = await getAdminClient().rpc("rfid_terminal_save", {
      p_actor: guard.userId, p_terminal: null, p_name: name, p_branch: branchId, p_status: "active", p_reset_key: false, p_reason: null,
    });
    if (result.error) return refused(result.error);
    const t = Array.isArray(result.data) ? result.data[0] : result.data;
    await appendAuditLog({
      actor: guard, module: "rfid", action: "rfid_terminal_added", entity_type: "rfid_terminal", entity_id: t?.id || name,
      branch_id: branchId, status: "success", source: "api", description: `RFID terminal "${name}" registered.`, metadata: { branch_id: branchId },
    });
    return NextResponse.json({ success: true, terminal: t ? { id: t.id, name: t.name } : null });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "rfid_devices", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const terminalId = normalizeText(body.terminal_id);
    if (!UUID.test(terminalId)) return NextResponse.json({ error: "Terminal not found." }, { status: 404 });
    const supabase = getAdminClient();
    const found = await supabase.from("rfid_terminals").select("*").eq("id", terminalId).maybeSingle();
    if (found.error || !found.data) return NextResponse.json({ error: "Terminal not found." }, { status: 404 });
    const current = found.data;
    const status = body.status === undefined ? current.status : normalizeText(body.status);
    const reason = normalizeText(body.reason).slice(0, 300);
    if ((status === "inactive" && current.status === "active") || body.reset_key === true) {
      if (reason.length < 5) return NextResponse.json({ error: "Give the reason (at least 5 characters)." }, { status: 400 });
    }
    const branchId = !guard.branchExempt ? current.branch_id
      : body.branch_id === undefined ? current.branch_id : (UUID.test(normalizeText(body.branch_id)) ? normalizeText(body.branch_id) : null);
    const result = await supabase.rpc("rfid_terminal_save", {
      p_actor: guard.userId, p_terminal: terminalId, p_name: body.name === undefined ? current.name : normalizeText(body.name).slice(0, 60),
      p_branch: branchId, p_status: status, p_reset_key: body.reset_key === true, p_reason: reason || null,
    });
    if (result.error) return refused(result.error);
    const t = Array.isArray(result.data) ? result.data[0] : result.data;
    await appendAuditLog({
      actor: guard, module: "rfid", action: body.reset_key === true ? "rfid_terminal_key_reset" : "rfid_terminal_updated", entity_type: "rfid_terminal",
      entity_id: terminalId, branch_id: t?.branch_id || null, status: "success", source: "api",
      description: `RFID terminal "${t?.name || current.name}" ${body.reset_key === true ? "key reset" : status !== current.status ? `switched ${status === "active" ? "on" : "off"}` : "updated"}${reason ? `: ${reason}` : ""}.`,
      metadata: { from: current.status, to: status, reset_key: body.reset_key === true },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
