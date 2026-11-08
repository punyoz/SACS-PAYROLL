/**
 * The Super Admin's payroll export (Backup & Recovery, 2026-11-08).
 *
 *   GET ?format=csv (default) | xlsx
 *       every branch's payslips (public.payroll_entries), the amounts exactly
 *       as stored, one row per payslip. Read-only: for backup and recovery.
 *
 * It does not give the Super Admin any Accountant page or action (no
 * process_payroll; nothing here writes). Super Admin only: the proxy
 * (backup_recovery), this route, and the database
 * (public.backup_payroll_export refuses anyone else, 20261108010000).
 * The Accountant's own exports stay on its Reports page, limited to its
 * branch. Every export is in the audit log: who, when, what, how many rows.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { deploymentEnvironment } from "@/lib/payroll/window-enforcement";
import { xlsxStream } from "@/lib/export/xlsx-stream";
import { PAYROLL_EXPORT_COLUMNS, csvField } from "@/lib/backup/payroll-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 1000;

async function* payrollRows(supabase, actorId) {
  let after = null;
  for (;;) {
    const { data, error } = await supabase.rpc("backup_payroll_export", { p_actor: actorId, p_after: after, p_limit: PAGE });
    if (error) throw Object.assign(new Error(error.message), { status: /forbidden/.test(error.message) ? 403 : 500 });
    const rows = data || [];
    for (const row of rows) yield row;
    if (rows.length < PAGE) return;
    after = rows[rows.length - 1].id;
  }
}

export async function GET(request) {
  const guard = await requirePermission(request, "backup_recovery", "read");
  if (guard.denied) return guard.denied;
  if (guard.role !== "super_admin") return NextResponse.json({ error: "Only the Super Admin exports payroll for backup." }, { status: 403 });

  const format = new URL(request.url).searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  const supabase = getAdminClient();
  const environment = deploymentEnvironment();
  const label = environment === "demo" ? "DEMO" : environment === "local" ? "LOCAL-TEST" : "";
  const started = Date.now();

  // Refuse up front (403, not a broken download) when the database says no.
  const probe = await supabase.rpc("backup_payroll_export", { p_actor: guard.userId, p_after: null, p_limit: 1 });
  if (probe.error) {
    const forbidden = /forbidden/.test(probe.error.message);
    return NextResponse.json({ error: forbidden ? "Only the Super Admin exports payroll for backup." : sanitizeError(probe.error) }, { status: forbidden ? 403 : 500 });
  }

  let count = 0;
  const audit = async (status, extra = {}) => appendAuditLog({
    actor: guard, module: "backup", action: status === "success" ? "backup_payroll_export" : "backup_payroll_export_failed",
    entity_type: "payroll_entries", status, source: "api",
    description: status === "success"
      ? `Payroll exported for backup (${format.toUpperCase()}, every branch): ${count} payslip row${count === 1 ? "" : "s"}.`
      : `Payroll export for backup did not finish (${count} rows written).`,
    metadata: { format, rows: count, environment, seconds: (Date.now() - started) / 1000, ...extra },
  });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const fileName = `${label ? `${label}-` : ""}sacs-payroll-all-branches-${stamp}.${format}`;
  const headers = {
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "X-Content-Type-Options": "nosniff",
  };

  if (format === "xlsx") {
    const stream = xlsxStream(async function* sheets() {
      yield {
        key: "payroll_entries", name: label ? `Payroll (${label})` : "Payroll",
        columns: PAYROLL_EXPORT_COLUMNS.map(([header, , kind]) => ({ header, width: kind === "money" ? 14 : 20, money: kind === "money" })),
        rows: (async function* rows() {
          for await (const row of payrollRows(supabase, guard.userId)) {
            count += 1;
            yield PAYROLL_EXPORT_COLUMNS.map(([, field, kind]) => (kind === "money" ? (row[field] === null ? null : Number(row[field])) : row[field]));
          }
        })(),
      };
    }, { onFinish: () => audit("success"), onError: (error) => audit("failed", { error: sanitizeError(error) }) });
    return new Response(stream, { status: 200, headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  }

  const encoder = new TextEncoder();
  const iterator = payrollRows(supabase, guard.userId);
  let headerSent = false;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (!headerSent) {
          headerSent = true;
          // A UTF-8 mark so Excel shows ₱ and ñ correctly; a DEMO line first outside production.
          const banner = label ? `${csvField(`${label} DATA - not real payroll`)}\r\n` : "";
          controller.enqueue(encoder.encode(`﻿${banner}${PAYROLL_EXPORT_COLUMNS.map(([h]) => csvField(h)).join(",")}\r\n`));
          return;
        }
        const lines = [];
        for (let i = 0; i < 500; i += 1) {
          const next = await iterator.next();
          if (next.done) {
            if (lines.length) controller.enqueue(encoder.encode(lines.join("")));
            await audit("success");
            controller.close();
            return;
          }
          count += 1;
          lines.push(`${PAYROLL_EXPORT_COLUMNS.map(([, field, kind]) => csvField(next.value[field], kind)).join(",")}\r\n`);
        }
        controller.enqueue(encoder.encode(lines.join("")));
      } catch (error) {
        await audit("failed", { error: sanitizeError(error) });
        controller.error(error);
      }
    },
    async cancel() {
      await audit("failed", { cancelled: true });
    },
  });
  return new Response(stream, { status: 200, headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
}
