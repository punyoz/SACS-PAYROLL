"use client";

import * as React from "react";
import { CheckIcon, ClipboardCheckIcon, GiftIcon, HandCoinsIcon, Loader2Icon, RefreshCwIcon, UndoIcon, UserXIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel, money } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Approvals (/api/admin/approvals; SACS-Payroll-Permission-Matrix.md row 10a).
 * One page, three queues; what each role may do comes from the API:
 *   AWOL separations      Admin approves or returns to HR
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
    setInput({ note: "", reason: "", decision: "offset_next_subsidy", separation_effective: manilaDateKey(), balance: data?.balances?.[0]?.id || "", months: "1", label: "", amount: "", ...preset });
  }

  async function submit() {
    const { kind, row } = dialog;
    setBusy(true);
    setError("");
    try {
      let message = ["Saved", ""];
      if (kind === "separate" || kind === "return") {
        await fetchJson("/api/admin/approvals", jsonBody("PATCH", { action: "decide_awol", case_id: row.id, decision: kind === "separate" ? "approve" : "return", separation_effective: input.separation_effective, note: input.note }));
        message = kind === "separate" ? ["Separation Approved", "Paid only through final pay (Accountant)."] : ["Returned to HR", ""];
      } else if (kind === "recommend") {
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

  const awolColumns = [
    { key: "employee_name", header: "Employee", cell: (c) => <div><p className="font-medium">{c.employee_name}</p><p className="text-xs text-muted-foreground">{c.employee_code}</p></div>, searchValue: (c) => c.employee_name },
    { key: "since", header: "Absent since", cell: (c) => dateLabel(c.first_absent_on) },
    { key: "notices", header: "Notices", cell: (c) => <p className="text-xs">{c.first_notice_sent_on ? `1st ${dateLabel(c.first_notice_sent_on)}` : "—"}{c.second_notice_sent_on ? ` · 2nd ${dateLabel(c.second_notice_sent_on)}` : ""}{c.conference_on ? ` · conference ${dateLabel(c.conference_on)}` : ""}</p> },
    { key: "rec", header: "HR recommendation", cell: (c) => <p className="max-w-72 text-xs whitespace-normal">{c.recommendation}<span className="block text-muted-foreground">— {c.recommended_by_name || "HR"}{c.employee_reply ? ` · Reply: ${c.employee_reply}` : " · No reply"}</span></p> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (c) => (can.decide ? (
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="destructive" onClick={() => open("separate", c)}><CheckIcon aria-hidden="true" />Approve separation</Button>
        <Button size="sm" variant="outline" onClick={() => open("return", c)}><UndoIcon aria-hidden="true" />Return</Button>
      </div>
    ) : null) },
  ];

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
    separate: ["Approve separation", "Notice of Decision: the employee becomes Separated and is paid only through final pay (within 30 days)."],
    return: ["Return to HR", "The case goes back to the 2nd-notice stage with your note."],
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
            <CardTitle className="flex items-center gap-2"><UserXIcon className="size-4" aria-hidden="true" />AWOL separations</CardTitle>
            <CardDescription>HR sent both notices and recommends separation (abandonment).</CardDescription>
            <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
          </CardHeader>
          <CardContent>
            <DataTable columns={awolColumns} rows={data?.awol || []} loading={first} error={state.error} onRetry={load} pageSize={10}
              searchPlaceholder="Search employee…" empty={{ title: "No separations waiting", icon: ClipboardCheckIcon }} caption="AWOL separations" minWidth={900} />
          </CardContent>
        </Card>
      ) : null}

      {data?.role !== "accountant" ? (
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HandCoinsIcon className="size-4" aria-hidden="true" />Excess subsidy advances</CardTitle>
            <CardDescription>The teacher refused to sign for converting the excess to a salary deduction. HR recommends; the Admin approves.</CardDescription>
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
                {dialog.kind === "separate" ? fieldFor("eff", "Separation effective", <DatePicker id="apv-eff" value={input.separation_effective} onChange={(v) => setInput((c) => ({ ...c, separation_effective: v }))} />) : null}
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
                {["separate", "return", "approve_loan", "approve_adj", "reject_adj"].includes(dialog.kind)
                  ? fieldFor("note", dialog.kind === "return" || dialog.kind === "reject_adj" ? "Reason" : "Note (optional)", <Input id="apv-note" maxLength={1000} value={input.note} onChange={(e) => setInput((c) => ({ ...c, note: e.target.value }))} />)
                  : null}
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
                <Button onClick={submit} disabled={busy} variant={["separate", "reject_adj"].includes(dialog.kind) ? "destructive" : "default"}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Confirm</Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
