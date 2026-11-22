/**
 * Preset remarks for decisions (Part H, 2026-11-22;
 * supabase/migrations/20261122030000_remark_presets.sql).
 *
 * A decision's remark is { code, extra }: a preset's code (or "other") and
 * optional extra words. The server turns it into the text ("Filed late: the
 * form came on Friday"), stores the text on the decided record as before,
 * and sends { code, text } with the decision's own database call in the
 * x-sacs-remark header: the trigger writes the audit entry in the same
 * transaction (both fail together), one per decided row.
 */

import { createClient } from "@supabase/supabase-js";

export const DECISIONS = Object.freeze(["approve", "reject", "resolve", "endorse", "object", "override", "revoke"]);
/** A reason is required for these; optional for approve / resolve / endorse. */
export const REMARK_REQUIRED = Object.freeze(new Set(["reject", "revoke", "override", "object"]));
export const OTHER = "other";
export const EXTRA_MAX = 400;

const ENTITY = /^[a-z_]{3,40}$/;

/** The presets for one decision and type (the type's own first, then the general ones), active only unless asked. */
export async function readPresets(supabase, { decision = null, entityType = null, includeInactive = false } = {}) {
  let query = supabase.from("remark_presets").select("id,code,decision,entity_type,label,active,sort_order,updated_at,updated_by")
    .order("decision", { ascending: true }).order("sort_order", { ascending: true }).order("label", { ascending: true });
  if (decision) query = query.eq("decision", decision);
  if (entityType) query = query.in("entity_type", [entityType, "*"]);
  if (!includeInactive) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = data || [];
  // The type's own presets before the general ones.
  return entityType ? [...rows.filter((r) => r.entity_type === entityType), ...rows.filter((r) => r.entity_type === "*")] : rows;
}

/**
 * The remark of a decision, checked: { code, text } or { error }.
 *   input        { code, extra } from the form (or null)
 *   fallbackText the request's plain reason / note, for callers that do not send a remark yet
 *                (it is kept as an "Other" remark, so every reason still counts)
 */
export async function resolveRemark(supabase, input, { decision, entityType, required = REMARK_REQUIRED.has(decision), fallbackText = "" }) {
  if (!DECISIONS.includes(decision) || !ENTITY.test(String(entityType || ""))) return { error: "Unknown decision." };
  const extra = String(input?.extra ?? "").trim();
  if (extra.length > EXTRA_MAX) return { error: `The remark is too long (${EXTRA_MAX} characters at most).` };
  const code = String(input?.code ?? "").trim();
  if (!code) {
    const text = String(fallbackText || "").trim();
    if (text.length >= 3) return { code: OTHER, text: text.slice(0, EXTRA_MAX) };
    return required ? { error: "Choose a remark (a reason is required).", missing: true } : { code: null, text: "" };
  }
  if (code === OTHER) {
    if (extra.length < 3) return { error: "Write the remark (at least 3 characters)." };
    return { code: OTHER, text: extra };
  }
  const { data, error } = await supabase.from("remark_presets").select("code,decision,entity_type,label,active").eq("code", code).maybeSingle();
  if (error) return { error: error.message };
  if (!data || !data.active) return { error: "That remark is no longer offered. Choose another." };
  if (data.decision !== decision || (data.entity_type !== "*" && data.entity_type !== entityType)) return { error: "That remark is not for this decision." };
  return { code, text: extra ? `${data.label}: ${extra}` : data.label };
}

/**
 * A service-role client whose calls carry the remark: the decided table's
 * trigger writes one audit entry per row in `ids` (all rows of `table` the
 * call writes when ids is null; only INSERTs with ops ["INSERT"]), in the
 * call's own transaction. Without a
 * remark (an optional one left empty) it is a plain service client.
 */
export function remarkClient(remark, { decision, entityType, module, table, ids = null, ops = null, actor = null }) {
  const headers = {};
  if (remark?.code) {
    const payload = {
      code: remark.code, text: remark.text, decision, entity_type: entityType, module, table,
      ids: Array.isArray(ids) ? ids.map(String) : null,
      ops: Array.isArray(ops) ? ops : null,
      actor_id: actor?.userId || null, actor_role: actor?.role || null,
      actor_name: actor?.session?.full_name || actor?.session?.email || null,
    };
    headers["x-sacs-remark"] = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers },
  });
}

export const ENTITY_LABELS = Object.freeze({
  leave_request: "Leave request", overtime_request: "Overtime request", attendance_correction: "Attendance correction",
  payroll_run: "Payroll run", awol_case: "AWOL case", transfer_request: "Transfer request", adjustment: "Incentive / loan",
  final_pay: "Final pay", tenure_grant: "Tenure pay protection", subsidy_request: "Subsidy request",
  payroll_correction: "Payroll correction", branch_request: "Branch request",
});
export const DECISION_LABELS = Object.freeze({ approve: "Approve", reject: "Reject", resolve: "Resolve", endorse: "Endorse", object: "Object", override: "Override", revoke: "Revoke" });

/**
 * Reason counts from the decision-remark audit entries (Part H): one row per
 * decision, type and remark (presets by code; "Other" by code too, its texts
 * vary). A deactivated preset keeps the label it was used with.
 * -> [{ key, decision, entity_type, code, label, count, last_at }] most used first
 */
export function countRemarkReasons(entries) {
  const groups = new Map();
  for (const e of entries || []) {
    const m = e.metadata || {};
    const code = m.remark_code || OTHER;
    const key = `${e.action}|${e.entity_type}|${code}`;
    const g = groups.get(key) || { key, decision: e.action, entity_type: e.entity_type, code, label: code === OTHER ? "Other (written)" : (m.preset_label || m.remark_text || code), count: 0, last_at: null };
    g.count += 1;
    if (!g.last_at || String(e.created_at) > g.last_at) g.last_at = String(e.created_at);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
