/**
 * Approval routing (2026-11-09 Parts A-D), shared by the routes so every one
 * answers "who decides this, and is it a fallback?" the same way. The
 * database checks the same rules (20261110020000_own_items_fallback_claims).
 *
 *   * Nobody approves, processes or edits their OWN item.
 *   * An HR's own item goes to any OTHER active HR; when none is active the
 *     Super Admin is the fallback (audit "fallback used", notifications).
 *   * The Super Admin never decides when a normal approver exists.
 *   * The shared HR queue: whoever claims first handles the item; a claim
 *     lasts 30 minutes, until Release, or until that HR signs out.
 */
import { NextResponse } from "next/server";
import { appendAuditLog } from "@/lib/audit/store";
import { notify, superAdminIds } from "@/lib/branch-requests-server";

const INACTIVE = ["Inactive", "Archived", "Separated"];
export const CLAIM_MINUTES = 30;

/** Active HR accounts (not archived, status not Inactive / Archived / Separated). */
export async function activeHrIds(supabase) {
  const result = await supabase.from("profiles").select("id,employee_status,archived").eq("role", "hr").eq("archived", false);
  if (result.error) return [];
  return (result.data || []).filter((row) => !INACTIVE.includes(String(row.employee_status || "Active"))).map((row) => row.id);
}

/** Every active HR except `exceptId`. */
export async function otherActiveHrIds(supabase, exceptId) {
  return (await activeHrIds(supabase)).filter((id) => id !== exceptId);
}

/** Active Accountants of a branch. */
export async function activeAccountantIds(supabase, branchId) {
  if (!branchId) return [];
  const result = await supabase.from("profiles").select("id,employee_status").eq("role", "accountant").eq("branch_id", branchId).eq("archived", false);
  if (result.error) return [];
  return (result.data || []).filter((row) => !INACTIVE.includes(String(row.employee_status || "Active"))).map((row) => row.id);
}

/** 403 for acting on one's own item (and an audit entry saying it was refused). */
export async function refuseOwnItem(guard, { module, entityType, entityId, what }) {
  await appendAuditLog({
    actor: guard, module, action: "own_item_blocked", entity_type: entityType, entity_id: entityId || null, status: "failed", source: "api",
    description: `${guard.session?.full_name || guard.session?.email || "Someone"} tried to act on their own ${what}; refused (nobody approves their own item).`,
  }).catch(() => null);
  return NextResponse.json({ error: `You cannot act on your own ${what}. Another approver handles it.`, code: "own_item" }, { status: 403 });
}

/**
 * The fallback is used: record "fallback used" with the reason and notify the
 * Super Admin(s) and the requester. Generic wording, no amounts.
 */
export async function recordFallback(supabase, { actor = null, ownerId, ownerName, itemType, itemId, what, linkPage = "sa-fallback", decided = null }) {
  const reason = "No other HR account is active, so the Super Admin is the fallback approver.";
  await appendAuditLog({
    actor, module: "approvals", action: decided ? "fallback_decided" : "fallback_used", entity_type: itemType, entity_id: itemId || null,
    status: "success", source: "api",
    description: decided
      ? `Fallback used: the Super Admin ${decided} ${ownerName || "an HR"}'s ${what}. ${reason}`
      : `Fallback used: ${ownerName || "An HR"}'s ${what} waits on the Super Admin. ${reason}`,
    metadata: { fallback: true, reason, owner_id: ownerId || null, item_type: itemType, item_id: itemId || null },
  }).catch(() => null);
  if (!decided) {
    await notify(supabase, await superAdminIds(supabase), {
      kind: "fallback_waiting", title: "An item is waiting on you (fallback)", body: `${ownerName || "An HR"}'s ${what}. ${reason}`, link_page: linkPage,
    }).catch(() => 0);
  }
  if (ownerId) {
    await notify(supabase, [ownerId], {
      kind: decided ? "fallback_decided" : "fallback_routed",
      title: decided ? `Your ${what} was ${decided} by the Super Admin` : `Your ${what} went to the Super Admin`,
      body: reason, link_page: null,
    }).catch(() => 0);
  }
}

/** The active claim on an item, or null (expired claims do not count). */
export async function claimOn(supabase, itemType, itemId) {
  const result = await supabase.from("hr_queue_claims").select("*").eq("item_type", itemType).eq("item_id", itemId).maybeSingle();
  const row = result.data;
  return row && new Date(row.expires_at).getTime() > Date.now() ? row : null;
}

/** Active claims for a list of items: Map item_id -> claim. */
export async function claimsFor(supabase, itemType, itemIds) {
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const result = await supabase.from("hr_queue_claims").select("*").eq("item_type", itemType).in("item_id", ids.slice(0, 500));
  const now = Date.now();
  return new Map((result.data || []).filter((row) => new Date(row.expires_at).getTime() > now).map((row) => [row.item_id, row]));
}

/** 409 when another HR holds the item's claim; null when the caller may act. */
export async function refuseClaimedByOther(supabase, guard, itemType, itemId) {
  const claim = await claimOn(supabase, itemType, itemId);
  if (!claim || claim.claimed_by === guard.userId) return null;
  return NextResponse.json({ error: `Claimed by ${claim.claimed_by_name || "another HR"}. Wait for them to finish or release it.`, code: "claimed", claimed_by_name: claim.claimed_by_name, expires_at: claim.expires_at }, { status: 409 });
}

/** Shape a claim for the queue: { claimed_by_name, claimed_by_me, expires_at } or null. */
export function claimView(claim, guard) {
  if (!claim) return null;
  return { claimed_by_name: claim.claimed_by_name, claimed_by_me: claim.claimed_by === guard.userId, expires_at: claim.expires_at };
}

/** Map a database refusal (own item, claimed, self-processing) to a clear reply, or null. */
export function routingErrorResponse(error) {
  const message = String(error?.message || "");
  if (/^own_item|own_payslip/.test(message)) return NextResponse.json({ error: message.replace(/^\w+:\s*/, ""), code: "own_item" }, { status: 403 });
  if (/^claimed/.test(message)) return NextResponse.json({ error: message.replace(/^claimed:\s*claimed by/i, "Claimed by"), code: "claimed" }, { status: 409 });
  if (/^self_processing_blocked/.test(message)) return NextResponse.json({ error: message.replace(/^\w+:\s*/, ""), code: "self_processing_blocked" }, { status: 403 });
  return null;
}
