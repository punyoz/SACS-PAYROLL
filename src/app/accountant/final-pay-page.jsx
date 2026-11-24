"use client";

import * as React from "react";
import { FileCheck2Icon, Loader2Icon, RefreshCwIcon, UserMinusIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel, money } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { lineLabel } from "@/lib/payroll/final-pay-text";
import { DotLoader } from "@/components/galaxy/dot-loader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

/*
 * Final Pay (/api/accountant/final-pay; docs/payroll-schedule-loans-awol.md
 * §5.4). For employees the branch Admin separated (AWOL) — paid only through
 * final pay, within 30 days. The breakdown is computed on the server and
 * submitted for HR approval (20261120010000): HR's approval writes the Final
 * payslip with its loan repayments, 13th month and subsidy in one transaction.
 */

/** Sum of the lines of these kinds. */
function sumKinds(lines, kinds) {
  return (lines || []).filter((l) => kinds.includes(l.kind)).reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
}
/** A deduction, shown below zero (alpha test A8): "-₱ 1,000.00". */
function negative(amount) {
  const n = Math.abs(Number(amount) || 0);
  return n ? `-${money(n)}` : money(0);
}

const LABELS = {
  salary: "Unpaid salary", thirteenth_month: "Pro-rated 13th month", subsidy: "Licensed teacher subsidy",
  sss: "SSS", philhealth: "PhilHealth", pagibig: "Pag-IBIG", withholding_tax: "Withholding tax",
  carry_over: "Carry-over owed", loan: "Loan balance", year_end_tax: "Year-end tax adjustment",
};

/** The final pay lines and totals (Accountant and HR's approval screen show the same table). */
export function FinalPayBreakdown({ b, leaveConversion = null }) {
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>How</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
          <TableBody>
            {b.earnings.filter((e) => e.kind !== "leave_conversion").map((e, i) => (
              <TableRow key={`e${i}`}><TableCell>+ {lineLabel(LABELS[e.kind] || e.kind, e.month_key)}</TableCell><TableCell className="max-w-md text-xs whitespace-normal text-muted-foreground">{e.note}</TableCell><TableCell className="text-right tabular-nums">{money(e.amount)}</TableCell></TableRow>
            ))}
            {b.deductions.map((d, i) => (
              <TableRow key={`d${i}`}><TableCell>{d.credit ? "+" : "−"} {lineLabel(d.label || LABELS[d.kind] || d.kind, d.month_key)}</TableCell><TableCell className="max-w-md text-xs whitespace-normal text-muted-foreground">{d.note || ""}</TableCell><TableCell className="text-right tabular-nums">{d.credit ? money(d.amount) : negative(d.amount)}</TableCell></TableRow>
            ))}
            {/* Its own line, never mixed in: off until the school confirms its rule. */}
            {leaveConversion ? (
              <TableRow data-testid="leave-conversion" className={leaveConversion.enabled ? "" : "text-muted-foreground"}>
                <TableCell>Unused leave conversion <span className={cn("ml-1 rounded px-1.5 text-xs", leaveConversion.enabled ? "bg-success/15 text-success" : "bg-muted")}>{leaveConversion.enabled ? "On" : "Off"}</span></TableCell>
                <TableCell className="max-w-md text-xs whitespace-normal">
                  {leaveConversion.enabled
                    ? `${leaveConversion.paid_days} of ${leaveConversion.days} unused day${Number(leaveConversion.days) === 1 ? "" : "s"} × ${money(leaveConversion.daily)}. `
                    : `${leaveConversion.days} unused day${Number(leaveConversion.days) === 1 ? "" : "s"} × ${money(leaveConversion.daily)} would be ${money(leaveConversion.would_be)}. `}
                  {leaveConversion.note}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(leaveConversion.amount || 0)}</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
          <TableFooter>
            <TableRow><TableCell colSpan={2}>Final pay</TableCell><TableCell className="text-right font-semibold tabular-nums">{money(b.net_pay)}</TableCell></TableRow>
            {b.overpayment_to_recover > 0 ? (
              <TableRow data-testid="overpayment-to-recover" className="text-warning">
                <TableCell colSpan={2}>Overpayment to recover <span className="block text-xs font-normal text-muted-foreground">Not deducted from anything. HR recovers it by hand.</span></TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{money(b.overpayment_to_recover)}</TableCell>
              </TableRow>
            ) : null}
          </TableFooter>
        </Table>
      </div>
      {b.subsidy && (b.subsidy.forfeited > 0 || b.subsidy.excess > 0) ? (
        <p className="text-sm text-muted-foreground">Licensed teacher subsidy: {b.subsidy.forfeited > 0 ? `${money(b.subsidy.forfeited)} forfeited (dismissal rule). ` : ""}{b.subsidy.excess > 0 ? `${money(b.subsidy.excess)} advanced above what was earned is recovered as a loan balance.` : ""}</p>
      ) : null}
      {b.uncovered.length ? (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertDescription>{b.uncovered.map((u) => `${money(u.amount)} not covered (${u.reason})`).join("; ")}. Approval leaves it on the loan as &quot;Separated – for collection&quot;; send a demand letter.</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/** Days left on the 30-day deadline: red at 7 days or fewer, and once overdue. */
export function DeadlineText({ deadline, daysLeft }) {
  return <span className={cn(daysLeft <= 7 && "font-medium text-destructive")} data-testid="final-pay-deadline">{dateLabel(deadline)} ({daysLeft < 0 ? `${-daysLeft} days overdue` : `${daysLeft} days left`})</span>;
}

/** The final pay's state for the list (20261120010000). */
function FinalPayState({ p }) {
  if (p.final_pay) {
    return (
      <div>
        <StatusBadge tone="success">{p.final_pay.legacy ? "Released" : "Paid"}</StatusBadge>
        <p className="text-xs text-muted-foreground">{p.final_pay.payslip_no} · net {money(p.final_pay.net_pay)} · released {dateLabel(p.final_pay.release_on)}</p>
        {p.final_pay.legacy ? <p className="text-xs text-muted-foreground" data-testid="legacy-label">{p.final_pay.status_label}</p> : null}
        {p.final_pay.approval ? <p className="text-xs text-muted-foreground">Approved by {p.final_pay.approval.approved_by_name}</p> : null}
        {p.submission?.status === "pending" ? <p className="text-xs text-warning">Correction pending HR approval</p> : null}
        {p.submission?.status === "rejected" && p.submission.correction ? <p className="text-xs text-destructive">Correction rejected by HR: {p.submission.reject_reason}</p> : null}
        {p.final_pay.overpayment_to_recover > 0 ? <p className="text-xs text-warning" data-testid="saved-overpayment">Overpayment to recover: {money(p.final_pay.overpayment_to_recover)}</p> : null}
      </div>
    );
  }
  if (p.submission?.status === "pending") {
    return <div><StatusBadge tone="warning">Pending HR approval</StatusBadge><p className="text-xs text-muted-foreground">Net {money(p.submission.net_pay)} · release {dateLabel(p.submission.release_on)} · locked</p></div>;
  }
  if (p.submission?.status === "rejected") {
    return <div data-testid="rejected-final-pay"><StatusBadge tone="danger">Returned by HR</StatusBadge><p className="max-w-xs text-xs whitespace-normal text-destructive">{p.submission.reject_reason}</p><p className="text-xs text-muted-foreground">by {p.submission.decided_by_name}</p></div>;
  }
  return <StatusBadge tone="gold">Not yet</StatusBadge>;
}

/** Action needed (final pay only): rejected by HR, not yet computed, overdue. */
function FinalPayActionNeeded({ people, onOpen }) {
  const rejected = people.filter((p) => !p.final_pay && p.submission?.status === "rejected");
  const notYet = people.filter((p) => !p.final_pay && !p.submission);
  const overdue = people.filter((p) => !p.final_pay && p.days_left < 0);
  if (!rejected.length && !notYet.length && !overdue.length) return null;
  const item = (p, text) => (
    <li key={`${text}-${p.id}`} className="flex flex-wrap items-center justify-between gap-2">
      <span><span className="font-medium">{p.full_name}</span> <span className="text-muted-foreground">· {text}</span> · <DeadlineText deadline={p.deadline} daysLeft={p.days_left} /></span>
      <Button size="sm" variant="outline" onClick={() => onOpen(p)}>{p.submission?.status === "rejected" ? "Recompute" : "Compute"}</Button>
    </li>
  );
  return (
    <Alert className="border-warning/40 bg-warning/10" data-testid="final-pay-action-needed">
      <AlertDescription className="w-full space-y-2">
        <p className="font-semibold text-foreground">Action needed</p>
        {rejected.length ? <div><p className="text-sm font-medium">Final pay rejected by HR</p><ul className="space-y-1 text-sm">{rejected.map((p) => item(p, `HR: ${p.submission.reject_reason}`))}</ul></div> : null}
        {notYet.length ? <div><p className="text-sm font-medium">Final pay not yet computed</p><ul className="space-y-1 text-sm">{notYet.map((p) => item(p, "not computed"))}</ul></div> : null}
        {overdue.length ? <p className="text-sm text-destructive">Overdue (past 30 days, not yet approved by HR): {overdue.map((p) => p.full_name).join(", ")}</p> : null}
      </AlertDescription>
    </Alert>
  );
}

/** The dashboard's final pay Action needed (nothing when all is done). */
export function FinalPayActionNeededCard({ refreshKey, onOpen }) {
  const [people, setPeople] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    fetchJson("/api/accountant/final-pay").then((d) => { if (!cancelled && d?.can_edit) setPeople(d.people || []); }).catch(() => null);
    return () => { cancelled = true; };
  }, [refreshKey]);
  return <FinalPayActionNeeded people={people} onOpen={() => onOpen?.()} />;
}

export function FinalPayPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [selected, setSelected] = React.useState(null);
  const [detail, setDetail] = React.useState({ loading: false, error: null, data: null });
  const [releaseOn, setReleaseOn] = React.useState(manilaDateKey());
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, data: await fetchJson("/api/accountant/final-pay") });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  async function open(person, correction = false) {
    setSelected({ ...person, correction });
    setDetail({ loading: true, error: null, data: null });
    try {
      setDetail({ loading: false, error: null, data: await fetchJson(`/api/accountant/final-pay?employee_id=${encodeURIComponent(person.id)}${correction ? "&correction=1" : ""}`) });
    } catch (error) {
      setDetail({ loading: false, error: error.message, data: null });
    }
  }

  const [sep, setSep] = React.useState({ type: "", reference_no: "", clearance_status: "Pending", notes: "" });
  React.useEffect(() => {
    const d = detail.data?.separation;
    setSep({ type: d?.type || "", reference_no: "", clearance_status: "Pending", notes: "" });
  }, [detail.data]);

  async function save() {
    const b = detail.data.breakdown;
    const ok = await confirm({
      title: `Submit ${selected.full_name}'s final pay${selected.correction ? " correction" : ""} for HR approval?`,
      description: `Net ${money(b.net_pay)}, proposed release ${dateLabel(releaseOn)}. It is locked while HR reviews it; its loan repayments, 13th month and subsidy are held. The employee sees it only after HR approves.`,
      confirmLabel: "Submit for HR approval",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await fetchJson("/api/accountant/final-pay", jsonBody("POST", { employee_id: selected.id, release_on: releaseOn, separation: sep, ...(selected.correction ? { correction: true } : {}) }));
      notify("Sent to HR", `Final pay pending HR approval · net ${money(result.net_pay)}`, "success");
      setSelected(null);
      await load();
    } catch (error) {
      notify("Not Saved", error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    { key: "full_name", header: "Employee", sortable: true, cell: (p) => <div><p className="font-medium">{p.full_name}</p><p className="text-xs text-muted-foreground">{p.employee_id}</p></div>, searchValue: (p) => p.full_name },
    { key: "separated_on", header: "Separated", cell: (p) => dateLabel(p.separated_on) },
    // The deadline runs until HR approves (DOLE Labor Advisory 06-2020).
    { key: "deadline", header: "Release by", cell: (p) => (p.final_pay ? "—" : <DeadlineText deadline={p.deadline} daysLeft={p.days_left} />) },
    { key: "status", header: "Final pay", cell: (p) => <FinalPayState p={p} /> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (p) => {
      if (!state.data?.can_edit || p.submission?.status === "pending") return null;
      if (p.final_pay) return <Button size="sm" variant="outline" onClick={() => open(p, true)}>Correct</Button>;
      return <Button size="sm" onClick={() => open(p)}>{p.submission?.status === "rejected" ? "Recompute & resubmit" : "Compute final pay"}</Button>;
    } },
  ];

  const b = detail.data?.breakdown;
  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Separated employees</CardTitle>
          <CardDescription>Final pay is released within 30 days of separation, after clearance. HR approves each final pay before the employee sees it.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.data?.can_edit ? <FinalPayActionNeeded people={state.data?.people || []} onOpen={(p) => open(p)} /> : null}
          <DataTable columns={columns} rows={state.data?.people || []} loading={state.loading && !state.data} error={state.error} onRetry={load} pageSize={10}
            searchPlaceholder="Search employee…" empty={{ title: "No separated employees", icon: UserMinusIcon }} caption="Separated employees" minWidth={760} />
        </CardContent>
      </Card>

      {selected ? (
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileCheck2Icon className="size-4" aria-hidden="true" />{selected.correction ? "Correct final pay" : "Final pay"} — {selected.full_name}</CardTitle>
            <CardDescription>Separated {dateLabel(selected.separated_on)}{detail.data ? ` · monthly ${money(detail.data.salary)} · daily ${money(detail.data.daily)}` : ""}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {detail.loading ? <p className="text-sm text-muted-foreground"><DotLoader className="mr-2" />Computing…</p> : null}
            {detail.error ? <p className="text-sm text-destructive">{detail.error}</p> : null}
            {b ? (
              <>
                {/* Summary before generating (alpha test A7). */}
                <dl data-testid="final-pay-summary" className="grid gap-x-6 gap-y-1 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
                  {[
                    ["Last working day", dateLabel(selected.separated_on)],
                    ["Unpaid salary", money(sumKinds(b.earnings, ["salary"]))],
                    ["Pro-rated 13th month", money(sumKinds(b.earnings, ["thirteenth_month"]))],
                    ["Loans and cash advances", negative(sumKinds(b.deductions, ["loan", "cash_advance"]))],
                    ["Government contributions", negative(sumKinds(b.deductions, ["sss", "philhealth", "pagibig"]))],
                    ["Withholding tax", negative(sumKinds(b.deductions.filter((d) => !d.credit), ["withholding_tax", "year_end_tax"]))],
                  ].map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted-foreground">{k}</dt><dd className="tabular-nums">{v}</dd></div>)}
                  <div className="flex justify-between gap-3 border-t pt-1 font-semibold sm:col-span-2"><dt>Net final pay</dt><dd className="tabular-nums">{money(b.net_pay)}</dd></div>
                </dl>
                <FinalPayBreakdown b={b} leaveConversion={detail.data?.leave_conversion} />
                <p className="text-xs text-muted-foreground">Tax is withheld per month on the monthly table; the year-end tax annualization settles any difference.</p>
                <fieldset data-testid="separation-details" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
                  <legend className="px-1 text-sm font-medium">Separation details (kept with the Final Pay record)</legend>
                  <p className="text-sm sm:col-span-2"><span className="text-muted-foreground">Separated on</span> {dateLabel(selected.separated_on)}{detail.data?.separation?.hr_reason ? ` · HR: ${detail.data.separation.hr_reason}` : ""}{detail.data?.separation?.recorded_by ? ` · recorded by ${detail.data.separation.recorded_by}${detail.data.separation.recorded_at ? ` on ${dateLabel(String(detail.data.separation.recorded_at).slice(0, 10))}` : ""}` : ""}</p>
                  <div className="space-y-1.5">
                    <Label htmlFor="fp-type">Type of separation</Label>
                    <Select value={sep.type || undefined} onValueChange={(v) => setSep((c) => ({ ...c, type: v }))}>
                      <SelectTrigger id="fp-type" className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
                      <SelectContent>{(detail.data?.separation_types || []).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="fp-ref">Memo / reference no.</Label>
                    <Input id="fp-ref" maxLength={80} value={sep.reference_no} onChange={(e) => setSep((c) => ({ ...c, reference_no: e.target.value }))} placeholder="e.g. HR-2026-114" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="fp-clearance">Clearance status</Label>
                    <Select value={sep.clearance_status} onValueChange={(v) => setSep((c) => ({ ...c, clearance_status: v }))}>
                      <SelectTrigger id="fp-clearance" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{(detail.data?.clearance_statuses || ["Pending", "Cleared", "Not required"]).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="fp-notes">Notes</Label>
                    <Textarea id="fp-notes" rows={2} maxLength={1000} value={sep.notes} onChange={(e) => setSep((c) => ({ ...c, notes: e.target.value }))} />
                  </div>
                </fieldset>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1.5"><Label htmlFor="fp-release">Proposed release date</Label><DatePicker id="fp-release" value={releaseOn} onChange={setReleaseOn} /></div>
                  {state.data?.can_edit ? <Button onClick={save} disabled={busy} data-testid="generate-final-pay">{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Submit for HR approval</Button> : <p className="text-sm text-muted-foreground">View only: the Accountant computes final pay and HR approves it.</p>}
                  <Button variant="outline" onClick={() => setSelected(null)}>Close</Button>
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {confirmDialog}
    </>
  );
}
