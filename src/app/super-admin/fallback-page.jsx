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
import { DecisionRemarkDialog } from "@/components/portal/remark-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchJson } from "@/lib/portal/api";

/** onCounts(total): the sidebar badge takes the count from this same reload (2026-11-14). */
export function FallbackPage({ refreshKey = 0, onCounts }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  // The item being decided, with its remark dialog (Part H): { row, action }.
  const [deciding, setDeciding] = React.useState(null);
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

  const decide = async (remark) => {
    const { row, action } = deciding;
    await fetchJson("/api/super-admin/fallback", { method: "POST", body: JSON.stringify({ action, item_type: row.item_type, id: row.id, remark }) });
    toast.success(action === "approve" ? "Approved as the fallback" : "Rejected as the fallback", { description: "Recorded in the audit log; the requester was notified." });
    setDeciding(null);
    await load();
  };

  const columns = [
    { key: "title", header: "Item", cell: (r) => <div className="min-w-0"><p className="font-medium">{r.title}</p><p className="text-xs text-muted-foreground">{r.detail}</p></div>, sortable: true },
    { key: "reason", header: "Why it waits on you", cell: (r) => <span className="text-sm">{r.reason}</span> },
    { key: "submitted_at", header: "Filed", cell: (r) => (r.submitted_at ? String(r.submitted_at).slice(0, 10) : "—"), sortable: true },
    {
      key: "actions", header: "", cell: (r) => (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setDeciding({ row: r, action: "approve" })}>Approve</Button>
          <Button size="sm" variant="outline" onClick={() => setDeciding({ row: r, action: "reject" })}>Reject</Button>
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
      <DecisionRemarkDialog
        open={Boolean(deciding)}
        idPrefix="fb-remark"
        decision={deciding?.action || "approve"}
        entityType={deciding?.row?.item_type || "leave_request"}
        destructive={deciding?.action === "reject"}
        confirmLabel={deciding?.action === "reject" ? "Reject" : "Approve"}
        title={deciding ? `${deciding.action === "reject" ? "Reject" : "Approve"} as the fallback: ${deciding.row.title}` : ""}
        description="Recorded in the audit log as the fallback approver; the requester is notified (a rejection with your remark)."
        onClose={() => setDeciding(null)}
        onConfirm={decide}
      />
    </Card>
  );
}
