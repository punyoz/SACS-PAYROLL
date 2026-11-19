"use client";

import * as React from "react";
import { CheckIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel, money } from "@/lib/portal/payroll-preview";
import { dateTimeText } from "@/lib/payroll/final-pay-text";
import { FilterTabs } from "@/components/portal/filter-tabs";
import { InfoTip } from "@/components/portal/info-tip";
import { useUrlParam } from "@/components/portal/use-url-param";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { DeadlineText, FinalPayBreakdown } from "@/app/accountant/final-pay-page";

/*
 * HR → Payroll Approval → Final pay tab (/api/hr/final-pay-approvals, 20261120010000).
 * The Accountant computes and submits; HR reviews the full breakdown and
 * approves (the Final payslip, repayments, 13th month, subsidy and AWOL stamp
 * are written then, and the employee sees it) or rejects with a reason
 * (everything held is released). HR never changes an amount.
 */

const TONES = { pending: "warning", approved: "success", rejected: "danger" };
const ANY = "all";

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

/** One final pay: who, why, the deadline (while waiting), the full breakdown and HR's decision. */
function FinalPayCard({ row, onDecide }) {
  const sep = row.separation || {};
  const pending = row.status === "pending";
  // Only what is on file: an empty memo or note is left out (2026-11-20).
  const facts = [
    [pending ? "Proposed release date" : "Release date", dateLabel(row.release_on)],
    ["Monthly salary", row.salary !== null && row.salary !== undefined ? money(row.salary) : null],
    // Recorded by the Accountant on the final pay form (Pending / Cleared / Not required).
    ["Clearance", sep.clearance_status || null],
    ["Memo / reference no.", sep.reference_no || null],
    ["Net final pay", money(row.net_pay)],
  ].filter(([, v]) => v);
  return (
    <Card className="min-w-0 shadow-xs" data-testid="final-pay-approval" data-status={row.status}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {row.employee_name}
          {row.correction ? <StatusBadge tone="gold">Correction</StatusBadge> : null}
          <StatusBadge tone={TONES[row.status] || "muted"}>{row.legacy ? "Released" : row.status_label}</StatusBadge>
        </CardTitle>
        <CardDescription>
          {row.branch_name} · separated {dateLabel(row.separated_on)}{sep.type || sep.hr_reason ? ` · ${[sep.type, sep.hr_reason].filter((v, i, a) => v && a.indexOf(v) === i).join(" — ")}` : ""}
          {row.legacy ? "" : ` · submitted by ${row.submitted_by_name} on ${dateTimeText(row.submitted_at)}`}
        </CardDescription>
        {pending ? <CardAction className="text-sm">Release by <DeadlineText deadline={row.deadline} daysLeft={row.days_left} /></CardAction> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-1 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
          {facts.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted-foreground">{k}</dt><dd className="tabular-nums">{v}</dd></div>)}
          {sep.notes ? <div className="sm:col-span-2"><dt className="text-muted-foreground">Notes</dt><dd>{sep.notes}</dd></div> : null}
        </dl>
        {row.legacy ? <p className="text-sm text-muted-foreground" data-testid="legacy-label">{row.status_label}. Saved by {row.submitted_by_name || "the Accountant"}; its amounts were not changed.</p> : null}
        {row.breakdown ? <FinalPayBreakdown b={row.breakdown} leaveConversion={row.leave_conversion} /> : null}
        {row.overpayment_to_recover > 0 ? (
          <Alert className="border-warning/40 bg-warning/10" data-testid="hr-overpayment"><AlertDescription>Overpayment flagged for recovery: {money(row.overpayment_to_recover)}. Not deducted from anything; HR recovers it by hand.</AlertDescription></Alert>
        ) : null}
        {!pending && !row.legacy ? (
          <p className="text-sm" data-testid="final-pay-decision">
            {row.status === "approved" ? "Approved" : "Rejected"} by {row.decided_by_name}{row.decided_by_role === "super_admin" ? " (Super Admin, stand-in)" : ""} on {dateTimeText(row.decided_at)}
            {row.reject_reason ? <span className="block text-destructive">Reason: {row.reject_reason}</span> : null}
          </p>
        ) : null}
        {pending ? (row.can_decide ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => onDecide({ row, action: "reject" })} data-testid="fp-reject"><XIcon aria-hidden="true" />Reject</Button>
            <Button onClick={() => onDecide({ row, action: "approve" })} data-testid="fp-approve"><CheckIcon aria-hidden="true" />Approve and release</Button>
          </div>
        ) : <p className="text-sm text-muted-foreground">You cannot decide this one (your own submission or final pay, or the Super Admin view). Another HR approves it.</p>) : null}
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

const STATUS_FILTERS = [
  { value: "pending", label: "Pending HR Approval" },
  { value: "approved", label: "Released" },
  { value: "rejected", label: "Rejected by HR" },
];

/** Payroll Approval → Final pay tab: what waits first, then one card per final pay, filtered by status and branch. */
export function FinalPayApprovalsPage({ refreshKey, onChanged }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [target, setTarget] = React.useState(null);
  const [status, setStatus] = useUrlParam("fp_status", "pending");
  const [branch, setBranch] = useUrlParam("fp_branch", ANY);
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
  const branches = [...new Map(rows.map((r) => [r.branch_id, r.branch_name])).entries()].filter(([id]) => id).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const inBranch = rows.filter((r) => branch === ANY || r.branch_id === branch);
  const shown = inBranch.filter((r) => r.status === status);

  return (
    <div className="flex flex-col gap-4">
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-1">
            Final pay
            <InfoTip label="The 30-day rule">DOLE Labor Advisory 06-2020: final pay is released within 30 days of separation. The days left count until HR approves.</InfoTip>
          </CardTitle>
          <CardDescription>Approve a separated employee&apos;s final pay to release it, or send it back to the Accountant with a reason.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          <FinalPayWaitingAlert rows={inBranch} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <FilterTabs value={status} onValueChange={setStatus} label="Final pay status"
              options={STATUS_FILTERS.map((f) => ({ ...f, count: inBranch.filter((r) => r.status === f.value).length }))} />
            <Select value={branch} onValueChange={setBranch}>
              <SelectTrigger className="w-full sm:w-56" aria-label="Branch" id="fp-branch"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All branches</SelectItem>
                {branches.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {!state.loading && !shown.length ? (
            <p className="text-sm text-muted-foreground" data-testid="final-pay-empty">
              {status === "pending" ? "No final pay is waiting for approval." : status === "approved" ? "No released final pay here." : "No rejected final pay here."}
            </p>
          ) : null}
        </CardContent>
      </Card>
      {shown.map((row) => <FinalPayCard key={row.id} row={row} onDecide={setTarget} />)}
      <DecideDialog target={target} onClose={() => setTarget(null)} onSaved={() => { load(); onChanged?.(); }} />
    </div>
  );
}
