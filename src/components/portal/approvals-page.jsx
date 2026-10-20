"use client";

import * as React from "react";
import { CheckIcon, GiftIcon, HandCoinsIcon, HistoryIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
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
import { dateTime, money } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Subsidy Approvals (/api/admin/approvals). HR is the only approver since
 * 2026-10-20; what each role may do comes from the API:
 *   Excess subsidy advances (consent refused)  HR decides
 *   Missed-month subsidy adjustments  Accountant requests, HR approves / rejects
 *   Decision history  every decision HR made, kept for good
 */

const ADJ_TONE = { pending: "gold", approved: "info", applied: "success", rejected: "danger" };

export function ApprovalsPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [dialog, setDialog] = React.useState(null);
  const [input, setInput] = React.useState({});
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/admin/approvals");
      if (!data.available) throw new Error(data.error || "Approvals are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((c) => ({ loading: false, error: err.message || "Unable to load approvals.", data: c.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const can = data?.can || {};
  const first = state.loading && !data;

  function open(kind, row, preset = {}) {
    setDialog({ kind, row });
    setError("");
    setInput({ note: "", reason: "", decision: "offset_next_subsidy", balance: data?.balances?.[0]?.id || "", months: "1", label: "", amount: "", ...preset });
  }

  async function submit() {
    const { kind, row } = dialog;
    setBusy(true);
    setError("");
    try {
      let message = ["Saved", ""];
      if (kind === "decide_loan") {
        await fetchJson("/api/admin/approvals", jsonBody("PATCH", { action: "decide_loan_decision", loan_id: row.id, decision: input.decision, reason: input.reason }));
        message = ["Decision Saved", "It is listed under Decision history."];
      } else if (kind === "approve_adj" || kind === "reject_adj") {
        await fetchJson("/api/admin/approvals", jsonBody("PATCH", { action: "decide_adjustment", adjustment_id: row.id, decision: kind === "approve_adj" ? "approve" : "reject", note: input.note }));
        message = kind === "approve_adj" ? ["Adjustment Approved", "Paid on the next 16–end payslip."] : ["Adjustment Rejected", ""];
      } else if (kind === "request_adj") {
        const balance = data.balances.find((b) => b.id === input.balance);
        await fetchJson("/api/admin/approvals", jsonBody("POST", { action: "request_adjustment", subsidy_balance_id: input.balance, months_missed: Number(input.months), months_label: input.label, amount: input.amount || (balance ? balance.monthly * Number(input.months) : 0), reason: input.reason }));
        message = ["Adjustment Requested", "HR approves it."];
      }
      notify(message[0], message[1], "success");
      setDialog(null);
      await load();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  const loanColumns = [
    { key: "employee_name", header: "Teacher", cell: (l) => <p className="font-medium">{l.employee_name}</p>, searchValue: (l) => l.employee_name },
    { key: "excess", header: "Excess advance", align: "right", className: "tabular-nums font-semibold", cell: (l) => money(l.excess) },
    { key: "why", header: "Teacher's answer", cell: (l) => <p className="max-w-60 text-xs whitespace-normal text-muted-foreground">{l.status_reason}</p> },
    { key: "dec", header: "Decision", cell: () => <StatusBadge tone="gold">Waiting for HR</StatusBadge> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (l) => (can.decide
      ? <Button size="sm" onClick={() => open("decide_loan", l, { decision: l.decision || "offset_next_subsidy" })}>Decide</Button>
      : null) },
  ];

  const adjColumns = [
    { key: "employee_name", header: "Teacher", cell: (a) => <div><p className="font-medium">{a.employee_name}</p><p className="text-xs text-muted-foreground">{a.months_label} · {a.months_missed} month{a.months_missed === 1 ? "" : "s"}</p></div>, searchValue: (a) => `${a.employee_name} ${a.months_label}` },
    { key: "amount", header: "Amount", align: "right", className: "tabular-nums", cell: (a) => money(a.amount) },
    { key: "reason", header: "Reason", cell: (a) => <p className="max-w-64 text-xs whitespace-normal">{a.reason}<span className="block text-muted-foreground">— {a.requested_by_name}{a.decision_note ? ` · ${a.decided_by_name}: ${a.decision_note}` : ""}</span></p> },
    { key: "status", header: "Status", cell: (a) => <StatusBadge tone={ADJ_TONE[a.status] || "muted"}>{a.status === "applied" ? "Paid" : a.status[0].toUpperCase() + a.status.slice(1)}</StatusBadge> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (a) => (can.decide && a.status === "pending" ? (
      <div className="flex justify-end gap-1.5">
        <Button size="sm" onClick={() => open("approve_adj", a)}><CheckIcon aria-hidden="true" />Approve</Button>
        <Button size="sm" variant="outline" className="text-destructive" onClick={() => open("reject_adj", a)}><XIcon aria-hidden="true" />Reject</Button>
      </div>
    ) : null) },
  ];

  const historyColumns = [
    { key: "kind_label", header: "Type", cell: (h) => <StatusBadge tone={h.kind === "adjustment" ? "info" : "gold"} dot={false}>{h.kind_label}</StatusBadge>, searchValue: (h) => h.kind_label },
    { key: "employee_name", header: "Teacher", className: "font-medium", sortable: true, searchValue: (h) => h.employee_name },
    { key: "amount", header: "Amount", align: "right", className: "tabular-nums", cell: (h) => money(h.amount) },
    { key: "requested", header: "Requested by", cell: (h) => <div className="text-xs">{h.requested_by_name || "—"}{h.requested_at ? <span className="block text-muted-foreground">{dateTime(h.requested_at)}</span> : null}</div>, searchValue: (h) => h.requested_by_name },
    { key: "decision_label", header: "Decision", cell: (h) => <StatusBadge tone={h.decision === "rejected" ? "danger" : "success"}>{h.decision_label}</StatusBadge>, searchValue: (h) => h.decision_label },
    { key: "decided_by_name", header: "Decided by", sortable: true, cell: (h) => h.decided_by_name || "—", searchValue: (h) => h.decided_by_name },
    { key: "decided_at", header: "Decision date", sortable: true, className: "whitespace-nowrap", cell: (h) => (h.decided_at ? dateTime(h.decided_at) : "—") },
    { key: "reason", header: "Reason", cell: (h) => <p className="max-w-64 text-xs whitespace-normal text-muted-foreground">{h.reason || "—"}</p> },
  ];

  const titles = {
    decide_loan: ["Decide the excess advance", "The teacher refused to sign for the excess advance. Nothing is deducted from salary meanwhile. A waiver closes the advance now; the other decisions act at next year's payout, final pay, or outside payroll."],
    approve_adj: ["Approve the adjustment", "Paid once on the teacher's next 16–end payslip."],
    reject_adj: ["Reject the adjustment", "It stays on record with your reason."],
    request_adj: ["Request a missed-month adjustment", "License changes are never backdated: missed months are paid once, with HR's approval."],
  };
  const fieldFor = (id, label, el) => <div className="space-y-1.5"><Label htmlFor={`apv-${id}`}>{label}</Label>{el}</div>;
  const selectedBalance = data?.balances?.find((b) => b.id === input.balance);

  return (
    <>
      {data?.role !== "accountant" ? (
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HandCoinsIcon className="size-4" aria-hidden="true" />Excess subsidy advances</CardTitle>
            <CardDescription>The teacher refused to sign for converting the excess to a salary deduction. HR decides what happens to it.</CardDescription>
            <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
          </CardHeader>
          <CardContent>
            <DataTable columns={loanColumns} rows={data?.loan_decisions || []} loading={first} error={state.error} onRetry={load} pageSize={10}
              searchPlaceholder="Search teacher…" empty={{ title: "Nothing waiting", icon: HandCoinsIcon }} caption="Excess subsidy advances" minWidth={900} />
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><GiftIcon className="size-4" aria-hidden="true" />Missed-month subsidy adjustments</CardTitle>
            <CardDescription>Months a licensed teacher missed because verification came late. The Accountant requests; HR approves or rejects.</CardDescription>
            {can.request ? <CardAction><Button size="sm" onClick={() => open("request_adj", null)} disabled={!data?.balances?.length}>Request adjustment</Button></CardAction> : null}
          </CardHeader>
          <CardContent>
            <DataTable columns={adjColumns} rows={data?.adjustments || []} loading={first} error={state.error} onRetry={load} pageSize={10}
              searchPlaceholder="Search teacher…" empty={{ title: "No adjustments", icon: GiftIcon }} caption="Subsidy adjustments" minWidth={900} />
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HistoryIcon className="size-4" aria-hidden="true" />Decision history</CardTitle>
            <CardDescription>Every subsidy decision HR has made: who decided, when, and why. Decisions stay listed here for good.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable columns={historyColumns} rows={data?.history || []} loading={first} pageSize={10}
              searchPlaceholder="Search teacher, decision or person…" empty={{ title: "No decisions yet", icon: HistoryIcon }} caption="Subsidy decision history" minWidth={1000} />
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={Boolean(dialog)} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          {dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>{titles[dialog.kind][0]}{dialog.row?.employee_name ? ` — ${dialog.row.employee_name}` : ""}</DialogTitle>
                <DialogDescription>{titles[dialog.kind][1]}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3">
                {dialog.kind === "decide_loan" ? (
                  <>
                    {fieldFor("dec", "Decision", (
                      <Select value={input.decision} onValueChange={(v) => setInput((c) => ({ ...c, decision: v }))}>
                        <SelectTrigger id="apv-dec" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>{Object.entries(data.decisions || {}).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                      </Select>
                    ))}
                    {fieldFor("reason", "Reason", <Textarea id="apv-reason" rows={3} maxLength={1000} value={input.reason} onChange={(e) => setInput((c) => ({ ...c, reason: e.target.value }))} />)}
                  </>
                ) : null}
                {dialog.kind === "request_adj" ? (
                  <>
                    {fieldFor("bal", "Teacher", (
                      <Select value={input.balance} onValueChange={(v) => setInput((c) => ({ ...c, balance: v }))}>
                        <SelectTrigger id="apv-bal" className="w-full"><SelectValue placeholder="Select teacher" /></SelectTrigger>
                        <SelectContent>{(data.balances || []).map((b) => <SelectItem key={b.id} value={b.id}>{`${b.employee_name} — ${b.year} (${b.eligible_months} months counted)`}</SelectItem>)}</SelectContent>
                      </Select>
                    ))}
                    <div className="grid gap-3 sm:grid-cols-3">
                      {fieldFor("months", "Months missed", <Input id="apv-months" type="number" min="1" max="12" value={input.months} onChange={(e) => setInput((c) => ({ ...c, months: e.target.value }))} />)}
                      {fieldFor("label", "Which months", <Input id="apv-label" maxLength={60} placeholder="e.g. May–Jul 2027" value={input.label} onChange={(e) => setInput((c) => ({ ...c, label: e.target.value }))} />)}
                      {fieldFor("amount", "Amount (₱)", <Input id="apv-amount" type="number" min="0" step="0.01" placeholder={selectedBalance ? (selectedBalance.monthly * Number(input.months || 0)).toFixed(2) : ""} value={input.amount} onChange={(e) => setInput((c) => ({ ...c, amount: e.target.value }))} />)}
                    </div>
                    {fieldFor("reason", "Reason", <Textarea id="apv-reason" rows={3} maxLength={1000} placeholder="e.g. License valid since May 2; verification delayed" value={input.reason} onChange={(e) => setInput((c) => ({ ...c, reason: e.target.value }))} />)}
                  </>
                ) : null}
                {["approve_adj", "reject_adj"].includes(dialog.kind)
                  ? fieldFor("note", dialog.kind === "reject_adj" ? "Reason" : "Note (optional)", <Input id="apv-note" maxLength={1000} value={input.note} onChange={(e) => setInput((c) => ({ ...c, note: e.target.value }))} />)
                  : null}
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
                <Button onClick={submit} disabled={busy} variant={dialog.kind === "reject_adj" ? "destructive" : "default"}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Confirm</Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
