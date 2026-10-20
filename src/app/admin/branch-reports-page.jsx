"use client";

import * as React from "react";
import { CalendarDaysIcon, ClockAlertIcon, DownloadIcon, Loader2Icon, PercentIcon, TrendingUpIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatCard } from "@/components/portal/stat-card";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { API, useBranchView } from "./oversight-shared";

/*
 * Branch Reports (GET /api/admin/branch-oversight?view=reports&from&to):
 * attendance rate, lateness by month and leave usage for the Admin's branch,
 * for a chosen date range, exportable as PDF. No pay figures.
 */

function addDays(key, days) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function BranchReportsPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const today = manilaDateKey();
  const [from, setFrom] = React.useState(() => addDays(today, -29));
  const [to, setTo] = React.useState(today);
  const [downloading, setDownloading] = React.useState(false);
  const view = useBranchView("reports", { from, to }, refreshKey);
  const data = view.data;
  const s = data?.summary || {};

  async function downloadPdf() {
    setDownloading(true);
    try {
      const response = await apiFetch(`${API}?view=reports&format=pdf&from=${from}&to=${to}`);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Unable to export.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `branch-report-${from}-to-${to}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      notify("Export Failed", error.message, "error");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <Card className="shadow-xs">
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5"><Label htmlFor="br-from">From</Label><DatePicker id="br-from" value={from} max={to} onChange={(v) => setFrom(v || from)} /></div>
          <div className="space-y-1.5"><Label htmlFor="br-to">To</Label><DatePicker id="br-to" value={to} min={from} max={today} onChange={(v) => setTo(v || to)} /></div>
          <Button variant="outline" onClick={downloadPdf} disabled={downloading || !data}>{downloading ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}Export PDF</Button>
        </CardContent>
      </Card>
      {view.error ? <p role="alert" className="text-sm text-destructive">{view.error}{data ? " Showing the last loaded data." : ""}</p> : null}
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Attendance rate" value={`${s.attendance_rate ?? 0}%`} hint={data ? `${s.attended_days} of ${s.expected_days} days` : ""} icon={PercentIcon} tone="success" loading={view.first} />
        <StatCard label="Late days" value={s.late_days ?? 0} icon={ClockAlertIcon} tone="gold" loading={view.first} />
        <StatCard label="Leave days used" value={s.leave_days ?? 0} icon={CalendarDaysIcon} loading={view.first} />
        <StatCard label="Employees" value={s.employees ?? 0} icon={UsersIcon} loading={view.first} />
      </section>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card className="min-w-0 shadow-xs">
          <CardHeader><CardTitle className="flex items-center gap-2"><TrendingUpIcon className="size-4" aria-hidden="true" />Lateness and attendance by month</CardTitle></CardHeader>
          <CardContent>
            <DataTable columns={[
              { key: "label", header: "Month", className: "font-medium" },
              { key: "attendance_rate", header: "Attendance", align: "right", className: "tabular-nums", cell: (m) => `${m.attendance_rate}%` },
              { key: "late", header: "Late days", align: "right", className: "tabular-nums" },
              { key: "late_minutes", header: "Late minutes", align: "right", className: "tabular-nums" },
            ]} rows={data?.months || []} loading={view.first} searchable={false} pageSize={12} empty={{ title: "No attendance in this range", icon: TrendingUpIcon }} caption="Lateness by month" />
          </CardContent>
        </Card>
        <Card className="min-w-0 shadow-xs">
          <CardHeader><CardTitle className="flex items-center gap-2"><CalendarDaysIcon className="size-4" aria-hidden="true" />Leave usage</CardTitle><CardDescription>Approved leave days (weekdays) in the range.</CardDescription></CardHeader>
          <CardContent>
            <DataTable columns={[
              { key: "leave_type", header: "Leave type", className: "font-medium" },
              { key: "requests", header: "Requests", align: "right", className: "tabular-nums" },
              { key: "days", header: "Days", align: "right", className: "tabular-nums" },
            ]} rows={data?.leave_usage || []} loading={view.first} searchable={false} pageSize={10} empty={{ title: "No leave in this range", icon: CalendarDaysIcon }} caption="Leave usage" />
          </CardContent>
        </Card>
      </div>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>By employee</CardTitle>
          <CardDescription>{data ? `${dateLabel(data.from)} – ${dateLabel(data.to)}` : ""}</CardDescription>
          <CardAction />
        </CardHeader>
        <CardContent>
          <DataTable columns={[
            { key: "name", header: "Employee", sortable: true, className: "font-medium", searchValue: (e) => e.name },
            { key: "attended", header: "Attended", align: "right", sortable: true, className: "tabular-nums" },
            { key: "absent", header: "Absent", align: "right", sortable: true, className: "tabular-nums" },
            { key: "late", header: "Late days", align: "right", sortable: true, className: "tabular-nums" },
            { key: "late_minutes", header: "Late min", align: "right", sortable: true, className: "tabular-nums" },
            { key: "leave_days", header: "Leave days", align: "right", sortable: true, className: "tabular-nums" },
            { key: "attendance_rate", header: "Rate", align: "right", sortable: true, className: "tabular-nums", cell: (e) => `${e.attendance_rate}%` },
          ]} rows={data?.employees || []} loading={view.first} pageSize={15} searchPlaceholder="Search employee…" empty={{ title: "No records", icon: UsersIcon }} caption="Attendance by employee" minWidth={760} />
        </CardContent>
      </Card>
    </>
  );
}
