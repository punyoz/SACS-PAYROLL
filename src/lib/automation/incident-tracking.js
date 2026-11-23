/**
 * Part E step 8 (2026-11-23): incidents and RFID issue reports the branch Admin
 * files are tracked by the system: logged as an open item for HR (so the
 * stale-item escalation, the daily digest and the Automation card count it),
 * and closed when HR decides the report. A no-show goes to AWOL Cases instead
 * (tracked there). Never throws: the report itself is already saved.
 */
export const TRACKED_KINDS = Object.freeze(["incident_report", "rfid_issue"]);

/** Pure (tested): what is tracked, and its summary. */
export function trackingFor(kind, details = {}, { routedElsewhere = false } = {}) {
  if (!TRACKED_KINDS.includes(kind) || routedElsewhere) return null;
  const who = details.employee_name ? `${details.employee_name}: ` : "";
  return kind === "incident_report"
    ? { rule: "an incident the branch Admin filed waits for HR", summary: `Incident report, ${who}${details.incident_type_label || "incident"} on ${details.incident_date || "—"}. HR handles and closes it.` }
    : { rule: "an RFID problem the branch Admin reported waits for HR", summary: `RFID issue, ${who}${details.issue_type_label || "problem"}${details.device ? ` (${details.device})` : ""}. HR or the Super Admin resolves it.` };
}

export async function trackBranchReport(supabase, request, { routedElsewhere = false } = {}) {
  try {
    const t = trackingFor(request?.kind, request?.details || {}, { routedElsewhere });
    if (!t || !request?.id) return null;
    const { data } = await supabase.rpc("automation_log", {
      p_module: "incident_tracking", p_rule: t.rule, p_kind: "flag", p_summary: t.summary,
      p_data: { code: request.kind, request_id: request.id }, p_employee: request.employee_id || null, p_branch: request.branch_id || null,
      p_entity_type: "branch_request", p_entity_id: String(request.id),
    });
    return data || null;
  } catch {
    return null;
  }
}

export async function closeBranchReport(supabase, requestId, note) {
  try {
    const { data } = await supabase.from("automation_actions").select("id").eq("module", "incident_tracking")
      .eq("entity_type", "branch_request").eq("entity_id", String(requestId)).neq("status", "closed");
    for (const r of data || []) await supabase.rpc("automation_close", { p_id: r.id, p_note: note });
  } catch { /* never fails the decision */ }
}
