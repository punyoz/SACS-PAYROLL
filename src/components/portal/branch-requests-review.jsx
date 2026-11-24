"use client";

import { ItemThread, useThreadCounts } from "@/components/portal/item-thread";

import * as React from "react";
import { CheckIcon, InboxIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { EMPTY_REMARK, RemarkField, remarkProblem } from "@/components/portal/remark-field";
import { useApprovalFilters } from "@/components/portal/approval-filters";
import { useBulkDecisions } from "@/components/portal/bulk-action-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable } from "@/components/portal/data-table";
import { FilterTabs } from "@/components/portal/filter-tabs";
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
  // Part H: the decision's preset remark (a remark for the Admin is always required).
  const [remark, setRemark] = React.useState(EMPTY_REMARK);
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
  // Part F: decide several at once; the decisions common to every kind on this page (a remark for the Admin is always required).
  const shared = (kinds || []).map((k) => REQUEST_KINDS[k]?.decisions || []).reduce((acc, d) => (acc === null ? d : acc.filter((x) => d.includes(x))), null) || [];
  const requestFilters = useApprovalFilters(rows, {
    prefix: `br_${(kinds || []).join("_")}`, get: { name: (r) => r.employee_name, code: (r) => r.branch_name, type: (r) => r.kind_label, filed: (r) => r.created_at, requested: (r) => r.details?.effective_from || r.details?.incident_date || r.details?.work_date || r.created_at, branch: (r) => r.branch_id, employeeId: (r) => r.employee_id },
  });
  const bulkRequests = useBulkDecisions({
    entityType: "branch_request", remarkRequired: true, onDone: () => load(),
    decisions: (shared || []).map((d) => ({ decision: d, label: DECISION_LABELS[d], destructive: d === "reject" })),
    isSelectable: (r) => !readOnly && r.status === "pending" && (REQUEST_KINDS[r.kind]?.decisions || []).length > 0,
    label: (r) => `${r.employee_name || r.kind_label} request`,
    rowLabel: (r) => `${r.employee_name ? `${r.employee_name} · ` : ""}${r.kind_label} · ${requestSummary(r)}`,
    send: (r, decision, remark) => fetchJson("/api/hr/branch-requests", jsonBody("PATCH", { id: r.id, decision, remark })),
  });

  async function decide() {
    const problem = remarkProblem(remark, dialog.decision, true);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true); setError("");
    try {
      await fetchJson("/api/hr/branch-requests", jsonBody("PATCH", { id: dialog.row.id, decision: dialog.decision, remark }));
      notify("Decision Saved", "The branch Admin has been notified.", "success");
      setDialog(null);
      await load();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  // HR <-> branch Admin messages on each item (2026-11-24).
  const threadCounts = useThreadCounts("branch_admin_request", (state.data?.requests || []).map((r) => r.id), state.data);
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
          <ItemThread itemType="branch_admin_request" itemId={r.id} count={threadCounts[r.id] || 0} title={`Messages · ${r.kind_label}${r.employee_name ? ` · ${r.employee_name}` : ""}`} />
          {!readOnly && r.status === "pending" ? (REQUEST_KINDS[r.kind]?.decisions || []).map((decision) => (
            <Button key={decision} size="sm" variant={decision === "reject" ? "outline" : "default"} className={cn(decision === "reject" && "text-destructive")}
              onClick={() => { setDialog({ row: r, decision }); setRemark(EMPTY_REMARK); setError(""); }}>
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
        <CardAction className="flex flex-wrap items-center justify-end gap-2">{hasPendingState ? <FilterTabs value={tab} onValueChange={setTab} label="Request filter" options={[{ value: "pending", label: "Pending" }, { value: "decided", label: "Decided" }, { value: "all", label: "All" }]} /> : null}<Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataTable toolbar={requestFilters.toolbar}
          columns={columns} rows={requestFilters.rows} loading={state.loading && !state.data} error={state.error} onRetry={load}
          searchPlaceholder="Search employee, branch or remark…" empty={{ title: tab === "pending" && hasPendingState ? "Nothing waiting" : "Nothing here yet", icon: Icon }} caption={title} minWidth={1150}
          selection={!readOnly && shared.length ? bulkRequests.selection : null} />
        {bulkRequests.dialog}
      </CardContent>
      <Dialog open={Boolean(dialog)} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          {dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>{DECISION_LABELS[dialog.decision]} — {dialog.row.kind_label}</DialogTitle>
                <DialogDescription>{dialog.row.employee_name ? `${dialog.row.employee_name} · ` : ""}{requestSummary(dialog.row)}{dialog.row.kind === "incentive_endorsement" && dialog.decision === "approve" ? " Approving adds it to payroll now (after the month's cutoff it moves to next month)." : ""}</DialogDescription>
              </DialogHeader>
              <RemarkField id="brr-remark" decision={dialog.decision} entityType="branch_request" required label={dialog.decision === "reject" ? "Reason" : "Remark for the Admin"}
                value={remark} onChange={(v) => { setRemark(v); setError(""); }} error={error} disabled={busy} />
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
