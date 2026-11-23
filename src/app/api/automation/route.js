/**
 * Automation (Batch 3, Part E step 1; 20261124010000_automation_framework.sql).
 *
 *   GET    ?status=&module=&limit=  the automatic actions in scope (Admin: own
 *          branch; HR / Super Admin: all), the counts, and whether it is paused.
 *   PATCH  { id, action: "note", note }        Admin: a note; sends it to HR now
 *          { id, action: "object", remark }   Admin: objects (preset); to HR now
 *          { id, action: "undo", remark }     HR: undoes an applied action (preset reason)
 *   POST   { action: "pause", paused }         HR / Super Admin: Pause / Resume automation
 *
 * HR approvals stay manual: this route never approves anything. A module that
 * can undo its own applied actions registers it in src/lib/automation/undo.js.
 */
import { NextResponse } from "next/server";
import { requirePermission, denyForeignBranch } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { sanitizeError } from "@/lib/api-error";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { appendAuditLog } from "@/lib/audit/store";
import { remarkClient, resolveRemark } from "@/lib/remarks/presets";
import { notify } from "@/lib/branch-requests-server";
import { undoAutomation } from "@/lib/automation/undo";
import { AUTOMATION_STATUSES, NOTE_MIN, NOTE_MAX, summarizeAutomation } from "@/lib/automation/shared";

const ROLES = new Set(["admin", "hr", "super_admin"]);
const SELECT = "id,module,rule,kind,status,summary,data,reason,entity_type,entity_id,employee_id,branch_id,effective_on,admin_due_on,admin_note,admin_noted_by_name,admin_noted_at,admin_objected,forwarded_at,forwarded_by,escalated_at,undone_at,undone_by_name,undo_reason,closed_at,closed_note,created_at";

const nameOf = (guard) => guard.session?.full_name || guard.session?.email || guard.role;

async function pausedNow(supabase) {
  const { data } = await supabase.from("system_config").select("value").eq("section", "automation").eq("key", "paused").maybeSingle();
  return String(data?.value ?? "true") !== "false";
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "read");
    if (guard.denied) return guard.denied;
    if (!ROLES.has(guard.role)) return NextResponse.json({ error: "Automation is for the branch Admin and HR." }, { status: 403 });
    const supabase = getServiceClient();
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || "";
    const moduleName = url.searchParams.get("module") || "";
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
    let q = supabase.from("automation_actions").select(SELECT).order("created_at", { ascending: false }).limit(limit);
    // The branch Admin sees their own branch only (server-side).
    if (guard.role === "admin") q = q.eq("branch_id", guard.branchId);
    if (status && AUTOMATION_STATUSES.includes(status)) q = q.eq("status", status);
    if (/^[a-z_]{3,40}$/.test(moduleName)) q = q.eq("module", moduleName);
    const { data, error } = await q;
    if (error) throw error;
    const rows = data || [];
    const ids = [...new Set(rows.map((r) => r.employee_id).filter(Boolean))];
    const { data: people } = await fetchAllIn(() => supabase.from("profiles").select("id,full_name").order("id"), "id", ids);
    const names = new Map((people || []).map((p) => [p.id, p.full_name]));
    const actions = rows.map((r) => ({ ...r, employee_name: names.get(r.employee_id) || null }));
    return NextResponse.json({ actions, counts: summarizeAutomation(actions, guard.role), paused: await pausedNow(supabase), role: guard.role });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const action = String(body.action || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Choose an item." }, { status: 400 });
    const supabase = getServiceClient();
    const { data: row, error } = await supabase.from("automation_actions").select(SELECT).eq("id", id).maybeSingle();
    if (error) throw error;
    if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const now = new Date().toISOString();
    const by = nameOf(guard);

    if (action === "note" || action === "object") {
      if (guard.role !== "admin") return NextResponse.json({ error: "The branch Admin checks what the system prepared." }, { status: 403 });
      const foreign = denyForeignBranch(guard, row.branch_id);
      if (foreign) return foreign;
      if (row.status !== "admin_check") return NextResponse.json({ error: "This item is no longer waiting for your check." }, { status: 409 });
      let note = String(body.note || "").trim();
      let decider = supabase;
      if (action === "note") {
        if (note.length < NOTE_MIN || note.length > NOTE_MAX) return NextResponse.json({ error: `Write a note of ${NOTE_MIN} to ${NOTE_MAX} characters.` }, { status: 400 });
      } else {
        const remark = await resolveRemark(supabase, body.remark, { decision: "object", entityType: "automation_action", fallbackText: body.note });
        if (remark.error) return NextResponse.json({ error: remark.error, code: "remark_invalid" }, { status: 400 });
        note = remark.text;
        decider = remarkClient(remark, { decision: "object", entityType: "automation_action", module: row.module, table: "automation_actions", ids: [id], actor: guard });
      }
      const { error: upd } = await decider.from("automation_actions").update({
        status: "with_hr", admin_note: note, admin_noted_by: guard.userId, admin_noted_by_name: by, admin_noted_at: now,
        admin_objected: action === "object", forwarded_at: now, forwarded_by: by, updated_at: now,
      }).eq("id", id).eq("status", "admin_check");
      if (upd) throw upd;
      const { data: hr } = await supabase.from("profiles").select("id").eq("role", "hr").eq("archived", false);
      await notify(supabase, (hr || []).map((h) => h.id), {
        kind: action === "object" ? "automation_objected" : "automation_noted",
        title: action === "object" ? "The branch Admin objected" : "Checked by the branch Admin",
        body: `${row.summary} · ${by}: ${note}`, link_page: "hr-dashboard",
      }).catch(() => 0);
      await appendAuditLog({ actor: guard, module: row.module, action: `automation_${action}`, entity_type: "automation_action", entity_id: id, branch_id: row.branch_id,
        description: `${action === "object" ? "Objected" : "Noted"}: ${row.summary}`, metadata: { note, rule: row.rule } });
      return NextResponse.json({ success: true });
    }

    if (action === "undo") {
      if (guard.role !== "hr") return NextResponse.json({ error: "HR undoes an automatic action." }, { status: 403 });
      if (row.kind !== "applied" || row.status !== "done") return NextResponse.json({ error: "Only an applied action that is not undone yet can be undone." }, { status: 409 });
      const remark = await resolveRemark(supabase, body.remark, { decision: "revoke", entityType: "automation_action", fallbackText: body.note });
      if (remark.error) return NextResponse.json({ error: remark.error, code: "remark_invalid" }, { status: 400 });
      const undone = await undoAutomation(supabase, row, { actor: guard });
      if (undone.error) return NextResponse.json({ error: undone.error }, { status: undone.status || 409 });
      const decider = remarkClient(remark, { decision: "revoke", entityType: "automation_action", module: row.module, table: "automation_actions", ids: [id], actor: guard });
      const { error: upd } = await decider.from("automation_actions").update({
        status: "undone", undone_at: now, undone_by: guard.userId, undone_by_name: by, undo_reason: remark.text, updated_at: now,
      }).eq("id", id).eq("status", "done");
      if (upd) throw upd;
      await appendAuditLog({ actor: guard, module: row.module, action: "automation_undo", entity_type: "automation_action", entity_id: id, branch_id: row.branch_id,
        description: `Undone: ${row.summary} (${remark.text})`, metadata: { rule: row.rule, reason: remark.text, reverted: undone.reverted || null } });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    if (body.action !== "pause") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    if (guard.role !== "hr" && guard.role !== "super_admin") return NextResponse.json({ error: "HR or the Super Admin pauses automation." }, { status: 403 });
    if (typeof body.paused !== "boolean") return NextResponse.json({ error: "Say whether to pause or resume." }, { status: 400 });
    const supabase = getServiceClient();
    const by = nameOf(guard);
    const { error } = await supabase.from("system_config").update({ value: body.paused ? "true" : "false", updated_by: by })
      .eq("section", "automation").eq("key", "paused");
    if (error) throw error;
    await appendAuditLog({ actor: guard, module: "automation", action: body.paused ? "automation_pause" : "automation_resume", entity_type: "system_config", entity_id: "automation.paused",
      description: body.paused ? "Automation paused." : "Automation resumed.", metadata: { paused: body.paused } });
    return NextResponse.json({ success: true, paused: body.paused });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
