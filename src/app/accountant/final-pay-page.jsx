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

/*
 * Final Pay (/api/accountant/final-pay; docs/payroll-schedule-loans-awol.md
 * §5.4). For employees the branch Admin separated (AWOL) — paid only through
 * final pay, within 30 days. The breakdown is computed on the server and
 * saved as a Final payslip with the loan repayments in the same transaction.
 */

const LABELS = {
  salary: "Unpaid salary", thirteenth_month: "Pro-rated 13th month", subsidy: "Licensed teacher subsidy",
  sss: "SSS", philhealth: "PhilHealth", pagibig: "Pag-IBIG", withholding_tax: "Withholding tax",
  carry_over: "Carry-over owed", loan: "Loan balance",
};

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

  async function open(person) {
    setSelected(person);
    setDetail({ loading: true, error: null, data: null });
    try {
      setDetail({ loading: false, error: null, data: await fetchJson(`/api/accountant/final-pay?employee_id=${encodeURIComponent(person.id)}`) });
    } catch (error) {
      setDetail({ loading: false, error: error.message, data: null });
    }
  }

  async function save() {
    const b = detail.data.breakdown;
    const ok = await confirm({
      title: `Save ${selected.full_name}'s final pay?`,
      description: `Net ${money(b.net_pay)}, released ${dateLabel(releaseOn)}. It becomes a Final payslip; loan repayments are written with it.`,
      confirmLabel: "Save final pay",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await fetchJson("/api/accountant/final-pay", jsonBody("POST", { employee_id: selected.id, release_on: releaseOn }));
      notify("Final Pay Saved", `${result.payslip_no} · net ${money(result.net_pay)}`, "success");
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
    { key: "deadline", header: "Release by", cell: (p) => (p.final_pay ? "—" : <span className={cn(p.days_left < 0 && "text-destructive", p.days_left >= 0 && p.days_left <= 7 && "text-warning")}>{dateLabel(p.deadline)} ({p.days_left < 0 ? `${-p.days_left} days late` : `${p.days_left} days left`})</span>) },
    { key: "status", header: "Final pay", cell: (p) => (p.final_pay ? <div><StatusBadge tone="success">Saved</StatusBadge><p className="text-xs text-muted-foreground">{p.final_pay.payslip_no} · net {money(p.final_pay.net_pay)}</p></div> : <StatusBadge tone="gold">Not yet</StatusBadge>) },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (p) => (p.final_pay ? null : <Button size="sm" onClick={() => open(p)}>Compute</Button>) },
  ];

  const b = detail.data?.breakdown;
  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Separated employees</CardTitle>
          <CardDescription>Final pay is released within 30 days of separation, after clearance.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={columns} rows={state.data?.people || []} loading={state.loading && !state.data} error={state.error} onRetry={load} pageSize={10}
            searchPlaceholder="Search employee…" empty={{ title: "No separated employees", icon: UserMinusIcon }} caption="Separated employees" minWidth={760} />
        </CardContent>
      </Card>

      {selected ? (
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileCheck2Icon className="size-4" aria-hidden="true" />Final pay — {selected.full_name}</CardTitle>
            <CardDescription>Separated {dateLabel(selected.separated_on)}{detail.data ? ` · monthly ${money(detail.data.salary)} · daily ${money(detail.data.daily)}` : ""}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {detail.loading ? <p className="text-sm text-muted-foreground"><Loader2Icon className="mr-1 inline size-4 animate-spin" aria-hidden="true" />Computing…</p> : null}
            {detail.error ? <p className="text-sm text-destructive">{detail.error}</p> : null}
            {b ? (
              <>
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>How</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {b.earnings.map((e, i) => (
                        <TableRow key={`e${i}`}><TableCell>+ {LABELS[e.kind] || e.kind}{e.month_key ? ` (${e.month_key})` : ""}</TableCell><TableCell className="max-w-md text-xs whitespace-normal text-muted-foreground">{e.note}</TableCell><TableCell className="text-right tabular-nums">{money(e.amount)}</TableCell></TableRow>
                      ))}
                      {b.deductions.map((d, i) => (
                        <TableRow key={`d${i}`}><TableCell>− {LABELS[d.kind] || d.kind}{d.month_key ? ` (${d.month_key})` : ""}</TableCell><TableCell className="max-w-md text-xs whitespace-normal text-muted-foreground">{d.note || ""}</TableCell><TableCell className="text-right tabular-nums">{money(d.amount)}</TableCell></TableRow>
                      ))}
                    </TableBody>
                    <TableFooter>
                      <TableRow><TableCell colSpan={2}>Final pay</TableCell><TableCell className="text-right font-semibold tabular-nums">{money(b.net_pay)}</TableCell></TableRow>
                    </TableFooter>
                  </Table>
                </div>
                {b.subsidy && (b.subsidy.forfeited > 0 || b.subsidy.excess > 0) ? (
                  <p className="text-sm text-muted-foreground">Licensed teacher subsidy: {b.subsidy.forfeited > 0 ? `${money(b.subsidy.forfeited)} forfeited (dismissal rule). ` : ""}{b.subsidy.excess > 0 ? `${money(b.subsidy.excess)} advanced above what was earned is recovered as a loan balance.` : ""}</p>
                ) : null}
                {b.uncovered.length ? (
                  <Alert className="border-warning/40 bg-warning/10">
                    <AlertDescription>{b.uncovered.map((u) => `${money(u.amount)} not covered (${u.reason})`).join("; ")}. Saving leaves it on the loan as &quot;Separated – for collection&quot;; send a demand letter.</AlertDescription>
                  </Alert>
                ) : null}
                <p className="text-xs text-muted-foreground">Tax is withheld per month on the monthly table; the year-end annualization (BIR 2316) settles any difference.</p>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1.5"><Label htmlFor="fp-release">Release date</Label><DatePicker id="fp-release" value={releaseOn} onChange={setReleaseOn} /></div>
                  {state.data?.can_edit ? <Button onClick={save} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save final pay</Button> : null}
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
