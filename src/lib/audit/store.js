import { normalizeText } from "@/lib/auth/normalize";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

function shapeLogRow(row) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};

  return {
    id: String(row.id || row.log_id || `row-${Date.now()}`),
    created_at: row.created_at || row.timestamp || new Date().toISOString(),
    module: normalizeText(row.module, "system"),
    action: normalizeText(row.action, "event"),
    entity_type: normalizeText(row.entity_type, "resource"),
    entity_id: normalizeText(row.entity_id),
    description: normalizeText(row.description, "No description provided."),
    status: normalizeText(row.status, "success"),
    source: normalizeText(row.source, "api"),
    branch_id: row.branch_id || null,
    is_system_event: Boolean(row.is_system_event),
    actor_id: row.actor_id || null,
    actor_role: normalizeText(row.actor_role),
    actor_name: normalizeText(row.actor_name),
    actor_ip: normalizeText(row.actor_ip),
    metadata,
  };
}

/**
 * Who performed an audited action, from the route guard
 * (src/lib/rbac/guard.js requirePermission). The guard's identity comes from
 * the signed HttpOnly session cookie, so an entry can never be attributed to
 * somebody else by anything in the request body.
 *
 * @param {object|null|undefined} guard
 * @returns {{ actor_id: string|null, actor_role: string|null, actor_name: string|null, actor_ip: string|null }}
 */
export function actorColumns(guard) {
  if (!guard || typeof guard !== "object") {
    return { actor_id: null, actor_role: null, actor_name: null, actor_ip: null };
  }
  const id = normalizeText(guard.userId || guard.session?.sub);
  return {
    actor_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null,
    actor_role: normalizeText(guard.role) || null,
    actor_name: normalizeText(guard.session?.full_name, normalizeText(guard.session?.email)) || null,
    actor_ip: normalizeText(guard.clientIp) || null,
  };
}

/**
 * Modules whose events are system-level rather than branch activity: logins,
 * configuration changes, backups. Admin's branch-scoped Audit Logs must never
 * show these — they belong to Super Admin's Audit & Monitoring alone.
 * See SACS-Payroll-Permission-Matrix.md row 16.
 */
const SYSTEM_EVENT_MODULES = new Set([
  "system",
  "system_config",
  "config",
  "maintenance",
  "backup",
  "auth",
  "login",
  "roles",
  "branches",
]);

export function isSystemEventModule(moduleName) {
  return SYSTEM_EVENT_MODULES.has(normalizeText(moduleName, "system").toLowerCase());
}

function applyFilters(logs, options = {}) {
  const moduleFilter = normalizeText(options.module, "all").toLowerCase();
  const actionFilter = normalizeText(options.action, "all").toLowerCase();
  const search = normalizeText(options.search).toLowerCase();

  return logs.filter((log) => {
    if (moduleFilter !== "all" && String(log.module || "").toLowerCase() !== moduleFilter) {
      return false;
    }

    if (actionFilter !== "all" && String(log.action || "").toLowerCase() !== actionFilter) {
      return false;
    }

    if (!search) return true;

    const haystack = [
      log.module,
      log.action,
      log.entity_type,
      log.entity_id,
      log.description,
      log.status,
      log.source,
      log.actor_name,
      log.actor_role,
    ]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");

    return haystack.includes(search);
  });
}

function buildSummary(logs) {
  const summary = {
    total: logs.length,
    success: 0,
    failed: 0,
  };

  logs.forEach((log) => {
    if (String(log.status || "").toLowerCase() === "failed") {
      summary.failed += 1;
    } else {
      summary.success += 1;
    }
  });

  return summary;
}

// Audit logging is a side effect called from many otherwise-unrelated routes
// (creating a branch, assigning an RFID card, etc.). A failure here must not
// fail the primary operation that triggered it — but unlike before, a failed
// write is no longer silently faked into an in-memory record that looks like
// it succeeded. It's reported honestly as unpersisted and logged server-side.
//
// `payload.actor` is the route's guard: every entry records who did it.
export async function appendAuditLog(payload) {
  const entry = {
    module: normalizeText(payload.module, "system"),
    action: normalizeText(payload.action, "event"),
    entity_type: normalizeText(payload.entity_type, "resource"),
    entity_id: normalizeText(payload.entity_id) || null,
    description: normalizeText(payload.description, "No description provided."),
    status: normalizeText(payload.status, "success"),
    source: normalizeText(payload.source, "api"),
    branch_id: payload.branch_id || null,
    is_system_event: typeof payload.is_system_event === "boolean"
      ? payload.is_system_event
      : isSystemEventModule(payload.module),
    metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
    ...actorColumns(payload.actor),
  };

  try {
    const supabase = getAdminClient();
    const insertResult = await supabase.from("audit_logs").insert(entry).select("*").maybeSingle();

    if (insertResult.error || !insertResult.data) {
      console.error("[audit_logs] insert failed:", insertResult.error?.message);
      return { ...entry, id: null, created_at: new Date().toISOString(), persisted: false };
    }

    return { ...shapeLogRow(insertResult.data), persisted: true };
  } catch (error) {
    console.error("[audit_logs] insert threw:", error?.message || error);
    return { ...entry, id: null, created_at: new Date().toISOString(), persisted: false };
  }
}

export async function listAuditLogs(options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 150)));
  const supabase = getAdminClient();

  let query = supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  // options.branch_id is set by the route from the caller's session when the
  // caller is branch-scoped. Super Admin passes it as null and sees everything,
  // system-level events included.
  if (options.branch_id) {
    query = query.eq("branch_id", options.branch_id).eq("is_system_event", false);
  }

  const queryResult = await query;

  if (queryResult.error) {
    throw new Error(queryResult.error.message);
  }

  const shaped = (queryResult.data || []).map(shapeLogRow);
  const filtered = applyFilters(shaped, options).slice(0, limit);

  return {
    logs: filtered,
    summary: buildSummary(filtered),
    source_mode: "table",
  };
}
