"use client";

import * as React from "react";
import { CalendarCheckIcon, FlagIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { AttendanceBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { formatTime, manilaDateKey } from "@/lib/portal/format";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { DecisionCell, FileDialog, FiledCell, HistoryButton, RequestStatus, fileRequest, useBranchView } from "./oversight-shared";

/*
 * Branch Attendance (GET /api/admin/branch-oversight?view=attendance):
 * read-only daily or monthly logs of the Admin's branch. "Flag issue" sends a
 * record to HR with a note (Pending until HR marks it Resolved); the Admin
 * never edits a log.
 */

function monthStart(key) {
  return `${key.slice(0, 7)}-01`;
}

export function AttendancePage({ refreshKey }) {
  const { notify } = usePortalSession();
  const today = manilaDateKey();
  const [mode, setMode] = React.useState("daily");
  const [day, setDay] = React.useState(today);
  const [month, setMonth] = React.useState(today.slice(0, 7));
  const [target, setTarget] = React.useState(null);
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const from = mode === "daily" ? day : monthStart(`${month}-01`);
  const to = mode === "daily" ? day : `${month}-${String(lastDay).padStart(2, "0")}`;
  const view = useBranchView("attendance", { from, to: to > today ? today : to }, refreshKey);
  const data = view.data;

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", cell: (l) => <div><p>{l.employee_name}</p><p className="text-xs text-muted-foreground">{l.employee_code}</p></div>, searchValue: (l) => `${l.employee_name} ${l.employee_code}` },
    { key: "log_date", header: "Date", sortable: true, className: "whitespace-nowrap tabular-nums", cell: (l) => dateLabel(l.log_date) },
    { key: "time_in", header: "Time in", className: "tabular-nums", cell: (l) => (l.time_in ? formatTime(l.time_in) : "—") },
    { key: "time_out", header: "Time out", className: "tabular-nums", cell: (l) => (l.time_out ? formatTime(l.time_out) : "—") },
    { key: "status", header: "Status", sortValue: (l) => l.status, cell: (l) => <div><AttendanceBadge status={l.status} />{l.late_minutes ? <p className="mt-0.5 text-xs text-muted-foreground">{l.late_minutes} min late</p> : null}</div>, searchValue: (l) => l.status },
    { key: "flag", header: "Flag", cell: (l) => (l.flag ? <div className="flex items-center gap-1"><RequestStatus status={l.flag.status} label={l.flag.status_label} /><HistoryButton request={l.flag} /></div> : <span className="text-xs text-muted-foreground">—</span>) },
    { key: "act", header: <span className="sr-only">Flag issue</span>, align: "right", cell: (l) => (l.flag?.status === "pending" ? null : <Button size="sm" variant="outline" onClick={() => setTarget(l)}><FlagIcon aria-hidden="true" />Flag issue</Button>) },
  ];

  const flagColumns = [
    { key: "employee_name", header: "Employee", className: "font-medium", cell: (r) => r.details?.employee_name || "—", searchValue: (r) => r.details?.employee_name },
    { key: "day", header: "Record", cell: (r) => <div className="text-xs"><p>{dateLabel(r.details?.log_date)}</p><p className="text-muted-foreground">{r.details?.log_status}</p></div> },
    { key: "admin_note", header: "Your note", cell: (r) => <p className="max-w-64 text-xs whitespace-normal">{r.admin_note}</p> },
    { key: "filed", header: "Sent", cell: (r) => <FiledCell request={r} /> },
    { key: "status", header: "Status", cell: (r) => <RequestStatus status={r.status} label={r.status_label} /> },
    { key: "decision", header: "HR", cell: (r) => <DecisionCell request={r} /> },
    { key: "history", header: <span className="sr-only">History</span>, align: "right", cell: (r) => <HistoryButton request={r} /> },
  ];

  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CalendarCheckIcon className="size-4 text-gold-text" aria-hidden="true" />Branch attendance</CardTitle>
          <CardDescription>View only. To question a record, flag it: HR checks it and marks it Resolved.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={view.load} disabled={view.loading}><RefreshCwIcon className={cn(view.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Tabs value={mode} onValueChange={setMode}><TabsList><TabsTrigger value="daily">Daily</TabsTrigger><TabsTrigger value="monthly">Monthly</TabsTrigger></TabsList></Tabs>
            {mode === "daily" ? (
              <div className="space-y-1.5"><Label htmlFor="adm-att-day">Day</Label><DatePicker id="adm-att-day" value={day} max={today} onChange={(v) => setDay(v || today)} /></div>
            ) : (
              <div className="space-y-1.5"><Label htmlFor="adm-att-month">Month</Label><input id="adm-att-month" type="month" max={today.slice(0, 7)} value={month} onChange={(e) => setMonth(e.target.value || today.slice(0, 7))} className="h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs" /></div>
            )}
          </div>
          <DataTable columns={columns} rows={data?.logs || []} loading={view.first} error={view.error} onRetry={view.load} pageSize={25}
            searchPlaceholder="Search employee or status…" empty={{ title: "No attendance records for this range", icon: CalendarCheckIcon }} caption="Branch attendance" minWidth={980} />
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FlagIcon className="size-4" aria-hidden="true" />Flags sent to HR</CardTitle>
          <CardDescription>Every record you flagged, with HR&apos;s resolution. Kept for good.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={flagColumns} rows={data?.flags || []} loading={view.first} error={view.error} onRetry={view.load} pageSize={10} searchPlaceholder="Search employee…" empty={{ title: "No flags sent", icon: FlagIcon }} caption="Attendance flags" minWidth={900} />
        </CardContent>
      </Card>

      <FileDialog open={Boolean(target)} onOpenChange={(o) => { if (!o) setTarget(null); }}
        title={`Flag issue — ${target?.employee_name || ""}`}
        description={target ? `${dateLabel(target.log_date)} · ${target.status}${target.time_in ? ` · in ${formatTime(target.time_in)}` : ""}${target.time_out ? ` · out ${formatTime(target.time_out)}` : ""}. HR is notified; the record itself is not changed.` : ""}
        submitLabel="Flag for HR"
        onSubmit={async (values) => {
          await fileRequest("attendance_flag", { ref_id: target.id, note: values.note });
          notify("Flagged for HR", "HR has been notified.", "success");
          await view.load();
        }} />
    </>
  );
}
