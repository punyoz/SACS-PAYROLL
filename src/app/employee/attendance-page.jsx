"use client";

import * as React from "react";
import { toast } from "sonner";
import { CalendarXIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable } from "@/components/portal/data-table";
import { AttendanceBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import {
  attendanceBucket,
  formatDateKey,
  formatPhTime,
  formatTime,
  leaveSummary,
  normalizeAttendanceStatus,
  timeInputValue,
  weekdayOf,
} from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/* ── Month calendar (renderAttendanceCalendar, employee.js) ── */

const BUCKET_CLASS = {
  present: "border-success/40 bg-success/12 text-success",
  late: "border-warning/40 bg-warning/12 text-warning",
  absent: "border-destructive/40 bg-destructive/10 text-destructive",
  leave: "border-info/40 bg-info/10 text-info",
  holiday: "border-brand-gold/50 bg-brand-gold/15 text-gold-text",
};

const LEGEND = [
  ["present", "Present"],
  ["late", "Late / Undertime / Half Day"],
  ["absent", "Absent"],
  ["leave", "On Leave"],
  ["holiday", "Holiday"],
];

const LEGEND_SWATCH = {
  present: "bg-success",
  late: "bg-warning",
  absent: "bg-destructive",
  leave: "bg-info",
  holiday: "bg-brand-gold",
};

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function MonthCalendar({ data }) {
  const records = data?.records || [];
  const todayKey = data?.today_key;
  const statusMap = {};
  const leaveMap = {};
  records.forEach((rec) => {
    statusMap[rec.date] = rec.status;
    if (rec.leave) leaveMap[rec.date] = rec.leave;
  });
  const holidayMap = {};
  (data?.holidays || []).forEach((holiday) => { holidayMap[holiday.date] = holiday; });

  const [year, month, todayDay] = String(todayKey || "").split("-").map(Number);
  if (!year) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDay = new Date(year, month - 1, 1).getDay();

  return (
    <div>
      <div className="grid grid-cols-7 gap-1 text-center" role="grid" aria-label={`Attendance for ${data.month_label}`}>
        {WEEKDAYS.map((day) => (
          <div key={day} role="columnheader" className="pb-1 text-[11px] font-semibold text-muted-foreground">{day}</div>
        ))}
        {Array.from({ length: firstDay }, (_, i) => <div key={`pad-${i}`} aria-hidden="true" />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const status = statusMap[key];
          const holiday = holidayMap[key];
          let bucket = status ? attendanceBucket(status) : "";
          // A whole-day holiday with no work recorded reads as a holiday.
          if (holiday && !bucket && (holiday.day_part || "whole") === "whole") bucket = "holiday";
          const isToday = key === todayKey;
          const isFuture = day > todayDay;
          const label = bucket === "leave"
            ? `On Leave · ${leaveSummary(leaveMap[key])}`
            : holiday
              ? `${holiday.name}${holiday.note ? ` · ${holiday.note}` : ""}`
              : status ? normalizeAttendanceStatus(status) : isFuture ? "Upcoming" : "No record";

          const cell = (
            <div
              role="gridcell"
              aria-label={`${formatDateKey(key)}: ${label}`}
              aria-current={isToday ? "date" : undefined}
              tabIndex={bucket === "leave" ? 0 : undefined}
              onClick={bucket === "leave" ? () => toast.info(`On Leave · ${key}`, { description: leaveSummary(leaveMap[key]) }) : undefined}
              onKeyDown={bucket === "leave" ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toast.info(`On Leave · ${key}`, { description: leaveSummary(leaveMap[key]) }); } } : undefined}
              className={cn(
                "flex aspect-square items-center justify-center rounded-md border text-sm font-medium tabular-nums",
                bucket ? BUCKET_CLASS[bucket] : "border-transparent",
                !bucket && (isFuture ? "text-muted-foreground/50" : "text-muted-foreground"),
                isToday && "ring-2 ring-brand-gold ring-offset-1 ring-offset-card",
                bucket === "leave" && "cursor-pointer focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              )}
            >
              {day}
            </div>
          );
          return bucket || holiday ? (
            <Tooltip key={key}>
              <TooltipTrigger asChild>{cell}</TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ) : <React.Fragment key={key}>{cell}</React.Fragment>;
        })}
      </div>
      <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label="Legend">
        {LEGEND.map(([bucket, text]) => (
          <li key={bucket} className="flex items-center gap-1.5">
            <span className={cn("size-3 rounded-sm", LEGEND_SWATCH[bucket])} aria-hidden="true" />
            {text}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm ring-2 ring-brand-gold" aria-hidden="true" />Today
        </li>
      </ul>
    </div>
  );
}

function TodayLog({ today }) {
  const timeIn = today?.time_in ? formatPhTime(today.time_in) : null;
  const timeOut = today?.time_out ? formatPhTime(today.time_out) : null;
  const status = !today || !today.time_in ? (today?.status === "On Leave" ? "On Leave" : null) : (today.status || "Absent");

  return (
    <div className="grid grid-cols-3 divide-x rounded-lg border bg-muted/40">
      <div className="p-3">
        <p className="text-xs font-medium text-muted-foreground">Time in</p>
        <p className={cn("mt-1 tabular-nums text-sm font-semibold", timeIn ? "text-success" : "text-muted-foreground")}>{timeIn || "— : —"}</p>
      </div>
      <div className="p-3">
        <p className="text-xs font-medium text-muted-foreground">Time out</p>
        <p className={cn("mt-1 tabular-nums text-sm font-semibold", timeOut ? "text-gold-text" : "text-muted-foreground")}>{timeOut || "— : —"}</p>
      </div>
      <div className="p-3">
        <p className="text-xs font-medium text-muted-foreground">Status</p>
        <div className="mt-1"><AttendanceBadge status={status} /></div>
      </div>
    </div>
  );
}

const RECORD_COLUMNS = [
  { key: "date", header: "Date", sortable: true, className: "font-medium", cell: (r) => formatDateKey(r.date), searchValue: (r) => `${r.date} ${formatDateKey(r.date)}` },
  { key: "day", header: "Day", cell: (r) => <span className="text-muted-foreground">{weekdayOf(r.date)}</span> },
  { key: "time_in", header: "Time in", sortable: true, className: "tabular-nums whitespace-nowrap", cell: (r) => formatPhTime(r.time_in) || "—" },
  { key: "time_out", header: "Time out", sortable: true, className: "tabular-nums whitespace-nowrap", cell: (r) => formatPhTime(r.time_out) || "—" },
  {
    key: "status",
    header: "Status",
    sortValue: (r) => normalizeAttendanceStatus(r.status),
    searchValue: (r) => normalizeAttendanceStatus(r.status),
    className: "whitespace-normal",
    cell: (r) => (
      <div>
        <AttendanceBadge status={r.status} />
        {r.status === "On Leave" ? <p className="mt-1 text-xs text-muted-foreground">{leaveSummary(r.leave)}</p> : null}
      </div>
    ),
  },
];

/* ── This pay period + Request Correction (loadMyAttendancePeriod / openMyCorrectionRequest, app.js) ── */

function CorrectionDialog({ row, onOpenChange, onDone }) {
  const { notify } = usePortalSession();
  const [time, setTime] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [serverError, setServerError] = React.useState("");

  React.useEffect(() => {
    if (!row) return;
    setTime(timeInputValue(row.time_out));
    setReason("");
    setErrors({});
    setServerError("");
  }, [row]);

  async function submit(event) {
    event.preventDefault();
    const next = {};
    if (!time) next.time = "Corrected time out is required.";
    const r = reason.trim();
    if (!r) next.reason = "Reason is required.";
    else if (r.length < 5) next.reason = "Give a little more detail (at least 5 characters).";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setServerError("");
    try {
      await fetchJson("/api/attendance/corrections", jsonBody("POST", { log_id: row.id, corrected_time: time, reason: r }));
      notify("Correction Requested", "Your request was sent for review. The day shows Pending Correction until it is decided.", "success");
      onOpenChange(false);
      onDone();
    } catch (error) {
      setServerError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(row)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Request correction</DialogTitle>
          <DialogDescription>HR or your Administrator will review it.</DialogDescription>
        </DialogHeader>
        {row ? (
          <div className="space-y-1 rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><strong>{formatDateKey(row.log_date)}</strong> <AttendanceBadge status={row.status} /></div>
            <p className="text-muted-foreground">Recorded: time in {formatTime(row.time_in)}, time out {formatTime(row.time_out)}</p>
          </div>
        ) : null}
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="att-request-time">Corrected time out</Label>
            <Input id="att-request-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-invalid={Boolean(errors.time) || undefined} aria-describedby={errors.time ? "att-request-time-error" : undefined} />
            {errors.time ? <p id="att-request-time-error" className="text-sm text-destructive">{errors.time}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="att-request-reason">Reason</Label>
            <Textarea id="att-request-reason" rows={3} maxLength={500} placeholder="e.g. The reader was offline when I left at 5:00 PM" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={Boolean(errors.reason) || undefined} aria-describedby={errors.reason ? "att-request-reason-error" : undefined} />
            {errors.reason ? <p id="att-request-reason-error" className="text-sm text-destructive">{errors.reason}</p> : null}
          </div>
          {serverError ? <p role="alert" className="text-sm text-destructive">{serverError}</p> : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Submitting…</> : "Submit request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PayPeriodCard({ refreshKey }) {
  const [state, setState] = React.useState({ logs: [], period: "", loading: true, error: null });
  const [requesting, setRequesting] = React.useState(null);

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: !current.logs.length, error: null }));
    try {
      const data = await fetchJson("/api/attendance/logs");
      setState({ logs: data.logs || [], period: data.range?.label || "", loading: false, error: null });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const columns = React.useMemo(() => [
    { key: "log_date", header: "Date", sortable: true, className: "font-medium", cell: (r) => formatDateKey(r.log_date), searchValue: (r) => formatDateKey(r.log_date) },
    { key: "time_in", header: "Time in", className: "tabular-nums whitespace-nowrap", cell: (r) => formatTime(r.time_in) },
    { key: "time_out", header: "Time out", className: "tabular-nums whitespace-nowrap", cell: (r) => formatTime(r.time_out) },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => normalizeAttendanceStatus(r.status),
      searchValue: (r) => normalizeAttendanceStatus(r.status),
      className: "whitespace-normal",
      cell: (r) => (
        <div>
          <AttendanceBadge status={r.status} />
          {r.status === "On Leave" ? <p className="mt-1 text-xs text-muted-foreground">{leaveSummary(r.leave)}</p> : null}
        </div>
      ),
    },
    {
      key: "action",
      header: <span className="sr-only">Action</span>,
      align: "right",
      cell: (r) => (r.correction
        ? <span className="text-xs text-muted-foreground">Awaiting review</span>
        : r.can_request_correction
          ? <Button variant="outline" size="sm" onClick={() => setRequesting(r)}>Request correction</Button>
          : null),
    },
  ], []);

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle>This pay period</CardTitle>
        <CardDescription>
          Forgot to tap out, or think a day is wrong? Use <strong className="text-foreground">Request correction</strong> on an Incomplete,
          Undertime or Half Day record.
        </CardDescription>
        {state.period ? <CardAction><span className="text-xs text-muted-foreground">{state.period}</span></CardAction> : null}
      </CardHeader>
      <CardContent>
        <DataTable
          columns={columns}
          rows={state.logs}
          loading={state.loading}
          error={state.error}
          onRetry={load}
          searchable={false}
          paginate={state.logs.length > 10}
          empty={{ title: "No attendance recorded yet this pay period", icon: CalendarXIcon }}
          caption="This pay period's attendance"
          minWidth={560}
        />
      </CardContent>
      <CorrectionDialog row={requesting} onOpenChange={(open) => { if (!open) setRequesting(null); }} onDone={load} />
    </Card>
  );
}

export function AttendancePage({ stats, refreshKey }) {
  const data = stats.data;
  const loading = stats.loading && !data;

  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle>{data?.month_label ? `My attendance — ${data.month_label}` : "My attendance"}</CardTitle>
            <CardDescription>Read-only · updated by RFID tap</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? <Skeleton className="aspect-[7/6] w-full" /> : <MonthCalendar data={data} />}
            <div>
              <p className="mb-2 text-sm font-semibold">Today&apos;s log</p>
              {loading ? <Skeleton className="h-16 w-full" /> : <TodayLog today={data?.today || null} />}
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Attendance records</CardTitle>
            <CardAction><span className="text-xs text-muted-foreground">{data?.month_label || "This month"}</span></CardAction>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={RECORD_COLUMNS}
              rows={data?.records || []}
              loading={loading}
              error={!data ? stats.error : null}
              onRetry={() => stats.reload()}
              rowKey={(r) => r.date}
              searchPlaceholder="Search records…"
              empty={{ title: "No records found for this month", icon: CalendarXIcon }}
              caption="Attendance records this month"
              minWidth={520}
            />
          </CardContent>
        </Card>
      </div>

      <PayPeriodCard refreshKey={refreshKey} />
    </>
  );
}
