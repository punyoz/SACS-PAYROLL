"use client";

import * as React from "react";
import { CheckIcon, InboxIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { REQUEST_KINDS, requestSummary } from "@/lib/branch-requests";
import { cn } from "@/lib/utils";
import { DecisionCell, FiledCell, HistoryButton, RequestStatus } from "@/app/admin/oversight-shared";

/*
 * What the branch Admins sent (/api/hr/branch-requests): HR approves,
 * rejects or resolves with a remark; the Super Admin resolves RFID issues.
 * With readOnly + source (the Accountant), the same list without actions.
 * Decided requests stay listed with their history.
 */

const DECISION_LABELS = { approve: "Approve", reject: "Reject", resolve: "Mark resolved" };

export function BranchRequestsReview({ refreshKey, kinds, title, description, icon: Icon = InboxIcon, readOnly = false, source = null }) {
  const { notify } = usePortalSession();
  const [tab, setTab] = React.useState("pending");
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [dialog, setDialog] = React.useState(null);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const url = source || `/api/hr/branch-requests?kind=${encodeURIComponent(kinds.join(","))}`;

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(url);
      if (data.available === false) throw new Error(data.error);
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((c) => ({ loading: false, error: err.message || "Unable to load.", data: c.data }));
    }
  }, [url]);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const all = state.data?.requests || [];
  const hasPendingState = kinds.some((k) => !REQUEST_KINDS[k]?.endorsement);
  const rows = !hasPendingState || tab === "all" ? all : tab === "pending" ? all.filter((r) => r.status === "pending") : all.filter((r) => r.status !== "pending");

  async function decide() {
    if (dialog.decision === "reject" ? note.trim().length < 5 : note.trim().length < 3) {
      setError(dialog.decision === "reject" ? "Write the reason (at least 5 characters)." : "Write a remark for the Admin.");
      return;
    }
    setBusy(true); setError("");
    try {
      await fetchJson("/api/hr/branch-requests", jsonBody("PATCH", { id: dialog.row.id, decision: dialog.decision, note }));
      notify("Decision Saved", "The branch Admin has been notified.", "success");
      setDialog(null);
      await load();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    { key: "branch_name", header: "Branch", sortable: true, cell: (r) => r.branch_name || "Your branch" },
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", cell: (r) => r.employee_name || "—", searchValue: (r) => r.employee_name },
    ...(kinds.length > 1 ? [{ key: "kind_label", header: "Type", cell: (r) => r.kind_label }] : []),
    { key: "about", header: "About", cell: (r) => <p className="max-w-72 text-xs whitespace-normal">{requestSummary(r)}</p>, searchValue: (r) => requestSummary(r) },
    { key: "admin_note", header: "Admin's remark", cell: (r) => <p className="max-w-64 text-xs whitespace-normal">{r.admin_note}</p>, searchValue: (r) => r.admin_note },
    { key: "filed", header: "Sent by", sortValue: (r) => r.created_at, cell: (r) => <FiledCell request={r} /> },
    { key: "status", header: "Status", cell: (r) => <RequestStatus status={r.status} label={r.status_label} />, searchValue: (r) => r.status_label },
    ...(hasPendingState ? [{ key: "decision", header: "Decision", cell: (r) => <DecisionCell request={r} /> }] : []),
    {
      key: "act", header: <span className="sr-only">Actions</span>, align: "right",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <HistoryButton request={r} />
          {!readOnly && r.status === "pending" ? (REQUEST_KINDS[r.kind]?.decisions || []).map((decision) => (
            <Button key={decision} size="sm" variant={decision === "reject" ? "outline" : "default"} className={cn(decision === "reject" && "text-destructive")}
              onClick={() => { setDialog({ row: r, decision }); setNote(""); setError(""); }}>
              {decision === "reject" ? <XIcon aria-hidden="true" /> : <CheckIcon aria-hidden="true" />}{DECISION_LABELS[decision]}
            </Button>
          )) : null}
        </div>
      ),
    },
  ];

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Icon className="size-4 text-gold-text" aria-hidden="true" />{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasPendingState ? (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList><TabsTrigger value="pending">Pending</TabsTrigger><TabsTrigger value="decided">Decided</TabsTrigger><TabsTrigger value="all">All</TabsTrigger></TabsList>
          </Tabs>
        ) : null}
        <DataTable columns={columns} rows={rows} loading={state.loading && !state.data} error={state.error} onRetry={load} pageSize={15}
          searchPlaceholder="Search employee, branch or remark…" empty={{ title: tab === "pending" && hasPendingState ? "Nothing waiting" : "Nothing here yet", icon: Icon }} caption={title} minWidth={1150} />
      </CardContent>
      <Dialog open={Boolean(dialog)} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          {dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>{DECISION_LABELS[dialog.decision]} — {dialog.row.kind_label}</DialogTitle>
                <DialogDescription>{dialog.row.employee_name ? `${dialog.row.employee_name} · ` : ""}{requestSummary(dialog.row)}{dialog.row.kind === "incentive_endorsement" && dialog.decision === "approve" ? " Approving adds it to payroll now (after the month's cutoff it moves to next month)." : ""}</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor="brr-note">{dialog.decision === "reject" ? "Reason" : "Remark for the Admin"}</Label>
                <Textarea id="brr-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setDialog(null)} disabled={busy}>Cancel</Button>
                <Button variant={dialog.decision === "reject" ? "destructive" : "default"} onClick={decide} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{DECISION_LABELS[dialog.decision]}</Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
