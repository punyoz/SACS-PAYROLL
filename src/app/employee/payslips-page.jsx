"use client";

import * as React from "react";
import { DownloadIcon, EyeIcon, Loader2Icon, ReceiptTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/portal/data-table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { formatIssued, formatPeso, formatPesoShort } from "@/lib/portal/format";
import { useDownloader } from "@/components/portal/bir-forms";
import { WhyTaxNote } from "@/components/portal/payroll-lines";
import { PayslipDocument } from "@/app/accountant/pay-record-page";
import { periodDisplay } from "@/lib/payroll/period-display";

function PayslipCard({ payslip }) {
  if (!payslip) {
    return (
      <Card className="shadow-xs">
        <CardContent>
          <EmptyState icon={ReceiptTextIcon} title="No payslip available" description="Your payslip will appear here once payroll is processed." />
        </CardContent>
      </Card>
    );
  }
  const m = payslip.monthly || null;
  const view = payslip.line_groups || null;
  // The same payslip every role sees (PayslipDocument), with the employee's own notes.
  // Only Paid payslips reach My Payslips; the tax box and month total are drawn by PayslipDocument.
  const doc = { ...payslip, pay_period: periodDisplay(payslip.period_label), issued_at: payslip.processed_at, status: "final", status_label: payslip.status_label || "Paid" };
  return (
    <PayslipDocument payslip={doc} netLabel={m && !payslip.final_pay ? (m.half === "first" ? "1st half net pay" : "2nd half net pay") : "Net pay"}>
      <div className="space-y-3" data-testid="payslip-full" data-half={view?.half}>
        {payslip.early_bird_winner ? (
          <p className="rounded-lg border border-success/40 bg-success/8 px-3 py-2 text-sm text-success">
            <span className="font-semibold">Early Bird winner</span> for {payslip.early_bird_winner.period_label || payslip.period_label}: {payslip.early_bird_winner.early_count} early time-in{payslip.early_bird_winner.early_count === 1 ? "" : "s"}, the most of any employee.
          </p>
        ) : null}
        {/* Only on a payslip that deducts withholding tax (audit 2026-11-16). */}
        {view?.tax_deducted > 0 ? <WhyTaxNote /> : null}
      </div>
    </PayslipDocument>
  );
}

export function PayslipsPage({ payslips }) {
  const [selected, setSelected] = React.useState(0);
  const list = payslips.list;
  const current = list[selected] || list[0] || null;
  // The shown payslip as a PDF (2026-11-06): own, approved payslips only.
  const [busy, download] = useDownloader();

  const columns = React.useMemo(() => [
    { key: "period_label", header: "Pay period", className: "font-medium", searchValue: (p) => periodDisplay(p.period_label), cell: (p) => periodDisplay(p.period_label) },
    { key: "payslip_no", header: "Payslip no.", className: "font-mono text-xs", cell: (p) => p.payslip_no || "—", searchValue: (p) => p.payslip_no },
    { key: "processed_at", header: "Issued", sortValue: (p) => p.processed_at || "", cell: (p) => formatIssued(p.processed_at, "short") || "—" },
    { key: "net_pay", header: "Net pay", align: "right", sortValue: (p) => Number(p.net_pay || 0), className: "tabular-nums", cell: (p) => formatPesoShort(p.net_pay) },
    {
      key: "view",
      header: <span className="sr-only">View</span>,
      align: "right",
      cell: (p) => {
        const index = list.indexOf(p);
        const isOpen = list[selected] === p;
        return (
          <Button variant={isOpen ? "secondary" : "outline"} size="sm" onClick={() => setSelected(index)} aria-pressed={isOpen}>
            <EyeIcon aria-hidden="true" />{isOpen ? "Showing" : "View"}
          </Button>
        );
      },
    },
  ], [list, selected]);

  if (payslips.loading) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-96 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (payslips.error && !list.length) {
    return <Card className="shadow-xs"><CardContent><ErrorState message={payslips.error} onRetry={payslips.reload} /></CardContent></Card>;
  }

  return (
    <div className="grid items-start gap-4">
      <section aria-label="Selected payslip" className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Selected payslip</p>
          {current?.id ? (
            <Button variant="outline" size="sm" disabled={busy === current.id}
              onClick={() => download(current.id, `/api/me/payslips?format=pdf&entry_id=${encodeURIComponent(current.id)}`, `payslip-${current.period_label || "payslip"}.pdf`)}>
              {busy === current.id ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}Download PDF
            </Button>
          ) : null}
        </div>
        <PayslipCard payslip={current} />
      </section>
      <div className="min-w-0 space-y-4">
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>All payslips</CardTitle>
            <CardDescription>Choose View to open an earlier payslip.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={columns}
              rows={list}
              rowKey={(p, i) => p.id || `${p.period_label}-${i}`}
              rowClassName={(p) => (list[selected] === p ? "bg-primary/5" : undefined)}
              searchPlaceholder="Search payslips…"
              empty={{ title: "No payslips yet", icon: ReceiptTextIcon }}
              caption="Payslips"
              minWidth={560}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
