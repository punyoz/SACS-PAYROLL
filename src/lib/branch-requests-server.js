/**
 * Server side of branch oversight (src/lib/branch-requests.js): the branch's
 * staff (never salaries), and the notifications that tell HR when a branch
 * Admin sends something and the Admin when it is decided.
 */

import { normalizeText } from "@/lib/auth/normalize";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The branch's employees and accountants: names, codes and types only. */
export async function loadBranchStaff(supabase, branchId, { includeArchived = false } = {}) {
  if (!branchId) return [];
  let query = supabase.from("profiles")
    .select("id,full_name,email,employee_id,employee_type,position,employee_status,role,branch_id,archived,date_hired")
    .eq("branch_id", branchId)
    .in("role", ["employee", "accountant"]);
  if (!includeArchived) query = query.eq("archived", false);
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return (result.data || [])
    .map((p) => ({
      id: p.id,
      full_name: normalizeText(p.full_name, p.email || "Employee"),
      employee_code: p.employee_id || "",
      employee_type: p.employee_type || "Teaching",
      position: p.position || "",
      employee_status: p.employee_status || "Active",
      role: String(p.role || "employee"),
      archived: Boolean(p.archived),
      date_hired: p.date_hired || null,
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/** Stored notifications (the bell). Never fails the action that sent them. */
export async function notify(supabase, recipientIds, { kind, title, body = null, link_page = null }) {
  const ids = [...new Set((recipientIds || []).filter((id) => UUID.test(String(id || ""))))];
  if (!ids.length) return 0;
  const result = await supabase.from("notifications").insert(ids.map((recipient_id) => ({
    recipient_id, kind, title: String(title).slice(0, 200), body: body ? String(body).slice(0, 1000) : null, link_page,
  })));
  return result.error ? 0 : ids.length;
}

async function idsOf(supabase, query) {
  const result = await query;
  return result.error ? [] : (result.data || []).map((row) => row.id);
}

export function hrAccountIds(supabase) {
  return idsOf(supabase, supabase.from("profiles").select("id").eq("role", "hr").eq("archived", false));
}

export function superAdminIds(supabase) {
  return idsOf(supabase, supabase.from("profiles").select("id").eq("role", "super_admin").eq("archived", false));
}

/** Everyone an announcement reaches: the branch's active employees and accountants. */
export function branchEmployeeIds(supabase, branchId) {
  if (!branchId) return Promise.resolve([]);
  return idsOf(supabase, supabase.from("profiles").select("id").eq("branch_id", branchId)
    .in("role", ["employee", "accountant"]).eq("archived", false));
}

/**
 * Tell the Admins who endorsed a record (a leave or a transfer) what HR
 * decided. Used by the HR leave and transfer routes.
 */
export async function notifyEndorsers(supabase, kind, refId, { title, body }) {
  if (!refId) return 0;
  const result = await supabase.from("branch_admin_requests").select("created_by").eq("kind", kind).eq("ref_id", String(refId));
  if (result.error) return 0;
  return notify(supabase, (result.data || []).map((r) => r.created_by), {
    kind: `${kind}_decided`, title, body,
    link_page: kind === "leave_endorsement" ? "adm-leaves" : "adm-transfers",
  });
}

/** The endorsements of some records, by record id (HR's leave and transfer screens). */
export async function endorsementsFor(supabase, kind, refIds) {
  const ids = [...new Set((refIds || []).map(String).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const result = await supabase.from("branch_admin_requests")
    .select("id,ref_id,branch_id,status,admin_note,created_by_name,created_at,updated_at,history")
    .eq("kind", kind).in("ref_id", ids);
  if (result.error) return out;
  (result.data || []).forEach((row) => {
    const list = out.get(row.ref_id) || [];
    list.push(row);
    out.set(row.ref_id, list);
  });
  return out;
}
