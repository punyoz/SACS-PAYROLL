"use client";

import * as React from "react";
import { FinalPayWaitingCard } from "./final-pay-approvals-page";
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
import { portalHref } from "@/lib/portal/navigate";
import { manilaDateKey } from "@/lib/payroll/periods";
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
  const today = manilaDateKey();
  const todayRange = { hr_att_from: today, hr_att_to: today };
  // Part J (2026-11-22): two charts, each bar linking to its filtered list.
  const staffBars = [
    { label: "Teaching", count: Number(d.teaching_staff || 0), fill: "var(--chart-1)", href: portalHref("hr-employees", { emp_filter: "teaching" }) },
    { label: "Non-Teaching", count: Number(d.non_teaching_staff || 0), fill: "var(--chart-2)", href: portalHref("hr-employees", { emp_filter: "non-teaching" }) },
  ];
  const late = Number(d.late_today || 0);
  const todayBars = [
    // "On time" (not "Present"): Late is its own bar, so the bars add up; the Present card above counts Late in.
    { label: "On time", count: Math.max(0, Number(d.present_today || 0) - late), fill: "var(--chart-1)", href: portalHref("hr-attendance", { ...todayRange, hr_att_status: "Present" }) },
    { label: "Late", count: late, fill: "var(--chart-4)", href: portalHref("hr-attendance", { ...todayRange, hr_att_status: "Late" }) },
    { label: "Absent", count: Number(d.absent_marked_today || 0), fill: "var(--destructive)", href: portalHref("hr-attendance", { ...todayRange, hr_att_status: "Absent" }) },
    { label: "On leave", count: Number(d.on_leave_today || 0), fill: "var(--chart-2)", href: portalHref("hr-attendance", { ...todayRange, hr_att_status: "On Leave" }) },
    { label: "Not tapped yet", count: Number(d.absent_today || 0), fill: "var(--chart-5)", href: portalHref("hr-attendance", { ...todayRange, hr_att_status: "Not tapped yet" }) },
  ];

  if (state.error && !state.data) {
    return <Card className="shadow-xs"><CardContent><ErrorState message={state.error} /></CardContent></Card>;
  }

  return (
    <>
      {/* Final pay waiting for HR, with days left (20261120010000). */}
      <FinalPayWaitingCard refreshKey={refreshKey} onOpen={() => onNavigate?.("hr-final-pay-approvals")} />
      <ActionNeededCard data={d.action_needed} />
      <section aria-label="Today at a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total employees" value={d.total_employees ?? 0} hint="Active staff on record" icon={UsersIcon} loading={loading} href={portalHref("hr-employees")} actionLabel="View active employees" />
        <StatCard label="Present today" value={d.present_today ?? 0} hint="Late included" icon={CheckCircle2Icon} tone="success" loading={loading} href={portalHref("hr-attendance", { ...todayRange, hr_att_status: "Present" })} actionLabel="View who is present today" />
        <StatCard label="Absent today" value={d.absent_today ?? 0} hint="No tap yet" icon={XCircleIcon} tone="danger" loading={loading} href={portalHref("hr-attendance", { ...todayRange, hr_att_status: "Not tapped yet" })} actionLabel="View who has not tapped in today" />
        <StatCard label="Pending leaves" value={pending} hint="Awaiting your decision" icon={CalendarClockIcon} tone="gold" loading={loading} href={portalHref("hr-leaves")} actionLabel="View pending leave requests" />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid min-w-0 gap-4">
          <CountChart testId="chart-staff" title="Staff breakdown" description={`Teaching ${d.teaching_staff ?? 0} · Non-Teaching ${d.non_teaching_staff ?? 0}`} bars={staffBars} loading={loading} unit="Employees" />
          <CountChart testId="chart-today" title="Today's attendance" description="On time, Late, Absent, On leave and Not tapped yet, from today's records" bars={todayBars} loading={loading} unit="Employees" />
        </div>

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

const fmtDay = (key) => new Date(`${key}T00:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });

/**
 * One bar chart with its own title and legend (Part J, 2026-11-22); each
 * legend entry links to the filtered list behind its bar.
 */
function CountChart({ testId, title, description, bars, loading, unit }) {
  return (
    <Card className="min-w-0 shadow-xs" data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? <Skeleton className="h-[180px] w-full" /> : (
          <ChartContainer config={{ count: { label: unit } }} className="h-[180px] w-full">
            <BarChart accessibilityLayer data={bars} margin={{ left: 4, right: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} interval={0} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} fontSize={11} />
              <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent hideLabel />} />
              <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={52}>
                {bars.map((bar) => <Cell key={bar.label} fill={bar.fill} />)}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={`${title}: legend`}>
          {bars.map((bar) => (
            <li key={bar.label}>
              <a href={bar.href} className="inline-flex items-center gap-1.5 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                <span aria-hidden="true" className="size-2.5 rounded-sm" style={{ background: bar.fill }} />
                {bar.label} <span className="tabular-nums font-medium">{bar.count}</span>
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** HR's Action needed (Part A): records to confirm, probations and contracts ending soon, salaries not set. */
function ActionNeededCard({ data }) {
  const a = data || {};
  const groups = [
    { key: "unconfirmed", title: "Needs HR confirmation", text: "Employment status and type set by default (Regular / Full-time).", href: portalHref("hr-employees", { emp_filter: "unconfirmed" }), rows: a.unconfirmed || [] },
    { key: "probation", title: "Probation ending", text: "Decide the next status before the date.", href: portalHref("hr-employees", { emp_status: "Probationary" }), rows: a.probation_ending || [] },
    { key: "contract", title: "Contract ending", text: "Renew, end or change the status before the date.", href: portalHref("hr-employees", { emp_status: "Contractual" }), rows: a.contract_ending || [] },
    // 2026-11-22: payroll refuses a ₱0 salary; each name opens that employee's record.
    { key: "salary", title: "Salary not set", text: "₱0 salary: payroll refuses them until it is set (an HR account's salary: Super Admin).", href: portalHref("hr-employees"), rows: a.salary_not_set || [],
      rowHref: (r) => portalHref("hr-employees", { emp_open: r.id }) },
    // Part B (2026-11-22): a Final payslip never changes by itself; the Accountant files the correction.
    { key: "late-leave", title: "Leave approved after its payslip", text: "The payslip for that day was already paid: the branch Accountant files a correction on the next payslip.", href: portalHref("hr-payroll-records"), rows: a.leave_after_payslip || [] },
  ].filter((g) => g.rows.length);
  if (!groups.length) return null;
  return (
    <Card className="border-brand-gold/40 shadow-xs">
      <CardHeader>
        <CardTitle>Action needed</CardTitle>
        <CardDescription>Employee records waiting for HR.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        {groups.map((g) => (g.rowHref ? (
          // One link per person (a card-wide link cannot hold links inside it).
          <div key={g.key} className="rounded-lg border p-3" data-testid={`action-${g.key}`}>
            <p className="text-sm font-semibold">{g.title} <span className="tabular-nums text-gold-text">({g.rows.length})</span></p>
            <p className="mb-2 text-xs text-muted-foreground">{g.text}</p>
            <ul className="space-y-0.5 text-sm">
              {g.rows.map((r) => <li key={r.id}><a href={g.rowHref(r)} className="underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{r.full_name}</a></li>)}
            </ul>
          </div>
        ) : (
          <a key={g.key} href={g.href} className="block rounded-lg border p-3 transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <p className="text-sm font-semibold">{g.title} <span className="tabular-nums text-gold-text">({g.rows.length})</span></p>
            <p className="mb-2 text-xs text-muted-foreground">{g.text}</p>
            <ul className="space-y-0.5 text-sm">
              {g.rows.slice(0, 5).map((r) => <li key={r.id}>{r.full_name}{r.due_on ? <span className="text-muted-foreground"> · {fmtDay(r.due_on)}</span> : null}{r.detail ? <span className="text-muted-foreground"> · {r.detail}</span> : null}</li>)}
              {g.rows.length > 5 ? <li className="text-xs text-muted-foreground">and {g.rows.length - 5} more</li> : null}
            </ul>
          </a>
        )))}
      </CardContent>
    </Card>
  );
}
