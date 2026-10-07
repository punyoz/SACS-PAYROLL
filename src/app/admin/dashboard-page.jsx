"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, Label, Pie, PieChart, XAxis, YAxis } from "recharts";
import {
  CalendarDaysIcon,
  CheckCircle2Icon,
  ClockAlertIcon,
  GraduationCapIcon,
  PartyPopperIcon,
  ReceiptTextIcon,
  UsersIcon,
  XCircleIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { BACKGROUND, fetchJson } from "@/lib/portal/api";
import { initialsOf, manilaDateKey } from "@/lib/portal/format";

/*
 * Admin Dashboard (loadDashboard / renderDashboardPanels /
 * renderRecentPayrollActivity, public/legacy/js/admin.js; mountUpcomingHolidays,
 * app.js): GET /api/admin/dashboard and /api/admin/holidays?upcoming=5.
 */

const TODAY_CHART = {
  present: { label: "Present", color: "var(--chart-1)" },
  late: { label: "Late", color: "var(--chart-2)" },
  absent: { label: "Absent", color: "var(--destructive)" },
  on_leave: { label: "On Leave", color: "var(--info)" },
};

const STAFF_CHART = { count: { label: "Employees", color: "var(--chart-1)" } };

/** "₱ 12,345" (formatMoney, admin.js). */
export function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "₱ 0";
  return `₱ ${amount.toLocaleString("en-PH", { maximumFractionDigits: 0 })}`;
}

function payrollStatus(status) {
  const key = String(status || "").toLowerCase();
  if (key === "paid" || key === "approved") return { tone: "success", label: "Paid" };
  if (key === "on_hold" || key === "rejected") return { tone: "danger", label: "On Hold" };
  if (key === "not_paid" || key === "unpaid") return { tone: "danger", label: "Not Paid" };
  return { tone: "gold", label: "Pending" };
}

/** The next holidays and suspensions (mountUpcomingHolidays, app.js). */
export function UpcomingHolidaysCard({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, holidays: [], today: "" });

  React.useEffect(() => {
    let cancelled = false;
    fetchJson("/api/admin/holidays?upcoming=5", BACKGROUND)
      .then((data) => { if (!cancelled) setState({ loading: false, error: null, holidays: data.holidays || [], today: data.today || manilaDateKey() }); })
      .catch((error) => { if (!cancelled) setState({ loading: false, error: error.message || "Unable to load holidays.", holidays: [], today: "" }); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const todayTime = new Date(`${state.today || "1970-01-01"}T00:00:00+08:00`).getTime();

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>Upcoming holidays</CardTitle>
        <CardDescription>Holidays and suspensions on the calendar</CardDescription>
      </CardHeader>
      <CardContent>
        {state.loading ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : state.error ? (
          <ErrorState message={state.error} />
        ) : !state.holidays.length ? (
          <EmptyState icon={PartyPopperIcon} title="No upcoming holidays saved" />
        ) : (
          <ul className="divide-y">
            {state.holidays.map((holiday) => {
              const date = new Date(`${holiday.holiday_date}T00:00:00+08:00`);
              const day = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", day: "numeric" }).format(date);
              const when = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date);
              const daysAway = Math.round((date.getTime() - todayTime) / 86400000);
              const away = daysAway <= 0 ? "Today" : daysAway === 1 ? "Tomorrow" : `In ${daysAway} days`;
              const kind = [holiday.type_label, holiday.day_part_label].filter(Boolean).join(" · ");
              return (
                <li key={`${holiday.holiday_date}-${holiday.name}`} className="flex items-center gap-3 py-2.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-gold/15 text-sm font-semibold text-gold-text tabular-nums">{day}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{holiday.name || "Holiday"}</p>
                    <p className="truncate text-xs text-muted-foreground">{when} · {kind}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{away}</span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardPage({ refreshKey, onSummary }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });

  React.useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: !current.data, error: null }));
    fetchJson("/api/admin/dashboard")
      .then((data) => {
        if (cancelled) return;
        setState({ loading: false, error: null, data });
        const p = data?.panels || {};
        const absent = Number(p.absent_today || 0);
        onSummary?.([
          { title: absent > 0 ? `${absent} employee${absent > 1 ? "s" : ""} absent today` : "Full attendance today", description: "Open Attendance to review today's records." },
          { title: `${p.total_employees || 0} active employees loaded`, description: "Manage Employees has the current staff list and status." },
        ]);
      })
      .catch((error) => { if (!cancelled) setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load dashboard data" })); });
    return () => { cancelled = true; };
  }, [refreshKey, onSummary]);

  const p = state.data?.panels || {};
  const loading = state.loading;
  const today = Object.keys(TODAY_CHART).map((key) => ({
    key,
    value: Number(p[`${key}_today`] || 0),
    fill: `var(--color-${key})`,
  }));
  const todayTotal = today.reduce((sum, slice) => sum + slice.value, 0);
  const staff = [
    { type: "Teaching", count: Number(p.teaching_count || 0) },
    { type: "Non-Teaching", count: Number(p.non_teaching_count || 0) },
  ];
  const activity = (state.data?.recent_activity || []).slice(0, 5);

  if (state.error && !state.data) {
    return <Card className="shadow-xs"><CardContent><ErrorState message={state.error} /></CardContent></Card>;
  }

  return (
    <>
      <section aria-label="Today at a glance" className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <StatCard label="Total employees" value={p.total_employees || 0} hint={`Teaching: ${p.teaching_count || 0} · Non-Teaching: ${p.non_teaching_count || 0}`} icon={UsersIcon} loading={loading} />
        <StatCard label="Present today" value={p.present_today || 0} hint="Logged in on time" icon={CheckCircle2Icon} tone="success" loading={loading} />
        <StatCard label="Late today" value={p.late_today || 0} hint="Arrived after 8:00 AM" icon={ClockAlertIcon} tone="gold" loading={loading} />
        <StatCard label="Absent today" value={p.absent_today || 0} hint="Based on employee status" icon={XCircleIcon} tone="danger" loading={loading} />
        <StatCard label="On leave today" value={p.on_leave_today || 0} hint="Approved leave" icon={CalendarDaysIcon} tone="info" loading={loading} />
        <StatCard label="Teaching staff" value={p.teaching_count || 0} hint={`Non-Teaching: ${p.non_teaching_count || 0}`} icon={GraduationCapIcon} tone="gold" loading={loading} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Today&apos;s attendance</CardTitle>
            <CardDescription>Employees by status</CardDescription>
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
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Staff mix</CardTitle>
            <CardDescription>Active employees by type</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-[220px] w-full" /> : (
              <ChartContainer config={STAFF_CHART} className="h-[240px] w-full">
                <BarChart accessibilityLayer data={staff} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis type="category" dataKey="type" tickLine={false} axisLine={false} width={96} fontSize={12} />
                  <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent hideLabel />} />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={44}>
                    {staff.map((row, i) => <Cell key={row.type} fill={i === 0 ? "var(--chart-1)" : "var(--chart-2)"} />)}
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <UpcomingHolidaysCard refreshKey={refreshKey} />
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Recent payroll activity</CardTitle>
            <CardDescription>The latest payroll entries</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : !activity.length ? (
              <EmptyState icon={ReceiptTextIcon} title="No recent payroll activity available" />
            ) : (
              <ul className="divide-y">
                {activity.map((item, index) => {
                  const status = payrollStatus(item.status);
                  return (
                    <li key={item.id || index} className="flex items-center gap-3 py-2.5">
                      <Avatar className="size-9"><AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initialsOf(item.name, "NA")}</AvatarFallback></Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{item.name} — {item.employee_type}</p>
                        <p className="truncate text-xs text-muted-foreground">{item.sub_text || item.period || ""}</p>
                      </div>
                      <div className="shrink-0 space-y-1 text-right">
                        <p className="text-sm font-semibold tabular-nums">{formatMoney(item.amount)}</p>
                        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                      </div>
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
