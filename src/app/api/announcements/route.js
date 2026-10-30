/**
 * Announcements (public.branch_announcements; 20261020020000, audiences and
 * HR / Admin management 20261030010000).
 *
 *   GET                  what the caller should see now: school-wide ones plus
 *                        its own branch's, current (not deleted, not expired).
 *                        HR and the Super Admin see every branch's.
 *   GET ?manage=1        the management list (HR, Admin, Super Admin): deleted
 *                        and expired ones too, with what the caller may do to each
 *   POST  { title, body, category, audience, expires_on? }
 *                        HR: audience "all" (whole school) or a branch id.
 *                        Admin: its own branch only (the database refuses anything else).
 *   PATCH { id, action: "edit", title, body, category, expires_on?, audience? }
 *                        the author (an Admin, in its branch) or HR; only HR
 *                        changes the audience
 *   DELETE { id }        the author (an Admin, in its branch), HR, or the Super
 *                        Admin (moderation). Kept on file, hidden from everyone.
 *   PATCH { id, action: "remove" }   the same delete, as the Admin's page sent it
 *
 * Every write goes through announcement_post / _edit / _remove, which check
 * the acting user in the database. A new announcement notifies the people
 * it is for (the bell); no email.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { ANNOUNCEMENT_CATEGORIES } from "@/lib/branch-requests";
import { notify } from "@/lib/branch-requests-server";
import { ANNOUNCEMENT_MESSAGE_MAX, ANNOUNCEMENT_TITLE_MAX, textLimitError } from "@/lib/input-limits";
import { isDateKey, manilaDateKey } from "@/lib/payroll/periods";

// The longest text each box takes; the form boxes and the database match.
const TEXT_CAPS = { title: [ANNOUNCEMENT_TITLE_MAX, "The title"], body: [ANNOUNCEMENT_MESSAGE_MAX, "The message"] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_READY = "Announcements are not set up yet: apply 20261030010000_announcements_hr_admin.sql.";
const SCHOOL_WIDE = "Whole school";

// Each role's own Announcements page, for the notification bell.
const PAGE_FOR_ROLE = { employee: "emp-announcements", accountant: "ac-announcements", admin: "adm-announcements", hr: "hr-announcements" };

function actorName(guard) {
  return normalizeText(guard.session?.full_name, guard.session?.email) || "Staff";
}

/** The caller's branch: its signed session's, else its trusted profile's (never the request). */
async function branchOf(supabase, guard) {
  if (guard.branchId) return guard.branchId;
  if (!guard.userId) return null;
  const me = await supabase.from("profiles").select("branch_id").eq("id", guard.userId).maybeSingle();
  return me.data?.branch_id || null;
}

function validate(body) {
  const tooLong = textLimitError(body, TEXT_CAPS);
  if (tooLong) return { error: tooLong };
  const title = normalizeText(body.title);
  const text = normalizeText(body.body);
  if (!title) return { error: "Write a title." };
  if (!text) return { error: "Write the message." };
  const category = ANNOUNCEMENT_CATEGORIES[body.category] ? body.category : "general";
  const expires = normalizeText(body.expires_on);
  if (expires && !isDateKey(expires)) return { error: "Choose a valid expiry date." };
  if (expires && expires < manilaDateKey()) return { error: "The expiry date cannot be in the past." };
  return { title, body: text, category, expires_on: expires || null };
}

/** A database refusal (announcement_post / _edit / _remove) as an API answer. */
function refused(error) {
  const text = String(error?.message || error || "");
  const [code] = /^[a-z_]+(?=:)/.exec(text) || [];
  const message = text.replace(/^[a-z_]+:\s*/, "") || "Not saved.";
  if (String(error?.code) === "42P01" || String(error?.code) === "42883") return NextResponse.json({ error: NOT_READY }, { status: 503 });
  const status = code?.startsWith("forbidden") ? 403 : code === "not_found" ? 404 : code?.startsWith("invalid") ? 400 : 400;
  return NextResponse.json({ error: message, code: code || "refused" }, { status });
}

/** What the caller may do to one announcement (the database decides; this is what the screen offers). */
function rightsFor(guard, row, branchId) {
  if (row.archived) return { can_edit: false, can_delete: false };
  const mine = row.created_by && row.created_by === guard.userId;
  if (guard.role === "hr") return { can_edit: true, can_delete: true };
  if (guard.role === "super_admin") return { can_edit: false, can_delete: true };
  if (guard.role === "admin") {
    const own = Boolean(mine && branchId && String(row.branch_id || "") === String(branchId));
    return { can_edit: own, can_delete: own };
  }
  return { can_edit: false, can_delete: false };
}

function shape(guard, row, branchId, branchNames, today) {
  const expired = Boolean(row.expires_on && String(row.expires_on).slice(0, 10) < today);
  return {
    ...row,
    expires_on: row.expires_on ? String(row.expires_on).slice(0, 10) : null,
    audience: row.branch_id ? "branch" : "all",
    audience_label: row.branch_id ? branchNames.get(String(row.branch_id)) || "A branch" : SCHOOL_WIDE,
    status: row.archived ? "deleted" : expired ? "expired" : "active",
    ...rightsFor(guard, row, branchId),
  };
}

/** Who an announcement is for: the branch's (or every branch's) active staff, but not its author. */
async function recipientsByRole(supabase, branchId, authorId) {
  let query = supabase.from("profiles").select("id,role").in("role", ["employee", "accountant", "admin", "hr"]).eq("archived", false);
  if (branchId) query = query.eq("branch_id", branchId).in("role", ["employee", "accountant", "admin"]);
  const result = await query;
  const byRole = new Map();
  (result.error ? [] : result.data || []).forEach((p) => {
    if (p.id === authorId) return;
    const role = String(p.role || "").toLowerCase();
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(p.id);
  });
  return byRole;
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "announcements", "read");
    if (guard.denied) return guard.denied;
    const url = new URL(request.url);
    const supabase = getAdminClient();
    const everyBranch = guard.role === "hr" || guard.role === "super_admin";
    const manage = url.searchParams.get("manage") === "1" && ["hr", "admin", "super_admin"].includes(guard.role);
    const branchId = everyBranch ? null : await branchOf(supabase, guard);
    const today = manilaDateKey();

    let query = supabase.from("branch_announcements").select("*");
    if (!everyBranch) {
      // School-wide ones and the caller's own branch's; never another branch's.
      query = branchId ? query.or(`branch_id.is.null,branch_id.eq.${branchId}`) : query.is("branch_id", null);
    }
    if (!manage) query = query.eq("archived", false);
    const [result, branches] = await Promise.all([
      query.order("created_at", { ascending: false }).limit(300),
      supabase.from("branches").select("id,name,status").order("name", { ascending: true }),
    ]);
    if (result.error) return NextResponse.json({ available: false, error: NOT_READY, announcements: [] });
    const branchNames = new Map((branches.data || []).map((b) => [String(b.id), b.name]));
    let rows = (result.data || []).map((row) => shape(guard, row, branchId, branchNames, today));
    // The normal view: current ones only (an expired one disappears on its own).
    if (!manage) rows = rows.filter((row) => row.status === "active");
    // An Admin manages its branch's; the school-wide ones are listed read only.
    const canPost = guard.role === "hr" || (guard.role === "admin" && Boolean(branchId));
    return NextResponse.json({
      available: true,
      announcements: rows,
      can_post: canPost,
      // HR chooses the audience; an Admin's is fixed to its branch.
      audiences: guard.role === "hr"
        ? [{ value: "all", label: SCHOOL_WIDE }, ...(branches.data || []).filter((b) => String(b.status || "active").toLowerCase() !== "closed").map((b) => ({ value: b.id, label: b.name }))]
        : null,
      fixed_audience: guard.role === "admin" && branchId ? { value: branchId, label: branchNames.get(String(branchId)) || "Your branch" } : null,
      limits: { title: ANNOUNCEMENT_TITLE_MAX, message: ANNOUNCEMENT_MESSAGE_MAX },
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "announcements", "create");
    if (guard.denied) return guard.denied;
    if (!["hr", "admin"].includes(guard.role)) return NextResponse.json({ error: "Only HR and the branch Admin post announcements." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const input = validate(body);
    if (input.error) return NextResponse.json({ error: input.error }, { status: 400 });
    const supabase = getAdminClient();
    const own = guard.role === "admin" ? await branchOf(supabase, guard) : null;
    const audience = normalizeText(body.audience);
    if (guard.role === "hr" && !audience) return NextResponse.json({ error: "Choose who the announcement is for." }, { status: 400 });
    if (audience && audience !== "all" && !UUID.test(audience)) return NextResponse.json({ error: "Choose who the announcement is for." }, { status: 400 });
    // The database decides: an Admin asking for "all" or another branch is refused there.
    const target = audience === "all" ? null : audience || own;
    const saved = await supabase.rpc("announcement_post", {
      p_actor: guard.userId, p_branch: target, p_title: input.title, p_body: input.body, p_category: input.category, p_expires_on: input.expires_on,
    });
    if (saved.error) return refused(saved.error);
    const row = Array.isArray(saved.data) ? saved.data[0] : saved.data;
    const category = ANNOUNCEMENT_CATEGORIES[input.category];
    let sent = 0;
    for (const [role, ids] of await recipientsByRole(supabase, target, guard.userId)) {
      sent += await notify(supabase, ids, { kind: "branch_announcement", title: `${category}: ${input.title}`, body: input.body.slice(0, 300), link_page: PAGE_FOR_ROLE[role] || null });
    }
    await appendAuditLog({
      actor: guard, module: "announcements", action: "announcement_post", entity_type: "branch_announcement", entity_id: row?.id || null,
      status: "success", source: "api", branch_id: target,
      description: `Announcement posted for ${target ? "a branch" : "the whole school"}: ${input.title} (${sent} notified).`,
      metadata: { category: input.category, audience: target || "all", expires_on: input.expires_on },
    });
    return NextResponse.json({ success: true, announcement: row, notified: sent });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

/** Delete (archive) through the database's checks. */
async function removeAnnouncement(supabase, guard, id) {
  const saved = await supabase.rpc("announcement_remove", { p_actor: guard.userId, p_id: id });
  if (saved.error) return refused(saved.error);
  const row = Array.isArray(saved.data) ? saved.data[0] : saved.data;
  await appendAuditLog({
    actor: guard, module: "announcements", action: "announcement_remove", entity_type: "branch_announcement", entity_id: id,
    status: "success", source: "api", branch_id: row?.branch_id || null,
    description: `Announcement deleted${guard.role === "super_admin" ? " (moderation)" : ""}: ${row?.title || ""}.`,
    metadata: { audience: row?.branch_id || "all", author: row?.created_by_name || null },
  });
  return NextResponse.json({ success: true, announcement: row });
}

/** An Admin never learns that another branch's announcement exists. */
async function hiddenFromAdmin(supabase, guard, id) {
  if (guard.role !== "admin") return false;
  const [found, branchId] = await Promise.all([
    supabase.from("branch_announcements").select("branch_id").eq("id", id).maybeSingle(),
    branchOf(supabase, guard),
  ]);
  if (!found.data) return true;
  return Boolean(found.data.branch_id) && String(found.data.branch_id) !== String(branchId || "");
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "announcements", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const id = normalizeText(body.id);
    if (!UUID.test(id)) return NextResponse.json({ error: "Announcement not found." }, { status: 404 });
    const supabase = getAdminClient();
    if (await hiddenFromAdmin(supabase, guard, id)) return NextResponse.json({ error: "Announcement not found." }, { status: 404 });
    const action = normalizeText(body.action);
    if (action === "remove") return await removeAnnouncement(supabase, guard, id);
    if (action !== "edit") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    const input = validate(body);
    if (input.error) return NextResponse.json({ error: input.error }, { status: 400 });
    const audience = normalizeText(body.audience);
    if (audience && audience !== "all" && !UUID.test(audience)) return NextResponse.json({ error: "Choose who the announcement is for." }, { status: 400 });
    const saved = await supabase.rpc("announcement_edit", {
      p_actor: guard.userId, p_id: id, p_title: input.title, p_body: input.body, p_category: input.category, p_expires_on: input.expires_on,
      // Only HR changes the audience; the database ignores it for anyone else.
      p_set_audience: guard.role === "hr" && Boolean(audience), p_branch: audience && audience !== "all" ? audience : null,
    });
    if (saved.error) return refused(saved.error);
    const row = Array.isArray(saved.data) ? saved.data[0] : saved.data;
    await appendAuditLog({
      actor: guard, module: "announcements", action: "announcement_edit", entity_type: "branch_announcement", entity_id: id,
      status: "success", source: "api", branch_id: row?.branch_id || null,
      description: `Announcement edited: ${row?.title || ""}.`,
      metadata: { audience: row?.branch_id || "all", expires_on: row?.expires_on || null },
    });
    return NextResponse.json({ success: true, announcement: row });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const guard = await requirePermission(request, "announcements", "delete");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const id = normalizeText(body.id || new URL(request.url).searchParams.get("id"));
    if (!UUID.test(id)) return NextResponse.json({ error: "Announcement not found." }, { status: 404 });
    const supabase = getAdminClient();
    if (await hiddenFromAdmin(supabase, guard, id)) return NextResponse.json({ error: "Announcement not found." }, { status: 404 });
    return await removeAnnouncement(supabase, guard, id);
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
