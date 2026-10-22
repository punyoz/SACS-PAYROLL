"use client";

import * as React from "react";
import { CheckIcon, FilePenLineIcon, HistoryIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
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

/*
 * Payroll corrections after HR approval (/api/payroll/corrections,
 * src/lib/payroll/corrections.js). An approved payslip is never changed:
 * the Accountant files a correction (Payroll Records → Correct), HR approves
 * or rejects it (Payroll Approval), and it is paid or recovered on a later
 * payslip. The history of each one stays visible.
 */

const EMPTY = { kind: "underpayment", amount: "", payrolls: "1", reason: "" };

/** File a correction (record) or fix and resubmit a rejected one (correction). */
export function CorrectionDialog({ record = null, correction = null, onClose, onSaved }) {
  const { notify } = usePortalSession();
  const open = Boolean(record || correction);
  const [input, setInput] = React.useState(EMPTY);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (correction) setInput({ kind: correction.kind, amount: String(correction.amount), payrolls: String(correction.payrolls || 1), reason: correction.reason });
    else setInput(EMPTY);
    setError("");
  }, [record, correction]);

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
              <Input id="pc-amount" type="number" min="0" step="0.01" inputMode="decimal" value={input.amount} onChange={(e) => setInput((c) => ({ ...c, amount: e.target.value }))} />
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
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setNote(""); setError(""); }, [target]);
  async function decide() {
    if (target.action === "reject" && note.trim().length < 5) { setError("Give the reason for rejecting (at least 5 characters)."); return; }
    setBusy(true);
    try {
      await fetchJson("/api/payroll/corrections", jsonBody("PATCH", { id: target.row.id, action: target.action, note: note.trim() }));
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
            <div className="space-y-1.5">
              <Label htmlFor="pc-note">{target.action === "reject" ? "Reason for rejecting" : "Note (optional)"}</Label>
              <Textarea id="pc-note" rows={3} maxLength={500} value={note} onChange={(e) => { setNote(e.target.value); setError(""); }} autoFocus />
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            </div>
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
        <DataTable columns={columns} rows={rows} loading={state.loading && !state.data} error={state.error} onRetry={load} pageSize={10}
          searchPlaceholder="Search employee, branch, period or status…" empty={{ title: "No payroll corrections", icon: FilePenLineIcon }} caption="Payroll corrections" minWidth={980} />
      </CardContent>
      <DecideDialog target={decide} onClose={() => setDecide(null)} onSaved={load} />
      <CorrectionDialog correction={resubmit} onClose={() => setResubmit(null)} onSaved={load} />
      <HistoryDialog row={history} onClose={() => setHistory(null)} />
    </Card>
  );
}
