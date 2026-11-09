"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/portal/status-badge";
import { useAttendanceActions } from "@/components/portal/attendance/dialogs";
import { EmployeeCell, RecordActions, StatusCell } from "@/components/portal/attendance/grouped-table";
import { AttendanceBadge } from "@/components/portal/status-badge";
import { AttendanceView } from "@/components/portal/attendance/attendance-view";
import { DataTable } from "@/components/portal/data-table";
import { useUrlRange } from "@/components/portal/date-range-filter";
import { useUrlParam } from "@/components/portal/use-url-param";
import { apiFetch, fetchJson } from "@/lib/portal/api";
import { formatDateTime, formatMinutes, formatWorked } from "@/lib/portal/attendance";
import { formatDateKey, formatTime } from "@/lib/portal/format";
import { defaultRange, rangePresets } from "@/lib/portal/date-range";
import { manilaDateKey } from "@/lib/payroll/periods";

/*
 * The attendance board of the Super Admin (view only), HR (review) and the
 * Accountant (view only, own branch), on the ONE shared attendance layout
 * (src/components/portal/attendance/attendance-view.jsx, redesign 2026-11-09).
 *
 *   All records / Incomplete queue   GET /api/attendance/logs, server pages:
 *                                    search, branch, status, day and the page
 *                                    are sent; the summary counts come back
 *   Correction requests / Overtime / Blocked taps
 *                                    the reviewers' queues (small lists)
 *
 * The server keeps the branch limits as before: the Accountant and the Admin
 * only ever get their own branch's rows.
 */

const NOTES = {
  all: "Statuses are computed automatically from each branch's schedule. Today, people who have not tapped yet show as \"Not tapped yet\", not Absent: the day is not over.",
  incomplete: "Days with a time in but no time out after the shift ended. They are left out of payroll until resolved: by the employee's correction request, by recording the time out (or Absent / Half Day) here, or with Correct.",
  blocked: "RFID taps that were refused: an unregistered card, an inactive employee, another branch's card, or an employee on approved leave. Nothing was recorded for them.",
  corrections: "Approving replaces the time out and marks the day Corrected. Rejecting keeps it Incomplete (out of payroll) or sets it to Absent or Half Day. Correct enters different times yourself and closes the request.",
  overtime: "Days whose time out is well after the branch's end of shift. Payroll pays overtime only for the minutes approved here. Decisions lock once that pay period is processed.",
};

/**
 * branchFilter   the role sees several branches (Super Admin, HR)
 * readOnly       view only, no reviewer queues (Super Admin, Accountant)
 * defaultPreset  the range it opens on ("this_cutoff", "this_month", ...)
 * urlKey         keeps range and filters in the address (Refresh / Back)
 */
export function AttendanceStatusBoard({
  branchFilter = false, refreshKey = 0, initialTab = "all", readOnly = false,
  defaultPreset = "this_cutoff", urlKey = "att", title = "Attendance", help = null,
}) {
  const { version } = useAttendanceActions();
  const fallback = React.useMemo(() => {
    const p = rangePresets(manilaDateKey()).find((x) => x.id === defaultPreset);
    return p ? { from: p.from, to: p.to } : defaultRange();
  }, [defaultPreset]);
  const [range, setRange] = useUrlRange(urlKey, fallback);
  const [tab, setTab] = useUrlParam(`${urlKey}_tab`, initialTab);
  const [status, setStatus] = useUrlParam(`${urlKey}_status`, "all");
  const [day, setDay] = useUrlParam(`${urlKey}_day`, "all");
  const [branch, setBranch] = useUrlParam(`${urlKey}_branch`, "");
  const [search, setSearch] = React.useState("");
  const [q, setQ] = React.useState("");
  const [paging, setPaging] = React.useState({ page: 1, pageSize: 25 });
  const [branches, setBranches] = React.useState([]);
  const [state, setState] = React.useState({ loading: true, error: null, logs: [], total: 0, counts: {}, days: [], blocked: [], canReview: false, scope: "" });
  const [queues, setQueues] = React.useState({ corrections: [], overtime: [], overtimeCanReview: false });

  // Search waits for a pause in typing (300 ms), then asks the server.
  React.useEffect(() => {
    const timer = setTimeout(() => { setQ(search.trim()); setPaging((c) => ({ ...c, page: 1 })); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  React.useEffect(() => {
    if (!branchFilter) return;
    apiFetch("/api/admin/branches").then((r) => (r.ok ? r.json() : null)).then((data) => {
      setBranches((data?.branches || []).filter((b) => b?.id).map((b) => [String(b.id), b.name || "Branch"]).sort((a, b) => a[1].localeCompare(b[1])));
    }).catch(() => {});
  }, [branchFilter]);

  const listTab = tab === "all" || tab === "incomplete";
  const params = React.useMemo(() => {
    const p = new URLSearchParams({ from: range.from, to: range.to });
    if (branch) p.set("branch_id", branch);
    if (q) p.set("q", q);
    if (day !== "all") p.set("day", day);
    return p;
  }, [range, branch, q, day]);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const p = new URLSearchParams(params);
      p.set("page", String(paging.page));
      p.set("page_size", String(paging.pageSize));
      const effectiveStatus = tab === "incomplete" ? "unresolved" : status;
      if (effectiveStatus !== "all") p.set("status", effectiveStatus);
      const data = await fetchJson(`/api/attendance/logs?${p}`);
      setState({
        loading: false, error: null, logs: data.logs || [], total: Number(data.total) || 0, counts: data.counts || {},
        days: data.days || [], blocked: data.blocked_taps || [], canReview: Boolean(data.can_review), scope: String(data.scope || ""),
      });
    } catch (error) {
      setState((c) => ({ ...c, loading: false, error: error.message }));
    }
  }, [params, paging, tab, status]);

  const loadQueues = React.useCallback(async () => {
    if (readOnly) return;
    const [corrections, overtime] = await Promise.all([
      fetchJson("/api/attendance/corrections?status=pending").catch(() => ({ corrections: [] })),
      fetchJson(`/api/attendance/overtime?from=${range.from}&to=${range.to}`).catch(() => ({ overtime: [] })),
    ]);
    setQueues({ corrections: corrections.corrections || [], overtime: overtime.overtime || [], overtimeCanReview: Boolean(overtime.can_review) });
  }, [readOnly, range]);

  React.useEffect(() => { load(); }, [load, version, refreshKey]);
  React.useEffect(() => { loadQueues(); }, [loadQueues, version, refreshKey]);

  const canReview = state.canReview && !readOnly;
  const matches = React.useCallback((row) => (!branch || String(row.branch_id || row.group_branch_id || "") === branch)
    && (!q || String(row.employee_name || "").toLowerCase().includes(q.toLowerCase())), [branch, q]);
  const corrections = queues.corrections.filter(matches);
  const overtime = queues.overtime.filter(matches);
  const blocked = state.blocked.filter((row) => !q || String(row.employee_name || "").toLowerCase().includes(q.toLowerCase()));
  const incompleteCount = Number(state.counts.Incomplete || 0) + Number(state.counts["Pending Correction"] || 0);

  const tabOptions = [
    { value: "all", label: "All records" },
    ...(readOnly && !branchFilter ? [{ value: "incomplete", label: "Incomplete queue", count: incompleteCount || undefined }] : []),
    ...(!readOnly ? [{ value: "incomplete", label: "Incomplete queue", count: incompleteCount || undefined }] : []),
    ...(canReview ? [{ value: "corrections", label: "Correction requests", count: corrections.length || undefined }] : []),
    ...(canReview || queues.overtimeCanReview ? [{ value: "overtime", label: "Overtime", count: overtime.filter((r) => !r.approval && !r.locked).length || undefined }] : []),
    ...(!readOnly || branchFilter ? [{ value: "blocked", label: "Blocked taps", count: blocked.length || undefined }] : []),
  ];
  const activeTab = tabOptions.some((t) => t.value === tab) ? tab : "all";
  const multiBranch = branchFilter && branches.length > 1;

  const columns = React.useMemo(() => {
    if (activeTab === "corrections") {
      return [
        { key: "employee", header: "Employee", mobilePrimary: true, cell: (c) => <span className="font-medium">{c.employee_name || "—"}</span> },
        { key: "date", header: "Date", className: "whitespace-nowrap", cell: (c) => formatDateKey(c.log_date) },
        { key: "recorded", header: "Recorded", cell: (c) => <div className="space-y-1"><p className="tabular-nums">{formatTime(c.original_time_in)} – {formatTime(c.original_time_out)}</p><AttendanceBadge status={c.original_status} /></div> },
        { key: "requested_out", header: "Requested time out", className: "tabular-nums", cell: (c) => formatTime(c.corrected_time_out) },
        { key: "reason", header: "Reason", className: "max-w-64 whitespace-normal text-muted-foreground", cell: (c) => c.reason || "" },
        { key: "requested", header: "Requested", className: "whitespace-nowrap", cell: (c) => formatDateTime(c.requested_at) },
        ...(canReview ? [{ key: "action", header: <span className="sr-only">Actions</span>, align: "right", cell: (c) => <CorrectionActions correction={c} /> }] : []),
      ];
    }
    if (activeTab === "overtime") {
      return [
        { key: "employee", header: "Employee", mobilePrimary: true, cell: (r) => <span className="font-medium">{r.employee_name || "—"}</span> },
        { key: "date", header: "Date", className: "whitespace-nowrap", cell: (r) => formatDateKey(r.log_date) },
        { key: "out", header: "Time out", cell: (r) => <div><p className="tabular-nums">{formatTime(r.time_out)}</p><p className="text-xs text-muted-foreground">Shift ends {r.work_end || ""}</p></div> },
        { key: "past", header: "Past schedule", align: "right", className: "tabular-nums", cell: (r) => formatMinutes(r.overtime_minutes) },
        { key: "decision", header: "Decision", cell: (r) => <OvertimeDecision row={r} /> },
        ...(queues.overtimeCanReview ? [{ key: "action", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => <OvertimeAction row={r} /> }] : []),
      ];
    }
    if (activeTab === "blocked") {
      return [
        { key: "employee", header: "Employee", mobilePrimary: true, cell: (r) => <span className="font-medium">{r.employee_name || (r.employee_id ? "—" : `Unregistered card ${r.rfid_code || ""}`.trim())}</span> },
        { key: "date", header: "Date", className: "whitespace-nowrap", cell: (r) => formatDateKey(r.log_date) },
        { key: "attempted", header: "Attempted", className: "tabular-nums whitespace-nowrap", cell: (r) => formatDateTime(r.attempted_at) },
        { key: "source", header: "Source", cell: (r) => (r.source === "manual_entry" ? "Manual entry" : "RFID terminal") },
        { key: "reason", header: "Reason", className: "max-w-72 whitespace-normal", cell: (r) => r.reason || "" },
      ];
    }
    // All records and the Incomplete queue.
    return [
      { key: "employee", header: "Employee", mobilePrimary: true, cell: (r) => <EmployeeCell row={r} link={canReview} /> },
      ...(state.scope !== "self" && (branchFilter || multiBranch) ? [{ key: "branch", header: "Branch", className: "whitespace-nowrap", cell: (r) => r.branch_name || r.group_branch_name || "—" }] : []),
      { key: "date", header: "Date", className: "whitespace-nowrap", cell: (r) => formatDateKey(r.log_date) },
      { key: "in", header: "Time in", align: "right", mobile: false, className: "tabular-nums whitespace-nowrap", cell: (r) => formatTime(r.time_in) },
      { key: "out", header: "Time out", align: "right", mobile: false, className: "tabular-nums whitespace-nowrap", cell: (r) => formatTime(r.time_out) },
      { key: "hours", header: "Hours", align: "right", mobile: false, className: "tabular-nums whitespace-nowrap", cell: (r) => formatWorked(r) },
      // Phones: in, out and hours on one line.
      { key: "time", header: "Time", mobileOnly: true, cell: (r) => <span className="tabular-nums">{formatTime(r.time_in)} – {formatTime(r.time_out)} · {formatWorked(r)}</span> },
      { key: "status", header: "Status", mobileBadge: true, className: "min-w-36", cell: (r) => (r.not_tapped_yet ? <AttendanceBadge status="Not tapped yet" /> : <StatusCell row={r} />) },
      { key: "notes", header: "Notes", className: "min-w-40 max-w-72 text-xs whitespace-normal text-muted-foreground", cell: (r) => rowNote(r) },
      ...(canReview ? [{ key: "action", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => (r.not_tapped_yet ? null : activeTab === "incomplete" ? <IncompleteActions row={r} /> : <RecordActions row={r} />) }] : []),
    ];
  }, [activeTab, canReview, queues.overtimeCanReview, state.scope, branchFilter, multiBranch]);

  const resetFilters = () => {
    setSearch(""); setQ(""); setStatus("all"); setDay("all"); setBranch("");
    setRange(fallback); setPaging((c) => ({ ...c, page: 1 }));
  };
  const onFilter = (fn) => (value) => { fn(value); setPaging((c) => ({ ...c, page: 1 })); };
  const rows = activeTab === "corrections" ? corrections : activeTab === "overtime" ? overtime : activeTab === "blocked" ? blocked : state.logs;
  const exportParams = new URLSearchParams(params);
  if (status !== "all" && activeTab === "all") exportParams.set("status", status);
  if (activeTab === "incomplete") exportParams.set("status", "unresolved");

  const emptyText = q ? `No employees match "${q}".`
    : activeTab === "blocked" ? "No taps were blocked in this range."
      : activeTab === "corrections" ? "No correction requests waiting."
        : activeTab === "incomplete" ? "Nothing to resolve."
          : activeTab === "overtime" ? "No overtime in this range."
            : "No attendance for this range.";

  return (
    <AttendanceView
      title={title}
      help={help || (readOnly ? "View only. Any range of up to 62 days." : "Any range of up to 62 days, computed from each branch's schedule.")}
      actions={{
        onRefresh: () => { load(); loadQueues(); }, refreshing: state.loading,
        exportHref: state.scope === "self" ? null : `/api/attendance/logs?${exportParams}`, exportLabel: "attendance", exportDisabled: !state.total,
      }}
      summary={{ counts: state.counts, active: activeTab === "all" ? status : "all", loading: state.loading && !state.logs.length, onSelect: (s) => { setTab("all"); onFilter(setStatus)(s); } }}
      toolbar={{
        search: { value: search, onChange: setSearch },
        range: { value: range, onChange: onFilter((next) => { setRange(next); setDay("all"); }), maxDays: 62, idPrefix: `${urlKey}-range` },
        branch: multiBranch ? { value: branch, onChange: onFilter(setBranch), options: branches } : null,
        status: activeTab === "all" ? { value: status, onChange: onFilter(setStatus) } : null,
        day: listTab ? { value: day, onChange: onFilter(setDay), options: state.days.map((d) => [d, formatDateKey(d)]) } : null,
        onReset: resetFilters,
        count: state.loading ? null : listTab ? state.total : rows.length,
      }}
      tabs={{ value: activeTab, onChange: (v) => { setTab(v); setPaging((c) => ({ ...c, page: 1 })); }, options: tabOptions }}
      footer={NOTES[activeTab]}
      testId="attendance-board"
    >
      <DataTable
        key={activeTab}
        columns={columns}
        rows={rows}
        loading={state.loading && !state.logs.length && listTab}
        error={state.error}
        onRetry={load}
        searchable={false}
        stickyHeader
        striped
        pageSize={listTab ? paging.pageSize : 25}
        pageSizes={[10, 25, 50]}
        server={listTab ? { total: state.total, page: paging.page, pageSize: paging.pageSize, query: "", onChange: (next) => setPaging((c) => ({ page: next.page ?? c.page, pageSize: next.pageSize ?? c.pageSize })) } : null}
        empty={{ title: emptyText }}
        caption={title}
        minWidth={listTab ? 980 : 760}
        rowKey={(r, i) => r.id || r.log_id || `${r.employee_id}|${r.log_date}|${i}`}
      />
    </AttendanceView>
  );
}

/** Late / undertime minutes, a holiday or leave, a correction waiting. */
function rowNote(row) {
  const parts = [];
  if (Number(row.late_minutes) > 0) parts.push(`Late ${formatMinutes(row.late_minutes)}`);
  if (Number(row.undertime_minutes) > 0) parts.push(`Undertime ${formatMinutes(row.undertime_minutes)}`);
  if (row.holiday_name) parts.push(row.holiday_name);
  if (row.leave?.leave_type) parts.push(`${row.leave.leave_type} leave`);
  if (row.correction) parts.push("Correction requested");
  if (row.corrected_reason || row.correction_reason) parts.push(`Corrected: ${row.corrected_reason || row.correction_reason}`);
  return parts.join(" · ") || "—";
}

function IncompleteActions({ row }) {
  const { open } = useAttendanceActions();
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {row.status === "Incomplete"
        ? <Button size="sm" onClick={() => open("resolve", row)}>Resolve</Button>
        : <span className="text-xs text-muted-foreground">See correction requests</span>}
      <RecordActions row={row} viewRecords={false} />
    </div>
  );
}

function CorrectionActions({ correction }) {
  const { open } = useAttendanceActions();
  const record = {
    id: correction.log_id, employee_id: correction.employee_id, employee_name: correction.employee_name, log_date: correction.log_date,
    time_in: correction.original_time_in, time_out: correction.original_time_out, status: "Pending Correction", group_branch_id: correction.branch_id,
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
