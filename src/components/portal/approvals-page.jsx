"use client";

import * as React from "react";
import { CheckIcon, GiftIcon, HandCoinsIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
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
import { money } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Approvals (/api/admin/approvals; SACS-Payroll-Permission-Matrix.md row 10a).
 * One page, two queues; what each role may do comes from the API
 * (AWOL separations are decided by HR on its AWOL Cases page):
 *   Excess subsidy advances (consent refused)  HR recommends, Admin approves
 *   Missed-month subsidy adjustments  Accountant requests, Admin approves / rejects
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
      setState({ loading: false, error: err.message || "Unable to load approvals.", data: null });
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
      if (kind === "recommend") {
        await fetchJson("/api/admin/approvals", jsonBody("PATCH", { action: "recommend_loan_decision", loan_id: row.id, decision: input.decision, reason: input.reason }));
        message = ["Recommendation Sent", "The branch Admin approves it."];
      } else if (kind === "approve_loan") {
        await fetchJson("/api/admin/approvals", jsonBody("PATCH", { action: "approve_loan_decision", loan_id: row.id, note: input.note }));
        message = ["Decision Approved", ""];
      } else if (kind === "approve_adj" || kind === "reject_adj") {
        await fetchJson("/api/admin/approvals", jsonBody("PATCH", { action: "decide_adjustment", adjustment_id: row.id, decision: kind === "approve_adj" ? "approve" : "reject", note: input.note }));
        message = kind === "approve_adj" ? ["Adjustment Approved", "Paid on the next 16–end payslip."] : ["Adjustment Rejected", ""];
      } else if (kind === "request_adj") {
        const balance = data.balances.find((b) => b.id === input.balance);
        await fetchJson("/api/admin/approvals", jsonBody("POST", { action: "request_adjustment", subsidy_balance_id: input.balance, months_missed: Number(input.months), months_label: input.label, amount: input.amount || (balance ? balance.monthly * Number(input.months) : 0), reason: input.reason }));
        message = ["Adjustment Requested", "The branch Admin approves it."];
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
    { key: "dec", header: "Decision", cell: (l) => (l.decision_label ? <div><StatusBadge tone={l.decision_approved_at ? "success" : "gold"}>{l.decision_approved_at ? "Approved" : "Recommended"}</StatusBadge><p className="mt-1 text-xs">{l.decision_label}</p><p className="max-w-60 text-xs whitespace-normal text-muted-foreground">{l.decision_reason} — {l.decision_recommended_by_name}</p></div> : <StatusBadge tone="muted">Waiting for HR</StatusBadge>) },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (l) => {
      if (can.recommend && !l.decision_approved_at) return <Button size="sm" onClick={() => open("recommend", l, { decision: l.decision || "offset_next_subsidy" })}>{l.decision ? "Change" : "Recommend"}</Button>;
      if (can.decide && l.decision && !l.decision_approved_at) return <Button size="sm" onClick={() => open("approve_loan", l)}><CheckIcon aria-hidden="true" />Approve</Button>;
      return null;
    } },
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

  const titles = {
    recommend: ["Recommend a decision", "The teacher refused to sign for the excess advance. Nothing is deducted from salary meanwhile."],
    approve_loan: ["Approve HR's recommendation", "A waiver closes the advance now; the other decisions act at next year's payout, final pay, or outside payroll."],
    approve_adj: ["Approve the adjustment", "Paid once on the teacher's next 16–end payslip."],
    reject_adj: ["Reject the adjustment", "It stays on record with your reason."],
    request_adj: ["Request a missed-month adjustment", "License changes are never backdated: missed months are paid once, with the Admin's approval."],
  };
  const fieldFor = (id, label, el) => <div className="space-y-1.5"><Label htmlFor={`apv-${id}`}>{label}</Label>{el}</div>;
  const selectedBalance = data?.balances?.find((b) => b.id === input.balance);

  return (
    <>
      {data?.role !== "accountant" ? (
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HandCoinsIcon className="size-4" aria-hidden="true" />Excess subsidy advances</CardTitle>
            <CardDescription>The teacher refused to sign for converting the excess to a salary deduction. HR recommends; the Admin approves.</CardDescription>
            <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
          </CardHeader>
          <CardContent>
            <DataTable columns={loanColumns} rows={data?.loan_decisions || []} loading={first} error={state.error} onRetry={load} pageSize={10}
              searchPlaceholder="Search teacher…" empty={{ title: "Nothing waiting", icon: HandCoinsIcon }} caption="Excess subsidy advances" minWidth={900} />
          </CardContent>
        </Card>
      ) : null}

      {data?.role !== "hr" ? (
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><GiftIcon className="size-4" aria-hidden="true" />Missed-month subsidy adjustments</CardTitle>
            <CardDescription>Months a licensed teacher missed because verification came late. The Accountant requests; the Admin approves.</CardDescription>
            {can.request ? <CardAction><Button size="sm" onClick={() => open("request_adj", null)} disabled={!data?.balances?.length}>Request adjustment</Button></CardAction> : null}
          </CardHeader>
          <CardContent>
            <DataTable columns={adjColumns} rows={data?.adjustments || []} loading={first} error={state.error} onRetry={load} pageSize={10}
              searchPlaceholder="Search teacher…" empty={{ title: "No adjustments", icon: GiftIcon }} caption="Subsidy adjustments" minWidth={900} />
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
                {dialog.kind === "recommend" ? (
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
                {["approve_loan", "approve_adj", "reject_adj"].includes(dialog.kind)
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
