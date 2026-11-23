"use client";

import * as React from "react";
import { CheckIcon, FilePenLineIcon, HistoryIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { EMPTY_REMARK, RemarkField, remarkProblem } from "@/components/portal/remark-field";
import { useApprovalFilters } from "@/components/portal/approval-filters";
import { useBulkDecisions } from "@/components/portal/bulk-action-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateTime, moneyCompact } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { CORRECTION_KIND_LABELS, CORRECTION_STATUS_TONES } from "@/lib/payroll/corrections";
import { PESO_MAX } from "@/lib/input-limits";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { followPortalLink, portalHref } from "@/lib/portal/navigate";
import { InfoTip } from "@/components/portal/info-tip";

/*
 * Payroll corrections after HR approval (/api/payroll/corrections,
 * src/lib/payroll/corrections.js). An approved payslip is never changed:
 * the Accountant files a correction (Payroll Records → Correct), HR approves
 * or rejects it (Payroll Approval), and it is paid or recovered on a later
 * payslip. The history of each one stays visible.
 */

const EMPTY = { kind: "underpayment", amount: "", payrolls: "1", reason: "" };

/** File a correction (record) or fix and resubmit a rejected one (correction). */
export function CorrectionDialog({ record = null, correction = null, prefill = null, onClose, onSaved }) {
  const { notify } = usePortalSession();
  const open = Boolean(record || correction);
  const [input, setInput] = React.useState(EMPTY);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (correction) setInput({ kind: correction.kind, amount: String(correction.amount), payrolls: String(correction.payrolls || 1), reason: correction.reason });
    // Suggested from Action needed (a Paid 2nd half computed with an old 1st half); the Accountant reviews it.
    else if (record && prefill) setInput({ ...EMPTY, ...prefill, amount: prefill.amount ? String(prefill.amount) : "" });
    else setInput(EMPTY);
    setError("");
  }, [record, correction, prefill]);

  async function save() {
    const amount = Number(input.amount);
    if (!(amount > 0)) { setError("Enter the amount."); return; }
    if (input.reason.trim().length < 5) { setError("Give the reason (at least 5 characters)."); return; }
    setBusy(true);
    try {
      const payload = { kind: input.kind, amount, payrolls: Number(input.payrolls) || 1, reason: input.reason.trim() };
      if (correction) await fetchJson("/api/payroll/corrections", jsonBody("PATCH", { ...payload, id: correction.id, action: "resubmit" }));
      else await fetchJson("/api/payroll/corrections", jsonBody("POST", { ...payload, entry_id: record.id }));
      notify(correction ? "Correction Resubmitted" : "Correction Sent to HR", "HR approves or rejects it; an approved correction is on the next payslip.", "success");
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  const subject = record ? `${record.employee_name} — ${record.pay_period}` : correction ? `${correction.employee_name} — ${correction.period_label}` : "";
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{correction ? "Fix and resubmit correction" : "Correct an approved payslip"}</DialogTitle>
          <DialogDescription>{subject}. The approved payslip stays as it is; the correction is paid or recovered on a later payslip once HR approves it.</DialogDescription>
        </DialogHeader>
        {correction?.decision_note ? <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">HR: {correction.decision_note}</p> : null}
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pc-kind">Correction</Label>
            <Select value={input.kind} onValueChange={(kind) => setInput((c) => ({ ...c, kind }))}>
              <SelectTrigger id="pc-kind" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(CORRECTION_KIND_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pc-amount">Amount (₱)</Label>
              <Input id="pc-amount" type="number" min="0" max={PESO_MAX} step="0.01" inputMode="decimal" value={input.amount} onChange={(e) => setInput((c) => ({ ...c, amount: e.target.value }))} />
            </div>
            {input.kind === "overpayment" ? (
              <div className="space-y-1.5">
                <Label htmlFor="pc-payrolls">Recover over (payslips)</Label>
                <Input id="pc-payrolls" type="number" min="1" max="24" step="1" inputMode="numeric" value={input.payrolls} onChange={(e) => setInput((c) => ({ ...c, payrolls: e.target.value }))} />
              </div>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pc-reason">Reason</Label>
            <Textarea id="pc-reason" rows={3} maxLength={500} placeholder="e.g. Raise effective Sep 1 (memo 2026-17) was not applied" value={input.reason} onChange={(e) => setInput((c) => ({ ...c, reason: e.target.value }))} />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{correction ? "Resubmit to HR" : "Send to HR"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** HR's decision on one pending correction. */
function DecideDialog({ target, onClose, onSaved }) {
  const { notify } = usePortalSession();
  const [remark, setRemark] = React.useState(EMPTY_REMARK);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setRemark(EMPTY_REMARK); setError(""); }, [target]);
  async function decide() {
    const problem = remarkProblem(remark, target.action);
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      await fetchJson("/api/payroll/corrections", jsonBody("PATCH", { id: target.row.id, action: target.action, remark }));
      notify(target.action === "approve" ? "Correction Approved" : "Correction Rejected", target.action === "approve" ? "It is on the employee's next payslip." : "It went back to the Accountant.", "success");
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }
  const row = target?.row;
  return (
    <Dialog open={Boolean(target)} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {row ? (
          <>
            <DialogHeader>
              <DialogTitle>{target.action === "approve" ? "Approve this correction?" : "Reject this correction?"}</DialogTitle>
              <DialogDescription>{row.employee_name} — {row.period_label}: {row.kind_label}, {moneyCompact(row.amount)}{row.kind === "overpayment" && row.payrolls > 1 ? ` over ${row.payrolls} payslips` : ""}. {row.reason}</DialogDescription>
            </DialogHeader>
            <RemarkField id="pc-remark" decision={target.action} entityType="payroll_correction" label={target.action === "reject" ? "Reason for rejecting" : "Remark"}
              value={remark} onChange={(v) => { setRemark(v); setError(""); }} error={error} disabled={busy} />
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant={target.action === "reject" ? "destructive" : "default"} onClick={decide} disabled={busy}>
                {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{target.action === "approve" ? "Approve" : "Reject"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ row, onClose }) {
  return (
    <Dialog open={Boolean(row)} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Correction history</DialogTitle>
          <DialogDescription>{row ? `${row.employee_name} — ${row.period_label}` : ""}. Every step, kept for good.</DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          {(row?.history || []).map((step, i) => (
            <li key={`${step.at}-${i}`} className="rounded-md border px-3 py-2">
              <p className="font-medium capitalize">{step.action} · {step.by_name || "—"} <span className="font-normal text-muted-foreground">({String(step.role || "").replace("_", " ")})</span></p>
              <p className="text-xs text-muted-foreground">{dateTime(step.at)}{step.amount ? ` · ${step.kind} ${moneyCompact(step.amount)}` : ""}</p>
              {step.note ? <p className="mt-1">{step.note}</p> : null}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** The corrections list: the Accountant's branch (resubmit) or every branch for HR (decide). */
export function CorrectionsCard({ refreshKey, className }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  // Part F: HR decides several corrections at once (one remark; each row checked and reported).
  const bulkCorrections = useBulkDecisions({
    entityType: "payroll_correction", decisions: [{ decision: "approve", label: "Approve" }, { decision: "reject", label: "Reject", destructive: true }], onDone: () => load(),
    isSelectable: (r) => r.status === "pending",
    label: (r) => `${r.employee_name} ${r.period_label}`,
    rowLabel: (r) => `${r.employee_name} · ${r.period_label} · ${r.kind_label}`,
    send: (r, decision, remark) => fetchJson("/api/payroll/corrections", jsonBody("PATCH", { id: r.id, action: decision, remark })),
  });
  const [decide, setDecide] = React.useState(null);   // { action, row }
  const [resubmit, setResubmit] = React.useState(null);
  const [history, setHistory] = React.useState(null);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/payroll/corrections");
      setState({ loading: false, error: data.available === false ? data.error : null, data });
    } catch (err) {
      setState((c) => ({ loading: false, error: err.message || "Unable to load corrections.", data: c.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const rows = state.data?.corrections || [];
  // Part F: search, type (with counts), branch, category, employment status, dates and sort (in the address).
  const correctionFilters = useApprovalFilters(rows, {
    prefix: "pc", get: { name: (r) => r.employee_name, code: (r) => r.payslip_no, type: (r) => r.kind_label, filed: (r) => r.requested_at, requested: (r) => r.requested_at, branch: (r) => r.branch_id, employeeId: (r) => r.employee_id },
  });
  const can = state.data?.can || {};
  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => `${r.employee_name} ${r.branch_name}` },
    { key: "period_label", header: "Payslip", cell: (r) => <div className="text-xs"><p>{r.period_label}</p><p className="text-muted-foreground">{r.payslip_no || ""} · {r.branch_name}</p></div>, searchValue: (r) => r.period_label },
    { key: "kind", header: "Correction", cell: (r) => <div className="max-w-64 text-xs whitespace-normal"><p className="font-medium">{r.kind === "underpayment" ? "+" : "−"} {moneyCompact(r.amount)}{r.kind === "overpayment" && r.payrolls > 1 ? ` over ${r.payrolls} payslips` : ""}</p><p className="text-muted-foreground">{r.reason}</p></div> },
    { key: "status", header: "Status", sortValue: (r) => r.status_label, cell: (r) => <div className="text-xs"><StatusBadge tone={CORRECTION_STATUS_TONES[r.status] || "muted"}>{r.status_label}</StatusBadge>{r.decision_note ? <p className="mt-1 max-w-56 whitespace-normal text-muted-foreground">HR: {r.decision_note}</p> : null}</div>, searchValue: (r) => r.status_label },
    { key: "requested", header: "Filed", className: "whitespace-nowrap text-xs", cell: (r) => <div><p>{r.requested_by_name || "—"}</p><p className="text-muted-foreground">{dateTime(r.requested_at)}</p></div> },
    { key: "actions", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => (
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={() => setHistory(r)} aria-label={`History of ${r.employee_name}'s correction`}><HistoryIcon aria-hidden="true" /></Button>
        {can.decide && r.status === "pending" ? (
          <>
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDecide({ action: "reject", row: r })}><XIcon aria-hidden="true" />Reject</Button>
            <Button size="sm" onClick={() => setDecide({ action: "approve", row: r })}><CheckIcon aria-hidden="true" />Approve</Button>
          </>
        ) : null}
        {can.file && r.status === "rejected" ? <Button size="sm" variant="outline" onClick={() => setResubmit(r)}><FilePenLineIcon aria-hidden="true" />Fix &amp; resubmit</Button> : null}
      </div>
    ) },
  ];

  return (
    <Card className={cn("min-w-0 shadow-xs", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FilePenLineIcon className="size-4 text-gold-text" aria-hidden="true" />Payroll corrections</CardTitle>
        <CardDescription>
          {can.decide
            ? "Corrections to approved payslips, filed by the branch Accountants. An approved one is paid or recovered on the employee's next payslip; the approved payslip itself never changes."
            : "Corrections you filed to approved payslips (Payroll Records → Correct). HR approves or rejects each one."}
        </CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent>
        <DataTable toolbar={correctionFilters.toolbar} columns={columns} rows={correctionFilters.rows} loading={state.loading && !state.data} error={state.error} onRetry={load} pageSize={10}
          searchPlaceholder="Search employee, branch, period or status…" empty={{ title: "No payroll corrections", icon: FilePenLineIcon }} caption="Payroll corrections" minWidth={980}  selection={can.decide ? bulkCorrections.selection : null} />
        {bulkCorrections.dialog}
      </CardContent>
      <DecideDialog target={decide} onClose={() => setDecide(null)} onSaved={load} />
      <CorrectionDialog correction={resubmit} onClose={() => setResubmit(null)} onSaved={load} />
      <HistoryDialog row={history} onClose={() => setHistory(null)} />
    </Card>
  );
}

/*
 * A Paid 2nd half computed with an old 1st half (2026-11-16): an inline
 * warning on its Payroll Records row and its payslip, from the server's
 * needs_correction ({ reason, kind, amount, period_label }). It is gone once
 * a correction is filed. The reason (with figures) is only in the hover text.
 */
export const NEEDS_CORRECTION_LABEL = "Needs correction: computed with an old 1st half";

/** The Correct dialog's suggested values for that payslip; the Accountant reviews them. */
export function correctionPrefill(info) {
  if (!info) return null;
  return { kind: info.kind, amount: info.amount, reason: `${info.reason} after the ${info.period_label} payslip was paid.` };
}

/** The Accountant's Payroll Records address that opens the Correct dialog for this payslip. */
export function correctionHref(entryId, info) {
  const pre = correctionPrefill(info);
  return portalHref("ac-records", { correct: entryId, ...(pre?.amount ? { kind: pre.kind, amount: String(pre.amount), why: pre.reason } : {}) });
}

/** The row badge, with the way into the correction flow (`action`). */
export function NeedsCorrectionBadge({ info, action = null }) {
  if (!info) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="needs-correction">
      <StatusBadge tone="warning"><span title={info.reason}>{NEEDS_CORRECTION_LABEL}</span></StatusBadge>
      {action}
    </span>
  );
}

/** The same warning above a payslip. role: "accountant" files the correction; "hr" decides it in Payroll Approval. */
export function NeedsCorrectionNote({ info, entryId, role }) {
  if (!info) return null;
  const href = role === "accountant" ? correctionHref(entryId, info) : portalHref("hr-payroll-approval");
  return (
    <Alert className="border-warning/40 bg-warning/10" data-testid="needs-correction-note">
      <AlertDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <strong className="text-foreground">{NEEDS_CORRECTION_LABEL}</strong>
        <InfoTip label="About this correction">
          {role === "accountant"
            ? "The 1st half changed after this payslip was paid. File a correction on a later payslip."
            : "The 1st half changed after this payslip was paid. The branch Accountant files the correction; you decide it in Payroll Approval."}
          {" "}{info.reason}.
        </InfoTip>
        <a href={href} onClick={followPortalLink} className="inline-flex min-h-10 items-center font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-0">
          {role === "accountant" ? "Correct in Payroll Records" : "Corrections in Payroll Approval"}
        </a>
      </AlertDescription>
    </Alert>
  );
}
