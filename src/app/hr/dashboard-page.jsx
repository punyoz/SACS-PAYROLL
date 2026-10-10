"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { ArrowRightIcon, CalendarClockIcon, CalendarDaysIcon, CheckCircle2Icon, ClockIcon, UsersIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { AttendanceBadge } from "@/components/portal/status-badge";
import { UpcomingHolidaysCard } from "@/components/portal/upcoming-holidays";
import { fetchJson } from "@/lib/portal/api";
import { LicenseAlertsCard } from "./license-alerts-card";

/*
 * HR Dashboard (loadHRDashboard / renderHRDashboardLeaves /
 * renderHRRecentActivity, public/legacy/js/hr.js): GET /api/hr/dashboard.
 */

/** "08:05 AM" in the browser's time zone (formatTimeOnly, app.js). */
function timeOnly(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-PH", { hour: "2-digit", minute: "2-digit", hour12: true }).format(date);
}

const CHART = { count: { label: "Employees" } };

export function DashboardPage({ refreshKey, onNavigate, onSummary }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });

  React.useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: !current.data, error: null }));
    fetchJson("/api/hr/dashboard")
      .then((data) => {
        if (cancelled) return;
        setState({ loading: false, error: null, data });
        const pending = Number(data.pending_leaves || 0);
        const total = Number(data.total_employees || 0);
        onSummary?.([
          {
            title: pending > 0 ? `${pending} leave request${pending > 1 ? "s" : ""} pending approval` : "No pending leave requests",
            description: pending > 0 ? "Open Leave Approval to review and approve pending requests." : "All leave requests have been processed.",
          },
          { title: `${total} employees on record`, description: "Use User Management to view and update staff information." },
        ]);
      })
      .catch((error) => { if (!cancelled) setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load dashboard." })); });
    return () => { cancelled = true; };
  }, [refreshKey, onSummary]);

  const d = state.data || {};
  const loading = state.loading && !state.data;
  const pending = Number(d.pending_leaves || 0);
  const activity = d.recent_activity || [];
  const bars = [
    { label: "Teaching", count: Number(d.teaching_staff || 0), fill: "var(--chart-1)" },
    { label: "Non-Teaching", count: Number(d.non_teaching_staff || 0), fill: "var(--chart-2)" },
    { label: "Present today", count: Number(d.present_today || 0), fill: "var(--chart-3)" },
    { label: "Late today", count: Number(d.late_today || 0), fill: "var(--chart-4)" },
  ];

  if (state.error && !state.data) {
    return <Card className="shadow-xs"><CardContent><ErrorState message={state.error} /></CardContent></Card>;
  }

  return (
    <>
      <section aria-label="Today at a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total employees" value={d.total_employees ?? 0} hint="Active staff on record" icon={UsersIcon} loading={loading} />
        <StatCard label="Present today" value={d.present_today ?? 0} hint="Attendance today" icon={CheckCircle2Icon} tone="success" loading={loading} />
        <StatCard label="Absent today" value={d.absent_today ?? 0} hint="Not yet recorded" icon={XCircleIcon} tone="danger" loading={loading} />
        <StatCard label="Pending leaves" value={pending} hint="Awaiting your decision" icon={CalendarClockIcon} tone="gold" loading={loading} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Staff breakdown</CardTitle>
            <CardDescription>Teaching: {d.teaching_staff ?? 0} · Non-Teaching: {d.non_teaching_staff ?? 0} · Late today: {d.late_today ?? 0}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? <Skeleton className="h-[220px] w-full" /> : (
              <ChartContainer config={CHART} className="h-[220px] w-full">
                <BarChart accessibilityLayer data={bars} margin={{ left: 4, right: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} fontSize={11} />
                  <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent hideLabel />} />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={52}>
                    {bars.map((bar) => <Cell key={bar.label} fill={bar.fill} />)}
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => onNavigate("hr-employees")}>View employees</Button>
              <Button variant="outline" size="sm" onClick={() => onNavigate("hr-attendance")}>View attendance</Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card className="min-w-0 shadow-xs">
            <CardHeader>
              <CardTitle>Pending leave requests</CardTitle>
              <CardAction><Button variant="ghost" size="sm" onClick={() => onNavigate("hr-leaves")}>View all<ArrowRightIcon aria-hidden="true" /></Button></CardAction>
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton className="h-12 w-full" /> : pending === 0 ? (
                <EmptyState icon={CalendarDaysIcon} title="No pending leave requests" className="py-6" />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-gold/40 bg-brand-gold/10 p-4">
                  <p><strong className="text-lg text-gold-text tabular-nums">{pending}</strong> leave request{pending > 1 ? "s" : ""} awaiting your decision.</p>
                  <Button size="sm" onClick={() => onNavigate("hr-leaves")}>Review now</Button>
                </div>
              )}
            </CardContent>
          </Card>
          <UpcomingHolidaysCard refreshKey={refreshKey} />
        </div>
      </div>

      <LicenseAlertsCard refreshKey={refreshKey} onNavigate={onNavigate} />

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Recent attendance activity</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : !activity.length ? (
            <EmptyState icon={ClockIcon} title="No recent attendance activity" />
          ) : (
            <ul className="divide-y">
              {activity.map((row, index) => (
                <li key={`${row.employee_id}-${row.date}-${index}`} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{row.employee_name || row.employee_id || "Unknown"}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.date ? new Date(row.date).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : ""}
                      {" · "}Time in {timeOnly(row.time_in)} · Time out {row.time_out ? timeOnly(row.time_out) : "Still clocked in"}
                    </p>
                  </div>
                  <AttendanceBadge status={row.status} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
