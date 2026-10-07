"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, Label, Pie, PieChart, XAxis, YAxis } from "recharts";
import { ArrowRightIcon, BanknoteIcon, CheckCircle2Icon, FilePenLineIcon, MinusCircleIcon, ReceiptTextIcon, UsersIcon, WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/portal/data-table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { UpcomingHolidaysCard } from "@/components/portal/upcoming-holidays";
import { dateTime, money, moneyCompact, statusMeta } from "@/lib/portal/payroll-preview";
import { useAccountant } from "./accountant-data";

/* Dashboard (renderDashboard, public/legacy/js/accountant.js). */

const TOTALS_CHART = { amount: { label: "Amount" } };
const STATUS_CHART = {
  paid: { label: "Paid", color: "var(--chart-1)" },
  draft: { label: "Draft", color: "var(--info)" },
  pending: { label: "Pending", color: "var(--chart-2)" },
  on_hold: { label: "On hold", color: "var(--destructive)" },
};

export const RECORD_COLUMNS = [
  { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => r.employee_name },
  { key: "pay_period", header: "Period", sortable: true, searchValue: (r) => r.pay_period },
  { key: "gross_pay", header: "Gross pay", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.gross_pay || 0), cell: (r) => moneyCompact(r.gross_pay) },
  { key: "net_pay", header: "Net pay", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.net_pay || 0), cell: (r) => moneyCompact(r.net_pay) },
  { key: "status", header: "Status", cell: (r) => { const s = statusMeta(r.status); return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>; } },
  { key: "date", header: "Processed", className: "whitespace-nowrap text-xs text-muted-foreground", cell: (r) => { const d = r.submitted_at || r.updated_at; return d ? dateTime(d) : "—"; } },
];

function bucket(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid" || s === "approved") return "paid";
  if (s === "draft") return "draft";
  if (s === "on_hold" || s === "rejected") return "on_hold";
  return "pending";
}

export function DashboardPage({ refreshKey, onNavigate }) {
  const { data, loading, error, load } = useAccountant();
  const first = loading && !data;
  const employees = data?.employees || [];
  const records = data?.records || [];
  const drafts = data?.draft_entries || [];
  const panels = data?.panels || {};
  const paid = records.filter((r) => r.status === "paid" || r.status === "approved").length;

  const totals = [
    { label: "Gross pay", amount: Number(panels.total_gross || 0), fill: "var(--chart-1)" },
    { label: "Deductions", amount: Number(panels.total_deductions || 0), fill: "var(--destructive)" },
    { label: "Net pay", amount: Number(panels.total_net || 0), fill: "var(--chart-2)" },
  ];
  const statusCounts = [...records, ...drafts].reduce((acc, r) => { acc[bucket(r.status)] = (acc[bucket(r.status)] || 0) + 1; return acc; }, {});
  const slices = Object.keys(STATUS_CHART).map((key) => ({ key, value: statusCounts[key] || 0, fill: `var(--color-${key})` })).filter((s) => s.value > 0);
  const totalEntries = slices.reduce((sum, s) => sum + s.value, 0);

  if (error && !data) return <Card className="shadow-xs"><CardContent><ErrorState message={error} onRetry={() => load()} /></CardContent></Card>;

  return (
    <>
      <section aria-label="This period at a glance" className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label="Total employees" value={employees.length} hint="Active staff" icon={UsersIcon} loading={first} />
        <StatCard label="Period gross pay" value={moneyCompact(panels.total_gross || 0)} hint={data?.active_period?.label || "Current period"} icon={BanknoteIcon} tone="gold" loading={first} />
        <StatCard label="Period net pay" value={moneyCompact(panels.total_net || 0)} icon={WalletIcon} tone="success" loading={first} />
        <StatCard label="Paid payrolls" value={paid} hint="Processed entries" icon={CheckCircle2Icon} tone="success" loading={first} />
        <StatCard label="Draft payrolls" value={drafts.length} hint="Saved drafts" icon={FilePenLineIcon} tone="info" loading={first} />
        <StatCard label="Total deductions" value={moneyCompact(panels.total_deductions || 0)} hint="Current period" icon={MinusCircleIcon} tone="danger" loading={first} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Period totals</CardTitle>
            <CardDescription>Gross pay, deductions and net pay</CardDescription>
          </CardHeader>
          <CardContent>
            {first ? <Skeleton className="h-[220px] w-full" /> : (
              <ChartContainer config={TOTALS_CHART} className="h-[240px] w-full">
                <BarChart accessibilityLayer data={totals} margin={{ left: 4, right: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={12} />
                  <YAxis tickLine={false} axisLine={false} width={52} fontSize={11} tickFormatter={(v) => (v >= 1000 ? `₱${Math.round(v / 1000)}k` : `₱${v}`)} />
                  <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent hideLabel formatter={(value, _n, item) => <span className="flex w-full justify-between gap-3"><span className="text-muted-foreground">{item.payload.label}</span><span className="font-medium tabular-nums">{money(value)}</span></span>} />} />
                  <Bar dataKey="amount" radius={[6, 6, 0, 0]} maxBarSize={64}>
                    {totals.map((t) => <Cell key={t.label} fill={t.fill} />)}
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Payroll entries by status</CardTitle>
            <CardDescription>Processed entries and drafts</CardDescription>
          </CardHeader>
          <CardContent>
            {first ? <Skeleton className="mx-auto aspect-square w-full max-w-[220px] rounded-full" /> : !totalEntries ? (
              <EmptyState icon={ReceiptTextIcon} title="No payroll entries yet" description="Process payroll to see entries here." />
            ) : (
              <ChartContainer config={STATUS_CHART} className="mx-auto aspect-square max-h-[260px]">
                <PieChart accessibilityLayer>
                  <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" />} />
                  <Pie data={slices} dataKey="value" nameKey="key" innerRadius={62} strokeWidth={3} stroke="var(--card)">
                    {slices.map((s) => <Cell key={s.key} fill={s.fill} />)}
                    <Label content={({ viewBox }) => (viewBox && "cx" in viewBox ? (
                      <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                        <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-2xl font-semibold">{totalEntries}</tspan>
                        <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 20} className="fill-muted-foreground text-xs">entries</tspan>
                      </text>
                    ) : null)} />
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="key" />} className="flex-wrap gap-x-4 gap-y-1" />
                </PieChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <UpcomingHolidaysCard refreshKey={refreshKey} />
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Recent payroll activity</CardTitle>
            <CardAction><Button variant="ghost" size="sm" onClick={() => onNavigate("ac-records")}>View all records<ArrowRightIcon aria-hidden="true" /></Button></CardAction>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={RECORD_COLUMNS}
              rows={records.slice(0, 5)}
              loading={first}
              searchable={false}
              paginate={false}
              empty={{ title: "No recent payroll activity", icon: ReceiptTextIcon }}
              caption="Recent payroll activity"
              minWidth={640}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
