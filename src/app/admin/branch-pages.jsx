"use client";

import * as React from "react";
import { BanknoteIcon, RefreshCwIcon, WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/portal/data-table";
import { StatCard } from "@/components/portal/stat-card";
import { dateTime, money, moneyCompact } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { useBranchView } from "./oversight-shared";

/*
 * Branch Payroll Summary (view=payroll): each approved run's totals for the
 * Admin's branch, never an employee's figures. Announcements: see
 * src/components/portal/announcements.jsx.
 */

export function PayrollSummaryPage({ refreshKey }) {
  const view = useBranchView("payroll", {}, refreshKey);
  const periods = view.data?.periods || [];
  const latest = periods[0];
  return (
    <>
      <section aria-label="Latest" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Latest approved period" value={latest ? latest.period_label : "—"} hint={latest ? latest.cutoff : "No approved payroll yet"} icon={BanknoteIcon} tone="gold" loading={view.first} />
        <StatCard label="Total payroll cost (gross)" value={latest ? moneyCompact(latest.total_gross) : "₱ 0"} hint={latest ? `${latest.employees} employees` : ""} icon={WalletIcon} loading={view.first} />
        <StatCard label="Total net paid" value={latest ? moneyCompact(latest.total_net) : "₱ 0"} icon={WalletIcon} tone="success" loading={view.first} />
      </section>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Branch payroll by period</CardTitle>
          <CardDescription>Totals of HR-approved payroll runs only. Individual salaries and payslips are not shown.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={view.load} disabled={view.loading}><RefreshCwIcon className={cn(view.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={[
            { key: "period_start", header: "Pay period", sortable: true, cell: (p) => <div><p className="font-medium">{p.period_label}</p><p className="text-xs text-muted-foreground">{p.cutoff}</p></div>, searchValue: (p) => p.period_label },
            { key: "employees", header: "Employees", align: "right", className: "tabular-nums" },
            { key: "total_gross", header: "Total gross", align: "right", className: "tabular-nums", cell: (p) => money(p.total_gross) },
            { key: "total_deductions", header: "Total deductions", align: "right", className: "tabular-nums", cell: (p) => money(p.total_deductions) },
            { key: "total_net", header: "Total net", align: "right", className: "tabular-nums font-medium", cell: (p) => money(p.total_net) },
            { key: "approved_at", header: "Approved by HR", cell: (p) => <div className="text-xs"><p>{p.approved_by || "HR"}</p><p className="text-muted-foreground">{p.approved_at ? dateTime(p.approved_at) : ""}</p></div> },
          ]} rows={periods} loading={view.first} error={view.error} onRetry={view.load} pageSize={12} searchable={false}
            empty={{ title: "No approved payroll yet", description: "A period appears here once HR approves the branch's run.", icon: BanknoteIcon }} caption="Branch payroll summary" minWidth={820} />
        </CardContent>
      </Card>
    </>
  );
}

// Announcements moved to src/components/portal/announcements.jsx (HR and Super
// Admin manage them too, 2026-10-30); these names stay for the existing imports.
export { AnnouncementsManager as AnnouncementsPage, AnnouncementsCard as BranchAnnouncementsCard } from "@/components/portal/announcements";
