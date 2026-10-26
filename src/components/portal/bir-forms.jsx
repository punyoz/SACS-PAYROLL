"use client";

import * as React from "react";
import { AlertTriangleIcon, DownloadIcon, FileSpreadsheetIcon, FileTextIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/portal/data-table";
import { ErrorState } from "@/components/portal/empty-state";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch, fetchJson } from "@/lib/portal/api";
import { moneyCompact } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * BIR Form 2316 and the 1604-C alphalist (scenario AC-11, 2026-10-22).
 *   BirFormsCard     Accountant → Payroll Reports (its branch); HR → Payroll
 *                    Records (every branch, read-only). GET /api/payroll/bir-forms
 *   MyBir2316Card    Employee → Payslips: their own 2316 for a finished year.
 *                    GET /api/employee/bir-2316
 * The forms are computed from paid, approved payslips each time; nothing
 * here changes a figure. A year-end difference is settled by the Accountant
 * with a payroll correction.
 */

async function download(url, fallbackName) {
  const response = await apiFetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Unable to download the file.");
  }
  const blob = await response.blob();
  const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "");
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = match ? match[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

const SETTLEMENT = {
  none: { tone: "success", label: "Balanced" },
  collect: { tone: "warning", label: "Under-withheld" },
  refund: { tone: "info", label: "Over-withheld" },
};

export function useDownloader() {
  const { notify } = usePortalSession();
  const [busy, setBusy] = React.useState("");
  const run = React.useCallback(async (key, url, name) => {
    setBusy(key);
    try {
      await download(url, name);
    } catch (error) {
      notify("Download Failed", error.message, "error");
    } finally {
      setBusy("");
    }
  }, [notify]);
  return [busy, run];
}

export function BirFormsCard({ refreshKey = 0 }) {
  const [year, setYear] = React.useState("");
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [busy, run] = useDownloader();

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/payroll/bir-forms${year ? `?year=${year}` : ""}`);
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message || "Unable to load the BIR forms.", data: null });
    }
  }, [year]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const shownYear = String(data?.year || year || "");
  const base = `/api/payroll/bir-forms?year=${shownYear}`;
  const rows = data?.rows || [];
  const off = (data?.rows || []).filter((r) => r.settlement !== "none").length;
  const noTin = rows.filter((r) => !r.has_tin).length;

  const columns = [
    { key: "full_name", header: "Employee", sortable: true, cell: (r) => <div><p className="font-medium">{r.full_name}</p><p className="text-xs text-muted-foreground">{r.employee_code}{r.tin_masked ? ` · TIN ${r.tin_masked}` : " · no TIN"}</p></div>, searchValue: (r) => `${r.full_name} ${r.employee_code}` },
    { key: "branch_name", header: "Branch", sortable: true },
    { key: "gross", header: "Gross comp.", align: "right", className: "tabular-nums", sortValue: (r) => r.gross, cell: (r) => moneyCompact(r.gross) },
    { key: "taxable", header: "Taxable", align: "right", className: "tabular-nums", sortValue: (r) => r.taxable, cell: (r) => moneyCompact(r.taxable) },
    { key: "tax_due", header: "Tax due", align: "right", className: "tabular-nums", sortValue: (r) => r.tax_due, cell: (r) => moneyCompact(r.tax_due) },
    { key: "tax_withheld", header: "Withheld", align: "right", className: "tabular-nums", sortValue: (r) => r.tax_withheld, cell: (r) => moneyCompact(r.tax_withheld) },
    {
      key: "difference", header: "Difference", align: "right", sortValue: (r) => r.difference,
      cell: (r) => {
        const s = SETTLEMENT[r.settlement] || SETTLEMENT.none;
        return <div className="flex flex-col items-end gap-1"><span className="tabular-nums">{moneyCompact(Math.abs(r.difference))}</span><StatusBadge tone={s.tone}>{s.label}</StatusBadge></div>;
      },
    },
    {
      key: "pdf", header: <span className="sr-only">2316</span>, align: "right",
      cell: (r) => (
        <Button variant="outline" size="sm" disabled={busy === r.employee_id} onClick={() => run(r.employee_id, `${base}&format=pdf&employee_id=${r.employee_id}`, "BIR-2316.pdf")} aria-label={`Download the 2316 of ${r.full_name}`}>
          {busy === r.employee_id ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}2316
        </Button>
      ),
    },
  ];

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>BIR forms</CardTitle>
        <CardDescription>
          BIR Form 2316 for each employee and the 1604-C alphalist, from the year&apos;s paid and approved payslips, 13th month and benefits.
          {data && !data.can_generate ? " Read-only." : ""}
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          <Select value={shownYear} onValueChange={setYear}>
            <SelectTrigger size="sm" className="w-28" aria-label="Tax year"><SelectValue placeholder="Year" /></SelectTrigger>
            <SelectContent>{(data?.years || []).map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.error ? <ErrorState message={state.error} onRetry={load} /> : null}
        {data && !data.finished ? (
          <Alert className="border-warning/40 bg-warning/5">
            <AlertTriangleIcon className="text-warning" aria-hidden="true" />
            <AlertDescription>{data.year} is not over yet: these figures cover the payslips approved so far.</AlertDescription>
          </Alert>
        ) : null}
        {data?.employer_missing?.length ? (
          <Alert className="border-warning/40 bg-warning/5">
            <AlertTriangleIcon className="text-warning" aria-hidden="true" />
            <AlertDescription>Employer details still blank on the forms: {data.employer_missing.join(", ")}. The Super Admin fills them in under System Configuration → General → BIR employer details.</AlertDescription>
          </Alert>
        ) : null}
        {data && !data.tax_table_ready ? (
          <Alert className="border-destructive/40 bg-destructive/5">
            <AlertTriangleIcon className="text-destructive" aria-hidden="true" />
            <AlertDescription>No tax table is in force for {data.year}, so the tax due shows as zero.</AlertDescription>
          </Alert>
        ) : null}
        {data ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!rows.length || busy === "pdf"} onClick={() => run("pdf", `${base}&format=pdf`, `BIR-2316-${shownYear}.pdf`)}>
              {busy === "pdf" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <FileTextIcon aria-hidden="true" />}All 2316 (PDF)
            </Button>
            <Button size="sm" variant="outline" disabled={!rows.length || busy === "xlsx"} onClick={() => run("xlsx", `${base}&format=xlsx`, `Alphalist-1604C-${shownYear}.xlsx`)}>
              {busy === "xlsx" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <FileSpreadsheetIcon aria-hidden="true" />}Alphalist (Excel)
            </Button>
            <Button size="sm" variant="outline" disabled={!rows.length || busy === "csv"} onClick={() => run("csv", `${base}&format=csv`, `Alphalist-1604C-${shownYear}.csv`)}>
              {busy === "csv" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}Alphalist (CSV)
            </Button>
            <p className="text-xs text-muted-foreground">
              {rows.length} employee{rows.length === 1 ? "" : "s"} · tax due {moneyCompact(data.totals?.tax_due || 0)} · withheld {moneyCompact(data.totals?.tax_withheld || 0)}
              {noTin ? ` · ${noTin} without a TIN` : ""}
            </p>
          </div>
        ) : null}
        {data || state.loading ? (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.employee_id}
            loading={state.loading && !data}
            pageSize={15}
            searchPlaceholder="Search employee…"
            empty={{ title: `No paid payslips in ${shownYear || "this year"}`, icon: FileTextIcon }}
            caption={`BIR forms ${shownYear}`}
            minWidth={900}
          />
        ) : null}
        {off ? (
          <p className="text-xs text-muted-foreground">
            {off} employee{off === 1 ? "'s" : "s'"} tax withheld differs from the tax due for the year. Settle each one with a payroll correction on a payslip
            (Payroll Records → Correct): under-withheld as a deduction, over-withheld as a refund.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function MyBir2316Card() {
  const [state, setState] = React.useState({ loading: true, error: null, years: [] });
  const [busy, run] = useDownloader();

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/employee/bir-2316");
      setState({ loading: false, error: null, years: data.years || [] });
    } catch (error) {
      setState({ loading: false, error: error.message || "Unable to load your BIR 2316.", years: [] });
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>My BIR 2316</CardTitle>
        <CardDescription>Your certificate of compensation and tax withheld, for each year that has ended.</CardDescription>
      </CardHeader>
      <CardContent>
        {state.error ? <ErrorState message={state.error} onRetry={load} />
          : state.loading ? <p className="text-sm text-muted-foreground">Loading…</p>
            : state.years.length ? (
              <div className="flex flex-wrap gap-2">
                {state.years.map((y) => (
                  <Button key={y} variant="outline" size="sm" disabled={busy === String(y)} onClick={() => run(String(y), `/api/employee/bir-2316?year=${y}&format=pdf`, `BIR-2316-${y}.pdf`)}>
                    {busy === String(y) ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}{y}
                  </Button>
                ))}
              </div>
            ) : <p className="text-sm text-muted-foreground">None yet. Your 2316 for a year is ready here once the year has ended.</p>}
      </CardContent>
    </Card>
  );
}
