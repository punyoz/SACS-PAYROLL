"use client";

import * as React from "react";
import { ActivityIcon, CalendarDaysIcon, CheckCircle2Icon, ClockAlertIcon, InboxIcon, UserXIcon, UsersIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { UpcomingHolidaysCard } from "@/components/portal/upcoming-holidays";
import { dateLabel, dateTime } from "@/lib/portal/payroll-preview";
import { useBranchView } from "./oversight-shared";

/*
 * Branch Dashboard (GET /api/admin/branch-oversight?view=dashboard): today's
 * attendance of the Admin's branch, who has not tapped in yet, pending leave,
 * headcount and recent branch activity. No pay figures.
 */

export function DashboardPage({ refreshKey, onSummary, onNavigate }) {
  const view = useBranchView("dashboard", {}, refreshKey);
  const data = view.data;
  const a = data?.attendance || {};

  React.useEffect(() => {
    if (!data || !onSummary) return;
    onSummary([
      { title: `${data.pending_leave_count} leave request${data.pending_leave_count === 1 ? "" : "s"} waiting for HR`, description: "Give your recommendation under Leave Recommendations." },
      { title: `${data.not_tapped.length} not tapped in yet today`, description: data.rest_day ? `Today: ${data.rest_day}` : "See Branch Attendance." },
    ]);
  }, [data, onSummary]);

  if (view.error && !data) return <Card className="shadow-xs"><CardContent><ErrorState message={view.error} onRetry={view.load} /></CardContent></Card>;

  return (
    <>
      {view.error ? <p role="alert" className="text-sm text-destructive">{view.error} Showing the last loaded data.</p> : null}
      <section aria-label="Today" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Present" value={a.present ?? 0} hint={data ? dateLabel(data.today) : ""} icon={CheckCircle2Icon} tone="success" loading={view.first} />
        <StatCard label="Late" value={a.late ?? 0} hint="Included in present" icon={ClockAlertIcon} tone="gold" loading={view.first} />
        <StatCard label="Absent" value={a.absent ?? 0} icon={XCircleIcon} tone="danger" loading={view.first} />
        <StatCard label="Not tapped in yet" value={a.not_tapped ?? 0} hint={data?.rest_day || ""} icon={UserXIcon} tone="danger" loading={view.first} />
        <StatCard label="On leave" value={a.on_leave ?? 0} icon={CalendarDaysIcon} loading={view.first} />
      </section>
      <section aria-label="Branch" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Headcount" value={data?.headcount?.total ?? 0} hint={data ? `${data.headcount.teaching} teaching · ${data.headcount.non_teaching} non-teaching` : ""} icon={UsersIcon} loading={view.first} />
        <StatCard label="Leave waiting for HR" value={data?.pending_leave_count ?? 0} icon={CalendarDaysIcon} tone="gold" loading={view.first} />
        <StatCard label="Your requests waiting for HR" value={data?.open_requests ?? 0} icon={InboxIcon} tone="gold" loading={view.first} />
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Not tapped in yet</CardTitle>
            <CardDescription>Employees of your branch with no time-in today (excluding those on approved leave).</CardDescription>
            <CardAction><Button variant="ghost" size="sm" onClick={() => onNavigate?.("adm-attendance")}>Branch Attendance</Button></CardAction>
          </CardHeader>
          <CardContent>
            {!data?.not_tapped?.length ? <EmptyState icon={CheckCircle2Icon} title={data?.rest_day ? `No work today (${data.rest_day})` : "Everyone has tapped in"} /> : (
              <ul className="divide-y rounded-lg border">
                {data.not_tapped.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="font-medium">{p.full_name}<span className="ml-2 text-xs font-normal text-muted-foreground">{p.employee_code}</span></span>
                    <StatusBadge tone={p.employee_type === "Non-Teaching" ? "gold" : "info"} dot={false}>{p.employee_type}</StatusBadge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Leave waiting for HR</CardTitle>
            <CardDescription>Recommend each one; HR decides.</CardDescription>
            <CardAction><Button variant="ghost" size="sm" onClick={() => onNavigate?.("adm-leaves")}>Leave Recommendations</Button></CardAction>
          </CardHeader>
          <CardContent>
            {!data?.pending_leaves?.length ? <EmptyState icon={CalendarDaysIcon} title="No pending leave" /> : (
              <ul className="divide-y rounded-lg border">
                {data.pending_leaves.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="font-medium">{l.employee_name}</span>
                    <span className="text-xs text-muted-foreground">{l.leave_type} · {dateLabel(l.start_date)}{l.end_date !== l.start_date ? ` – ${dateLabel(l.end_date)}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-xs">
          <CardHeader><CardTitle className="flex items-center gap-2"><ActivityIcon className="size-4" aria-hidden="true" />Recent branch activity</CardTitle></CardHeader>
          <CardContent>
            {!data?.recent_activity?.length ? <EmptyState icon={ActivityIcon} title="No activity yet" /> : (
              <ul className="space-y-2">
                {data.recent_activity.map((item, i) => (
                  <li key={`${item.at}-${i}`} className="text-sm"><p>{item.text}</p><p className="text-xs text-muted-foreground">{dateTime(item.at)}</p></li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <UpcomingHolidaysCard refreshKey={refreshKey} />
      </div>
    </>
  );
}
