"use client";

import * as React from "react";
import { CheckIcon, GiftIcon, HandCoinsIcon, HistoryIcon, Loader2Icon, PencilIcon, RefreshCwIcon, WalletIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { useUrlParam } from "@/components/portal/use-url-param";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel, dateTime, money } from "@/lib/portal/payroll-preview";
import { nextSecondHalf } from "@/lib/payroll/loans";
import { SUBSIDY_STATUS_LABELS, SUBSIDY_STATUS_TONES } from "@/lib/payroll/subsidy-requests";
import { cn } from "@/lib/utils";

/*
 * Subsidies (/api/admin/approvals; decision of 2026-10-21): the Accountant
 * processes, HR approves. One record per item, never removed:
 *
 *   Pending → Processed → Approved → Applied to payroll   (Rejected → fixed and resubmitted → Processed)
 *
 *   Accountant  processes a missed-month adjustment, a subsidy advance, or
 *               the settlement of an excess advance; fixes and resubmits
 *               what HR rejected
 *   HR          approves or rejects (with a reason) what was processed
 *
 * The database refuses any other order or person; this screen only offers
 * the next step to the person who owns it.
 */

const STATUS_TABS = ["all", "pending", "processed", "approved", "rejected", "applied"];

export function ApprovalsPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [statusParam, setStatus] = useUrlParam("sb_status", "all");
  const status = STATUS_TABS.includes(statusParam) ? statusParam : "all";
  const [dialog, setDialog] = React.useState(null);   // { kind, row }
  const [input, setInput] = React.useState({});
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/admin/approvals");
      if (!data.available) throw new Error(data.error || "Subsidy processing is not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((c) => ({ loading: false, error: err.message || "Unable to load subsidies.", data: c.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const can = data?.can || {};
  const first = state.loading && !data;
  const requests = React.useMemo(() => data?.requests || [], [data]);
  const shown = (kind) => requests.filter((r) => r.kind === kind && (status === "all" || r.status === status));
  const waitingForHr = requests.filter((r) => r.status === "processed").length;
  const toProcess = requests.filter((r) => r.status === "pending" || r.status === "rejected").length;

  function open(kind, row = null) {
    const d = row?.details || {};
    setDialog({ kind, row });
    setError("");
    setInput({
      note: "",
      balance: row?.subsidy_balance_id || data?.balances?.[0]?.id || "",
      months: String(d.months_missed || 1),
      label: d.months_label || "",
      amount: row?.amount ? String(row.amount) : "",
      reason: row?.reason || "",
      date: d.date_granted || manilaDateKey(),
      description: d.description || "",
      option: d.option || "offset_next_subsidy",
      signed: Boolean(d.consent_signed),
      payrolls: String(d.number_of_payrolls || 3),
      start: d.start_period || nextSecondHalf(manilaDateKey()),
    });
  }

  async function submit() {
    const { kind, row } = dialog;
    setBusy(true);
    setError("");
    try {
      let message;
      if (kind === "approve" || kind === "reject") {
        if (kind === "reject" && input.note.trim().length < 5) throw new Error("Write the reason for rejecting (at least 5 characters).");
        await fetchJson("/api/admin/approvals", jsonBody("PATCH", { action: "decide", request_id: row.id, decision: kind, note: input.note.trim() }));
        message = kind === "approve" ? ["Subsidy Approved", "The Accountant has been notified."] : ["Subsidy Rejected", "It went back to the Accountant with your reason."];
      } else {
        const body = { action: "process", request_id: row?.id || null, kind, subsidy_balance_id: input.balance, loan_id: row?.loan_id || null, reason: input.reason.trim() };
        if (kind === "adjustment") {
          const balance = data.balances.find((b) => b.id === input.balance);
          body.amount = input.amount || (balance ? balance.monthly * Number(input.months) : 0);
          body.details = { months_missed: Number(input.months), months_label: input.label.trim() };
        } else if (kind === "advance") {
          body.amount = input.amount;
          body.details = { date_granted: input.date, description: input.description.trim() };
        } else {
          if (input.option === "convert" && !input.signed) throw new Error("The teacher's signed consent is required to deduct from salary.");
          body.details = input.option === "convert"
            ? { option: "convert", consent_signed: true, number_of_payrolls: Number(input.payrolls) || 1, start_period: input.start }
            : { option: input.option };
        }
        await fetchJson("/api/admin/approvals", jsonBody("POST", body));
        message = [row?.status === "rejected" ? "Resubmitted to HR" : "Processed", "HR has been notified and will approve or reject it."];
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

  const person = (name, at) => (name ? <div className="text-xs whitespace-nowrap">{name}{at ? <span className="block text-muted-foreground">{dateTime(at)}</span> : null}</div> : <span className="text-xs text-muted-foreground">—</span>);

  const columns = [
    { key: "employee_name", header: "Teacher", sortable: true, cell: (r) => <div><p className="font-medium">{r.employee_name}</p><p className="text-xs text-muted-foreground">{r.year ? `Subsidy ${r.year}` : ""}</p></div>, searchValue: (r) => `${r.employee_name} ${r.details_label}` },
    { key: "amount", header: "Amount", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.amount || 0), cell: (r) => (r.amount ? money(r.amount) : "—") },
    {
      key: "details", header: "Details", cell: (r) => (
        <div className="max-w-72 text-xs whitespace-normal">
          <p>{r.details_label}</p>
          {r.reason ? <p className="text-muted-foreground">{r.reason}</p> : null}
          {r.status === "rejected" && r.decision_note ? <p className="mt-1 text-destructive">HR: {r.decision_note}</p> : null}
          {r.applied_note ? <p className="mt-1 text-success">{r.applied_note}</p> : null}
        </div>
      ),
    },
    { key: "status", header: "Status", sortValue: (r) => r.status_label, cell: (r) => <StatusBadge tone={SUBSIDY_STATUS_TONES[r.status] || "muted"}>{r.status_label}</StatusBadge>, searchValue: (r) => r.status_label },
    { key: "requested", header: "Requested by", cell: (r) => person(r.requested_by_name, r.requested_at), searchValue: (r) => r.requested_by_name },
    { key: "processed", header: "Processed by", cell: (r) => person(r.processed_by_name, r.processed_at), searchValue: (r) => r.processed_by_name },
    { key: "decided", header: "Approved / rejected by", cell: (r) => person(r.decided_by_name, r.decided_at), searchValue: (r) => r.decided_by_name },
    {
      key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => {
        if (can.decide && r.status === "processed") {
          return (
            <div className="flex justify-end gap-1.5">
              <Button size="sm" onClick={() => open("approve", r)}><CheckIcon aria-hidden="true" />Approve</Button>
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => open("reject", r)}><XIcon aria-hidden="true" />Reject</Button>
            </div>
          );
        }
        if (can.process && (r.status === "pending" || r.status === "rejected")) {
          return <Button size="sm" variant={r.status === "rejected" ? "outline" : "default"} onClick={() => open(r.kind, r)}><PencilIcon aria-hidden="true" />{r.status === "rejected" ? "Fix & resubmit" : "Process"}</Button>;
        }
        return null;
      },
    },
  ];

  const historyColumns = [
    { key: "kind_label", header: "Type", cell: (h) => <StatusBadge tone={h.kind === "adjustment" ? "info" : "gold"} dot={false}>{h.kind_label}</StatusBadge>, searchValue: (h) => h.kind_label },
    { key: "employee_name", header: "Teacher", className: "font-medium", sortable: true, searchValue: (h) => h.employee_name },
    { key: "amount", header: "Amount", align: "right", className: "tabular-nums", cell: (h) => (h.amount ? money(h.amount) : "—") },
    { key: "processed", header: "Processed by", cell: (h) => person(h.processed_by_name, h.processed_at), searchValue: (h) => h.processed_by_name },
    { key: "decision_label", header: "Decision", cell: (h) => <StatusBadge tone={h.decision === "rejected" ? "danger" : "success"}>{h.decision_label}</StatusBadge>, searchValue: (h) => h.decision_label },
    { key: "decided", header: "Decided by", sortValue: (h) => h.decided_at || "", cell: (h) => person(h.decided_by_name, h.decided_at), searchValue: (h) => h.decided_by_name },
    { key: "reason", header: "Reason / note", cell: (h) => <p className="max-w-64 text-xs whitespace-normal text-muted-foreground">{h.reason || "—"}</p> },
  ];

  const section = (kind, icon, title, description, action = null) => {
    const Icon = icon;
    return (
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Icon className="size-4" aria-hidden="true" />{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
          {action ? <CardAction>{action}</CardAction> : null}
        </CardHeader>
        <CardContent>
          <DataTable columns={columns} rows={shown(kind)} loading={first} error={state.error} onRetry={load} pageSize={10}
            rowClassName={(r) => ((can.decide && r.status === "processed") || (can.process && ["pending", "rejected"].includes(r.status)) ? "bg-brand-gold/5" : undefined)}
            searchPlaceholder="Search teacher…" empty={{ title: status === "all" ? "Nothing here yet" : `Nothing ${SUBSIDY_STATUS_LABELS[status].toLowerCase()}`, icon }}
            caption={title} minWidth={1180} />
        </CardContent>
      </Card>
    );
  };

  const titles = {
    approve: ["Approve this subsidy", "It takes effect as processed: an adjustment is paid on the next 16–end payslip, an advance is released, a settlement is applied."],
    reject: ["Reject this subsidy", "It goes back to the Accountant with your reason, to fix and resubmit. It stays on record."],
    adjustment: ["Process a missed-month adjustment", "License changes are never backdated: missed months are paid once, after HR approves."],
    advance: ["Process a subsidy advance", "Released in cash or by bank transfer only after HR approves. Never deducted from salary."],
    excess_settlement: ["Process the excess advance", "The teacher's advances are more than the subsidy earned. Choose how it is settled; HR approves or rejects."],
  };
  const fieldFor = (id, label, el) => <div className="space-y-1.5"><Label htmlFor={`sb-${id}`}>{label}</Label>{el}</div>;
  const selectedBalance = data?.balances?.find((b) => b.id === input.balance);
  const isNew = dialog && !dialog.row;

  return (
    <>
      {data && can.decide && waitingForHr ? (
        <Alert className="border-brand-gold/40 bg-brand-gold/5"><AlertDescription>{waitingForHr} subsidy item{waitingForHr === 1 ? "" : "s"} processed by the Accountant {waitingForHr === 1 ? "is" : "are"} waiting for your approval (highlighted below).</AlertDescription></Alert>
      ) : null}
      {data && can.process && toProcess ? (
        <Alert className="border-brand-gold/40 bg-brand-gold/5"><AlertDescription>{toProcess} subsidy item{toProcess === 1 ? "" : "s"} to process or fix (highlighted below). Rejected items show HR&apos;s reason.</AlertDescription></Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={status} onValueChange={setStatus} className="overflow-x-auto">
          <TabsList className="w-max">
            {STATUS_TABS.map((s) => <TabsTrigger key={s} value={s}>{s === "all" ? "All" : SUBSIDY_STATUS_LABELS[s]}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <Button variant="outline" size="sm" className="ml-auto" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
      </div>

      {section("excess_settlement", HandCoinsIcon, "Excess subsidy advances",
        "Advances above what the teacher earned. The system raises them; the Accountant processes the settlement; HR approves or rejects.")}
      {section("adjustment", GiftIcon, "Missed-month subsidy adjustments",
        "Months a licensed teacher missed because verification came late. The Accountant processes; HR approves or rejects; payroll pays it.",
        can.process ? <Button size="sm" onClick={() => open("adjustment")} disabled={!data?.balances?.length}>Process adjustment</Button> : null)}
      {section("advance", WalletIcon, "Subsidy advances",
        "Part of the subsidy paid early. The Accountant processes; it is released only after HR approves. Never deducted from salary.",
        can.process ? <Button size="sm" onClick={() => open("advance")} disabled={!data?.balances?.length}>Process advance</Button> : null)}

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><HistoryIcon className="size-4" aria-hidden="true" />Decision history</CardTitle>
          <CardDescription>Every approval and rejection: who processed it, who decided, when, and why. Kept for good.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={historyColumns} rows={data?.history || []} loading={first} error={state.error} onRetry={load} pageSize={10}
            searchPlaceholder="Search teacher, decision or person…" empty={{ title: "No decisions yet", icon: HistoryIcon }} caption="Subsidy decision history" minWidth={1000} />
        </CardContent>
      </Card>

      <Dialog open={Boolean(dialog)} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          {dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>{titles[dialog.kind][0]}{dialog.row?.employee_name ? ` — ${dialog.row.employee_name}` : ""}</DialogTitle>
                <DialogDescription>{titles[dialog.kind][1]}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3">
                {dialog.row?.status === "rejected" && dialog.row.last_rejection ? (
                  <Alert className="border-destructive/40 bg-destructive/5"><AlertDescription><strong className="text-foreground">Rejected by {dialog.row.last_rejection.actor_name} ({dateTime(dialog.row.last_rejection.at)}):</strong> {dialog.row.last_rejection.note}</AlertDescription></Alert>
                ) : null}
                {["approve", "reject"].includes(dialog.kind) ? (
                  <>
                    <dl className="grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded-lg border bg-muted/40 px-3 py-2"><dt className="text-xs text-muted-foreground">{dialog.row.kind_label}</dt><dd className="font-semibold tabular-nums">{dialog.row.amount ? money(dialog.row.amount) : "—"}</dd></div>
                      <div className="rounded-lg border bg-muted/40 px-3 py-2"><dt className="text-xs text-muted-foreground">Processed by</dt><dd className="font-medium">{dialog.row.processed_by_name}</dd></div>
                    </dl>
                    <p className="text-sm">{dialog.row.details_label}{dialog.row.reason ? ` — ${dialog.row.reason}` : ""}</p>
                    {fieldFor("note", dialog.kind === "reject" ? "Reason for rejecting" : "Note (optional)",
                      <Textarea id="sb-note" rows={3} maxLength={1000} value={input.note} placeholder={dialog.kind === "reject" ? "Required: what the Accountant must fix" : "Kept with the approval"} onChange={(e) => { setInput((c) => ({ ...c, note: e.target.value })); setError(""); }} autoFocus />)}
                  </>
                ) : null}
                {["adjustment", "advance"].includes(dialog.kind) && isNew ? fieldFor("bal", "Teacher", (
                  <Select value={input.balance} onValueChange={(v) => setInput((c) => ({ ...c, balance: v }))}>
                    <SelectTrigger id="sb-bal" className="w-full"><SelectValue placeholder="Select teacher" /></SelectTrigger>
                    <SelectContent>{(data.balances || []).map((b) => <SelectItem key={b.id} value={b.id}>{dialog.kind === "advance" ? `${b.employee_name} — ${b.year} · up to ${money(b.advance_available)}` : `${b.employee_name} — ${b.year} (${b.eligible_months} months counted)`}</SelectItem>)}</SelectContent>
                  </Select>
                )) : null}
                {dialog.kind === "adjustment" ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-3">
                      {fieldFor("months", "Months missed", <Input id="sb-months" type="number" min="1" max="12" value={input.months} onChange={(e) => setInput((c) => ({ ...c, months: e.target.value }))} />)}
                      {fieldFor("label", "Which months", <Input id="sb-label" maxLength={60} placeholder="e.g. May–Jul 2027" value={input.label} onChange={(e) => setInput((c) => ({ ...c, label: e.target.value }))} />)}
                      {fieldFor("amount", "Amount (₱)", <Input id="sb-amount" type="number" min="0" step="0.01" placeholder={selectedBalance ? (selectedBalance.monthly * Number(input.months || 0)).toFixed(2) : ""} value={input.amount} onChange={(e) => setInput((c) => ({ ...c, amount: e.target.value }))} />)}
                    </div>
                    {fieldFor("reason", "Reason", <Textarea id="sb-reason" rows={3} maxLength={1000} placeholder="e.g. License valid since May 2; verification delayed" value={input.reason} onChange={(e) => setInput((c) => ({ ...c, reason: e.target.value }))} />)}
                  </>
                ) : null}
                {dialog.kind === "advance" ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {fieldFor("amount", "Amount (₱)", <Input id="sb-amount" type="number" min="0" step="0.01" value={input.amount} onChange={(e) => setInput((c) => ({ ...c, amount: e.target.value }))} />)}
                      {fieldFor("date", "Release date", <Input id="sb-date" type="date" value={input.date} onChange={(e) => setInput((c) => ({ ...c, date: e.target.value }))} />)}
                    </div>
                    {fieldFor("desc", "Description (optional)", <Input id="sb-desc" maxLength={200} value={input.description} onChange={(e) => setInput((c) => ({ ...c, description: e.target.value }))} />)}
                  </>
                ) : null}
                {dialog.kind === "excess_settlement" ? (
                  <>
                    <p className="text-sm">Excess to settle: <strong className="tabular-nums">{dialog.row?.amount ? money(dialog.row.amount) : "—"}</strong></p>
                    {fieldFor("opt", "Settlement", (
                      <Select value={input.option} onValueChange={(v) => setInput((c) => ({ ...c, option: v }))}>
                        <SelectTrigger id="sb-opt" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>{Object.entries(data.options || {}).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                      </Select>
                    ))}
                    {input.option === "convert" ? (
                      <>
                        <div className="grid gap-3 sm:grid-cols-2">
                          {fieldFor("payrolls", "Number of payrolls", <Input id="sb-payrolls" type="number" min="1" max="120" value={input.payrolls} onChange={(e) => setInput((c) => ({ ...c, payrolls: e.target.value }))} />)}
                          {fieldFor("start", "First payslip", <Input id="sb-start" type="date" value={input.start} onChange={(e) => setInput((c) => ({ ...c, start: e.target.value }))} />)}
                        </div>
                        <p className="text-xs text-muted-foreground">First payslip must be a 16th ({dateLabel(input.start)}).</p>
                        <label className="flex items-start gap-2 text-sm"><Checkbox checked={input.signed} onCheckedChange={(v) => setInput((c) => ({ ...c, signed: v === true }))} className="mt-0.5" /><span>The teacher signed consent to the salary deduction.</span></label>
                      </>
                    ) : null}
                    {fieldFor("reason", input.option === "convert" ? "Note" : "What the teacher said, and why you propose this", <Textarea id="sb-reason" rows={3} maxLength={1000} value={input.reason} onChange={(e) => setInput((c) => ({ ...c, reason: e.target.value }))} />)}
                  </>
                ) : null}
              </div>
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setDialog(null)} disabled={busy}>Cancel</Button>
                <Button onClick={submit} disabled={busy} variant={dialog.kind === "reject" ? "destructive" : "default"}>
                  {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
                  {dialog.kind === "approve" ? "Approve" : dialog.kind === "reject" ? "Reject" : dialog.row?.status === "rejected" ? "Resubmit to HR" : "Process and send to HR"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
