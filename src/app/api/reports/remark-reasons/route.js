/**
 * Decision reasons (Part H, 2026-11-22): how often each preset remark was
 * used, counted from the decision-remark audit entries (one per decided
 * item), by decision, type, branch and date range.
 *
 *   GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&decision=&entity_type=&branch_id=&q=[&format=pdf|xlsx]
 *
 * HR and the Super Admin see every branch (or one); a branch Admin only its
 * own. The file lists exactly the rows the screen shows (same filters and
 * search). The proxy maps this route to "profile"; the roles are checked here.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/guard";
import { isBranchExemptFor } from "@/lib/rbac/permissions";
import { getServiceClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { sanitizeError } from "@/lib/api-error";
import { reportResponse, wantsFile } from "@/lib/export/report-file";
import { DECISIONS, DECISION_LABELS, ENTITY_LABELS, countRemarkReasons } from "@/lib/remarks/presets";

const READERS = new Set(["hr", "super_admin", "admin"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "profile", "read");
    if (guard.denied) return guard.denied;
    if (!READERS.has(guard.role)) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
    const url = new URL(request.url);
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    if ((from && !DAY.test(from)) || (to && !DAY.test(to)) || (from && to && from > to)) return NextResponse.json({ error: "Choose a valid date range." }, { status: 400 });
    const decision = url.searchParams.get("decision") || "";
    if (decision && !DECISIONS.includes(decision)) return NextResponse.json({ error: "Unknown decision." }, { status: 400 });
    const entityType = url.searchParams.get("entity_type") || "";
    if (entityType && !ENTITY_LABELS[entityType]) return NextResponse.json({ error: "Unknown type." }, { status: 400 });
    const wanted = url.searchParams.get("branch_id") || "";
    if (wanted && !UUID.test(wanted)) return NextResponse.json({ error: "Unknown branch." }, { status: 400 });
    // HR (every branch in HR Reports) and the Super Admin: any branch; a branch Admin: its own only.
    const allBranches = isBranchExemptFor(guard.role, "hr_reports");
    const branchId = allBranches ? wanted : guard.branchId;
    if (!allBranches && wanted && wanted !== guard.branchId) return NextResponse.json({ error: "Only your own branch." }, { status: 403 });
    if (!allBranches && !branchId) return NextResponse.json({ error: "Your account has no branch." }, { status: 403 });

    const supabase = getServiceClient();
    const { data, error } = await fetchAllRows(() => {
      let q = supabase.from("audit_logs").select("id,action,entity_type,metadata,branch_id,created_at")
        .eq("metadata->>kind", "decision_remark").order("created_at", { ascending: true });
      if (from) q = q.gte("created_at", `${from}T00:00:00+08:00`);
      if (to) q = q.lte("created_at", `${to}T23:59:59.999+08:00`);
      if (decision) q = q.eq("action", decision);
      if (entityType) q = q.eq("entity_type", entityType);
      if (branchId) q = q.eq("branch_id", branchId);
      return q;
    });
    if (error) throw new Error(error.message);
    const search = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const rows = countRemarkReasons(data).map((r) => ({ ...r, decision_label: DECISION_LABELS[r.decision] || r.decision, type_label: ENTITY_LABELS[r.entity_type] || r.entity_type }))
      .filter((r) => !search || `${r.label} ${r.decision_label} ${r.type_label}`.toLowerCase().includes(search));
    const total = rows.reduce((s, r) => s + r.count, 0);

    const format = wantsFile(url);
    if (format) {
      const branches = branchId ? (await supabase.from("branches").select("name").eq("id", branchId).maybeSingle()).data : null;
      return reportResponse({
        format, fileName: `decision-reasons_${from || "start"}_${to || "today"}`, title: "Decision reasons",
        branch: branches?.name || "All branches", period: from || to ? `${from || "…"} to ${to || "…"}` : "All dates",
        filters: [["Decision", DECISION_LABELS[decision]], ["Type", ENTITY_LABELS[entityType]], ["Search", search]],
        columns: [{ header: "Reason" }, { header: "Decision" }, { header: "Type" }, { header: "Times used", kind: "number", integer: true }],
        rows: rows.map((r) => [r.label, r.decision_label, r.type_label, r.count]), totals: true,
        empty: "No decision reasons in this range.",
      });
    }
    return NextResponse.json({ rows, total, branch_id: branchId || null });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
