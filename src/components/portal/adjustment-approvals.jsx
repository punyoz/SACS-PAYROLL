"use client";

import * as React from "react";
import { CheckIcon, ClipboardCheckIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { EMPTY_REMARK, RemarkField, remarkProblem } from "@/components/portal/remark-field";
import { useApprovalFilters } from "@/components/portal/approval-filters";
import { useBulkDecisions } from "@/components/portal/bulk-action-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable } from "@/components/portal/data-table";
import { FilterTabs } from "@/components/portal/filter-tabs";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateTime } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Incentive & Loan Approvals (GET/PATCH /api/hr/adjustment-approvals,
 * 20261027020000): what the Accountant filed in Incentives & Overload and
 * Loans, waiting for HR. HR approves or rejects (a reason is required to
 * reject); payroll pays or deducts only approved items. The Accountant sees
 * the same list for its branch, read-only.
 */

export function AdjustmentApprovalsPanel({ refreshKey }) {
  const { notify } = usePortalSession();
  const [tab, setTab] = React.useState("pending");
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [deciding, setDeciding] = React.useState(null); // { item, decision }
  const [remark, setRemark] = React.useState(EMPTY_REMARK);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/hr/adjustment-approvals?status=all");
      if (data.available === false) throw new Error(data.error || "Approvals are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((s) => ({ loading: false, error: err.message || "Unable to load approvals.", data: s.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const canDecide = Boolean(data?.can_decide);
  const tabRows = (data?.items || []).filter((item) => (tab === "pending" ? item.approval_status === "pending" : item.approval_status !== "pending"));
  // Part F: search, type (with counts), branch, category, employment status, dates and sort (in the address).
  const filters = useApprovalFilters(tabRows, {
    prefix: "adj", get: { name: (i) => i.employee_name, code: (i) => i.employee_code, type: (i) => i.type_label, filed: (i) => i.created_at, requested: (i) => i.item_date || i.date_granted, branch: (i) => i.branch_id, employeeId: (i) => i.employee_id },
  });
  const rows = filters.rows;
  // Part F: decide several at once (one remark; each row checked and reported).
  const bulk = useBulkDecisions({
    entityType: "adjustment", decisions: [{ decision: "approve", label: "Approve" }, { decision: "reject", label: "Reject", destructive: true }], onDone: load,
    isSelectable: (i) => canDecide && i.approval_status === "pending",
    label: (i) => `${i.employee_name} ${i.type_label}`,
    rowLabel: (i) => `${i.employee_name} · ${i.type_label} · ${i.amount_label}`,
    send: (i, decision, remark) => fetchJson("/api/hr/adjustment-approvals", jsonBody("PATCH", { kind: i.kind, id: i.id, decision, remark })),
  });

  function open(item, decision) {
    setDeciding({ item, decision });
    setRemark(EMPTY_REMARK);
    setError("");
  }

  async function decide(event) {
    event.preventDefault();
    const problem = remarkProblem(remark, deciding.decision);
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      await fetchJson("/api/hr/adjustment-approvals", jsonBody("PATCH", { kind: deciding.item.kind, id: deciding.item.id, decision: deciding.decision, remark }));
      notify(deciding.decision === "approve" ? "Approved" : "Rejected",
        deciding.decision === "approve" ? (deciding.item.kind === "rule_incentive" ? "Paid once the Accountant recomputes the payslip." : "Payroll will include it.") : "It will not be paid or deducted. The Accountant is notified.", "success");
      setDeciding(null);
      await load();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    {
      key: "employee_name", header: "Employee", sortable: true, searchValue: (i) => `${i.employee_name} ${i.employee_code} ${i.branch_name}`,
      cell: (i) => <div><p className="font-medium">{i.employee_name}</p><p className="text-xs text-muted-foreground">{i.employee_code} · {i.branch_name}</p></div>,
    },
    { key: "type_label", header: "Type", cell: (i) => <StatusBadge tone={i.kind === "loan" ? "info" : "success"}>{i.type_label}</StatusBadge> },
    { key: "amount_label", header: "Amount", align: "right", className: "tabular-nums whitespace-nowrap" },
    { key: "detail", header: "Details", className: "min-w-64 whitespace-normal text-sm", searchValue: (i) => i.detail },
    { key: "filed", header: "Filed by", className: "whitespace-nowrap text-xs", cell: (i) => <div>{i.filed_by || "—"}<p className="text-muted-foreground">{i.filed_at ? dateTime(i.filed_at) : ""}</p></div> },
    {
      key: "status", header: "Status",
      cell: (i) => (
        <div className="max-w-56 space-y-1 whitespace-normal">
          <StatusBadge tone={i.approval_tone}>{i.approval_label}</StatusBadge>
          {i.approval_status !== "pending" && i.decided_by_name ? <p className="text-xs text-muted-foreground">{i.decided_by_name}{i.decided_at ? `, ${dateTime(i.decided_at)}` : ""}{i.decision_note ? `: ${i.decision_note}` : ""}</p> : null}
        </div>
      ),
    },
    ...(canDecide ? [{
      key: "act", header: <span className="sr-only">Decide</span>, align: "right",
      cell: (i) => (i.approval_status === "pending" ? (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" onClick={() => open(i, "approve")} aria-label={`Approve ${i.type_label} for ${i.employee_name}`}><CheckIcon aria-hidden="true" />Approve</Button>
          <Button size="sm" variant="outline" className="text-destructive" onClick={() => open(i, "reject")} aria-label={`Reject ${i.type_label} for ${i.employee_name}`}><XIcon aria-hidden="true" />Reject</Button>
        </div>
      ) : null),
    }] : []),
  ];

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ClipboardCheckIcon className="size-4 text-gold-text" aria-hidden="true" />Incentive & loan approvals</CardTitle>
        <CardDescription>
          Incentives, overload, loans and cash advances the Accountant filed, and the Perfect Attendance and Early Bird incentives the system computed each cutoff (marked &ldquo;system&rdquo;). Payroll pays or deducts them only once HR approves; a rejected one is kept, never paid.
          {data && !canDecide ? " Read-only: HR decides." : ""}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataTable toolbar={<><FilterTabs value={tab} onValueChange={setTab} label="Approval filter" options={[{ value: "pending", label: "Pending", count: data?.pending || undefined }, { value: "decided", label: "Decided" }]} />{filters.toolbar}</>}
          columns={columns} rows={rows} rowKey={(i) => `${i.kind}-${i.id}`} loading={state.loading && !data} error={state.error} onRetry={load} pageSize={15}
          searchPlaceholder="Search employee, type or details…" caption="Incentive and loan approvals" minWidth={1000}
          empty={{ title: tab === "pending" ? "Nothing waiting for HR" : "No decisions yet", icon: ClipboardCheckIcon }}
          selection={canDecide ? { ...bulk.selection, rowId: (i) => `${i.kind}-${i.id}` } : null} />
        {bulk.dialog}
      </CardContent>

      <Dialog open={Boolean(deciding)} onOpenChange={(o) => { if (!o && !busy) setDeciding(null); }}>
        <DialogContent className="sm:max-w-md">
          {deciding ? (
            <form onSubmit={decide} className="contents">
              <DialogHeader>
                <DialogTitle>{deciding.decision === "approve" ? "Approve" : "Reject"} {deciding.item.type_label.toLowerCase()} — {deciding.item.employee_name}</DialogTitle>
                <DialogDescription>{deciding.item.amount_label} · {deciding.item.detail}</DialogDescription>
              </DialogHeader>
              <RemarkField id="adj-remark" decision={deciding.decision} entityType="adjustment" value={remark}
                onChange={(v) => { setRemark(v); setError(""); }} error={error} disabled={busy} />
              <DialogFooter className="gap-2 sm:gap-2">
                <Button type="button" variant="outline" onClick={() => setDeciding(null)} disabled={busy}>Cancel</Button>
                <Button type="submit" disabled={busy} variant={deciding.decision === "reject" ? "destructive" : "default"}>
                  {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{deciding.decision === "approve" ? "Approve" : "Reject"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
