"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { Building2Icon, CheckCircle2Icon, ClockAlertIcon, RefreshCwIcon, UserMinusIcon, UsersIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { fetchJson } from "@/lib/portal/api";
import { cn } from "@/lib/utils";
import { formatMoney } from "./dashboard-page";

/*
 * Branch Reports (loadBranchReports, public/legacy/js/admin.js): a view-only
 * summary of the Admin's own branch from GET /api/admin/branch-reports.
 * Payroll figures belong to the Accountant; nothing here is editable.
 */

const CHART = { count: { label: "Employees" } };

export function BranchReportsPage({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/admin/branch-reports");
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message || "Unable to load branch reports." }));
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const first = state.loading && !data;
  const byRole = data?.headcount?.by_role || {};
  const roleParts = Object.keys(byRole).sort().map((role) => `${byRole[role]} ${role.replace("_", " ")}`);
  const att = data?.attendance || {};
  const payroll = data?.payroll || {};
  const bars = [
    { label: "Present", count: Number(att.present || 0), fill: "var(--chart-1)" },
    { label: "Late", count: Number(att.late || 0), fill: "var(--chart-2)" },
    { label: "Absent", count: Number(att.absent || 0), fill: "var(--destructive)" },
    { label: "On leave", count: Number(att.on_leave || 0), fill: "var(--info)" },
  ];
  const measures = [
    ["Latest pay period", payroll.latest_period || "None processed yet"],
    ["Employees processed this period", payroll.processed_this_period ?? 0],
    ["Awaiting processing", payroll.awaiting_processing ?? 0],
    ["Pending payroll entries", payroll.pending_entries ?? 0],
    ["Total net pay this period", formatMoney(payroll.total_net_pay_this_period)],
  ];

  if (state.error && !data) {
    return <Card className="shadow-xs"><CardContent><ErrorState message={state.error} onRetry={load} /></CardContent></Card>;
  }

  return (
    <>
      <section aria-label="Branch" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Branch" value={data?.branch?.label || "—"} hint={data?.branch?.all_branches ? "All branches — view-only summary" : "View-only summary"} icon={Building2Icon} loading={first} />
        <StatCard label="Active headcount" value={data?.headcount?.total ?? 0} hint={roleParts.length ? roleParts.join(" · ") : "Staff assigned to this branch"} icon={UsersIcon} loading={first} />
        <StatCard label="Unassigned staff" value={data?.unassigned_staff ?? 0} hint="Not yet placed in a branch" icon={UserMinusIcon} tone="gold" loading={first} />
      </section>

      <section aria-label="Today" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Present today" value={att.present ?? 0} hint={att.date || "—"} icon={CheckCircle2Icon} tone="success" loading={first} />
        <StatCard label="Late today" value={att.late ?? 0} hint="Recorded after grace period" icon={ClockAlertIcon} tone="gold" loading={first} />
        <StatCard label="Absent today" value={att.absent ?? 0} hint={`No scan logged today · On leave: ${att.on_leave ?? 0}`} icon={XCircleIcon} tone="danger" loading={first} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Today&apos;s attendance</CardTitle>
            <CardDescription>{att.date || "Today"}</CardDescription>
          </CardHeader>
          <CardContent>
            {first ? <Skeleton className="h-[220px] w-full" /> : (
              <ChartContainer config={CHART} className="h-[240px] w-full">
                <BarChart accessibilityLayer data={bars} margin={{ left: 4, right: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={12} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} fontSize={11} />
                  <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent hideLabel />} />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={56}>
                    {bars.map((bar) => <Cell key={bar.label} fill={bar.fill} />)}
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Payroll status</CardTitle>
            <CardDescription>Managed by the Accountant. This view is read-only.</CardDescription>
            <CardAction>
              <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader className="bg-muted/60">
                  <TableRow className="hover:bg-transparent"><TableHead>Measure</TableHead><TableHead className="text-right">Value</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {first ? [0, 1, 2].map((i) => (
                    <TableRow key={i}><TableCell><Skeleton className="h-4 w-2/3" /></TableCell><TableCell><Skeleton className="ml-auto h-4 w-1/3" /></TableCell></TableRow>
                  )) : measures.map(([label, value]) => (
                    <TableRow key={label}><TableCell>{label}</TableCell><TableCell className="text-right font-medium tabular-nums">{String(value)}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
