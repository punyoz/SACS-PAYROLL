/**
 * RFID cards (20261021030000_rfid_cards_terminals.sql). HR and the Super
 * Admin for every branch; an Admin for the employees of its own branch only
 * (checked again by the database functions, whoever calls them).
 *
 *   GET    the cards in reach (all statuses, never removed), their history,
 *          and the employees a card can be registered to
 *   POST   { action: "register", employee_id, uid, reason? }
 *   PATCH  { action: "replace", card_id, new_uid, reason, lost }
 *          { action: "deactivate" | "mark_lost" | "reactivate", card_id, reason }
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { invalidateUsersCache } from "@/lib/auth/users-cache";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";
import { textLimitError } from "@/lib/input-limits";

// The longest text each box takes; the form boxes match.
const TEXT_CAPS = { reason: [300, "The reason"] };
import {
  CARD_ACTION_LABELS,
  CARD_STATUS_LABELS,
  ROLE_LABELS,
  describeRfidError,
  isCardUid,
  maskUid,
} from "@/lib/rfid/cards";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_READY = "RFID cards are not set up yet: apply 20261021030000_rfid_cards_terminals.sql.";

function refused(error) {
  const failure = describeRfidError(error);
  return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
}

/** Employees and Accountants the caller may register cards for (an Admin: its branch). */
async function peopleInReach(supabase, guard) {
  let query = supabase.from("profiles").select("id,full_name,email,employee_id,branch_id,role,archived,employee_status")
    .in("role", ["employee", "accountant"]);
  if (!guard.branchExempt) query = query.eq("branch_id", guard.branchId || "00000000-0000-0000-0000-000000000000");
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "rfid_devices", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const people = await peopleInReach(supabase, guard);
    const byId = new Map(people.map((p) => [p.id, p]));
    const ids = people.map((p) => p.id);
    const branches = (await supabase.from("branches").select("id,name").order("name")).data || [];
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    if (!ids.length) return NextResponse.json({ available: true, cards: [], events: [], employees: [], branches: guard.branchExempt ? branches : branches.filter((b) => b.id === guard.branchId) });

    const cards = await fetchAllIn(() => supabase.from("rfid_cards").select("*")
      .order("registered_at", { ascending: false }).order("id", { ascending: true }), "employee_id", ids);
    if (!cards.error) cards.data.sort((a, b) => String(b.registered_at || "").localeCompare(String(a.registered_at || "")));
    if (cards.error) return NextResponse.json({ available: false, error: NOT_READY, cards: [], events: [], employees: [], branches: [] });
    const events = await fetchAllIn(() => supabase.from("rfid_card_events").select("*")
      .order("created_at", { ascending: false }).order("id", { ascending: true }), "employee_id", ids);
    if (!events.error) events.data.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

    const name = (id) => byId.get(id)?.full_name || "—";
    // The branch shown is the employee's branch now (a transferred employee's
    // card follows them); the Admin sees exactly its branch's employees.
    const rows = (cards.data || []).map((c) => ({
      id: c.id,
      employee_id: c.employee_id,
      employee_name: name(c.employee_id),
      employee_code: byId.get(c.employee_id)?.employee_id || null,
      branch_id: byId.get(c.employee_id)?.branch_id || c.branch_id || null,
      branch_name: branchName.get(byId.get(c.employee_id)?.branch_id || c.branch_id) || "—",
      uid_masked: maskUid(c.uid_last4),
      uid_last4: c.uid_last4,
      status: c.status,
      status_label: CARD_STATUS_LABELS[c.status] || c.status,
      registered_by_name: c.registered_by_name,
      registered_by_role: ROLE_LABELS[c.registered_by_role] || c.registered_by_role,
      registered_at: c.registered_at,
      status_reason: c.status_reason || null,
      status_changed_by_name: c.status_changed_by_name || null,
      status_changed_by_role: c.status_changed_by_role ? ROLE_LABELS[c.status_changed_by_role] || c.status_changed_by_role : null,
      status_changed_at: c.status_changed_at || null,
      replaces_card_id: c.replaces_card_id || null,
      employee_archived: Boolean(byId.get(c.employee_id)?.archived),
    }));
    const activeFor = new Set(rows.filter((c) => c.status === "active").map((c) => c.employee_id));
    return NextResponse.json({
      available: true,
      cards: rows,
      events: (events.data || []).map((e) => ({
        id: e.id, card_id: e.card_id, employee_name: name(e.employee_id),
        branch_name: branchName.get(e.branch_id) || "—",
        action: e.action, action_label: CARD_ACTION_LABELS[e.action] || e.action,
        from_status: e.from_status ? CARD_STATUS_LABELS[e.from_status] || e.from_status : null,
        to_status: CARD_STATUS_LABELS[e.to_status] || e.to_status,
        uid_masked: maskUid(e.uid_last4), reason: e.reason || null,
        actor_name: e.actor_name, actor_role: ROLE_LABELS[e.actor_role] || e.actor_role, created_at: e.created_at,
      })),
      employees: people.filter((p) => !p.archived).map((p) => ({
        id: p.id, full_name: p.full_name, employee_code: p.employee_id || null, branch_id: p.branch_id,
        branch_name: branchName.get(p.branch_id) || "—", has_active_card: activeFor.has(p.id),
      })).sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))),
      branches: guard.branchExempt ? branches : branches.filter((b) => b.id === guard.branchId),
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
    // Over-long text is refused, not cut short (input limits).
    const tooLong = textLimitError(body, TEXT_CAPS);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
    if (normalizeText(body.action) !== "register") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    const employeeId = normalizeText(body.employee_id);
    const uid = normalizeText(body.uid);
    if (!UUID.test(employeeId)) return NextResponse.json({ error: "Choose the employee." }, { status: 400 });
    // The terminal keeps only the digits a reader types: anything else could never be matched.
    if (!isCardUid(uid)) return NextResponse.json({ error: "The RFID UID must be the card's number: exactly 10 digits." }, { status: 400 });

    const supabase = getAdminClient();
    const result = await supabase.rpc("rfid_card_register", {
      p_actor: guard.userId, p_employee: employeeId, p_uid: uid, p_reason: normalizeText(body.reason).slice(0, 300) || null,
    });
    if (result.error) return refused(result.error);
    invalidateUsersCache();
    const card = Array.isArray(result.data) ? result.data[0] : result.data;
    await appendAuditLog({
      actor: guard, module: "rfid", action: "rfid_card_registered", entity_type: "rfid_card", entity_id: card?.id || employeeId,
      branch_id: card?.branch_id || null, status: "success", source: "api",
      description: `RFID card ${maskUid(uid)} registered.`, metadata: { employee_id: employeeId, uid_last4: uid.slice(-4) },
    });
    return NextResponse.json({ success: true, card: card ? { id: card.id, status: card.status, uid_masked: maskUid(card.uid_last4) } : null });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "rfid_devices", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    // Over-long text is refused, not cut short (input limits).
    const tooLong = textLimitError(body, TEXT_CAPS);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
    const action = normalizeText(body.action);
    const cardId = normalizeText(body.card_id);
    if (!UUID.test(cardId)) return NextResponse.json({ error: "RFID card not found." }, { status: 404 });
    const reason = normalizeText(body.reason).slice(0, 300);
    const supabase = getAdminClient();

    let result;
    if (action === "replace") {
      const newUid = normalizeText(body.new_uid);
      if (!isCardUid(newUid)) return NextResponse.json({ error: "The new card's UID must be exactly 10 digits." }, { status: 400 });
      result = await supabase.rpc("rfid_card_replace", { p_actor: guard.userId, p_card: cardId, p_new_uid: newUid, p_reason: reason, p_lost: body.lost === true });
    } else if (["deactivate", "mark_lost", "reactivate"].includes(action)) {
      result = await supabase.rpc("rfid_card_set_status", { p_actor: guard.userId, p_card: cardId, p_action: action, p_reason: reason });
    } else {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    if (result.error) return refused(result.error);
    invalidateUsersCache();
    const card = Array.isArray(result.data) ? result.data[0] : result.data;
    await appendAuditLog({
      actor: guard, module: "rfid", action: `rfid_card_${action}`, entity_type: "rfid_card", entity_id: card?.id || cardId,
      branch_id: card?.branch_id || null, status: "success", source: "api",
      description: `RFID card ${action === "replace" ? "replaced" : action.replace("_", " ")}: ${reason}`, metadata: { card_id: cardId, reason },
    });
    return NextResponse.json({ success: true, card: card ? { id: card.id, status: card.status, uid_masked: maskUid(card.uid_last4) } : null });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
