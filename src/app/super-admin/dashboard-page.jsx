"use client";

import * as React from "react";
import { Cell, Label, Pie, PieChart } from "recharts";
import {
  ActivityIcon,
  CheckCircle2Icon,
  ClipboardListIcon,
  DatabaseIcon,
  HourglassIcon,
  ReceiptTextIcon,
  ScrollTextIcon,
  ServerIcon,
  UsersIcon,
  UsersRoundIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { UpcomingHolidaysCard } from "@/components/portal/upcoming-holidays";
import { fetchJson } from "@/lib/portal/api";

/*
 * SA Dashboard (loadSADashboard / renderSARecentActivity,
 * public/legacy/js/super-admin.js): GET /api/admin/dashboard and
 * /api/admin/system, each allowed to fail on its own.
 */

const TODAY_CHART = {
  present: { label: "Present", color: "var(--chart-1)" },
  late: { label: "Late", color: "var(--chart-2)" },
  absent: { label: "Absent", color: "var(--destructive)" },
  on_leave: { label: "On Leave", color: "var(--info)" },
};

/** The four health rows (updateSAHealthRow). */
export function healthRows(system, failed) {
  if (failed || !system) {
    return [
      { key: "db", icon: DatabaseIcon, label: "Database", meta: "Checking via admin endpoint", pill: "Pending", tone: "warning" },
      { key: "users", icon: UsersIcon, label: "User accounts", meta: "Could not load", pill: "Unknown", tone: "warning" },
      { key: "att", icon: ClipboardListIcon, label: "Attendance records", meta: "Could not load", pill: "Unknown", tone: "warning" },
      { key: "pay", icon: ReceiptTextIcon, label: "Payroll records", meta: "Could not load", pill: "Unknown", tone: "warning" },
    ];
  }
  const db = system.database_status || {};
  const total = system.system_stats?.total_users || 0;
  const dbOk = db.connection === "ok";
  const table = (key) => (db[key] === "ok"
    ? { meta: "Table available", pill: "Active", tone: "success" }
    : { meta: "Table missing", pill: "Missing", tone: "warning" });
  return [
    { key: "db", icon: DatabaseIcon, label: "Database", meta: dbOk ? "Connected" : "Connection error", pill: dbOk ? "Online" : "Error", tone: dbOk ? "success" : "danger" },
    { key: "users", icon: UsersIcon, label: "User accounts", meta: `${total} registered`, pill: "OK", tone: "success" },
    { key: "att", icon: ClipboardListIcon, label: "Attendance records", ...table("attendance_logs") },
    { key: "pay", icon: ReceiptTextIcon, label: "Payroll records", ...table("payroll_records") },
  ];
}

export function HealthList({ rows, loading }) {
  if (loading) return <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  return (
    <ul className="divide-y">
      {rows.map((row) => {
        const Icon = row.icon;
        return (
          <li key={row.key} className="flex items-center gap-3 py-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" aria-hidden="true" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{row.label}</p>
              <p className="truncate text-xs text-muted-foreground">{row.meta}</p>
            </div>
            <StatusBadge tone={row.tone}>{row.pill}</StatusBadge>
          </li>
        );
      })}
    </ul>
  );
}

function activityTone(row) {
  const s = String(row.status || row.action || "").toLowerCase();
  if (s === "success" || s === "approve" || s === "approved") return "success";
  if (s === "failed" || s === "error" || s === "reject") return "danger";
  return "gold";
}

function activityTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function DashboardPage({ refreshKey, onSummary, onNavigate }) {
  const [state, setState] = React.useState({ loading: true, dashboard: null, system: null, systemFailed: false });

  React.useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: !current.dashboard && !current.system }));
    Promise.allSettled([fetchJson("/api/admin/dashboard"), fetchJson("/api/admin/system")]).then(([dash, sys]) => {
      if (cancelled) return;
      const dashboard = dash.status === "fulfilled" ? dash.value : null;
      const system = sys.status === "fulfilled" ? sys.value : null;
      setState({ loading: false, dashboard, system, systemFailed: !system });
      const p = dashboard?.panels || {};
      const absent = Number(p.absent_today ?? dashboard?.absent_today ?? 0);
      onSummary?.([
        { title: absent > 0 ? `${absent} employee${absent > 1 ? "s" : ""} absent today` : "Full attendance today", description: "Open Attendance to review today's records." },
        { title: system?.database_status?.connection === "ok" ? "Database connected" : "Database status unknown", description: "System health is on the dashboard." },
      ]);
    });
    return () => { cancelled = true; };
  }, [refreshKey, onSummary]);

  const d = state.dashboard || {};
  const p = d.panels || {};
  // The legacy page read these at the top level; the API sends them in panels.
  const panel = (key, alt) => p[key] ?? d[key] ?? d[alt];
  const totalUsers = state.system?.system_stats?.total_users || 0;
  const loading = state.loading;

  const today = Object.keys(TODAY_CHART).map((key) => ({ key, value: Number(panel(`${key}_today`) || 0), fill: `var(--color-${key})` }));
  const todayTotal = today.reduce((sum, slice) => sum + slice.value, 0);
  const activity = (d.recent_activity || d.recentActivity || []).slice(0, 8);

  return (
    <>
      <section aria-label="System at a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total employees" value={panel("total_employees", "totalEmployees") ?? "—"} hint="Active system-wide" icon={UsersIcon} loading={loading} />
        <StatCard label="Total users" value={totalUsers || "—"} hint="All registered accounts" icon={UsersRoundIcon} tone="info" loading={loading} />
        <StatCard label="System status" value="Online" hint="Database & services" icon={ServerIcon} tone="success" loading={loading} />
        <StatCard label="Pending actions" value={0} hint="Across all modules" icon={HourglassIcon} tone="gold" loading={loading} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Today&apos;s attendance</CardTitle>
            <CardDescription>Employees by status, all branches</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="mx-auto aspect-square w-full max-w-[220px] rounded-full" /> : todayTotal === 0 ? (
              <EmptyState icon={CheckCircle2Icon} title="No attendance yet today" description="Statuses appear as employees tap in." />
            ) : (
              <ChartContainer config={TODAY_CHART} className="mx-auto aspect-square max-h-[260px]">
                <PieChart accessibilityLayer>
                  <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" />} />
                  <Pie data={today} dataKey="value" nameKey="key" innerRadius={62} strokeWidth={3} stroke="var(--card)">
                    {today.map((slice) => <Cell key={slice.key} fill={slice.fill} />)}
                    <Label
                      content={({ viewBox }) => (viewBox && "cx" in viewBox ? (
                        <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                          <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-2xl font-semibold">{todayTotal}</tspan>
                          <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 20} className="fill-muted-foreground text-xs">employees</tspan>
                        </text>
                      ) : null)}
                    />
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="key" />} className="flex-wrap gap-x-4 gap-y-1" />
                </PieChart>
              </ChartContainer>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => onNavigate("sa-audit")}><ScrollTextIcon aria-hidden="true" />View audit logs</Button>
              <Button variant="outline" size="sm" onClick={() => onNavigate("sa-accounts")}><UsersRoundIcon aria-hidden="true" />Admin &amp; HR accounts</Button>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>System health</CardTitle>
            <CardDescription>Database connection and core tables</CardDescription>
          </CardHeader>
          <CardContent>
            <HealthList rows={healthRows(state.system, state.systemFailed)} loading={loading} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <UpcomingHolidaysCard refreshKey={refreshKey} />
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Recent system activity</CardTitle>
            <CardDescription>The latest activity across the system</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : !activity.length ? (
              <EmptyState icon={ActivityIcon} title="No recent system activity" />
            ) : (
              <ul className="divide-y">
                {activity.map((row, index) => {
                  const label = row.status || row.action || "—";
                  const text = row.description || row.employee_name || row.entity_id || label;
                  const time = activityTime(row.timestamp || row.created_at);
                  return (
                    <li key={row.id || index} className="flex items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{row.module ? <span className="text-muted-foreground">[{row.module}] </span> : null}{text}</p>
                        {time ? <p className="text-xs text-muted-foreground">{time}</p> : null}
                      </div>
                      <StatusBadge tone={activityTone(row)} className="shrink-0 capitalize">{String(label).replaceAll("_", " ")}</StatusBadge>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
