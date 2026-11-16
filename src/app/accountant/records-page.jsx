"use client";

import * as React from "react";
import { BanknoteIcon, MinusCircleIcon, PrinterIcon, ReceiptTextIcon, WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/portal/data-table";
import { ErrorState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { moneyCompact, recordStatusMeta } from "@/lib/portal/payroll-preview";
import { HistorySelect, historyLabel, useAccountant } from "./accountant-data";
import { CorrectionDialog, CorrectionsCard, NeedsCorrectionBadge, correctionPrefill } from "@/components/portal/payroll-corrections";
import { printPdf } from "@/lib/portal/print-pdf";
import { ExportButtons } from "@/components/portal/export-buttons";

/* Payroll Records (renderRecordsPanels / renderPayrollRecordsTable, accountant.js). */

export function RecordsPage() {
  const { data, loading, error, load, openPayslip, history } = useAccountant();
  const [correcting, setCorrecting] = React.useState(null);
  const [correctionsKey, setCorrectionsKey] = React.useState(0);
  const [prefill, setPrefill] = React.useState(null);
  // Every period's processed entries (history_records), not just the
  // current period's: the page must not empty out when a later load (e.g.
  // opening a payslip) is scoped to one period.
  const finals = React.useMemo(() => data?.history_records || data?.records || [], [data]);
  // Drafts are listed too, labelled "Draft" (2026-11-15); the totals above stay Final-only.
  const records = [...finals, ...(data?.draft_entries || [])];
  const panels = data?.history_panels || data?.panels || {};
  const first = loading && !data;

  // ?correct=<entry id> (the payslip's "Needs correction" note) opens that payslip's correction.
  React.useEffect(() => {
    if (typeof window === "undefined" || !finals.length) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("correct");
    const target = id ? finals.find((r) => String(r.id) === id && r.run_status === "approved") : null;
    if (!target) return;
    const amount = Math.abs(Number(params.get("amount")) || 0);
    setPrefill(amount ? { kind: params.get("kind") === "underpayment" ? "underpayment" : "overpayment", amount, reason: params.get("why") || "" } : null);
    setCorrecting((c) => c || target);
  }, [finals]);

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => r.employee_name },
    { key: "pay_period", header: "Period", sortable: true, searchValue: (r) => r.pay_period },
    { key: "gross_pay", header: "Gross pay", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.gross_pay || 0), cell: (r) => moneyCompact(r.gross_pay) },
    { key: "total_deductions", header: "Deductions", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.total_deductions || 0), cell: (r) => moneyCompact(r.total_deductions) },
    { key: "net_pay", header: "Net pay", align: "right", className: "tabular-nums font-medium", sortValue: (r) => Number(r.net_pay || 0), cell: (r) => moneyCompact(r.net_pay) },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => recordStatusMeta(r).label,
      cell: (r) => {
        const s = recordStatusMeta(r);
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
            <NeedsCorrectionBadge info={r.needs_correction}
              action={<Button variant="link" size="sm" className="h-auto p-0" onClick={() => { setPrefill(correctionPrefill(r.needs_correction)); setCorrecting(r); }}>Correct</Button>} />
          </div>
        );
      },
    },
    {
      key: "payslip",
      header: <span className="sr-only">Payslip</span>,
      align: "right",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="sm" disabled={String(r.status || "").toLowerCase() === "draft"} onClick={() => openPayslip(r.id)}>Payslip</Button>
          {/* A payslip HR approved is corrected on a later payslip, never changed. */}
          {r.run_status === "approved" ? <Button variant="outline" size="sm" onClick={() => { setPrefill(correctionPrefill(r.needs_correction)); setCorrecting(r); }}>Correct</Button> : null}
        </div>
      ),
    },
  ];

  if (error && !data) return <Card className="shadow-xs"><CardContent><ErrorState message={error} onRetry={() => load()} /></CardContent></Card>;

  return (
    <>
      {error ? (
        <Card className="shadow-xs"><CardContent><ErrorState message={`${error} The figures below are from the last successful load.`} onRetry={() => load()} /></CardContent></Card>
      ) : null}
      <section aria-label="Totals" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Total gross pay" value={moneyCompact(panels.total_gross || 0)} hint={historyLabel(history)} icon={BanknoteIcon} tone="gold" loading={first} />
        <StatCard label="Total deductions" value={moneyCompact(panels.total_deductions || 0)} icon={MinusCircleIcon} tone="danger" loading={first} />
        <StatCard label="Total net pay" value={moneyCompact(panels.total_net || 0)} icon={WalletIcon} tone="success" glow loading={first} />
      </section>
      <Card className="min-w-0 shadow-xs">
        <CardContent>
          <DataTable
            toolbar={(
              <>
                <HistorySelect />
                {/* Excel / PDF of the records shown; Print prints that PDF, not the page (alpha test B4). */}
                <ExportButtons href={`/api/accountant/payroll?view=records&history=${encodeURIComponent(history)}`} label="payroll records" disabled={!finals.length} />
                <Button variant="outline" size="sm" disabled={!finals.length} title={finals.length ? undefined : "No processed payroll records to print yet."}
                  onClick={() => printPdf(`/api/accountant/payroll?view=records&history=${encodeURIComponent(history)}&format=pdf`).catch(() => {})}>
                  <PrinterIcon aria-hidden="true" />Print
                </Button>
              </>
            )}
            columns={columns}
            rows={records}
            loading={first}
            pageSize={15}
            searchPlaceholder="Search employee or period…"
            empty={{ title: "No payroll records available yet", icon: ReceiptTextIcon }}
            caption="Payroll records"
            minWidth={820}
          />
        </CardContent>
      </Card>
      <CorrectionsCard refreshKey={correctionsKey} />
      <CorrectionDialog record={correcting} prefill={prefill} onClose={() => { setCorrecting(null); setPrefill(null); }} onSaved={() => setCorrectionsKey((k) => k + 1)} />
    </>
  );
}
