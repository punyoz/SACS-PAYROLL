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
  const box = view?.tax_box;
  const sign = (s) => (s === "-" ? "− " : s === "+" ? "+ " : "");
  // The same payslip every role sees (PayslipDocument), with the employee's own notes.
  const doc = { ...payslip, pay_period: payslip.period_label, issued_at: payslip.processed_at, status: "final" };
  return (
    <PayslipDocument payslip={doc} netLabel={m && !payslip.final_pay ? (m.half === "first" ? "1st half net pay" : "2nd half net pay") : "Net pay"}>
      <div className="space-y-3" data-testid="payslip-full" data-half={view?.half}>
        {payslip.early_bird_winner ? (
          <p className="rounded-lg border border-success/40 bg-success/8 px-3 py-2 text-sm text-success">
            <span className="font-semibold">Early Bird winner</span> for {payslip.early_bird_winner.period_label || payslip.period_label}: {payslip.early_bird_winner.early_count} early time-in{payslip.early_bird_winner.early_count === 1 ? "" : "s"}, the most of any employee.
          </p>
        ) : null}
        {box ? (
          <section className="space-y-1 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2 text-xs" data-testid="tax-box">
            <p className="font-semibold tracking-wide text-gold-text uppercase">Monthly tax computation</p>
            {box.rows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-3"><span className="min-w-0">{r.label}</span><span className="shrink-0 tabular-nums">{sign(r.sign)}{formatPeso(r.amount)}</span></div>
            ))}
            <div className="flex items-baseline justify-between gap-3 border-t border-dashed pt-1 font-semibold"><span>Taxable income</span><span className="tabular-nums">{formatPeso(box.taxable)}</span></div>
            {box.bracket ? <p className="text-muted-foreground">Bracket: {box.bracket}{box.formula ? <span className="block font-mono text-[11px] break-words">{box.formula}</span> : null}</p> : null}
            <div className="flex items-baseline justify-between gap-3 font-semibold"><span>Withholding tax</span><span className="tabular-nums">{formatPeso(box.tax)}</span></div>
            {box.reason ? <p className="text-muted-foreground">{box.reason}</p> : null}
          </section>
        ) : null}
        {/* Only on a payslip that deducts withholding tax (audit 2026-11-16). */}
        {view?.tax_deducted > 0 ? <WhyTaxNote /> : null}
        {view?.month_total ? <p className="text-xs font-medium text-muted-foreground" data-testid="month-total">{view.month_total.label}</p> : null}
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
    { key: "period_label", header: "Pay period", className: "font-medium", searchValue: (p) => p.period_label },
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
