"use client";

import * as React from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AttendanceBadge, StatusBadge, attendanceTone } from "@/components/portal/status-badge";
import { useAttendanceActions } from "@/components/portal/attendance/dialogs";
import { EmployeeCell, GroupedAttendanceTable, RecordActions, StatusCell, recordColumns } from "@/components/portal/attendance/grouped-table";
import { apiFetch, fetchJson } from "@/lib/portal/api";
import {
  branchContext,
  branchCounts,
  countBy,
  formatDateTime,
  formatMinutes,
  oneRowPerDay,
  payPeriodLabels,
  rowBranchId,
  sortByBranchDay,
  sortByDay,
} from "@/lib/portal/attendance";
import { ATTENDANCE_STATUS_LIST, formatDateKey, formatTime } from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/*
 * The attendance status board (mountAttendanceBoard / renderAttendanceBoard,
 * public/legacy/js/app.js) for Admin, HR and Super Admin: one pay period's
 * records, the Incomplete queue, employees' correction requests, overtime
 * and blocked taps. GET /api/attendance/logs, /corrections?status=pending
 * and /overtime with the same parameters.
 */

const CHIP_STATUSES = ["On Time", "Early Bird", "Late", "Undertime", "Half Day", "Absent", "Incomplete", "Pending Correction", "Corrected", "On Leave", "Holiday"];

const NOTES = {
  incomplete: "Days with a time in but no time out after the shift ended. They are left out of payroll until resolved — by the employee's correction request, by recording the time out (or Absent / Half Day) here, or with Correct.",
  blocked: "RFID taps that were refused: an unregistered card, an inactive employee, another branch's card, or an employee on approved leave. Nothing was recorded for them. Tapping again soon after a tap is never refused.",
  corrections: "Approving replaces the time out and marks the day Corrected. Rejecting keeps it Incomplete (out of payroll) or sets it to Absent or Half Day. Correct enters different times yourself and closes the request.",
};

const ALL = "__all__";

export function AttendanceStatusBoard({ branchFilter = false, refreshKey = 0, initialTab = "all" }) {
  const { version } = useAttendanceActions();
  const periods = React.useMemo(() => payPeriodLabels(6), []);
  const [period, setPeriod] = React.useState(periods[0]);
  const [tab, setTab] = React.useState(initialTab);
  const [status, setStatus] = React.useState("all");
  const [day, setDay] = React.useState("all");
  const [branch, setBranch] = React.useState("");
  const [collapsed, setCollapsed] = React.useState(() => new Set());
  const [knownBranches, setKnownBranches] = React.useState(() => new Map());
  const [state, setState] = React.useState({ loading: true, error: null, logs: [], corrections: [], overtime: [], blocked: [], canReview: false, overtimeCanReview: false, overtimeMin: 30, scope: "", engineReady: true });

  // Every branch by name, including ones with no rows yet.
  React.useEffect(() => {
    apiFetch("/api/admin/branches")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const list = (data?.branches || []).filter((b) => branchFilter || b.status === "Active");
        setKnownBranches(new Map(list.filter((b) => b?.id).map((b) => [String(b.id), b.name || "Branch"])));
      })
      .catch(() => {});
  }, [branchFilter]);

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const params = new URLSearchParams({ period });
      const [logsData, correctionsData, overtimeData] = await Promise.all([
        fetchJson(`/api/attendance/logs?${params}`),
        fetchJson("/api/attendance/corrections?status=pending").catch(() => ({ corrections: [] })),
        fetchJson(`/api/attendance/overtime?${params}`).catch(() => ({ overtime: [] })),
      ]);
      setState({
        loading: false,
        error: null,
        logs: oneRowPerDay(logsData.logs || []),
        canReview: Boolean(logsData.can_review),
        scope: String(logsData.scope || ""),
        engineReady: logsData.engine_ready !== false,
        blocked: logsData.blocked_taps || [],
        corrections: correctionsData.corrections || [],
        overtime: overtimeData.overtime || [],
        overtimeCanReview: Boolean(overtimeData.can_review),
        overtimeMin: Number(overtimeData.min_minutes) || 30,
      });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message, logs: [], corrections: [], overtime: [], blocked: [] }));
    }
  }, [period]);

  React.useEffect(() => { load(); }, [load, version, refreshKey]);

  const groupByBranch = state.scope !== "self";
  const ctx = React.useMemo(() => branchContext(state.logs, knownBranches), [state.logs, knownBranches]);
  const inBranch = React.useCallback((row) => !branch || rowBranchId(ctx, row) === branch, [branch, ctx]);

  const logs = state.logs.filter(inBranch);
  const corrections = state.corrections.filter(inBranch);
  const overtime = state.overtime.filter(inBranch);
  const blocked = state.blocked.filter(inBranch);
  const incomplete = logs.filter((row) => row.status === "Incomplete" || row.status === "Pending Correction");
  const dayCountsAll = countBy(logs, (row) => String(row.log_date || ""));
  const days = [...dayCountsAll.keys()].filter(Boolean).sort().reverse();
  const effectiveDay = day !== "all" && !dayCountsAll.has(day) ? "all" : day;
  const dayRows = logs.filter((row) => effectiveDay === "all" || row.log_date === effectiveDay);
  const statusCounts = countBy(dayRows, () => "x").get("x")?.statuses || new Map();

  let rows;
  let grouping = null;
  if (tab === "all" || tab === "incomplete") {
    const source = tab === "all" ? dayRows : incomplete;
    const filtered = tab === "all" ? source.filter((row) => status === "all" || row.status === status) : source;
    if (groupByBranch) {
      rows = sortByBranchDay(ctx, filtered);
      grouping = {
        byBranch: true,
        ctx,
        collapsed,
        onToggle: (b) => setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(b)) next.delete(b); else next.add(b);
          return next;
        }),
        branchCounts: branchCounts(ctx, source),
        dayCounts: countBy(rows, (row) => `${rowBranchId(ctx, row)}|${row.log_date}`),
        statusBreakdown: tab === "all",
      };
    } else {
      rows = sortByDay(filtered);
      grouping = { byBranch: false, dayCounts: countBy(rows, (row) => String(row.log_date || "")), statusBreakdown: tab === "all" };
    }
  } else if (tab === "overtime" || tab === "blocked") {
    rows = sortByDay(tab === "overtime" ? overtime : blocked);
    grouping = { byBranch: false, dayCounts: countBy(rows, (row) => String(row.log_date || "")) };
  } else {
    rows = corrections;
  }

  const columns = React.useMemo(() => {
    if (tab === "all") return recordColumns({ canReview: state.canReview });
    if (tab === "incomplete") {
      const cols = [
        { key: "employee", header: "Employee", cell: (r) => <EmployeeCell row={r} link={state.canReview} /> },
        { key: "date", header: "Date", className: "whitespace-nowrap", cell: (r) => formatDateKey(r.log_date) },
        { key: "in", header: "Time in", className: "tabular-nums", cell: (r) => formatTime(r.time_in) },
        { key: "out", header: "Time out", className: "tabular-nums", cell: (r) => formatTime(r.time_out) },
        { key: "status", header: "Status", cell: (r) => <StatusCell row={r} /> },
      ];
      if (state.canReview) cols.push({ key: "action", header: <span className="sr-only">Action</span>, align: "right", cell: (r) => <IncompleteActions row={r} /> });
      return cols;
    }
    if (tab === "corrections") {
      const cols = [
        { key: "employee", header: "Employee", cell: (c) => <span className="font-medium">{c.employee_name || "—"}</span> },
        { key: "date", header: "Date", className: "whitespace-nowrap", cell: (c) => formatDateKey(c.log_date) },
        { key: "recorded", header: "Recorded", cell: (c) => <div className="space-y-1"><p className="tabular-nums">{formatTime(c.original_time_in)} – {formatTime(c.original_time_out)}</p><AttendanceBadge status={c.original_status} /></div> },
        { key: "requested_out", header: "Requested time out", className: "tabular-nums", cell: (c) => formatTime(c.corrected_time_out) },
        { key: "reason", header: "Reason", className: "max-w-64 whitespace-normal text-muted-foreground", cell: (c) => c.reason || "" },
        { key: "requested", header: "Requested", className: "whitespace-nowrap", cell: (c) => formatDateTime(c.requested_at) },
      ];
      if (state.canReview) cols.push({ key: "action", header: <span className="sr-only">Action</span>, align: "right", cell: (c) => <CorrectionActions correction={c} logs={state.logs} /> });
      return cols;
    }
    if (tab === "overtime") {
      const cols = [
        { key: "employee", header: "Employee", cell: (r) => <span className="font-medium">{r.employee_name || "—"}</span> },
        { key: "date", header: "Date", className: "whitespace-nowrap", cell: (r) => formatDateKey(r.log_date) },
        { key: "out", header: "Time out", cell: (r) => <div><p className="tabular-nums">{formatTime(r.time_out)}</p><p className="text-xs text-muted-foreground">Shift ends {r.work_end || ""}</p></div> },
        { key: "past", header: "Past schedule", className: "tabular-nums", cell: (r) => formatMinutes(r.overtime_minutes) },
        { key: "decision", header: "Decision", cell: (r) => <OvertimeDecision row={r} /> },
      ];
      if (state.overtimeCanReview) cols.push({ key: "action", header: <span className="sr-only">Action</span>, align: "right", cell: (r) => <OvertimeAction row={r} /> });
      return cols;
    }
    return [
      { key: "employee", header: "Employee", cell: (r) => <span className="font-medium">{r.employee_name || (r.employee_id ? "—" : `Unregistered card ${r.rfid_code || ""}`.trim())}</span> },
      { key: "date", header: "Date", className: "whitespace-nowrap", cell: (r) => formatDateKey(r.log_date) },
      { key: "attempted", header: "Attempted", className: "tabular-nums whitespace-nowrap", cell: (r) => formatDateTime(r.attempted_at) },
      { key: "source", header: "Source", cell: (r) => (r.source === "manual_entry" ? "Manual entry" : "RFID terminal") },
      { key: "reason", header: "Reason", className: "max-w-72 whitespace-normal", cell: (r) => r.reason || "" },
    ];
  }, [tab, state.canReview, state.overtimeCanReview, state.logs]);

  const note = tab === "overtime"
    ? `Days whose time out is at least ${state.overtimeMin} minutes after the branch's end of shift. Payroll pays overtime only for the minutes approved here (hourly rate plus the overtime premium in Payroll Rates). Decisions lock once that pay period is processed.`
    : tab === "all"
      ? (state.engineReady === false
        ? "Automatic statuses are not active yet: apply the attendance database migration (20260926010000_attendance_status_engine.sql)."
        : `Statuses are computed automatically from each branch's schedule. Today's list includes everyone who has not tapped yet.${state.canReview ? " Use Correct on any day to fix a wrong time in or time out, or to record a day someone worked but did not tap." : ""}`)
      : NOTES[tab];

  const empty = tab === "blocked" ? "No taps were blocked in this period."
    : tab === "corrections" ? "No correction requests waiting."
      : tab === "incomplete" ? "Nothing to resolve."
        : tab === "overtime" ? "No overtime in this period."
          : effectiveDay !== "all" ? "No attendance records for this day." : "No attendance records for this period.";

  const tabCount = (n) => (n ? <span className="ml-1 rounded-full bg-primary/12 px-1.5 text-[11px] font-semibold text-primary tabular-nums">{n}</span> : null);
  const branchOptions = [...ctx.names.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const showBranch = groupByBranch && branchOptions.length > 0;

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>Attendance status</CardTitle>
        <CardDescription>One pay period, computed from each branch&apos;s schedule.</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          <Select value={period} onValueChange={(value) => { setPeriod(value); setDay("all"); }}>
            <SelectTrigger size="sm" className="w-44" aria-label="Pay period"><SelectValue /></SelectTrigger>
            <SelectContent>{periods.map((label) => <SelectItem key={label} value={label}>{label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}>
            <RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={tab} onValueChange={setTab}>
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <TabsList>
              <TabsTrigger value="all">All records</TabsTrigger>
              <TabsTrigger value="incomplete">Incomplete queue{tabCount(incomplete.length)}</TabsTrigger>
              <TabsTrigger value="corrections">Correction requests{tabCount(corrections.length)}</TabsTrigger>
              <TabsTrigger value="overtime">Overtime{tabCount(overtime.filter((row) => !row.approval && !row.locked).length)}</TabsTrigger>
              <TabsTrigger value="blocked">Blocked taps{tabCount(blocked.length)}</TabsTrigger>
            </TabsList>
          </div>
        </Tabs>

        {tab === "all" || showBranch ? (
          <div className="flex flex-wrap gap-2">
            {showBranch ? (
              <Select value={branch || ALL} onValueChange={(value) => setBranch(value === ALL ? "" : value)}>
                <SelectTrigger size="sm" className="w-48" aria-label="Branch"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All branches</SelectItem>
                  {branchOptions.map(([value, name]) => <SelectItem key={value} value={value}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : null}
            {tab === "all" ? (
              <>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger size="sm" className="w-44" aria-label="Status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {ATTENDANCE_STATUS_LIST.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={effectiveDay} onValueChange={setDay}>
                  <SelectTrigger size="sm" className="w-52" aria-label="Day"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All days</SelectItem>
                    {days.map((key) => <SelectItem key={key} value={key}>{formatDateKey(key)} ({dayCountsAll.get(key).total})</SelectItem>)}
                  </SelectContent>
                </Select>
              </>
            ) : null}
          </div>
        ) : null}

        {tab === "all" ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            {CHIP_STATUSES.filter((s) => (s !== "Pending Correction" && s !== "Holiday") || statusCounts.get(s) || status === s).map((s) => {
              const n = statusCounts.get(s) || 0;
              const active = status === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={active}
                  title={active ? "Show all statuses" : `Show only ${s}`}
                  onClick={() => setStatus(active ? "all" : s)}
                  className={cn(
                    "rounded-full ring-offset-2 ring-offset-card transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    active && "ring-2 ring-primary",
                    !n && !active && "opacity-50",
                  )}
                >
                  <StatusBadge tone={attendanceTone(s)} className="cursor-pointer">
                    {s}
                    <span className="ml-0.5 rounded-full bg-current/10 px-1.5 text-[11px] font-semibold tabular-nums">
                      {n}<span className="sr-only"> records</span>
                    </span>
                  </StatusBadge>
                </button>
              );
            })}
          </div>
        ) : null}

        <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>

        <GroupedAttendanceTable
          key={tab}
          columns={columns}
          rows={rows}
          grouping={grouping}
          loading={state.loading}
          error={state.error}
          onRetry={load}
          empty={empty}
          caption="Attendance status"
          minWidth={tab === "all" ? 960 : 760}
          rowKey={(r, i) => r.id || r.log_id || `${r.employee_id}|${r.log_date}|${i}`}
        />
      </CardContent>
    </Card>
  );
}

function IncompleteActions({ row }) {
  const { open } = useAttendanceActions();
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {row.status === "Incomplete"
        ? <Button variant="default" size="sm" onClick={() => open("resolve", row)}>Resolve</Button>
        : <span className="text-xs text-muted-foreground">See correction requests</span>}
      <RecordActions row={row} viewRecords={false} />
    </div>
  );
}

function CorrectionActions({ correction, logs }) {
  const { open } = useAttendanceActions();
  // The record a request is about: the loaded row, or the request's own copy (attCorrectionRecord).
  const record = logs.find((row) => String(row.id) === String(correction.log_id)) || {
    id: correction.log_id,
    employee_id: correction.employee_id,
    employee_name: correction.employee_name,
    log_date: correction.log_date,
    time_in: correction.original_time_in,
    time_out: correction.original_time_out,
    status: "Pending Correction",
    group_branch_id: correction.branch_id,
  };
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      <Button size="sm" onClick={() => open("review", correction)}>Review</Button>
      <RecordActions row={record} viewRecords={false} />
    </div>
  );
}

function OvertimeDecision({ row }) {
  const approval = row.approval;
  return (
    <div className="space-y-1">
      {approval
        ? (approval.status === "approved"
          ? <StatusBadge tone="success">Approved {formatMinutes(approval.approved_minutes)}</StatusBadge>
          : <StatusBadge tone="danger">Rejected</StatusBadge>)
        : <StatusBadge tone="gold">Waiting</StatusBadge>}
      {approval?.decided_by_name ? <p className="text-xs text-muted-foreground">by {approval.decided_by_name}</p> : null}
    </div>
  );
}

function OvertimeAction({ row }) {
  const { open } = useAttendanceActions();
  if (row.locked) return <span className="text-xs text-muted-foreground">Payroll processed</span>;
  return (
    <Button variant={row.approval ? "outline" : "default"} size="sm" onClick={() => open("overtime", row)}>
      {row.approval ? "Change" : "Review"}
    </Button>
  );
}
