/**
 * The Super Admin's data backup (Backup & Recovery; CSV since 2026-11-15).
 *
 *   GET   ?from=YYYY-MM-DD&to=YYYY-MM-DD&branch=<uuid>   (all optional)
 *         the groups on offer with the number of files and rows each will
 *         hold under those filters, the branches for the filter, and how
 *         many downloads are left in the rate-limit window.
 *   POST  { password, groups: ["all"] | ["employees", ...], file?: "<file key>",
 *           filters?: { from, to, branch } }
 *         re-checks the Super Admin's password, then streams a ZIP of CSV
 *         files plus README.txt (or one CSV when only one file is asked
 *         for), built page by page on the server. Nothing is stored on the
 *         server; it goes once to the browser. Read-only.
 *
 * Super Admin only: the proxy (backup_recovery), this route (role check) and
 * the database (public.backup_export_page refuses anyone else,
 * 20261108010000). Rate limit: DOWNLOAD_LIMIT downloads per WINDOW_MINUTES,
 * counted from the audit log (so it holds across server instances). Every
 * download is in the audit log: who, when, what, filters, rows per file;
 * a failed or cancelled one too. The password and the file contents are
 * never logged.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { reverifyPassword } from "@/lib/auth/reverify-password";
import { deploymentEnvironment } from "@/lib/payroll/window-enforcement";
import { byteStream } from "@/lib/export/xlsx-stream";
import {
  BACKUP_EXCLUSIONS, BACKUP_GROUPS, MAIN_FILE, backupFiles, countFiles, countTables, fileKeysOf, loadContext, pickGroups,
} from "@/lib/backup/full-backup";
import { backupFileName, hasFilters, label as wordsOf, parseFilters, readmeText, writeCsvBackup } from "@/lib/backup/csv-backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A large backup can take a while; streaming keeps the connection alive.
export const maxDuration = 300;

const DOWNLOAD_LIMIT = 5;
const WINDOW_MINUTES = 15;
const DOWNLOAD_ACTION = "backup_full_download";
const ALL_FILES = fileKeysOf(BACKUP_GROUPS);

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
const appVersion = () => process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || process.env.npm_package_version || "unknown";
const branchIdsOf = (context) => new Set(context.branches.map((b) => String(b.id)));

export async function GET(request) {
  const guard = await requirePermission(request, "backup_recovery", "read");
  if (guard.denied) return guard.denied;
  const refused = superAdminOnly(guard);
  if (refused) return refused;
  try {
    const supabase = getAdminClient();
    const context = await loadContext(supabase, guard.userId);
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const filters = parseFilters(params, branchIdsOf(context));
    const [counts, used] = await Promise.all([countFiles(supabase, guard.userId, ALL_FILES, filters, context), recentDownloads(supabase, guard)]);
    const environment = deploymentEnvironment();
    return NextResponse.json({
      groups: BACKUP_GROUPS.map((g) => {
        const files = fileKeysOf([g]);
        return { ...g, files: files.length, main_file: MAIN_FILE[g.key] || null, rows: files.reduce((n, k) => n + (counts[k] || 0), 0) };
      }),
      counts,
      filters,
      branches: context.branches.map((b) => ({ id: b.id, name: b.name, code: b.code || null })),
      exclusions: BACKUP_EXCLUSIONS,
      // Demo people are included (2026-11-15); each file marks them in "Is demo".
      demo_accounts: context.demoIds.size,
      environment,
      environment_label: ENV_LABEL[environment] || null,
      limit: { per_window: DOWNLOAD_LIMIT, window_minutes: WINDOW_MINUTES, used, left: Math.max(0, DOWNLOAD_LIMIT - used) },
    });
  } catch (error) {
    if (error.status === 400) return NextResponse.json({ error: error.message }, { status: 400 });
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
  const file = body.file ? String(body.file) : null;
  try {
    groups = pickGroups(body.groups);
    if (file && !ALL_FILES.includes(file)) throw Object.assign(new Error(`Unknown backup file: ${file}.`), { status: 400 });
    parseFilters(body.filters || {});
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
        description: "Data backup refused: incorrect password.", metadata: { groups: groupKeys, file } });
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

  let context;
  let filters;
  try {
    context = await loadContext(supabase, guard.userId);
    filters = parseFilters(body.filters || {}, branchIdsOf(context));
  } catch (error) {
    return NextResponse.json({ error: error.status === 400 ? error.message : sanitizeError(error) }, { status: error.status || 500 });
  }

  const started = Date.now();
  const exportedAt = new Date();
  const environment = deploymentEnvironment();
  const label = ENV_LABEL[environment] || null;
  const everything = groups.length === BACKUP_GROUPS.length && !file;
  const keys = file ? [file] : fileKeysOf(groups);
  const single = keys.length === 1;
  const branchName = filters.branch ? context.branchName(filters.branch) : "";
  const me = context.profile(guard.userId);
  // Name and role; the Employee ID only when the account has one (decided 2026-11-15).
  const exportedBy = `${me?.name || guard.session?.full_name || "Super Admin"} (${wordsOf(me?.role || guard.role)})${me?.code ? `, Employee ID ${me.code}` : ""}`;
  const what = file ? file : everything ? "everything" : groupKeys.join("-");
  const description = `${file ? `File ${file}` : everything ? "Everything" : groups.map((g) => g.label).join(", ")}; ${filters.branch ? branchName : "every branch"}${filters.from || filters.to ? `; ${filters.from || "start"} to ${filters.to || "today"}` : ""}`;

  // The download itself is the audit entry the rate limit counts. Written
  // before the files, so audit_logs.csv includes it.
  const audit = await appendAuditLog({
    actor: guard, module: "backup", action: DOWNLOAD_ACTION, entity_type: "backup", status: "success", source: "api",
    description: `Data backup started (CSV): ${description}.`,
    metadata: { groups: groupKeys, file, filters, environment, format: single ? "csv" : "zip" },
  });
  let expected = null;
  if (!hasFilters(filters)) {
    const tables = keys.filter((k) => !["users", "employees", "leave_balances", "pay_rates"].includes(k));
    expected = await countTables(supabase, guard.userId, tables).catch(() => null);
  }

  let summary = null;
  const stream = byteStream(async (push) => {
    summary = await writeCsvBackup(() => backupFiles(supabase, guard.userId, keys, filters, context), push, {
      single,
      readme: (files) => readmeText(files, { exportedAt, exportedBy, filters, branchName, version: appVersion(), environment, groups: file ? [file] : groups.map((g) => g.label) }),
    });
    return summary;
  }, {
    async onFinish(result) {
      const rows = Object.fromEntries(result.files.map((f) => [f.key, f.rows]));
      const mismatches = expected ? Object.entries(expected).filter(([t, n]) => rows[t] !== undefined && rows[t] !== n && t !== "audit_logs").map(([t]) => t) : [];
      await appendAuditLog({
        actor: guard, module: "backup", action: "backup_full_completed", entity_type: "backup", entity_id: audit?.id || null, status: "success", source: "api",
        description: `Data backup downloaded (CSV): ${result.files.length} file${result.files.length === 1 ? "" : "s"}, ${Object.values(rows).reduce((a, b) => a + b, 0)} rows, ${Math.round((Date.now() - started) / 100) / 10} s.`,
        metadata: { groups: groupKeys, file, filters, environment, rows_per_file: rows, sha256: Object.fromEntries(result.files.map((f) => [f.name, f.sha256])), mismatches, seconds: (Date.now() - started) / 1000 },
      });
    },
    async onError(error, { cancelled } = {}) {
      await appendAuditLog({
        actor: guard, module: "backup", action: "backup_full_failed", entity_type: "backup", entity_id: audit?.id || null, status: "failed", source: "api",
        description: cancelled ? "Data backup cancelled before it finished." : `Data backup failed: ${sanitizeError(error)}`,
        metadata: { groups: groupKeys, file, filters, environment },
      });
    },
  });

  const fileName = backupFileName(what, { at: exportedAt, filters, branchName, ext: single ? "csv" : "zip", label: label ? label.replace(/\s+/g, "-") : "" });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": single ? "text/csv; charset=utf-8" : "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "X-Content-Type-Options": "nosniff",
      "X-Backup-Environment": environment,
    },
  });
}
