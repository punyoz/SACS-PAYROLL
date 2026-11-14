"use client";

/**
 * Items waiting on fallback (2026-11-09 Part D): what the Super Admin decides
 * ONLY because no other HR is active (an HR's own leave, a payroll run holding
 * the last HR's payslip). With two or more HR active the list is empty: the
 * Super Admin never decides when a normal approver exists. Each decision is
 * audited as "fallback used" and the requester is notified.
 */
import * as React from "react";
import { toast } from "sonner";
import { InboxIcon } from "lucide-react";
import { DataTable } from "@/components/portal/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/portal/api";

/** onCounts(total): the sidebar badge takes the count from this same reload (2026-11-14). */
export function FallbackPage({ refreshKey = 0, onCounts }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [reasons, setReasons] = React.useState({});
  const [busy, setBusy] = React.useState(null);
  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/super-admin/fallback");
      setState({ loading: false, error: null, data });
      onCounts?.(Number(data?.counts?.total || 0));
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error: error?.message || "Could not load the items." }));
    }
  }, [onCounts]);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const decide = async (row, action) => {
    setBusy(`${row.id}:${action}`);
    try {
      await fetchJson("/api/super-admin/fallback", { method: "POST", body: JSON.stringify({ action, item_type: row.item_type, id: row.id, reason: reasons[row.id] || "" }) });
      toast.success(action === "approve" ? "Approved as the fallback" : "Rejected as the fallback", { description: "Recorded in the audit log; the requester was notified." });
      await load();
    } catch (error) {
      toast.error("Not saved", { description: error?.message || "Try again." });
    } finally {
      setBusy(null);
    }
  };

  const columns = [
    { key: "title", header: "Item", cell: (r) => <div className="min-w-0"><p className="font-medium">{r.title}</p><p className="text-xs text-muted-foreground">{r.detail}</p></div>, sortable: true },
    { key: "reason", header: "Why it waits on you", cell: (r) => <span className="text-sm">{r.reason}</span> },
    { key: "submitted_at", header: "Filed", cell: (r) => (r.submitted_at ? String(r.submitted_at).slice(0, 10) : "—"), sortable: true },
    {
      key: "actions", header: "", cell: (r) => (
        <div className="flex min-w-56 flex-col gap-2">
          <Textarea aria-label={`Reason for ${r.title}`} placeholder="Reason (required to reject)" rows={2} value={reasons[r.id] || ""} onChange={(e) => setReasons((m) => ({ ...m, [r.id]: e.target.value }))} />
          <div className="flex gap-2">
            <Button size="sm" disabled={Boolean(busy)} onClick={() => decide(r, "approve")}>Approve</Button>
            <Button size="sm" variant="outline" disabled={Boolean(busy) || String(reasons[r.id] || "").trim().length < 5} onClick={() => decide(r, "reject")}>Reject</Button>
          </div>
        </div>
      ),
    },
  ];

  return (
    <Card data-testid="fallback-items">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><InboxIcon aria-hidden="true" className="size-4" />Items waiting on fallback</CardTitle>
        <CardDescription>
          You decide these only because no other HR account is active. With two or more HR active, this list stays empty and HR handles everything.
          Each decision is recorded as &ldquo;fallback used&rdquo; in the audit log, and the requester is notified.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={columns}
          rows={state.data?.items || []}
          loading={state.loading && !state.data}
          error={state.data ? null : state.error}
          onRetry={load}
          rowKey={(r) => `${r.item_type}:${r.id}`}
          empty={{ title: "Nothing waits on the fallback", description: "Every item has an active HR to decide it." }}
        />
      </CardContent>
    </Card>
  );
}
