"use client";

import { AttendanceCorrectionForm } from "@/components/portal/attendance-correction-form";
import { fixForFlag } from "@/lib/attendance/correction-requests";
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
import { defaultRange, useUrlRange } from "@/components/portal/date-range-filter";
import { useUrlParam } from "@/components/portal/use-url-param";
import { AttendanceView } from "@/components/portal/attendance/attendance-view";

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

  // Phones: the Status third is a little wider and the side padding smaller, so a long status fits beside the two times.
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] divide-x rounded-lg border bg-muted/40 sm:grid-cols-3">
      <div className="px-2 py-3 sm:p-3">
        <p className="text-xs font-medium text-muted-foreground">Time in</p>
        <p className={cn("mt-1 tabular-nums text-sm font-semibold", timeIn ? "text-success" : "text-muted-foreground")}>{timeIn || "— : —"}</p>
      </div>
      <div className="px-2 py-3 sm:p-3">
        <p className="text-xs font-medium text-muted-foreground">Time out</p>
        <p className={cn("mt-1 tabular-nums text-sm font-semibold", timeOut ? "text-gold-text" : "text-muted-foreground")}>{timeOut || "— : —"}</p>
      </div>
      <div className="px-2 py-3 sm:p-3">
        <p className="text-xs font-medium text-muted-foreground">Status</p>
        {/* A long status ("Pending Correction") wraps inside its third of the box on phones (it overflowed by 7 px at 390 px). */}
        <div className="mt-1"><AttendanceBadge status={status} className="h-auto max-w-full whitespace-normal text-left leading-tight [&>span:first-child]:shrink-0" /></div>
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

/* ── Part E step 2: the days the system found to fix (/api/me/attendance-flags) ── */

/** The person's own Leave & Overtime page in this portal. */
function myLeavePage() {
  const path = typeof window === "undefined" ? "" : window.location.pathname;
  return path.startsWith("/hr") ? "hr-my-leave" : path.startsWith("/accountant") ? "ac-my-leave" : "emp-leave";
}

function FixList({ refreshKey, onRequest }) {
  const [flags, setFlags] = React.useState([]);
  React.useEffect(() => {
    let alive = true;
    fetchJson("/api/me/attendance-flags").then((d) => { if (alive) setFlags(d.flags || []); }).catch(() => {});
    return () => { alive = false; };
  }, [refreshKey]);
  if (!flags.length) return null;
  const leave = (tab) => `?page=${myLeavePage()}${tab ? `&lo_tab=${tab}` : ""}`;
  return (
    <Card className="border-warning/40 shadow-xs" data-testid="attendance-fix-list">
      <CardHeader>
        <CardTitle>The system found these to fix</CardTitle>
        <CardDescription>File what fits; each item goes away by itself once it is fixed.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {flags.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3" data-testid="attendance-fix">
              <span className="text-sm">{f.summary}</span>
              <span className="flex flex-wrap gap-2">
                {f.code === "overtime_unfiled"
                  ? <Button size="sm" variant="outline" asChild><a href={leave("overtime")}>File overtime</a></Button>
                  : <Button size="sm" variant="outline" onClick={() => onRequest({ id: f.log_id, log_date: f.log_date, status: f.status, time_in: f.time_in, time_out: f.time_out, fix: fixForFlag(f.code, f) })}>Request correction</Button>}
                {f.code === "absent_no_request" || f.code === "short_day"
                  ? <Button size="sm" variant="outline" asChild><a href={leave(f.code === "short_day" ? "half" : "")}>File leave</a></Button> : null}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ── This pay period + Request Correction (loadMyAttendancePeriod / openMyCorrectionRequest, app.js) ── */

function CorrectionDialog({ row, onOpenChange, onDone }) {
  // Attendance correction request (2026-11-23): filled in with the day and its taps (and the flag's fix, if any).
  return (
    <Dialog open={Boolean(row)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Attendance correction request</DialogTitle>
          <DialogDescription>Ask HR to fix a time in or time out. The branch Admin checks it; HR decides.</DialogDescription>
        </DialogHeader>
        {row ? <AttendanceCorrectionForm key={`${row.id}-${row.fix || ""}`} day={row} initialFix={row.fix || null}
          onCancel={() => onOpenChange(false)} onDone={() => { onOpenChange(false); onDone(); }} /> : null}
      </DialogContent>
    </Dialog>
  );
}

// Records by date range (alpha test A1): From / To with quick choices, paged
// on the server, this cutoff by default.
function PayPeriodCard({ refreshKey }) {
  const [state, setState] = React.useState({ logs: [], total: 0, counts: {}, loading: true, error: null });
  // The shared attendance view (redesign 2026-11-09): own records only, no
  // search or branch; date range and status in the address.
  const fallback = React.useMemo(() => defaultRange(), []);
  const [range, setRange] = useUrlRange("emp_att", fallback);
  const [status, setStatus] = useUrlParam("emp_att_status", "all");
  const [paging, setPaging] = React.useState({ page: 1, pageSize: 10 });
  const [requesting, setRequesting] = React.useState(null);

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to, page: String(paging.page), page_size: String(paging.pageSize) });
      if (status !== "all") params.set("status", status);
      const data = await fetchJson(`/api/me/attendance/logs?${params}`);
      setState({ logs: data.logs || [], total: Number(data.total) || 0, counts: data.counts || {}, loading: false, error: null });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [range, paging, status]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const columns = React.useMemo(() => [
    { key: "log_date", header: "Date", mobilePrimary: true, className: "font-medium", cell: (r) => formatDateKey(r.log_date), searchValue: (r) => formatDateKey(r.log_date) },
    { key: "time_in", header: "Time in", align: "right", mobile: false, className: "tabular-nums whitespace-nowrap", cell: (r) => formatTime(r.time_in) },
    { key: "time_out", header: "Time out", align: "right", mobile: false, className: "tabular-nums whitespace-nowrap", cell: (r) => formatTime(r.time_out) },
    { key: "hours", header: "Hours", align: "right", mobile: false, className: "tabular-nums whitespace-nowrap", cell: (r) => (Number(r.total_hours) ? Number(r.total_hours).toFixed(2) : "—") },
    { key: "time", header: "Time", mobileOnly: true, cell: (r) => <span className="tabular-nums">{formatTime(r.time_in)} – {formatTime(r.time_out)} · {Number(r.total_hours) ? `${Number(r.total_hours).toFixed(2)} h` : "—"}</span> },
    {
      key: "status",
      header: "Status",
      mobileBadge: true,
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

  const toPage1 = (fn) => (v) => { fn(v); setPaging((c) => ({ ...c, page: 1 })); };
  return (
    <>
      <FixList refreshKey={`${refreshKey}-${state.logs.length}-${state.loading}`} onRequest={setRequesting} />
      <AttendanceView
        title="Attendance records by date"
        help="Forgot to tap out, or think a day is wrong? Use Request correction on an Incomplete, Undertime or Half Day record."
        actions={{ onRefresh: load, refreshing: state.loading }}
        summary={{ counts: state.counts, active: status, loading: state.loading && !state.logs.length, onSelect: toPage1(setStatus) }}
        toolbar={{
          search: null,
          range: { value: range, onChange: toPage1(setRange), maxDays: 366, idPrefix: "emp-att" },
          status: { value: status, onChange: toPage1(setStatus) },
          onReset: () => { setStatus("all"); setRange(fallback); setPaging((c) => ({ ...c, page: 1 })); },
          count: state.loading ? null : state.total,
        }}
        footer="Statuses are computed automatically from your schedule."
        testId="employee-attendance"
      >
        <DataTable
          columns={columns}
          rows={state.logs}
          loading={state.loading && !state.logs.length}
          error={state.error}
          onRetry={load}
          searchable={false}
          striped
          stickyHeader
          pageSize={paging.pageSize}
          pageSizes={[10, 25, 50]}
          server={{ total: state.total, page: paging.page, pageSize: paging.pageSize, query: "", onChange: (next) => setPaging((c) => ({ page: next.page ?? c.page, pageSize: next.pageSize ?? c.pageSize })) }}
          empty={{ title: "No attendance for this range", description: "Try another range, or Reset to this cutoff.", icon: CalendarXIcon }}
          caption="Attendance records by date"
          minWidth={620}
        />
      </AttendanceView>
      <CorrectionDialog row={requesting} onOpenChange={(open) => { if (!open) setRequesting(null); }} onDone={load} />
    </>
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
