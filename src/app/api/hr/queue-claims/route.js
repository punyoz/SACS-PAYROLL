/**
 * The shared HR queue's claim lock (2026-11-09 Part C).
 *
 *   POST { action: "claim" | "release", item_type, item_id }
 *     claim    locks the item for this HR for 30 minutes (renewing one's own
 *              claim); refused when another HR holds it ("claimed by <name>")
 *              or when the item is the caller's own.
 *     release  frees it. Signing out frees every claim of the account.
 *   item_type: leave_request | payroll_run | attendance_correction
 *
 * HR only (leave_approval "update", the HR queue's permission); the database
 * functions hr_claim_item / hr_release_claims do the locking atomically.
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ["leave_request", "payroll_run", "attendance_correction"];

/** Is this item the caller's own? (Then they may not claim it.) */
async function isOwn(supabase, type, id, userId) {
  if (type === "leave_request") return (await supabase.from("leave_requests").select("employee_id").eq("id", id).maybeSingle()).data?.employee_id === userId;
  if (type === "attendance_correction") return (await supabase.from("attendance_corrections").select("employee_id").eq("id", id).maybeSingle()).data?.employee_id === userId;
  if (type === "payroll_run") {
    const run = (await supabase.from("payroll_runs").select("submission_no").eq("id", id).maybeSingle()).data;
    if (!run) return false;
    const own = await supabase.from("payroll_run_items").select("id").eq("run_id", id).eq("submission_no", run.submission_no).eq("employee_id", userId).limit(1);
    return Boolean(own.data?.length);
  }
  return false;
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "update");
    if (guard.denied) return guard.denied;
    if (guard.role !== "hr") return NextResponse.json({ error: "Only HR claims queue items." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "").trim();
    const type = String(body.item_type || "").trim();
    const id = String(body.item_id || "").trim();
    if (!TYPES.includes(type) || !UUID.test(id)) return NextResponse.json({ error: "Send item_type and item_id." }, { status: 400 });
    const supabase = getServiceClient();

    if (action === "release") {
      const released = await supabase.rpc("hr_release_claims", { p_actor: guard.userId, p_type: type, p_item: id });
      if (released.error) throw released.error;
      return NextResponse.json({ success: true, released: released.data || 0 });
    }
    if (action !== "claim") return NextResponse.json({ error: "action must be claim or release." }, { status: 400 });

    if (await isOwn(supabase, type, id, guard.userId)) {
      await appendAuditLog({ actor: guard, module: "approvals", action: "own_item_blocked", entity_type: type, entity_id: id, status: "failed", source: "api",
        description: `${guard.session?.full_name || "An HR"} tried to claim their own item; refused.` }).catch(() => null);
      return NextResponse.json({ error: "You cannot claim your own request. Another HR handles it.", code: "own_item" }, { status: 403 });
    }
    const claimed = await supabase.rpc("hr_claim_item", { p_type: type, p_item: id, p_actor: guard.userId, p_owner: null });
    if (claimed.error) {
      const message = String(claimed.error.message || "");
      if (/^claimed/.test(message)) return NextResponse.json({ error: message.replace(/^claimed:\s*claimed by/i, "Claimed by"), code: "claimed" }, { status: 409 });
      throw claimed.error;
    }
    const row = Array.isArray(claimed.data) ? claimed.data[0] : claimed.data;
    return NextResponse.json({ success: true, claim: { claimed_by_name: row?.claimed_by_name, claimed_by_me: true, expires_at: row?.expires_at } });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
