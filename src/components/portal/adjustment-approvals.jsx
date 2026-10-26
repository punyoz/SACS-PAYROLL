"use client";

import * as React from "react";
import { CheckIcon, ClipboardCheckIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
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
  const [note, setNote] = React.useState("");
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
  const rows = (data?.items || []).filter((item) => (tab === "pending" ? item.approval_status === "pending" : item.approval_status !== "pending"));

  function open(item, decision) {
    setDeciding({ item, decision });
    setNote("");
    setError("");
  }

  async function decide(event) {
    event.preventDefault();
    if (deciding.decision === "reject" && note.trim().length < 5) { setError("Give the reason for rejecting it (at least 5 characters)."); return; }
    setBusy(true);
    try {
      await fetchJson("/api/hr/adjustment-approvals", jsonBody("PATCH", { kind: deciding.item.kind, id: deciding.item.id, decision: deciding.decision, note: note.trim() }));
      notify(deciding.decision === "approve" ? "Approved" : "Rejected",
        deciding.decision === "approve" ? "Payroll will include it." : "It will not be paid or deducted. The Accountant is notified.", "success");
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
          Incentives, overload, loans and cash advances the Accountant filed. Payroll pays or deducts them only once HR approves; a rejected one is kept, never paid.
          {data && !canDecide ? " Read-only: HR decides." : ""}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="pending">Pending{data?.pending ? ` (${data.pending})` : ""}</TabsTrigger>
            <TabsTrigger value="decided">Decided</TabsTrigger>
          </TabsList>
        </Tabs>
        <DataTable columns={columns} rows={rows} rowKey={(i) => `${i.kind}-${i.id}`} loading={state.loading && !data} error={state.error} onRetry={load} pageSize={15}
          searchPlaceholder="Search employee, type or details…" caption="Incentive and loan approvals" minWidth={1000}
          empty={{ title: tab === "pending" ? "Nothing waiting for HR" : "No decisions yet", icon: ClipboardCheckIcon }} />
      </CardContent>

      <Dialog open={Boolean(deciding)} onOpenChange={(o) => { if (!o && !busy) setDeciding(null); }}>
        <DialogContent className="sm:max-w-md">
          {deciding ? (
            <form onSubmit={decide} className="contents">
              <DialogHeader>
                <DialogTitle>{deciding.decision === "approve" ? "Approve" : "Reject"} {deciding.item.type_label.toLowerCase()} — {deciding.item.employee_name}</DialogTitle>
                <DialogDescription>{deciding.item.amount_label} · {deciding.item.detail}</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor="adj-note">{deciding.decision === "reject" ? "Reason (required)" : "Note (optional)"}</Label>
                <Textarea id="adj-note" rows={2} maxLength={500} value={note} onChange={(e) => { setNote(e.target.value); setError(""); }} autoFocus aria-invalid={Boolean(error) || undefined} />
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              </div>
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
