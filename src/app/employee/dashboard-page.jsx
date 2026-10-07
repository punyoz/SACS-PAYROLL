"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, Label, Pie, PieChart, XAxis, YAxis } from "recharts";
import {
  ArrowRightIcon,
  CalendarCheckIcon,
  CalendarDaysIcon,
  CalendarHeartIcon,
  CheckCircle2Icon,
  ClockAlertIcon,
  ClockIcon,
  PartyPopperIcon,
  ReceiptTextIcon,
  WalletIcon,
  XCircleIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { usePortalSession } from "@/components/portal/session";
import { formatPeso, initialsOf, leaveSummary } from "@/lib/portal/format";

const ATTENDANCE_CHART = {
  present: { label: "Present", color: "var(--chart-1)" },
  late: { label: "Late", color: "var(--chart-2)" },
  absent: { label: "Absent", color: "var(--destructive)" },
  on_leave: { label: "On Leave", color: "var(--info)" },
};

const PAY_CHART = { net_pay: { label: "Net pay", color: "var(--chart-1)" } };

const MODULES = [
  { id: "emp-attendance", title: "Attendance", text: "Your monthly attendance calendar, time in and out, and daily status.", icon: CalendarCheckIcon },
  { id: "emp-timesheet", title: "Timesheet", text: "Daily and monthly work hours, tardiness and undertime, ready to export.", icon: ClockIcon },
  { id: "emp-payslips", title: "Payslips", text: "Current and previous payslips with the full earnings and deductions.", icon: ReceiptTextIcon },
  { id: "emp-leave", title: "Leave Requests", text: "Request leave with supporting documents and track its approval.", icon: CalendarDaysIcon },
];

/** The role / staff / ID line (applyEmployeeIdentity, employee.js). */
function identityLine(ctx) {
  const role = String(ctx?.role || "").toLowerCase() === "accountant" || String(ctx?.position || "").toLowerCase().includes("account")
    ? "Accountant"
    : "Employee";
  const staff = ctx?.employee_type ? `${ctx.employee_type} Staff` : String(ctx?.position || "").trim();
  return [role, staff, ctx?.employee_id || "N/A"].filter(Boolean).join(" · ");
}

function nextHolidayText(holiday, todayKey) {
  if (!holiday) return null;
  const when = holiday.date === todayKey
    ? "Today"
    : new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric" })
      .format(new Date(`${holiday.date}T00:00:00+08:00`));
  return `${holiday.name} · ${when}${holiday.note ? ` (${holiday.note})` : ""}`;
}

function AttendanceDonut({ data, loading }) {
  const slices = Object.keys(ATTENDANCE_CHART).map((key) => ({ key, value: Number(data?.[key] || 0), fill: `var(--color-${key})` }));
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>This month&apos;s attendance</CardTitle>
        <CardDescription>{data?.month_label || "Days by status"}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="mx-auto aspect-square w-full max-w-[220px] rounded-full" />
        ) : total === 0 ? (
          <EmptyState icon={CalendarCheckIcon} title="No attendance yet this month" description="Days appear here once you tap in with your RFID card." />
        ) : (
          <ChartContainer config={ATTENDANCE_CHART} className="mx-auto aspect-square max-h-[260px]">
            <PieChart accessibilityLayer>
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" />} />
              <Pie data={slices} dataKey="value" nameKey="key" innerRadius={62} strokeWidth={3} stroke="var(--card)">
                {slices.map((slice) => <Cell key={slice.key} fill={slice.fill} />)}
                <Label
                  content={({ viewBox }) => (viewBox && "cx" in viewBox ? (
                    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                      <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-2xl font-semibold">{total}</tspan>
                      <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 20} className="fill-muted-foreground text-xs">days</tspan>
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
  );
}

function NetPayChart({ payslips }) {
  const points = React.useMemo(
    () => payslips.list.slice(0, 6).reverse().map((p) => ({ period: p.period_label, net_pay: Number(p.net_pay || 0) })),
    [payslips.list],
  );

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>Recent net pay</CardTitle>
        <CardDescription>Your last {points.length || "few"} payslips</CardDescription>
      </CardHeader>
      <CardContent>
        {payslips.loading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : points.length === 0 ? (
          <EmptyState icon={ReceiptTextIcon} title="No payslips yet" description="Your payslips will show here once payroll is processed." />
        ) : (
          <ChartContainer config={PAY_CHART} className="h-[240px] w-full">
            <BarChart accessibilityLayer data={points} margin={{ left: 4, right: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="period" tickLine={false} axisLine={false} tickMargin={8} interval={0} tickFormatter={(v) => String(v).replace(/,\s*\d{4}$/, "")} fontSize={11} />
              <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v) => (v >= 1000 ? `₱${Math.round(v / 1000)}k` : `₱${v}`)} fontSize={11} />
              <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent formatter={(value) => <span className="tabular-nums font-medium">{formatPeso(value)}</span>} />} />
              <Bar dataKey="net_pay" fill="var(--color-net_pay)" radius={[6, 6, 0, 0]} maxBarSize={48} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardPage({ stats, payslips, onNavigate }) {
  const { ctx } = usePortalSession();
  const name = String(ctx?.full_name || "").trim() || "Employee";
  const data = stats.data;
  const loading = stats.loading && !data;
  const holiday = nextHolidayText(data?.next_holiday, data?.today_key);

  return (
    <>
      <Card className="relative overflow-hidden border-0 bg-gradient-to-br from-brand-green to-brand-green-dark py-5 text-white shadow-md">
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1 bg-brand-gold" />
        <CardContent className="flex flex-col gap-4 px-5 sm:flex-row sm:items-center">
          <Avatar className="size-14 ring-2 ring-brand-gold-light/70">
            <AvatarFallback className="bg-white/15 text-lg font-semibold text-white">{initialsOf(name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-semibold">{name} <span aria-hidden="true">👋</span></h2>
            <p className="truncate text-sm text-white/80">{identityLine(ctx)}</p>
            {data?.upcoming_leave ? (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-brand-gold-light">
                <CalendarHeartIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">Upcoming leave: {leaveSummary(data.upcoming_leave)}</span>
              </p>
            ) : null}
            {holiday ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm text-brand-gold-light">
                <PartyPopperIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">Next holiday: {holiday}</span>
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <section aria-label="This month at a glance" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Present" value={data?.present} icon={CheckCircle2Icon} tone="success" loading={loading} />
        <StatCard label="Late" value={data?.late} icon={ClockAlertIcon} tone="gold" loading={loading} />
        <StatCard label="Absent" value={data?.absent} icon={XCircleIcon} tone="danger" loading={loading} />
        <StatCard label="On Leave" value={data?.on_leave} icon={CalendarDaysIcon} tone="info" loading={loading} />
        <StatCard label="Basic Salary" value={data?.basic_salary || "—"} icon={WalletIcon} tone="primary" loading={loading} className="col-span-2 md:col-span-1" />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <AttendanceDonut data={data} loading={loading} />
        <NetPayChart payslips={payslips} />
      </div>

      <section aria-label="Quick access" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {MODULES.map((module) => {
          const Icon = module.icon;
          return (
            <button
              key={module.id}
              type="button"
              onClick={() => onNavigate(module.id)}
              className="group flex h-full flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition hover:-translate-y-0.5 hover:border-brand-gold hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <span className="flex-1">
                <span className="block font-semibold">{module.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{module.text}</span>
              </span>
              <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                Open <ArrowRightIcon className="size-4 transition group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
            </button>
          );
        })}
      </section>
    </>
  );
}
