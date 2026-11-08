/**
 * The Super Admin's full data backup (Backup & Recovery, 2026-11-08).
 *
 *   GET   the groups on offer, the row count of each table (for the progress
 *         bar and the size of the file), and how many downloads are left in
 *         the rate-limit window.
 *   POST  { password, groups: ["all"] | ["employees", ...] }
 *         re-checks the Super Admin's password, then streams an Excel
 *         workbook (.xlsx) built batch by batch on the server: nothing is
 *         stored on the server or in the repository; it goes once to the
 *         browser. Every branch.
 *
 * Super Admin only: the proxy (backup_recovery), this route (role check) and
 * the database (public.backup_export_page refuses anyone else,
 * 20261108010000). Rate limit: DOWNLOAD_LIMIT downloads per WINDOW_MINUTES,
 * counted from the audit log (so it holds across server instances). Every
 * download is in the audit log: who, when, which groups, rows per sheet;
 * a failed or cancelled one too. The password is never logged.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { reverifyPassword } from "@/lib/auth/reverify-password";
import { deploymentEnvironment } from "@/lib/payroll/window-enforcement";
import { loadDemoIds } from "@/lib/demo";
import { xlsxStream } from "@/lib/export/xlsx-stream";
import {
  BACKUP_EXCLUSIONS, BACKUP_GROUPS, aboutSheet, countTables, countsSheet, employeesSheet, leaveBalancesSheet,
  loadContext, payRatesSheet, pickGroups, tableSheet, usersSheet,
} from "@/lib/backup/full-backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A large backup can take a while; streaming keeps the connection alive.
export const maxDuration = 300;

const DOWNLOAD_LIMIT = 5;
const WINDOW_MINUTES = 15;
const DOWNLOAD_ACTION = "backup_full_download";

function superAdminOnly(guard) {
  if (guard.role !== "super_admin") return NextResponse.json({ error: "Only the Super Admin downloads backups." }, { status: 403 });
  return null;
}

async function recentDownloads(supabase, guard) {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count, error } = await supabase.from("audit_logs").select("id", { count: "exact", head: true })
    .eq("action", DOWNLOAD_ACTION).eq("actor_id", guard.userId).gte("created_at", since);
  if (error) throw new Error(`Could not check the download limit: ${error.message}`);
  return count || 0;
}

const ENV_LABEL = { demo: "DEMO", local: "LOCAL TEST" };

export async function GET(request) {
  const guard = await requirePermission(request, "backup_recovery", "read");
  if (guard.denied) return guard.denied;
  const refused = superAdminOnly(guard);
  if (refused) return refused;
  try {
    const supabase = getAdminClient();
    const tables = [...new Set(BACKUP_GROUPS.flatMap((g) => g.tables))];
    const [counts, used, demoIds] = await Promise.all([countTables(supabase, guard.userId, tables), recentDownloads(supabase, guard), loadDemoIds(supabase)]);
    const environment = deploymentEnvironment();
    return NextResponse.json({
      groups: BACKUP_GROUPS.map((g) => ({ ...g, rows: g.tables.reduce((n, t) => n + (counts[t] || 0), 0) })),
      counts,
      exclusions: BACKUP_EXCLUSIONS,
      // Demo people (is_demo): the page's CSV exports leave them out too.
      demo_ids: [...demoIds],
      environment,
      environment_label: ENV_LABEL[environment] || null,
      limit: { per_window: DOWNLOAD_LIMIT, window_minutes: WINDOW_MINUTES, used, left: Math.max(0, DOWNLOAD_LIMIT - used) },
    });
  } catch (error) {
    console.error("[backup] GET failed:", error?.message || error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: error.status || 500 });
  }
}

export async function POST(request) {
  const guard = await requirePermission(request, "backup_recovery", "create");
  if (guard.denied) return guard.denied;
  const refused = superAdminOnly(guard);
  if (refused) return refused;

  let groups;
  const body = await request.json().catch(() => ({}));
  try {
    groups = pickGroups(body.groups);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  const supabase = getAdminClient();
  const groupKeys = groups.map((g) => g.key);

  try {
    const check = await reverifyPassword(guard, body.password, "backup");
    if (check.locked) {
      return NextResponse.json({ error: `Too many incorrect passwords. Try again in ${Math.ceil(check.retryAfterMs / 60000)} minute(s).`, code: "locked" }, { status: 429 });
    }
    if (!check.valid) {
      await appendAuditLog({ actor: guard, module: "backup", action: "backup_password_failed", entity_type: "backup", status: "failed", source: "api",
        description: "Full data backup refused: incorrect password.", metadata: { groups: groupKeys } });
      // 400, not 401: the portal treats a 401 as a lapsed session and signs out.
      return NextResponse.json({ error: check.error || "Incorrect password.", code: "wrong_password" }, { status: 400 });
    }
    const used = await recentDownloads(supabase, guard);
    if (used >= DOWNLOAD_LIMIT) {
      return NextResponse.json({ error: `At most ${DOWNLOAD_LIMIT} backup downloads every ${WINDOW_MINUTES} minutes. Try again later.`, code: "rate_limited" }, { status: 429 });
    }
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }

  const started = Date.now();
  const generatedAt = new Date().toISOString();
  const environment = deploymentEnvironment();
  const label = ENV_LABEL[environment] || null;
  const tables = [...new Set(groups.flatMap((g) => g.tables))];
  const actorName = guard.session?.full_name || guard.session?.email || "Super Admin";

  // The download itself is the audit entry the rate limit counts. Written
  // before the row counts, so the audit log's count includes it.
  const audit = await appendAuditLog({
    actor: guard, module: "backup", action: DOWNLOAD_ACTION, entity_type: "backup", status: "success", source: "api",
    description: `Full data backup started (${groups.length === BACKUP_GROUPS.length ? "all groups" : groups.map((g) => g.label).join(", ")}; every branch).`,
    metadata: { groups: groupKeys, environment },
  });
  let expected;
  try {
    expected = await countTables(supabase, guard.userId, tables);
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: error.status || 500 });
  }

  // Rows actually written, per source table / computed sheet.
  const written = new Map();
  const counted = (sheet) => {
    // Every sheet is listed in Row counts, an empty table too (0 rows).
    if (!written.has(sheet.key)) written.set(sheet.key, 0);
    return countedRows(sheet);
  };
  const countedRows = (sheet) => ({
    ...sheet,
    rows: (async function* count() {
      for await (const row of sheet.rows) {
        written.set(sheet.key, (written.get(sheet.key) || 0) + 1);
        yield row;
      }
    })(),
  });

  async function* sheets() {
    yield aboutSheet({ generatedAt, actorName, environment, groups, label });
    const needContext = groups.some((g) => g.computed.length);
    const context = needContext ? await loadContext(supabase, guard.userId) : null;
    for (const group of groups) {
      for (const computed of group.computed) {
        if (computed === "users") yield counted(await usersSheet(supabase, context));
        if (computed === "employees") yield counted(await employeesSheet(supabase, guard.userId, context));
        if (computed === "leave_balances") yield counted(await leaveBalancesSheet(supabase, guard.userId, context));
        if (computed === "pay_rates") yield counted(await payRatesSheet(supabase, context));
      }
      for (const table of group.tables) yield counted(await tableSheet(supabase, guard.userId, table));
    }
    yield countsSheet([...written].map(([source, rows]) => ({ name: source, source, rows })), expected);
  }

  const stream = xlsxStream(sheets, {
    async onFinish(summary) {
      const rows = Object.fromEntries(written);
      const mismatches = Object.entries(expected).filter(([t, n]) => rows[t] !== undefined && rows[t] !== n).map(([t]) => t);
      await appendAuditLog({
        actor: guard, module: "backup", action: "backup_full_completed", entity_type: "backup", entity_id: audit?.id || null, status: "success", source: "api",
        description: `Full data backup downloaded: ${summary.sheets.length} sheets, ${Object.values(rows).reduce((a, b) => a + b, 0)} rows, ${Math.round((Date.now() - started) / 100) / 10} s.`,
        metadata: { groups: groupKeys, environment, rows_per_sheet: rows, sheets: summary.sheets.length, truncated_cells: summary.truncated_cells, mismatches, seconds: (Date.now() - started) / 1000 },
      });
    },
    async onError(error, { cancelled } = {}) {
      await appendAuditLog({
        actor: guard, module: "backup", action: "backup_full_failed", entity_type: "backup", entity_id: audit?.id || null, status: "failed", source: "api",
        description: cancelled ? "Full data backup cancelled before it finished." : `Full data backup failed: ${sanitizeError(error)}`,
        metadata: { groups: groupKeys, environment, rows_written: Object.fromEntries(written) },
      });
    },
  });

  const stamp = generatedAt.replace(/[-:]/g, "").slice(0, 13);
  const prefix = label ? `${label.replace(/\s+/g, "-")}-` : "";
  const fileName = `${prefix}sacs-backup-${groups.length === BACKUP_GROUPS.length ? "full" : groupKeys.join("-")}-${stamp}.xlsx`;
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "X-Content-Type-Options": "nosniff",
      "X-Backup-Rows": String(Object.values(expected).reduce((a, b) => a + b, 0)),
      "X-Backup-Environment": environment,
    },
  });
}
