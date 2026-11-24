/**
 * HR <-> branch Admin messages on one item (2026-11-24; table
 * branch_item_messages, 20261124160000). Information only, never a decision.
 *
 *   GET  ?item_type=&item_id=            the thread, oldest first
 *   GET  ?item_type=&ids=a,b,c           message counts per item (for the list's buttons)
 *   POST { item_type, item_id, body }    add a message (HR, the Super Admin, or the Admin of the item's branch)
 *
 * The item's branch is read on the server from the item itself: an Admin
 * reaches only their own branch's items; HR and the Super Admin every branch.
 * The other side is notified; every message is in the audit log.
 * Mapped to branch_oversight in src/proxy.js.
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { notify } from "@/lib/branch-requests-server";

const ROLES = new Set(["hr", "admin", "super_admin"]);
const BODY_MAX = 1000;
// Each item type: its table, how its branch is found, and the page each side opens.
const ITEMS = {
  leave_request: { table: "leave_requests", branch: "branch_id", hr: "hr-leaves", admin: "adm-leaves", label: "leave request" },
  overtime_request: { table: "overtime_requests", branch: "branch_id", hr: "hr-leaves", admin: "adm-overtime", label: "overtime request" },
  attendance_correction: { table: "attendance_corrections", branch: "branch_id", hr: "hr-leaves", admin: "adm-attendance", label: "attendance correction" },
  substitution: { table: "substitutions", branch: "branch_id", hr: "hr-leaves", admin: "adm-overtime", label: "substitution" },
  transfer_request: { table: "transfer_requests", branch: ["from_branch_id", "to_branch_id"], hr: "hr-transfers", admin: "adm-transfers", label: "transfer" },
  branch_admin_request: { table: "branch_admin_requests", branch: "branch_id", hr: "hr-branch-requests", admin: "adm-incidents", label: "branch report" },
  automation_action: { table: "automation_actions", branch: "branch_id", hr: "hr-automation", admin: "adm-attendance", label: "system item" },
  awol_case: { table: "employee_awol_cases", branch: "branch_id", hr: "hr-awol", admin: "adm-incidents", label: "AWOL case" },
};
const ID = /^[0-9a-f-]{36}$/i;

/** The item's branch ids (a transfer has two), or null when the item is not found. */
async function branchesOf(supabase, type, id) {
  const spec = ITEMS[type];
  const cols = Array.isArray(spec.branch) ? spec.branch : [spec.branch];
  const { data } = await supabase.from(spec.table).select(cols.join(",")).eq("id", id).maybeSingle();
  if (!data) return null;
  return cols.map((c) => data[c]).filter(Boolean).map(String);
}

function denied(guard, branches) {
  if (guard.role !== "admin") return false;
  return !guard.branchId || !branches.includes(String(guard.branchId));
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "read");
    if (guard.denied) return guard.denied;
    if (!ROLES.has(guard.role)) return NextResponse.json({ error: "Messages are between HR and the branch Admin." }, { status: 403 });
    const url = new URL(request.url);
    const type = url.searchParams.get("item_type") || "";
    if (!ITEMS[type]) return NextResponse.json({ error: "Unknown item." }, { status: 400 });
    const supabase = getServiceClient();
    const ids = (url.searchParams.get("ids") || "").split(",").filter((x) => ID.test(x)).slice(0, 500);
    // Counts asked for items with no thread-able id (an older text id): none, not an error (2026-11-25).
    if (url.searchParams.has("ids") && !ids.length) return NextResponse.json({ counts: {} });
    if (ids.length) {
      // Counts only; an Admin's counts are limited to their branch's messages.
      let q = supabase.from("branch_item_messages").select("item_id,branch_id").eq("item_type", type).in("item_id", ids);
      if (guard.role === "admin") q = q.eq("branch_id", guard.branchId);
      const { data, error } = await q;
      if (error) throw error;
      const counts = {};
      for (const r of data || []) counts[r.item_id] = (counts[r.item_id] || 0) + 1;
      return NextResponse.json({ counts });
    }
    const id = url.searchParams.get("item_id") || "";
    if (!ID.test(id)) return NextResponse.json({ error: "Choose an item." }, { status: 400 });
    const branches = await branchesOf(supabase, type, id);
    if (!branches || denied(guard, branches)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const { data, error } = await supabase.from("branch_item_messages").select("id,author_name,author_role,body,created_at")
      .eq("item_type", type).eq("item_id", id).order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ messages: data || [] });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    // A message is information, not a change to the item: read access to branch oversight is enough.
    const guard = await requirePermission(request, "branch_oversight", "read");
    if (guard.denied) return guard.denied;
    if (!ROLES.has(guard.role)) return NextResponse.json({ error: "Messages are between HR and the branch Admin." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    if (Array.isArray(body.items)) return await postMany(guard, body);
    const type = String(body.item_type || "");
    const id = String(body.item_id || "");
    const text = String(body.body || "").trim().replace(/\s+\n/g, "\n");
    if (!ITEMS[type] || !ID.test(id)) return NextResponse.json({ error: "Choose an item." }, { status: 400 });
    if (text.length < 1) return NextResponse.json({ error: "Write the message." }, { status: 400 });
    if (text.length > BODY_MAX) return NextResponse.json({ error: `The message is too long (${BODY_MAX} characters at most).` }, { status: 400 });
    const supabase = getServiceClient();
    const branches = await branchesOf(supabase, type, id);
    if (!branches || denied(guard, branches)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const branchId = guard.role === "admin" ? String(guard.branchId) : branches[0] || null;
    const name = guard.session?.full_name || guard.session?.email || guard.role;
    const { data, error } = await supabase.from("branch_item_messages").insert({
      item_type: type, item_id: id, branch_id: branchId, author_id: guard.userId, author_name: name, author_role: guard.role, body: text,
    }).select("id,author_name,author_role,body,created_at").single();
    if (error) throw error;
    // The other side is told: the item's branch Admin(s) when HR writes; HR when the Admin writes.
    const spec = ITEMS[type];
    let recipients = [];
    if (guard.role === "admin") {
      const { data: hr } = await supabase.from("profiles").select("id").eq("role", "hr").eq("archived", false);
      recipients = (hr || []).map((h) => h.id);
    } else if (branches.length) {
      const { data: admins } = await supabase.from("profiles").select("id").eq("role", "admin").eq("archived", false).in("branch_id", branches);
      recipients = (admins || []).map((a) => a.id);
    }
    await notify(supabase, recipients.filter((r) => String(r) !== String(guard.userId)), {
      kind: "branch_message", title: `Message on a ${spec.label}`, body: `${name}: ${text.slice(0, 200)}`,
      link_page: guard.role === "admin" ? spec.hr : spec.admin,
    }).catch(() => 0);
    await appendAuditLog({ actor: guard, module: "branch_oversight", action: "branch_message", entity_type: type, entity_id: id, branch_id: branchId,
      description: `Message on a ${spec.label} by ${name}: ${text.slice(0, 300)}`, metadata: { message_id: data.id } });
    return NextResponse.json({ message: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

/**
 * 2026-11-26: the branch Admin sends ONE message to HR about several items (Branch Review, "select all"):
 * POST { items: [{ item_type, item_id }], body }. Information only (no decision): the message goes into
 * each item's HR <-> Admin thread; every item is checked first (own branch) and none is saved if one is
 * refused; HR is told once.
 */
const MANY_MAX = 50;
async function postMany(guard, body) {
  if (guard.role !== "admin") return NextResponse.json({ error: "Only the branch Admin sends one message about several items." }, { status: 403 });
  const text = String(body.body || "").trim().replace(/\s+\n/g, "\n");
  const seen = new Set();
  const items = body.items.map((i) => ({ type: String(i?.item_type || ""), id: String(i?.item_id || "") }))
    .filter((i) => { const k = `${i.type}:${i.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!items.length) return NextResponse.json({ error: "Select at least one item." }, { status: 400 });
  if (items.length > MANY_MAX) return NextResponse.json({ error: `Select at most ${MANY_MAX} items.` }, { status: 400 });
  if (items.some((i) => !ITEMS[i.type] || !ID.test(i.id))) return NextResponse.json({ error: "Choose an item." }, { status: 400 });
  if (text.length < 1) return NextResponse.json({ error: "Write the message." }, { status: 400 });
  if (text.length > BODY_MAX) return NextResponse.json({ error: `The message is too long (${BODY_MAX} characters at most).` }, { status: 400 });
  const supabase = getServiceClient();
  for (const i of items) {
    const branches = await branchesOf(supabase, i.type, i.id);
    if (!branches || denied(guard, branches)) return NextResponse.json({ error: "One of the selected items is not found or not your branch's. Nothing was sent." }, { status: 404 });
  }
  const branchId = String(guard.branchId);
  const name = guard.session?.full_name || guard.session?.email || guard.role;
  const { data, error } = await supabase.from("branch_item_messages").insert(items.map((i) => ({
    item_type: i.type, item_id: i.id, branch_id: branchId, author_id: guard.userId, author_name: name, author_role: guard.role, body: text,
  }))).select("id,item_type,item_id");
  if (error) throw error;
  const { data: hr } = await supabase.from("profiles").select("id").eq("role", "hr").eq("archived", false);
  await notify(supabase, (hr || []).map((h) => h.id).filter((r) => String(r) !== String(guard.userId)), {
    kind: "branch_message", title: `Message on ${items.length} item${items.length === 1 ? "" : "s"}`, body: `${name}: ${text.slice(0, 200)}`,
    link_page: ITEMS[items[0].type].hr,
  }).catch(() => 0);
  for (const row of data || []) {
    await appendAuditLog({ actor: guard, module: "branch_oversight", action: "branch_message", entity_type: row.item_type, entity_id: row.item_id, branch_id: branchId,
      description: `Message on a ${ITEMS[row.item_type].label} by ${name} (one message about ${items.length} items): ${text.slice(0, 300)}`, metadata: { message_id: row.id, items: items.length } });
  }
  return NextResponse.json({ sent: (data || []).length }, { status: 201 });
}
