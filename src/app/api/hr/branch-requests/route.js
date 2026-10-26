/**
 * HR's side of branch oversight (20261020020000): what the branch Admins sent,
 * and HR's decisions. The Super Admin reaches RFID issues only.
 *
 *   GET [?kind=a,b][&status=pending|decided|all][&branch_id]
 *   PATCH { id, decision: approve | reject | resolve, note }
 *     attendance_flag / incident_report / rfid_issue   resolve
 *     schedule_request                                 approve | reject
 *     incentive_endorsement                            approve (files the
 *       incentive / overload item for payroll, counted by the date HR
 *       approves it: after the month's cutoff it moves to next month) | reject
 *   Endorsements (leave, transfer, overtime) are not decided here: HR decides
 *   the leave or transfer itself on its own page; the Accountant reads the
 *   overtime confirmations.
 * Every decision is added to the request's history, and the Admin who sent it
 * is notified.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { DECISION_STATUS, REQUEST_KINDS, STATUS_LABELS, historyEntry, shapeRequest } from "@/lib/branch-requests";
import { notify } from "@/lib/branch-requests-server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A request id as stored (a UUID); anything else is simply not found.
const REQUEST_ID = /^[\w-]{1,64}$/;
const NOT_READY = "Branch oversight is not set up yet: apply 20261020020000_admin_branch_oversight.sql.";

function allowedKinds(role) {
  if (role === "hr") return Object.keys(REQUEST_KINDS);
  if (role === "super_admin") return ["rfid_issue"];
  return [];
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "read");
    if (guard.denied) return guard.denied;
    const allowed = allowedKinds(guard.role);
    if (!allowed.length) return NextResponse.json({ error: "You do not have permission to perform this action." }, { status: 403 });
    const url = new URL(request.url);
    const wanted = normalizeText(url.searchParams.get("kind")).split(",").map((k) => k.trim()).filter((k) => allowed.includes(k));
    const status = normalizeText(url.searchParams.get("status")).toLowerCase() || "all";
    const branchId = normalizeText(url.searchParams.get("branch_id"));
    const supabase = getAdminClient();
    let query = supabase.from("branch_admin_requests").select("*").in("kind", wanted.length ? wanted : allowed);
    if (status === "pending") query = query.eq("status", "pending");
    if (status === "decided") query = query.neq("status", "pending");
    if (UUID.test(branchId)) query = query.eq("branch_id", branchId);
    const result = await query.order("created_at", { ascending: false }).limit(2000);
    if (result.error) return NextResponse.json({ available: false, error: NOT_READY, requests: [] });
    const branches = await supabase.from("branches").select("id,name");
    const branchName = new Map((branches.data || []).map((b) => [String(b.id), b.name]));
    return NextResponse.json({
      available: true,
      requests: (result.data || []).map((r) => ({ ...shapeRequest(r), branch_name: branchName.get(String(r.branch_id)) || "—" })),
      branches: branches.data || [],
      can_decide: true,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "update");
    if (guard.denied) return guard.denied;
    const allowed = allowedKinds(guard.role);
    if (!allowed.length) return NextResponse.json({ error: "Only HR decides what the branch Admins send." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const id = normalizeText(body.id);
    const decision = normalizeText(body.decision);
    const note = normalizeText(body.note).slice(0, 1000);
    if (!REQUEST_ID.test(id)) return NextResponse.json({ error: "Request not found." }, { status: 404 });
    const supabase = getAdminClient();
    const found = await supabase.from("branch_admin_requests").select("*").eq("id", id).maybeSingle();
    if (found.error) {
      return String(found.error.code) === "22P02"
        ? NextResponse.json({ error: "Request not found." }, { status: 404 })
        : NextResponse.json({ error: NOT_READY }, { status: 503 });
    }
    const row = found.data;
    if (!row || !allowed.includes(row.kind)) return NextResponse.json({ error: "Request not found." }, { status: 404 });
    if (!REQUEST_KINDS[row.kind].decisions.includes(decision)) {
      return NextResponse.json({ error: REQUEST_KINDS[row.kind].endorsement ? "This is the Admin's endorsement: decide the record itself on its own page." : "That decision does not apply here." }, { status: 400 });
    }
    if (row.status !== "pending") return NextResponse.json({ error: "Already decided." }, { status: 409 });
    if (decision === "reject" && note.length < 5) return NextResponse.json({ error: "Write the reason (at least 5 characters)." }, { status: 400 });
    if (decision !== "reject" && note.length < 3) return NextResponse.json({ error: "Write a remark for the Admin." }, { status: 400 });

    const actorName = normalizeText(guard.session?.full_name, guard.session?.email) || (guard.role === "hr" ? "HR" : "Super Admin");
    const now = new Date().toISOString();
    let outcomeRef = row.outcome_ref || null;

    // An approved incentive recommendation becomes the incentive / overload item.
    if (row.kind === "incentive_endorsement" && decision === "approve") {
      const d = row.details || {};
      const item = await supabase.from("payroll_monthly_incentives").insert({
        employee_id: row.employee_id, branch_id: row.branch_id, item_date: d.item_date, kind: d.kind,
        description: `${d.description} (recommended by ${row.created_by_name || "the branch Admin"})`.slice(0, 200),
        amount: d.kind === "incentive" ? d.amount : null, hours: d.kind === "overload" ? d.hours : null,
        created_by: guard.userId || null, created_by_name: actorName, created_at: now,
        // Approved here by HR (or the Super Admin): no second approval (20261027020000).
        approval_status: "approved", decided_by: guard.userId || null, decided_by_name: actorName, decided_at: now,
      }).select("id").maybeSingle();
      if (item.error) return NextResponse.json({ error: sanitizeError(item.error) }, { status: 400 });
      outcomeRef = item.data?.id || null;
    }

    const status = DECISION_STATUS[decision];
    const updated = await supabase.from("branch_admin_requests").update({
      status, decided_by: guard.userId || null, decided_by_name: actorName, decided_by_role: guard.role, decided_at: now,
      decision_note: note || null, outcome_ref: outcomeRef,
      history: [...(row.history || []), historyEntry({ action: decision, status, by: guard.userId, byName: actorName, role: guard.role, note, at: now })],
    }).eq("id", row.id).eq("status", "pending").select("*").maybeSingle();
    if (updated.error) return NextResponse.json({ error: sanitizeError(updated.error) }, { status: 400 });
    if (!updated.data) return NextResponse.json({ error: "Already decided." }, { status: 409 });

    const label = REQUEST_KINDS[row.kind].label;
    const subject = row.details?.employee_name ? ` · ${row.details.employee_name}` : "";
    await notify(supabase, [row.created_by], {
      kind: `branch_${row.kind}_decided`,
      title: `${label}${subject}: ${STATUS_LABELS[status]}`,
      body: `${actorName}${guard.role === "hr" ? " (HR)" : " (Super Admin)"}: ${note}`,
      link_page: row.kind === "attendance_flag" ? "adm-attendance" : row.kind === "incident_report" ? "adm-incidents"
        : row.kind === "schedule_request" ? "adm-schedules" : row.kind === "rfid_issue" ? "adm-rfid-issues" : "adm-incentives",
    });
    await appendAuditLog({
      actor: guard, module: "branch_oversight", action: `branch_${row.kind}_${decision}`, entity_type: "branch_admin_request", entity_id: row.id,
      status: "success", source: "api", description: `${label}${subject}: ${STATUS_LABELS[status]} by ${actorName} (${note}).`,
      metadata: { decision, note, outcome_ref: outcomeRef },
    });
    return NextResponse.json({ success: true, request: shapeRequest(updated.data) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
