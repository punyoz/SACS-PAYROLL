"use client";

import * as React from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { AttendanceBadge } from "@/components/portal/status-badge";
import { useAttendanceActions } from "@/components/portal/attendance/dialogs";
import {
  branchLabel,
  canCorrect,
  formatDayHeading,
  formatMinutes,
  formatTapTime,
  formatWorked,
  rowBranchId,
  statusBreakdown,
  todayKey,
} from "@/lib/portal/attendance";
import { formatDateKey, formatTime, leaveSummary, normalizeAttendanceStatus } from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/**
 * An attendance table with branch and day headings (attWithGroupHeadings /
 * attWithDayHeadings, public/legacy/js/app.js): rows grouped by branch
 * (collapsible), then day (newest first), then employee. Headings repeat at
 * the top of every page, and their counts cover the whole group.
 *
 * grouping: {
 *   byBranch: boolean, ctx (branchContext), collapsed: Set, onToggle(branch),
 *   branchCounts: Map, dayCounts: Map keyed by day (or "branch|day"),
 *   statusBreakdown: show per-status counts in day headings
 * }
 */
export function GroupedAttendanceTable({
  columns,
  rows,
  grouping,
  loading = false,
  error = null,
  onRetry,
  pageSize = 20,
  empty = "No attendance records.",
  caption,
  minWidth = 900,
  rowKey = (row, i) => row.id || `${row.employee_id}|${row.log_date}|${i}`,
}) {
  const [page, setPage] = React.useState(1);
  const { byBranch, ctx, collapsed = new Set(), onToggle, branchCounts, dayCounts, statusBreakdown: showBreakdown } = grouping || {};

  // A collapsed branch keeps only its heading (attApplyCollapsed).
  const items = React.useMemo(() => {
    if (!byBranch || !collapsed.size) return rows;
    const out = [];
    const stubbed = new Set();
    rows.forEach((row) => {
      const branch = rowBranchId(ctx, row);
      if (!collapsed.has(branch)) { out.push(row); return; }
      if (stubbed.has(branch)) return;
      stubbed.add(branch);
      out.push({ __branchStub: true, group_branch_id: branch, log_date: "" });
    });
    return out;
  }, [rows, byBranch, collapsed, ctx]);

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pageCount);
  const start = (current - 1) * pageSize;
  const visible = items.slice(start, start + pageSize);
  const colSpan = columns.length;

  const dayHeading = (key, branch) => {
    const counts = dayCounts?.get(byBranch ? `${branch}|${key}` : key) || { total: 0, statuses: new Map() };
    const parts = [`${counts.total} record${counts.total === 1 ? "" : "s"}`, ...(showBreakdown ? statusBreakdown(counts.statuses) : [])];
    return (
      <TableRow key={`day-${branch}-${key}`} className="bg-muted/40 hover:bg-muted/40">
        <TableCell colSpan={colSpan} className={cn("py-2 whitespace-normal", byBranch && "pl-8")}>
          <span className="font-semibold">{formatDayHeading(key)}</span>
          {key === todayKey() ? <Badge variant="secondary" className="ml-2 align-middle">Today</Badge> : null}
          <span className="ml-3 text-xs text-muted-foreground">{parts.join(" · ")}</span>
        </TableCell>
      </TableRow>
    );
  };

  const branchHeading = (branch) => {
    const info = branchCounts?.get(branch) || { latestDay: "", employees: new Set(), statuses: new Map() };
    const isCollapsed = collapsed.has(branch);
    const employees = info.employees.size;
    const summary = [`${employees} employee${employees === 1 ? "" : "s"}`, ...statusBreakdown(info.statuses)].join(" · ");
    return (
      <TableRow key={`branch-${branch}`} className="bg-primary/8 hover:bg-primary/8">
        <TableCell colSpan={colSpan} className="py-2 whitespace-normal">
          <button
            type="button"
            onClick={() => onToggle?.(branch)}
            aria-expanded={!isCollapsed}
            className="inline-flex items-center gap-1.5 rounded font-semibold text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ChevronDownIcon className={cn("size-4 transition-transform", isCollapsed && "-rotate-90")} aria-hidden="true" />
            {branchLabel(ctx, branch)}
          </button>
          <span className="ml-3 text-xs text-muted-foreground">{info.latestDay ? `${formatDateKey(info.latestDay)}: ` : ""}{summary}</span>
        </TableCell>
      </TableRow>
    );
  };

  const body = [];
  let lastBranch = null;
  let lastDay = null;
  visible.forEach((row, index) => {
    const branch = byBranch ? rowBranchId(ctx, row) : "";
    if (byBranch && branch !== lastBranch) {
      body.push(branchHeading(branch));
      lastBranch = branch;
      lastDay = null;
    }
    if (row.__branchStub) return;
    const key = String(row.log_date || "");
    if (grouping && key !== lastDay) {
      body.push(dayHeading(key, branch));
      lastDay = key;
    }
    body.push(
      <TableRow key={rowKey(row, start + index)}>
        {columns.map((column) => (
          <TableCell key={column.key} className={cn(column.align === "right" && "text-right", column.className)}>
            {column.cell(row)}
          </TableCell>
        ))}
      </TableRow>,
    );
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table style={{ minWidth }}>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <TableHeader className="bg-muted/60">
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => (
                <TableHead key={column.key} className={cn("h-10 text-xs font-semibold text-muted-foreground", column.align === "right" && "text-right")}>
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }, (_, i) => (
                <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                  {columns.map((column, c) => (
                    <TableCell key={column.key}><Skeleton className="h-4" style={{ width: `${50 + ((i * 7 + c * 13) % 40)}%` }} /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow className="hover:bg-transparent"><TableCell colSpan={colSpan} className="p-0 whitespace-normal"><ErrorState message={error} onRetry={onRetry} /></TableCell></TableRow>
            ) : !rows.length ? (
              <TableRow className="hover:bg-transparent"><TableCell colSpan={colSpan} className="p-0 whitespace-normal"><EmptyState title={empty} /></TableCell></TableRow>
            ) : body}
          </TableBody>
        </Table>
      </div>
      {!loading && !error && items.length > pageSize ? (
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <p aria-live="polite">Showing {start + 1}–{Math.min(start + pageSize, items.length)} of {items.length}</p>
          <div className="flex items-center gap-2">
            <span className="tabular-nums">Page {current} of {pageCount}</span>
            <Button variant="outline" size="icon" className="size-8" onClick={() => setPage(current - 1)} disabled={current <= 1} aria-label="Previous page"><ChevronLeftIcon /></Button>
            <Button variant="outline" size="icon" className="size-8" onClick={() => setPage(current + 1)} disabled={current >= pageCount} aria-label="Next page"><ChevronRightIcon /></Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Shared cells (attEmployeeCell / attStatusCell / attRecordRowHtml) ── */

export function EmployeeCell({ row, link = false, showType = false }) {
  const { openEmployee } = useAttendanceActions() || {};
  const sub = [row?.employee_code, showType ? row?.employee_type : ""].filter(Boolean).join(" · ");
  const name = row?.employee_name || "—";
  return (
    <div className="min-w-0">
      {link && row?.employee_id && openEmployee ? (
        <button type="button" onClick={() => openEmployee(row.employee_id)} className="text-left font-medium text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" title="View attendance records">
          {name}
        </button>
      ) : <span className="font-medium">{name}</span>}
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export function StatusCell({ row }) {
  const status = normalizeAttendanceStatus(row.status);
  const c = row.last_correction;
  return (
    <div className="space-y-1 whitespace-normal">
      <AttendanceBadge status={row.status} />
      {row.holiday_name ? <p className="text-xs text-muted-foreground">{row.holiday_name}</p> : null}
      {row.not_yet_tapped ? <p className="text-xs text-muted-foreground">No tap yet today</p> : null}
      {status === "On Leave" ? <p className="text-xs text-muted-foreground">{leaveSummary(row.leave)}</p> : null}
      {status === "Corrected" && c ? <p className="text-xs text-muted-foreground">{[`Corrected by ${c.approved_by_name || "HR / Admin"}`, c.reason].filter(Boolean).join(" · ")}</p> : null}
      {row.tap_after_correction_at && status === "Corrected" ? (
        <p className="text-xs font-medium text-warning" title={`Latest tap ${formatTapTime(row.tap_after_correction_at)}`}>New tap after correction</p>
      ) : null}
    </div>
  );
}

export function RecordActions({ row, viewRecords = true }) {
  const { open, openEmployee } = useAttendanceActions() || {};
  const showCorrect = canCorrect(row);
  const showView = viewRecords && row?.employee_id && openEmployee;
  if (!showCorrect && !showView) return null;
  return (
    <div className="flex justify-end gap-1.5 whitespace-nowrap">
      {showCorrect ? <Button variant="outline" size="sm" onClick={() => open("correct", row)}>Correct</Button> : null}
      {showView ? <Button variant="ghost" size="sm" onClick={() => openEmployee(row.employee_id)}>View records</Button> : null}
    </div>
  );
}

/** Employee, Date, Time In, Time Out, Hours, Late, Undertime, Status, Action. */
export function recordColumns({ canReview, showType = false }) {
  const columns = [
    { key: "employee", header: "Employee", cell: (r) => <EmployeeCell row={r} link={canReview} showType={showType} /> },
    { key: "date", header: "Date", className: "whitespace-nowrap", cell: (r) => formatDateKey(r.log_date) },
    { key: "in", header: "Time in", className: "tabular-nums whitespace-nowrap", cell: (r) => formatTime(r.time_in) },
    { key: "out", header: "Time out", className: "tabular-nums whitespace-nowrap", cell: (r) => formatTime(r.time_out) },
    { key: "hours", header: "Hours", className: "tabular-nums whitespace-nowrap", cell: (r) => formatWorked(r) },
    { key: "late", header: "Late", className: "tabular-nums whitespace-nowrap", cell: (r) => formatMinutes(r.late_minutes) },
    { key: "under", header: "Undertime", className: "tabular-nums whitespace-nowrap", cell: (r) => formatMinutes(r.undertime_minutes) },
    { key: "status", header: "Status", className: "min-w-40", cell: (r) => <StatusCell row={r} /> },
  ];
  if (canReview) columns.push({ key: "action", header: <span className="sr-only">Action</span>, align: "right", cell: (r) => <RecordActions row={r} /> });
  return columns;
}
