/**
 * Branch announcements (public.branch_announcements, 20261020020000).
 *
 *   GET                 the caller's branch's announcements: the Admin sees
 *                       its branch's, removed ones included; an Employee or
 *                       Accountant its own branch's current ones; HR every
 *                       branch's (read only)
 *   POST  { title, body, category }                      the branch Admin
 *   PATCH { id, action: "edit", title, body, category }  the branch Admin
 *   PATCH { id, action: "remove" }                       (kept on file, hidden)
 *
 * A new announcement notifies every employee and accountant of the branch
 * (the bell). Nobody reaches another branch's announcements.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { ANNOUNCEMENT_CATEGORIES } from "@/lib/branch-requests";
import { branchEmployeeIds, notify } from "@/lib/branch-requests-server";
import { textLimitError } from "@/lib/input-limits";

// The longest text each box takes; the form boxes match.
const TEXT_CAPS = { title: [150, "The title"], body: [4000, "The message"] };

// An announcement id as stored (a UUID); anything else is simply not found.
const ANNOUNCEMENT_ID = /^[\w-]{1,64}$/;
const NOT_READY = "Announcements are not set up yet: apply 20261020020000_admin_branch_oversight.sql.";

function actorName(guard) {
  return normalizeText(guard.session?.full_name, guard.session?.email) || "Branch Admin";
}

/** The branch a caller's announcements belong to (its signed session's branch). */
function branchOf(guard) {
  return guard.branchId || null;
}

function validate(body) {
  const tooLong = textLimitError(body, TEXT_CAPS);
  if (tooLong) return { error: tooLong };
  const title = normalizeText(body.title).slice(0, 150);
  const text = normalizeText(body.body).slice(0, 4000);
  const category = ANNOUNCEMENT_CATEGORIES[body.category] ? body.category : "general";
  if (title.length < 3) return { error: "Write a title (at least 3 characters)." };
  if (text.length < 3) return { error: "Write the announcement." };
  return { title, body: text, category };
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "announcements", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    let query = supabase.from("branch_announcements").select("*");
    if (guard.role !== "hr") {
      // The Employee's "self" scope is its own branch's announcements; its
      // branch comes from its trusted profile, never the request.
      let branchId = branchOf(guard);
      if (!branchId && guard.userId) {
        const me = await supabase.from("profiles").select("branch_id").eq("id", guard.userId).maybeSingle();
        branchId = me.data?.branch_id || null;
      }
      if (!branchId) return NextResponse.json({ available: true, announcements: [] });
      query = query.eq("branch_id", branchId);
      if (guard.role !== "admin") query = query.eq("archived", false);
    }
    const result = await query.order("created_at", { ascending: false }).limit(200);
    if (result.error) return NextResponse.json({ available: false, error: NOT_READY, announcements: [] });
    return NextResponse.json({ available: true, announcements: result.data || [], can_post: guard.role === "admin" });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "announcements", "create");
    if (guard.denied) return guard.denied;
    if (guard.role !== "admin" || !branchOf(guard)) return NextResponse.json({ error: "Only the branch Admin posts announcements." }, { status: 403 });
    const input = validate(await request.json().catch(() => ({})));
    if (input.error) return NextResponse.json({ error: input.error }, { status: 400 });
    const supabase = getAdminClient();
    const branchId = branchOf(guard);
    const saved = await supabase.from("branch_announcements").insert({
      branch_id: branchId, title: input.title, body: input.body, category: input.category, archived: false,
      created_by: guard.userId, created_by_name: actorName(guard), updated_by: guard.userId, updated_by_name: actorName(guard),
    }).select("*").maybeSingle();
    if (saved.error) return NextResponse.json({ error: String(saved.error.code) === "42P01" ? NOT_READY : sanitizeError(saved.error) }, { status: 400 });
    const sent = await notify(supabase, await branchEmployeeIds(supabase, branchId), {
      kind: "branch_announcement", title: `${ANNOUNCEMENT_CATEGORIES[input.category]}: ${input.title}`, body: input.body.slice(0, 300), link_page: "emp-dash",
    });
    await appendAuditLog({
      actor: guard, module: "announcements", action: "announcement_post", entity_type: "branch_announcement", entity_id: saved.data?.id || null,
      status: "success", source: "api", description: `Announcement posted for the branch: ${input.title} (${sent} notified).`, metadata: { category: input.category },
    });
    return NextResponse.json({ success: true, announcement: saved.data, notified: sent });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "announcements", "update");
    if (guard.denied) return guard.denied;
    if (guard.role !== "admin" || !branchOf(guard)) return NextResponse.json({ error: "Only the branch Admin changes announcements." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    // Over-long text is refused, not cut short (input limits).
    const tooLong = textLimitError(body, TEXT_CAPS);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
    const id = normalizeText(body.id);
    if (!ANNOUNCEMENT_ID.test(id)) return NextResponse.json({ error: "Announcement not found." }, { status: 404 });
    const supabase = getAdminClient();
    const found = await supabase.from("branch_announcements").select("*").eq("id", id).maybeSingle();
    // Another branch's announcement does not exist, as far as this Admin can tell.
    if (!found.data || String(found.data.branch_id) !== String(branchOf(guard))) return NextResponse.json({ error: "Announcement not found." }, { status: 404 });
    const action = normalizeText(body.action);
    let patch;
    if (action === "remove") {
      patch = { archived: true, archived_at: new Date().toISOString(), updated_by: guard.userId, updated_by_name: actorName(guard) };
    } else if (action === "edit") {
      const input = validate(body);
      if (input.error) return NextResponse.json({ error: input.error }, { status: 400 });
      patch = { title: input.title, body: input.body, category: input.category, updated_by: guard.userId, updated_by_name: actorName(guard) };
    } else {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    const saved = await supabase.from("branch_announcements").update(patch).eq("id", id).select("*").maybeSingle();
    if (saved.error) return NextResponse.json({ error: sanitizeError(saved.error) }, { status: 400 });
    await appendAuditLog({
      actor: guard, module: "announcements", action: `announcement_${action}`, entity_type: "branch_announcement", entity_id: id,
      status: "success", source: "api", description: `Announcement ${action === "remove" ? "removed" : "edited"}: ${saved.data?.title || ""}.`,
    });
    return NextResponse.json({ success: true, announcement: saved.data });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
