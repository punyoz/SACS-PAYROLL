"use client";

import * as React from "react";
import { ArrowLeftIcon, CalendarCheckIcon, CalendarXIcon, ClockAlertIcon, HourglassIcon, PlaneIcon, SplitIcon, TimerIcon, TriangleAlertIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DatePicker } from "@/components/portal/date-picker";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { InfoList } from "@/components/portal/info-list";
import { StatCard } from "@/components/portal/stat-card";
import { AttendanceBadge } from "@/components/portal/status-badge";
import { useAttendanceActions } from "@/components/portal/attendance/dialogs";
import { RecordActions } from "@/components/portal/attendance/grouped-table";
import { fetchJson } from "@/lib/portal/api";
import {
  employeeRange,
  formatMinutes,
  formatMonthHeading,
  formatTapTime,
  formatWorked,
  hoursMinutes,
  isLogId,
  todayKey,
  workedMinutes,
} from "@/lib/portal/attendance";
import { ATTENDANCE_STATUS_LIST, formatDateKey, formatTime, leaveSummary, normalizeAttendanceStatus } from "@/lib/portal/format";

/*
 * One employee's attendance record (mountAttendanceEmployeePage /
 * renderAttendanceEmployeePage, public/legacy/js/app.js): GET
 * /api/attendance/employee/:id?from=&to=, summary cards for the whole range,
 * records by month with remarks, tap history and correction history.
 */

const ATTENDED = ["On Time", "Early Bird", "Late", "Undertime", "Half Day", "Corrected"];

function Remarks({ row, employeeName }) {
  const { open } = useAttendanceActions();
  const status = normalizeAttendanceStatus(row.status);
  const pending = (row.corrections || []).find((c) => c.status === "pending");
  const named = { ...row, employee_name: row.employee_name || employeeName };
  const parts = [];
  if (row.not_yet_tapped) parts.push(<p key="nt">No tap yet today</p>);
  if (status === "On Leave") parts.push(<p key="lv">{leaveSummary(row.leave)}</p>);
  if (pending) parts.push(<p key="pd">Correction requested: time out {formatTime(pending.corrected_time_out)} · “{pending.reason || ""}”</p>);
  if (status === "Corrected" && row.last_correction) {
    const c = row.last_correction;
    parts.push(<p key="cr">Corrected by {c.approved_by_name || "HR / Admin"}{c.reason ? ` · ${c.reason}` : ""}</p>);
  }
  if (row.tap_after_correction_at && status === "Corrected") {
    parts.push(<p key="fl" className="font-medium text-warning" title={`Latest tap ${formatTapTime(row.tap_after_correction_at)}`}>New tap after correction</p>);
  }
  const links = [];
  if ((row.corrections || []).length && isLogId(row.id)) {
    links.push(<Button key="h" variant="link" size="sm" className="h-auto p-0" onClick={() => open("history", named)}>Correction history ({row.corrections.length})</Button>);
  }
  if (status !== "On Leave" || (row.taps || []).length) {
    links.push(<Button key="t" variant="link" size="sm" className="h-auto p-0" onClick={() => open("taps", named)}>View taps ({(row.taps || []).length})</Button>);
  }
  if (links.length) parts.push(<div key="links" className="flex flex-wrap gap-x-3">{links}</div>);
  return parts.length ? <div className="space-y-1 text-xs text-muted-foreground">{parts}</div> : <span className="text-muted-foreground">—</span>;
}

export function EmployeeAttendanceRecord({ employeeId, onBack, backLabel = "Back to Attendance Monitoring" }) {
  const { version } = useAttendanceActions();
  const [range, setRange] = React.useState("this_month");
  const [custom, setCustom] = React.useState(() => employeeRange({ range: "this_month" }));
  // The range the records were loaded for: a preset at once, Custom on Apply.
  const [effective, setEffective] = React.useState(() => employeeRange({ range: "this_month" }));
  const [customError, setCustomError] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [state, setState] = React.useState({ loading: true, error: null, errorStatus: null, data: null });
  const seq = React.useRef(0);

  const { from, to } = effective;

  const load = React.useCallback(async () => {
    if (!employeeId) return;
    const mine = ++seq.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/attendance/employee/${encodeURIComponent(employeeId)}?${new URLSearchParams({ from, to })}`);
      if (mine !== seq.current) return;
      setState({ loading: false, error: null, errorStatus: null, data });
    } catch (error) {
      if (mine !== seq.current) return;
      setState({ loading: false, error: error.message, errorStatus: error.status, data: null });
    }
  }, [employeeId, from, to]);

  React.useEffect(() => { load(); }, [load, version]);

  function apply() {
    if (!custom.from) { setCustomError("From is required."); return; }
    if (!custom.to) { setCustomError("To is required."); return; }
    if (custom.to < custom.from) { setCustomError("To must be on or after From."); return; }
    setCustomError("");
    setEffective({ ...custom });
  }

  const data = state.data;
  const employee = data?.employee || {};
  const logs = data?.logs || [];
  const real = logs.filter((row) => !row.placeholder && !row.not_yet_tapped);
  const lateRows = real.filter((row) => Number(row.late_minutes) > 0);
  const underRows = real.filter((row) => Number(row.undertime_minutes) > 0);
  const leaveRows = real.filter((row) => row.status === "On Leave");
  const unpaidLeave = leaveRows.filter((row) => row.leave?.pay_status === "without_pay").length;
  const sum = (rows, field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
  const totalMinutes = real.reduce((total, row) => total + (workedMinutes(row) || 0), 0);

  const rows = logs
    .filter((row) => status === "all" || row.status === status)
    .sort((a, b) => String(b.log_date || "").localeCompare(String(a.log_date || "")));
  const monthCounts = new Map();
  rows.forEach((row) => {
    const month = String(row.log_date || "").slice(0, 7);
    monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
  });

  const nameParts = String(employee.full_name || "").trim().split(/\s+/).filter(Boolean);
  const initials = (nameParts.length > 1 ? nameParts[0][0] + nameParts[nameParts.length - 1][0] : String(employee.full_name || "NA").slice(0, 2)).toUpperCase();
  const schedule = employee.schedule
    ? `${employee.schedule.work_start || "—"} – ${employee.schedule.work_end || "—"} · ${Number(employee.schedule.grace) || 0} min grace${employee.schedule.source === "branch" ? "" : " (default schedule)"}`
    : "—";
  const blocked = state.error && (state.errorStatus === 403 || state.errorStatus === 404);
  const loadingFirst = state.loading && !data;

  let lastMonth = null;
  const body = [];
  rows.forEach((row) => {
    const month = String(row.log_date || "").slice(0, 7);
    if (month !== lastMonth) {
      const n = monthCounts.get(month) || 0;
      body.push(
        <TableRow key={`m-${month}`} className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={9} className="py-2"><span className="font-semibold">{formatMonthHeading(month)}</span><span className="ml-3 text-xs text-muted-foreground">{n} record{n === 1 ? "" : "s"}</span></TableCell>
        </TableRow>,
      );
      lastMonth = month;
    }
    body.push(
      <TableRow key={row.id || row.log_date}>
        <TableCell className="whitespace-nowrap font-medium">{formatDateKey(row.log_date)}</TableCell>
        <TableCell className="tabular-nums">{formatTime(row.time_in)}</TableCell>
        <TableCell className="tabular-nums">{formatTime(row.time_out)}</TableCell>
        <TableCell className="tabular-nums">{formatWorked(row)}</TableCell>
        <TableCell className="tabular-nums">{formatMinutes(row.late_minutes)}</TableCell>
        <TableCell className="tabular-nums">{formatMinutes(row.undertime_minutes)}</TableCell>
        <TableCell><AttendanceBadge status={row.status} /></TableCell>
        <TableCell className="max-w-72 whitespace-normal"><Remarks row={row} employeeName={employee.full_name} /></TableCell>
        <TableCell className="text-right"><RecordActions row={{ ...row, employee_name: row.employee_name || employee.full_name, employee_code: employee.employee_code }} viewRecords={false} /></TableCell>
      </TableRow>,
    );
  });

  return (
    <>
      <div>
        <Button variant="outline" size="sm" onClick={onBack}><ArrowLeftIcon aria-hidden="true" />{backLabel}</Button>
      </div>

      <Card className="shadow-xs">
        <CardContent className="space-y-5">
          {loadingFirst ? <Skeleton className="h-14 w-72" /> : blocked ? (
            <ErrorState message={state.error} />
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Avatar className="size-12"><AvatarFallback className="bg-primary font-semibold text-primary-foreground">{initials}</AvatarFallback></Avatar>
                <div>
                  <h2 className="text-lg font-semibold">{employee.full_name || "Employee"}</h2>
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">Individual attendance record {employee.archived ? <Badge variant="secondary">Archived</Badge> : null}</p>
                </div>
              </div>
              <InfoList className="lg:grid-cols-3" items={[
                { label: "Employee ID", value: employee.employee_code },
                { label: "Branch", value: employee.branch_name },
                { label: "Position", value: employee.position },
                { label: "Employment status", value: [employee.employee_status, employee.employee_type].filter(Boolean).join(" · ") },
                { label: "Assigned schedule", value: schedule },
                { label: "RFID card", value: employee.rfid_masked || "Not assigned" },
              ]} />
            </>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-xs">
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="emp-rec-range">Date range</Label>
            <Select
              value={range}
              onValueChange={(value) => {
                setRange(value);
                if (value === "custom") setCustom(effective);
                else setEffective(employeeRange({ range: value }));
              }}
            >
              <SelectTrigger id="emp-rec-range" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="this_week">This week</SelectItem>
                <SelectItem value="this_month">This month</SelectItem>
                <SelectItem value="last_month">Last month</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {range === "custom" ? (
            <>
              <div className="w-44 space-y-2">
                <Label htmlFor="emp-rec-from">From</Label>
                <DatePicker id="emp-rec-from" value={custom.from} onChange={(v) => setCustom((c) => ({ ...c, from: v > todayKey() ? todayKey() : v }))} />
              </div>
              <div className="w-44 space-y-2">
                <Label htmlFor="emp-rec-to">To</Label>
                <DatePicker id="emp-rec-to" value={custom.to} onChange={(v) => setCustom((c) => ({ ...c, to: v }))} aria-invalid={Boolean(customError) || undefined} />
              </div>
              <Button variant="outline" onClick={apply}>Apply</Button>
            </>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="emp-rec-status">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="emp-rec-status" className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {ATTENDANCE_STATUS_LIST.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {customError ? <p role="alert" className="basis-full text-sm text-destructive">{customError}</p> : null}
        </CardContent>
      </Card>

      {!blocked ? (
        <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Days present" value={real.filter((r) => ATTENDED.includes(r.status)).length} icon={CalendarCheckIcon} tone="success" loading={loadingFirst} />
          <StatCard label="Days absent" value={real.filter((r) => r.status === "Absent").length} icon={CalendarXIcon} tone="danger" loading={loadingFirst} />
          <StatCard label="Times late" value={lateRows.length} hint={`${sum(lateRows, "late_minutes")} min total`} icon={ClockAlertIcon} tone="gold" loading={loadingFirst} />
          <StatCard label="Undertime" value={`${sum(underRows, "undertime_minutes")} min`} hint={`${underRows.length} day${underRows.length === 1 ? "" : "s"}`} icon={HourglassIcon} tone="warning" loading={loadingFirst} />
          <StatCard label="Half days" value={real.filter((r) => r.is_half_day === true || r.status === "Half Day").length} icon={SplitIcon} tone="warning" loading={loadingFirst} />
          <StatCard label="Incomplete" value={real.filter((r) => r.status === "Incomplete" || r.status === "Pending Correction").length} icon={TriangleAlertIcon} tone="primary" loading={loadingFirst} />
          <StatCard label="Leave days" value={leaveRows.length} hint={leaveRows.length ? `${leaveRows.length - unpaidLeave} with pay · ${unpaidLeave} without pay` : null} icon={PlaneIcon} tone="info" loading={loadingFirst} />
          <StatCard label="Total hours worked" value={hoursMinutes(totalMinutes)} icon={TimerIcon} tone="success" loading={loadingFirst} />
        </section>
      ) : null}

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Attendance records</CardTitle>
          {data?.range ? <CardAction><span className="text-xs text-muted-foreground">{formatDateKey(data.range.from)} – {formatDateKey(data.range.to)}</span></CardAction> : null}
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <Table style={{ minWidth: 980 }}>
              <TableHeader className="bg-muted/60">
                <TableRow className="hover:bg-transparent">
                  {["Date", "Time in", "Time out", "Hours", "Late", "Undertime", "Status", "Remarks"].map((h) => <TableHead key={h} className="text-xs font-semibold text-muted-foreground">{h}</TableHead>)}
                  <TableHead><span className="sr-only">Action</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.loading ? Array.from({ length: 5 }, (_, i) => (
                  <TableRow key={i}>{Array.from({ length: 9 }, (__, c) => <TableCell key={c}><Skeleton className="h-4 w-3/4" /></TableCell>)}</TableRow>
                )) : state.error ? (
                  <TableRow className="hover:bg-transparent"><TableCell colSpan={9} className="p-0 whitespace-normal"><ErrorState message={state.error} onRetry={blocked ? undefined : load} /></TableCell></TableRow>
                ) : !rows.length ? (
                  <TableRow className="hover:bg-transparent"><TableCell colSpan={9} className="p-0 whitespace-normal"><EmptyState title={status === "all" ? "No attendance records in this range." : `No ${status} records in this range.`} /></TableCell></TableRow>
                ) : body}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
