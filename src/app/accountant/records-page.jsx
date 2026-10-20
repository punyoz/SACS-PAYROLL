"use client";

import * as React from "react";
import { BanknoteIcon, MinusCircleIcon, ReceiptTextIcon, WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/portal/data-table";
import { ErrorState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { moneyCompact, recordStatusMeta } from "@/lib/portal/payroll-preview";
import { useAccountant } from "./accountant-data";

/* Payroll Records (renderRecordsPanels / renderPayrollRecordsTable, accountant.js). */

export function RecordsPage() {
  const { data, loading, error, load, openPayslip } = useAccountant();
  // Every period's processed entries (history_records), not just the
  // current period's: the page must not empty out when a later load (e.g.
  // opening a payslip) is scoped to one period.
  const records = data?.history_records || data?.records || [];
  const panels = data?.history_panels || data?.panels || {};
  const first = loading && !data;

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => r.employee_name },
    { key: "pay_period", header: "Period", sortable: true, searchValue: (r) => r.pay_period },
    { key: "gross_pay", header: "Gross pay", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.gross_pay || 0), cell: (r) => moneyCompact(r.gross_pay) },
    { key: "total_deductions", header: "Deductions", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.total_deductions || 0), cell: (r) => moneyCompact(r.total_deductions) },
    { key: "net_pay", header: "Net pay", align: "right", className: "tabular-nums font-medium", sortValue: (r) => Number(r.net_pay || 0), cell: (r) => moneyCompact(r.net_pay) },
    { key: "status", header: "Status", sortValue: (r) => recordStatusMeta(r).label, cell: (r) => { const s = recordStatusMeta(r); return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>; } },
    {
      key: "payslip",
      header: <span className="sr-only">Payslip</span>,
      align: "right",
      cell: (r) => <Button variant="outline" size="sm" disabled={String(r.status || "").toLowerCase() === "draft"} onClick={() => openPayslip(r.id)}>Payslip</Button>,
    },
  ];

  if (error && !data) return <Card className="shadow-xs"><CardContent><ErrorState message={error} onRetry={() => load()} /></CardContent></Card>;

  return (
    <>
      {error ? (
        <Card className="shadow-xs"><CardContent><ErrorState message={`${error} The figures below are from the last successful load.`} onRetry={() => load()} /></CardContent></Card>
      ) : null}
      <section aria-label="Totals" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Total gross pay" value={moneyCompact(panels.total_gross || 0)} hint="All periods" icon={BanknoteIcon} tone="gold" loading={first} />
        <StatCard label="Total deductions" value={moneyCompact(panels.total_deductions || 0)} icon={MinusCircleIcon} tone="danger" loading={first} />
        <StatCard label="Total net pay" value={moneyCompact(panels.total_net || 0)} icon={WalletIcon} tone="success" loading={first} />
      </section>
      <Card className="min-w-0 shadow-xs">
        <CardContent>
          <DataTable
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
    </>
  );
}
