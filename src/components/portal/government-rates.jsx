"use client";

import * as React from "react";
import { HistoryIcon, LandmarkIcon, LockIcon, ReceiptTextIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataTable } from "@/components/portal/data-table";
import { ErrorState } from "@/components/portal/empty-state";
import { fetchJson } from "@/lib/portal/api";
import { dateTime } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { peso, rateDate, rateDisplay } from "@/app/super-admin/config-format";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeTaxTable, taxExplanation } from "@/lib/payroll/line-tags";
import { monthlyWithholdingTax, taxTableFromRows } from "@/lib/payroll/semi-monthly";
import { TaxBracketTable } from "@/components/portal/payroll-lines";

/*
 * Government Rates, read-only (GET /api/payroll/government-rates,
 * 2026-10-26): what the Accountant and HR use to check and explain each
 * employee's SSS, PhilHealth, Pag-IBIG and withholding tax. There is nothing
 * to edit here; the server refuses any change from these roles, and only the
 * Super Admin changes the tables (System Configuration).
 */

function versionIn(table, id) {
  return (table?.versions || []).find((v) => v.version_id === id) || null;
}

function RatesCard({ data }) {
  const columns = [
    {
      key: "label", header: "Rate", className: "min-w-56 whitespace-normal", searchValue: (r) => `${r.label} ${r.hint || ""}`,
      cell: (r) => <div><p className="font-medium">{r.label}</p>{r.hint ? <p className="text-xs text-muted-foreground">{r.hint}</p> : null}</div>,
    },
    { key: "current", header: "This period", className: "whitespace-nowrap tabular-nums", cell: (r) => rateDisplay(r, r.current) },
    {
      key: "next", header: "Next period", className: "whitespace-nowrap tabular-nums",
      cell: (r) => <span className={cn(Number(r.next_period) !== Number(r.current) && "font-semibold text-warning")}>{rateDisplay(r, r.next_period)}</span>,
    },
    {
      key: "history", header: "History", className: "min-w-72 whitespace-normal",
      cell: (r) => (
        <p className="text-xs text-muted-foreground">
          {r.history.length
            ? r.history.map((v) => `${rateDisplay(r, v.value)} (${rateDate(v.effective_date)}${v.until ? ` – ${rateDate(v.until)}` : " – present"})`).join(" → ")
            : "Default — never changed"}
        </p>
      ),
    },
  ];
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><LandmarkIcon className="size-4 text-gold-text" aria-hidden="true" />SSS, PhilHealth and Pag-IBIG</CardTitle>
        <CardDescription>The employee share of each contribution and its limits. Payroll uses the value in force on the pay period&apos;s first day.</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={data?.rates || []} rowKey={(r) => r.rate_type} loading={!data} pageSize={20}
          searchPlaceholder="Search rate…" caption="Government contribution rates" minWidth={760}
          empty={{ title: "No rates", icon: LandmarkIcon }} />
      </CardContent>
    </Card>
  );
}

/*
 * Withholding tax, kept apart from the contributions (2026-11-03): why it
 * exists, and the brackets payroll really uses — the stored, effective-dated
 * MONTHLY table (payroll_tax_brackets) the 2nd half taxes the month with.
 * "Check a taxable income" highlights its bracket and works the formula out
 * with the same function payroll uses (monthlyWithholdingTax).
 */
function TaxCard({ data }) {
  const current = versionIn(data?.tax_table, data?.tax_table?.current_version_id);
  const next = versionIn(data?.tax_table, data?.tax_table?.next_period_version_id);
  const [check, setCheck] = React.useState("");
  const rows = normalizeTaxTable(current?.rows || []);
  const income = Number(check);
  const checking = check !== "" && Number.isFinite(income) && income >= 0;
  const engineTable = taxTableFromRows(current?.rows || []);
  const explain = checking ? taxExplanation({ taxable: income, tax: monthlyWithholdingTax(income, engineTable), table: current?.rows || [] }) : null;
  return (
    <Card className="min-w-0 shadow-xs" data-testid="withholding-tax-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ReceiptTextIcon className="size-4 text-gold-text" aria-hidden="true" />Withholding tax (income tax) — separate from contributions</CardTitle>
        <CardDescription>
          Withholding tax is computed once a month, on the 16–end payslip: base tax + rate × (taxable income − &quot;over&quot;), for the highest bracket the taxable income is over.
          {current ? ` In force since ${rateDate(current.effective_date)}${current.note ? ` (${current.note})` : ""}.` : ""}
          {next && next.version_id !== current?.version_id ? ` A new table applies from ${rateDate(next.effective_date)}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 text-sm md:grid-cols-2">
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="font-semibold">Why is there a withholding tax?</p>
            <p className="mt-1 text-muted-foreground">It is <strong className="text-foreground">income tax</strong> under the TRAIN Law (RA 10963). The school withholds it from pay as an advance on the employee&apos;s yearly income tax and remits it to the BIR. There is no employer share and no benefit paid back.</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="font-semibold">How it differs from SSS, PhilHealth and Pag-IBIG</p>
            <p className="mt-1 text-muted-foreground">Those are <strong className="text-foreground">social insurance</strong>: the employee pays a share, the school adds its own, and the money returns as pension and sickness, health insurance and housing savings. They come off first; the tax is computed on what remains (gross less the employee&apos;s contributions, non-taxable items left out).</p>
          </div>
        </div>
        {!data ? <Skeleton className="h-40 w-full" /> : !current ? (
          <p className="text-sm text-muted-foreground">No tax table yet.</p>
        ) : (
          <>
            <TaxBracketTable rows={rows} index={explain ? explain.index : -1} />
            <p className="text-xs text-muted-foreground">
              Main table: <strong className="text-foreground">monthly</strong> (the one payroll uses on the 2nd half for the whole month). Source: {current.note || "BIR withholding tax table"}; effective {rateDate(current.effective_date)}; read from the stored table, so a Super Admin change shows here on its effective date. Verify against the current BIR table (RR 11-2018, Annex E).
            </p>
            <div className="space-y-2 rounded-lg border p-3">
              <Label htmlFor="gr-tax-check">Check a monthly taxable income</Label>
              <Input id="gr-tax-check" type="number" min="0" max="1000000" step="0.01" inputMode="decimal" className="max-w-56 tabular-nums" placeholder="e.g. 25000" value={check} onChange={(e) => setCheck(e.target.value)} />
              {explain ? (
                <div className="space-y-1 text-sm" data-testid="tax-check-result">
                  <p>Bracket <strong>{explain.range}</strong> (highlighted): {peso(explain.base_tax)} + {explain.rate_pct}% × ({peso(explain.taxable)} − {peso(explain.bracket?.over || 0)}) = <strong>{peso(explain.tax)}</strong> a month{explain.taxable > 0 ? ` (${explain.effective_pct}% of taxable income)` : ""}.</p>
                  {explain.reason ? <p className="text-success">{explain.reason}</p> : null}
                </div>
              ) : <p className="text-xs text-muted-foreground">Enter an amount to highlight its bracket and see the formula worked out.</p>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MscCard({ data }) {
  const msc = data?.sss_msc;
  const current = versionIn(msc, msc?.current_version_id);
  const rows = current?.rows || [];
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ReceiptTextIcon className="size-4 text-gold-text" aria-hidden="true" />SSS salary credit table</CardTitle>
        <CardDescription>
          SSS is the SSS contribution % of the salary credit the monthly salary falls in.
          {current ? ` In force since ${rateDate(current.effective_date)}${current.note ? ` (${current.note})` : ""}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!data ? <Skeleton className="h-40 w-full" /> : !current ? (
          <p className="text-sm text-muted-foreground">
            {msc?.available ? "No table saved yet." : "The SSS salary credit table is not set up yet."} Payroll rounds the monthly salary to the nearest ₱500 between the SSS lowest and highest salary credit above.
          </p>
        ) : (
          <div className="max-h-96 overflow-auto rounded-md border">
            <Table className="sm:min-w-120">
              <TableCaption className="sr-only">SSS salary credit brackets</TableCaption>
              <TableHeader><TableRow><TableHead>Monthly salary</TableHead><TableHead>Salary credit</TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={row.salary_from}>
                    <TableCell className="tabular-nums">{rows[index + 1] ? `${peso(row.salary_from)} – ${peso(rows[index + 1].salary_from - 0.01)}` : `${peso(row.salary_from)} and above`}</TableCell>
                    <TableCell className="tabular-nums">{peso(row.msc)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChangesCard({ data }) {
  const show = (change, value) => (value === null || value === undefined ? "—" : change.kind === "rate" ? rateDisplay(change, value) : value);
  const columns = [
    { key: "created_at", header: "When", sortable: true, sortValue: (c) => c.created_at || "", className: "whitespace-nowrap text-xs", cell: (c) => (c.created_at ? dateTime(c.created_at) : "—") },
    { key: "created_by_name", header: "By", sortable: true, className: "whitespace-nowrap", cell: (c) => c.created_by_name || "System" },
    { key: "what", header: "What", sortable: true, className: "min-w-48 whitespace-normal font-medium" },
    { key: "change", header: "Old → new", className: "min-w-56 whitespace-normal tabular-nums", searchValue: (c) => `${c.from ?? ""} ${c.to ?? ""}`, cell: (c) => `${show(c, c.from)} → ${show(c, c.to)}` },
    { key: "effective_date", header: "Effective", sortable: true, className: "whitespace-nowrap", cell: (c) => rateDate(c.effective_date) },
    { key: "note", header: "Note", className: "min-w-40 whitespace-normal text-xs text-muted-foreground", cell: (c) => c.note || "—" },
  ];
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><HistoryIcon className="size-4 text-gold-text" aria-hidden="true" />Change history</CardTitle>
        <CardDescription>Every change to these rates and tables: who made it, when, and the value before and after. Past payslips keep the values they were computed with.</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={data?.changes || []} rowKey={(c, i) => `${c.what}-${c.created_at}-${i}`} loading={!data} pageSize={10}
          searchPlaceholder="Search change…" caption="Government rate changes" minWidth={860}
          empty={{ title: "No changes yet", icon: HistoryIcon }} />
      </CardContent>
    </Card>
  );
}

export function GovernmentRatesPanel({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/payroll/government-rates");
      if (!data.available) throw new Error(data.error || "Government rates are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message || "Unable to load government rates." }));
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  if (state.error && !state.data) {
    return <Card className="shadow-xs"><CardContent><ErrorState message={state.error} onRetry={load} /></CardContent></Card>;
  }

  return (
    <>
      <Alert>
        <LockIcon aria-hidden="true" />
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>Read-only here. HR (on its Government Rates page) and the Super Admin change the SSS, PhilHealth and Pag-IBIG rates for future pay periods; the withholding tax table is fixed by law; the SSS salary credit table is the Super Admin&apos;s.</span>
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </AlertDescription>
      </Alert>
      <RatesCard data={state.data} />
      <MscCard data={state.data} />
      <TaxCard data={state.data} />
      <ChangesCard data={state.data} />
    </>
  );
}
