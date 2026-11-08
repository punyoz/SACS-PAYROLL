"use client";

import * as React from "react";
import { BanknoteIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/portal/data-table";
import { ErrorState } from "@/components/portal/empty-state";
import { fetchJson } from "@/lib/portal/api";
import { HOURS_PER_DAY } from "@/lib/payroll/rates";
import { cn } from "@/lib/utils";
import { manilaToday, rateDate, rateDisplay, rateHistory } from "@/app/super-admin/config-format";

/*
 * Pay rates, read-only (GET /api/payroll/pay-rates, 2026-11-08): the default
 * daily rate and its hourly rate (always daily ÷ 8), and each branch's.
 * HR sees every branch; the Accountant and the branch Admin their own. Only
 * the Super Admin changes rates (System Configuration).
 */

const PESO = { unit: "peso" };

export function PayRatesPanel({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [today] = React.useState(manilaToday);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/payroll/pay-rates");
      if (data.available === false) throw new Error(data.error || "Pay rates are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState((c) => ({ loading: false, error: error.message || "Unable to load pay rates.", data: c.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const def = data?.default;
  const pairRows = def ? [
    { key: "daily", label: "Daily rate (default)", ...def.daily },
    { key: "hourly", label: `Hourly rate — daily ÷ ${HOURS_PER_DAY} (automatic)`, ...def.hourly },
  ] : [];

  const columns = [
    { key: "name", header: "Branch", sortable: true, className: "min-w-40 font-medium whitespace-normal" },
    {
      key: "daily", header: "Daily rate", align: "right", headClassName: "w-32", className: "w-32 whitespace-nowrap tabular-nums",
      cell: (b) => <div>{rateDisplay(PESO, b.current?.value)}{b.uses_default ? <p className="text-xs text-muted-foreground">Uses system default</p> : null}</div>,
    },
    {
      key: "hourly", header: "Hourly rate (automatic)", align: "right", headClassName: "w-40", className: "w-40 whitespace-nowrap tabular-nums",
      cell: (b) => <div>{rateDisplay(PESO, b.hourly_current)}<p className="text-xs text-muted-foreground">Daily ÷ {HOURS_PER_DAY}</p></div>,
    },
    {
      key: "effective", header: "Effective", headClassName: "w-36", className: "w-36 whitespace-nowrap",
      cell: (b) => (b.uses_default ? <span className="text-muted-foreground">System default</span> : rateDate(b.current?.effective_date)),
    },
    {
      key: "next", header: "Next period", align: "right", headClassName: "w-36", className: "w-36 whitespace-nowrap tabular-nums",
      cell: (b) => <div className={cn(Number(b.next_period?.value) !== Number(b.current?.value) && "font-semibold text-warning")}>{rateDisplay(PESO, b.next_period?.value)}<p className="text-xs font-normal">{rateDisplay(PESO, b.hourly_next)}/hr</p></div>,
    },
  ];

  return (
    <Card className="min-w-0 shadow-xs" data-testid="pay-rates-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><BanknoteIcon className="size-4 text-gold-text" aria-hidden="true" />Pay rates</CardTitle>
        <CardDescription>
          View-only. The hourly rate is always the daily rate ÷ {HOURS_PER_DAY}. From Oct 1, 2026 an employee with a salary on file is paid on
          monthly salary × 12 ÷ working days per year; these rates apply to an employee with no salary on file. HR and the Super Admin change the daily rate.
        </CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.error && !data ? <ErrorState message={state.error} onRetry={load} /> : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[40rem] text-sm">
                <caption className="sr-only">Default daily and hourly rate</caption>
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Rate</th>
                    <th className="w-32 px-3 py-2 text-right font-semibold">This period</th>
                    <th className="w-32 px-3 py-2 text-right font-semibold">Next period</th>
                    <th className="px-3 py-2 text-left font-semibold">History</th>
                  </tr>
                </thead>
                <tbody>
                  {state.loading && !data ? <tr><td colSpan={4} className="px-3 py-4 text-muted-foreground">Loading…</td></tr> : pairRows.map((r) => (
                    <tr key={r.key} className="border-t align-top" data-testid={`pay-rate-${r.key}`}>
                      <td className="px-3 py-2 font-medium">{r.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{rateDisplay(PESO, r.current?.value)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{rateDisplay(PESO, r.next_period?.value)}</td>
                      <td className="px-3 py-2">
                        <ol className="space-y-0.5 text-xs">
                          {rateHistory(PESO, r.history, today).map((v) => (
                            <li key={v.key} className={cn("grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2", v.now ? "font-medium text-primary" : "text-muted-foreground")}>
                              <span className="text-right tabular-nums">{v.text}</span><span>{v.range}</span>
                            </li>
                          ))}
                        </ol>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DataTable columns={columns} rows={data?.branches || []} rowKey={(b) => b.branch_id} loading={state.loading && !data} paginate={false}
              searchable={(data?.branches || []).length > 5} searchPlaceholder="Search branches…" caption="Daily and hourly rate per branch" minWidth={760}
              empty={{ title: "No branch on file", icon: BanknoteIcon }} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
