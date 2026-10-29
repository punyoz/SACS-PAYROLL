"use client";

import * as React from "react";
import { ArrowLeftIcon, BanknoteIcon, DownloadIcon, Loader2Icon, MinusCircleIcon, PrinterIcon, ReceiptTextIcon, RefreshCwIcon, WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/portal/data-table";
import { useUrlParam } from "@/components/portal/use-url-param";
import { ErrorState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch, fetchJson } from "@/lib/portal/api";
import { dateTime, moneyCompact, recordStatusMeta, toAmount } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { PayslipDocument } from "@/app/accountant/pay-record-page";
import { RemittanceCard } from "@/components/portal/remittance-report";

/*
 * HR → Payroll Records (/api/hr/payroll-records). Every branch's processed
 * payslips, read-only: filter by period and branch, open any payslip exactly
 * as the Accountant's Pay Record shows it, print it or download the PDF.
 * Drafts are not listed, and nothing here changes a figure.
 */

const ALL = "all";

export function PayrollRecordsPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  // The filters stay in the address, so a refresh keeps them (useUrlParam).
  const [periodParam, setPeriod] = useUrlParam("pr_period", ALL);
  const [branchParam, setBranch] = useUrlParam("pr_branch", ALL);
  const [open, setOpen] = React.useState(null);   // { id, loading, error, payslip }
  const [downloading, setDownloading] = React.useState(false);
  // One page at a time, searched and filtered by the server (five years of
  // payslips are far too many to send to the browser).
  const [paging, setPaging] = React.useState({ page: 1, pageSize: 15, query: "" });

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const params = new URLSearchParams({ page: String(paging.page), page_size: String(paging.pageSize) });
      if (periodParam !== ALL) params.set("period", periodParam);
      if (branchParam !== ALL) params.set("branch", branchParam);
      if (paging.query.trim()) params.set("q", paging.query.trim());
      const data = await fetchJson(`/api/hr/payroll-records?${params.toString()}`);
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((c) => ({ loading: false, error: err.message || "Unable to load payroll records.", data: c.data }));
    }
  }, [paging, periodParam, branchParam]);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  const onPaging = React.useCallback((next) => setPaging((c) => ({ ...c, ...next })), []);
  const choosePeriod = (value) => { setPeriod(value); setPaging((c) => ({ ...c, page: 1 })); };
  const chooseBranch = (value) => { setBranch(value); setPaging((c) => ({ ...c, page: 1 })); };

  async function view(id) {
    setOpen({ id, loading: true, error: null, payslip: null });
    try {
      const data = await fetchJson(`/api/hr/payroll-records?entry_id=${encodeURIComponent(id)}`);
      setOpen({ id, loading: false, error: null, payslip: data.payslip });
    } catch (err) {
      setOpen({ id, loading: false, error: err.message || "Unable to open the payslip.", payslip: null });
    }
  }

  async function downloadPdf() {
    if (!open?.id) return;
    setDownloading(true);
    try {
      const response = await apiFetch(`/api/hr/payroll-records?format=pdf&entry_id=${encodeURIComponent(open.id)}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Unable to download the payslip.");
      }
      const blob = await response.blob();
      const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = match ? match[1] : "payslip.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      notify("Download Failed", error.message, "error");
    } finally {
      setDownloading(false);
    }
  }

  const data = state.data;
  const first = state.loading && !data;
  // A period or branch from the address that is not in the list (an old
  // link) shows everything instead of an empty table.
  const period = !data || periodParam === ALL || (data.periods || []).includes(periodParam) ? periodParam : ALL;
  const branch = !data || branchParam === ALL || (data.branches || []).some((b) => b.id === branchParam) ? branchParam : ALL;
  const rows = data?.records || [];
  // The totals of every payslip the filters match, summed by the database.
  const totals = {
    gross: toAmount(data?.totals?.gross || 0),
    deductions: toAmount(data?.totals?.deductions || 0),
    net: toAmount(data?.totals?.net || 0),
  };

  // One payslip, with the way back to the list.
  if (open) {
    return (
      <>
        <Card className="shadow-xs">
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setOpen(null)}><ArrowLeftIcon aria-hidden="true" />Back to records</Button>
            <Button variant="outline" onClick={() => window.print()} disabled={!open.payslip}><PrinterIcon aria-hidden="true" />Print</Button>
            <Button variant="outline" onClick={downloadPdf} disabled={!open.payslip || downloading}>{downloading ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}Download PDF</Button>
          </CardContent>
        </Card>
        {open.loading ? <Skeleton className="h-[480px] w-full rounded-xl" /> : null}
        {open.error ? <Card className="shadow-xs"><CardContent><ErrorState message={open.error} onRetry={() => view(open.id)} /></CardContent></Card> : null}
        {open.payslip ? <PayslipDocument payslip={open.payslip} /> : null}
      </>
    );
  }

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, cell: (r) => <div><p className="font-medium">{r.employee_name}</p><p className="text-xs text-muted-foreground">{r.employee_code}{r.payslip_no ? ` · ${r.payslip_no}` : ""}</p></div>, searchValue: (r) => `${r.employee_name} ${r.employee_code} ${r.payslip_no || ""}` },
    { key: "branch_name", header: "Branch", sortable: true, searchValue: (r) => r.branch_name },
    { key: "pay_period", header: "Period", sortable: true, cell: (r) => <div><p>{r.pay_period}</p><p className="text-xs text-muted-foreground">{r.processed_at ? dateTime(r.processed_at) : ""}</p></div>, searchValue: (r) => r.pay_period },
    { key: "gross_pay", header: "Gross pay", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.gross_pay || 0), cell: (r) => moneyCompact(r.gross_pay) },
    { key: "total_deductions", header: "Deductions", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.total_deductions || 0), cell: (r) => moneyCompact(r.total_deductions) },
    { key: "net_pay", header: "Net pay", align: "right", className: "tabular-nums font-medium", sortValue: (r) => Number(r.net_pay || 0), cell: (r) => moneyCompact(r.net_pay) },
    // The four payroll statuses, as the Accountant sees them (records here are processed payslips).
    { key: "run_status", header: "Status", cell: (r) => { const s = recordStatusMeta({ status: "paid", pay_period: r.pay_period, run_status: r.run_status }); return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>; } },
    { key: "view", header: <span className="sr-only">Payslip</span>, align: "right", cell: (r) => <Button variant="outline" size="sm" onClick={() => view(r.id)}>View</Button> },
  ];

  return (
    <>
      <section aria-label="Totals" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Total gross pay" value={moneyCompact(totals.gross)} hint={period === ALL ? "All periods" : period} icon={BanknoteIcon} tone="gold" loading={first} />
        <StatCard label="Total deductions" value={moneyCompact(totals.deductions)} icon={MinusCircleIcon} tone="danger" loading={first} />
        <StatCard label="Total net pay" value={moneyCompact(totals.net)} icon={WalletIcon} tone="success" loading={first} />
      </section>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Processed payslips</CardTitle>
          <CardAction className="flex flex-wrap gap-2">
            <Select value={period} onValueChange={choosePeriod}>
              <SelectTrigger size="sm" className="w-48" aria-label="Pay period"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All periods</SelectItem>
                {(data?.periods || []).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={branch} onValueChange={chooseBranch}>
              <SelectTrigger size="sm" className="w-40" aria-label="Branch"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All branches</SelectItem>
                {(data?.branches || []).map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={rows}
            loading={first}
            error={state.error}
            onRetry={load}
            pageSize={15}
            server={{ total: data?.total || 0, page: paging.page, pageSize: paging.pageSize, query: paging.query, onChange: onPaging }}
            searchPlaceholder="Search employee, payslip no. or period…"
            empty={{ title: "No processed payslips yet", icon: ReceiptTextIcon }}
            caption="Processed payslips"
            minWidth={980}
          />
          <p className="mt-3 text-xs text-muted-foreground">Read-only. Payslips are processed by each branch&apos;s Accountant; drafts are not listed.</p>
        </CardContent>
      </Card>
      {/* Every branch's remittance, read-only. BIR 2316, the alphalist and the
          year-end tax annualization are the Accountant's only (2026-10-29). */}
      <RemittanceCard refreshKey={refreshKey} />
    </>
  );
}
