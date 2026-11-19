"use client";

import * as React from "react";
import { CheckIcon, Loader2Icon, RefreshCwIcon, UserMinusIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel, dateTime, money } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { DeadlineText, FinalPayBreakdown } from "@/app/accountant/final-pay-page";

/*
 * HR → Final pay approvals (/api/hr/final-pay-approvals, 20261120010000).
 * The Accountant computes and submits; HR reviews the full breakdown and
 * approves (the Final payslip, repayments, 13th month, subsidy and AWOL stamp
 * are written then, and the employee sees it) or rejects with a reason
 * (everything held is released). HR never changes an amount.
 */

const TONES = { pending: "warning", approved: "success", rejected: "danger" };

function DecideDialog({ target, onClose, onSaved }) {
  const { notify } = usePortalSession();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setReason(""); setError(""); }, [target]);
  const row = target?.row;
  async function decide() {
    if (target.action === "reject" && reason.trim().length < 5) { setError("Give the reason for rejecting (at least 5 characters)."); return; }
    setBusy(true);
    try {
      await fetchJson("/api/hr/final-pay-approvals", jsonBody("PATCH", { id: row.id, action: target.action, reason: reason.trim() }));
      notify(target.action === "approve" ? "Final Pay Approved" : "Final Pay Rejected",
        target.action === "approve" ? "Released: the employee can now see it." : "It went back to the Accountant with your reason.", "success");
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(target)} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {row ? (
          <>
            <DialogHeader>
              <DialogTitle>{target.action === "approve" ? "Approve and release this final pay?" : "Reject this final pay?"}</DialogTitle>
              <DialogDescription>
                {row.employee_name}: net {money(row.net_pay)}, release {dateLabel(row.release_on)}.{" "}
                {target.action === "approve"
                  ? "The Final payslip, loan repayments, 13th month and subsidy settlement are written now, and the employee is notified."
                  : "Nothing is written: the held loans, 13th month and subsidy are released, and the Accountant recomputes."}
              </DialogDescription>
            </DialogHeader>
            {target.action === "reject" ? (
              <div className="space-y-1.5">
                <Label htmlFor="fp-reject-reason">Reason for rejecting</Label>
                <Textarea id="fp-reject-reason" rows={3} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); setError(""); }} autoFocus />
              </div>
            ) : null}
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant={target.action === "reject" ? "destructive" : "default"} onClick={decide} disabled={busy} data-testid={`fp-confirm-${target.action}`}>
                {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{target.action === "approve" ? "Approve" : "Reject"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** One final pay waiting for HR: who, why, the deadline and the full breakdown. */
function PendingFinalPay({ row, onDecide }) {
  const sep = row.separation || {};
  return (
    <Card className="min-w-0 shadow-xs" data-testid="final-pay-approval">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">{row.employee_name}{row.correction ? <StatusBadge tone="gold">Correction</StatusBadge> : null}<StatusBadge tone="warning">Pending HR Approval</StatusBadge></CardTitle>
        <CardDescription>
          {row.branch_name} · separated {dateLabel(row.separated_on)}{sep.type || sep.hr_reason ? ` · ${[sep.type, sep.hr_reason].filter(Boolean).join(" — ")}` : ""}
          {" · "}submitted by {row.submitted_by_name} {dateTime(row.submitted_at)}
        </CardDescription>
        <CardAction className="text-sm">Release by <DeadlineText deadline={row.deadline} daysLeft={row.days_left} /></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-1 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
          {[
            ["Proposed release date", dateLabel(row.release_on)],
            ["Monthly salary", row.salary !== null ? money(row.salary) : "—"],
            ["Clearance", sep.clearance_status || "—"],
            ["Memo / reference no.", sep.reference_no || "—"],
          ].map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted-foreground">{k}</dt><dd className="tabular-nums">{v}</dd></div>)}
          {sep.notes ? <div className="sm:col-span-2"><dt className="text-muted-foreground">Notes</dt><dd>{sep.notes}</dd></div> : null}
        </dl>
        {row.breakdown ? <FinalPayBreakdown b={row.breakdown} leaveConversion={row.leave_conversion} /> : null}
        {row.overpayment_to_recover > 0 ? (
          <Alert className="border-warning/40 bg-warning/10" data-testid="hr-overpayment"><AlertDescription>Overpayment flagged for recovery: {money(row.overpayment_to_recover)}. Not deducted from anything; HR recovers it by hand.</AlertDescription></Alert>
        ) : null}
        {row.can_decide ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => onDecide({ row, action: "reject" })} data-testid="fp-reject"><XIcon aria-hidden="true" />Reject</Button>
            <Button onClick={() => onDecide({ row, action: "approve" })} data-testid="fp-approve"><CheckIcon aria-hidden="true" />Approve and release</Button>
          </div>
        ) : <p className="text-sm text-muted-foreground">You cannot decide this one (your own submission or final pay, or the Super Admin view). Another HR approves it.</p>}
      </CardContent>
    </Card>
  );
}

/** "Final pay waiting for approval" with days left (HR's Action needed). */
export function FinalPayWaitingAlert({ rows, onOpen = null }) {
  const pending = (rows || []).filter((r) => r.status === "pending");
  if (!pending.length) return null;
  const overdue = pending.filter((r) => r.days_left < 0);
  return (
    <Alert className="border-warning/40 bg-warning/10" data-testid="hr-final-pay-action-needed">
      <AlertDescription className="w-full space-y-1">
        <p className="font-semibold text-foreground">Action needed: final pay waiting for approval ({pending.length})</p>
        <ul className="space-y-1 text-sm">
          {pending.map((r) => <li key={r.id}><span className="font-medium">{r.employee_name}</span> <span className="text-muted-foreground">· {r.branch_name}</span> · <DeadlineText deadline={r.deadline} daysLeft={r.days_left} /></li>)}
        </ul>
        {overdue.length ? <p className="text-sm text-destructive">Overdue: {overdue.map((r) => r.employee_name).join(", ")}</p> : null}
        {onOpen ? <Button size="sm" variant="outline" onClick={onOpen}>Open Final pay approvals</Button> : null}
      </AlertDescription>
    </Alert>
  );
}

/** The HR dashboard's final pay Action needed (nothing when none waits). */
export function FinalPayWaitingCard({ refreshKey, onOpen }) {
  const [rows, setRows] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    fetchJson("/api/hr/final-pay-approvals").then((d) => { if (!cancelled) setRows(d?.rows || []); }).catch(() => null);
    return () => { cancelled = true; };
  }, [refreshKey]);
  return <FinalPayWaitingAlert rows={rows} onOpen={onOpen} />;
}

export function FinalPayApprovalsPage({ refreshKey, onChanged, compact = false }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [target, setTarget] = React.useState(null);
  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, data: await fetchJson("/api/hr/final-pay-approvals") });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  const rows = state.data?.rows || [];
  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, cell: (r) => <div><p className="font-medium">{r.employee_name}</p><p className="text-xs text-muted-foreground">{r.branch_name} · separated {dateLabel(r.separated_on)}</p></div>, searchValue: (r) => `${r.employee_name} ${r.branch_name}` },
    { key: "status", header: "Status", cell: (r) => <div><StatusBadge tone={TONES[r.status] || "muted"}>{r.legacy ? "Released" : r.status_label}</StatusBadge>{r.legacy ? <p className="text-xs text-muted-foreground" data-testid="legacy-label">{r.status_label}</p> : null}{r.correction ? <p className="text-xs text-muted-foreground">Correction</p> : null}</div> },
    { key: "net_pay", header: "Net", align: "right", className: "tabular-nums", cell: (r) => money(r.net_pay) },
    { key: "release_on", header: "Release date", cell: (r) => dateLabel(r.release_on) },
    { key: "decided", header: "Decision", cell: (r) => (r.legacy ? <span className="text-xs text-muted-foreground">Saved by {r.submitted_by_name || "the Accountant"}</span> : (
      <div className="max-w-xs text-xs whitespace-normal">
        <p>{r.decided_by_name}{r.decided_by_role === "super_admin" ? " (Super Admin, stand-in)" : ""} · {dateTime(r.decided_at)}</p>
        {r.reject_reason ? <p className="text-destructive">{r.reject_reason}</p> : null}
      </div>
    )) },
  ];

  return (
    <div className={cn("flex flex-col gap-4", compact && "gap-3")}>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Final pay approvals</CardTitle>
          <CardDescription>
            The Accountant computes each separated employee&apos;s final pay and sends it here. Approving releases it to the employee; rejecting sends it back with your reason.
            Release within 30 days of separation (DOLE Labor Advisory 06-2020).{state.data?.branch_name ? ` Your branch: ${state.data.branch_name}.` : ""}
          </CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          {!state.loading && !pending.length ? <p className="text-sm text-muted-foreground">No final pay is waiting for approval.</p> : null}
          <FinalPayWaitingAlert rows={rows} />
        </CardContent>
      </Card>
      {pending.map((row) => <PendingFinalPay key={row.id} row={row} onDecide={setTarget} />)}
      {compact ? null : (
        <Card className="min-w-0 shadow-xs">
          <CardHeader><CardTitle>Final pay history</CardTitle><CardDescription>Approved, rejected, and the final pay released before HR approval was required.</CardDescription></CardHeader>
          <CardContent>
            <DataTable columns={columns} rows={decided} loading={state.loading && !state.data} error={state.error} onRetry={load} pageSize={10}
              searchPlaceholder="Search employee or branch…" empty={{ title: "No final pay decided yet", icon: UserMinusIcon }} caption="Final pay history" minWidth={720} />
          </CardContent>
        </Card>
      )}
      <DecideDialog target={target} onClose={() => setTarget(null)} onSaved={() => { load(); onChanged?.(); }} />
    </div>
  );
}
