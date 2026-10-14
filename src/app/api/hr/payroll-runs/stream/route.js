/**
 * Live updates for Payroll Approval: Server-Sent Events from this site.
 *
 * The browser has no Supabase session and the Content-Security-Policy allows
 * connections to this site only (connect-src 'self'), so the browser cannot
 * subscribe to Supabase Realtime itself. This route does it on the server,
 * with the service role, on public.payroll_runs (added to the
 * supabase_realtime publication by 20261014010000), and forwards only
 * "run X is now <status>". The page then refetches through the API, which
 * applies every permission as usual.
 *
 * A connection lasts up to 4 minutes; EventSource reconnects by itself. The
 * page also polls every minute, so a missed event costs at most a minute.
 */

import crypto from "node:crypto";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LIFETIME_MS = 4 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;

export async function GET(request) {
  const guard = await requirePermission(request, "payroll_run_approval", "read");
  if (guard.denied) return guard.denied;

  const supabase = getAdminClient();
  const encoder = new TextEncoder();
  let channel = null;
  let heartbeat = null;
  let lifetime = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const write = (text) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(text)); } catch { /* the client went away */ }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        if (channel) supabase.removeChannel(channel).catch(() => {});
        try { controller.close(); } catch { /* already closed */ }
      };

      write(`retry: 5000\nevent: ready\ndata: {}\n\n`);
      channel = supabase
        .channel(`payroll-runs-${crypto.randomUUID()}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "payroll_runs" }, (payload) => {
          const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old || {};
          // A branch-scoped reader hears only about its own branch.
          if (!guard.branchExempt && String(row.branch_id || "") !== String(guard.branchId || "")) return;
          write(`event: change\ndata: ${JSON.stringify({ id: row.id || null, status: row.status || null })}\n\n`);
        })
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") write("event: degraded\ndata: {}\n\n");
        });

      heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      lifetime = setTimeout(close, LIFETIME_MS);
      request.signal?.addEventListener?.("abort", close);
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      if (channel) supabase.removeChannel(channel).catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
