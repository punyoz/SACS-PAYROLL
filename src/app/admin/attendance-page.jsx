"use client";

import * as React from "react";
import { CheckCircle2Icon, ClockAlertIcon, DownloadIcon, RadioTowerIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/portal/stat-card";
import { usePortalSession } from "@/components/portal/session";
import { useAttendanceActions } from "@/components/portal/attendance/dialogs";
import { EmployeeSearch, GroupedAttendanceTable, recordColumns } from "@/components/portal/attendance/grouped-table";
import { AttendanceStatusBoard } from "@/components/portal/attendance/status-board";
import { fetchJson, hardNavigate } from "@/lib/portal/api";
import { branchContext, branchCounts, countBy, downloadCsv, matchesEmployee, oneRowPerDay, rowBranchId, sortByBranchDay } from "@/lib/portal/attendance";
import { logAuditMovement } from "@/lib/portal/audit";

/*
 * Attendance Monitoring (loadAttendanceData / exportAttendanceCsv,
 * public/legacy/js/admin.js): GET /api/admin/attendance for today's panels
 * and log, grouped by branch and day (attPrepareAttendanceLog, app.js), then
 * the shared status board.
 */

/** "08:05 AM" in the browser's time zone (formatTimeOnly, app.js) — the CSV keeps the legacy format. */
function timeOnly(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-PH", { hour: "2-digit", minute: "2-digit", hour12: true }).format(date);
}

/** "8h 05m" from decimal hours (formatHours, app.js). */
function hoursText(value) {
  const total = Number(value || 0);
  if (!Number.isFinite(total) || total <= 0) return "—";
  const whole = Math.floor(total);
  return `${whole}h ${String(Math.round((total - whole) * 60)).padStart(2, "0")}m`;
}

const COLUMNS = recordColumns({ canReview: true, showType: true });

const ADMIN_TERMINAL_TEXT = "Open the dedicated tap-in/tap-out screen for your branch's RFID reader. It replaces this view and is locked behind your Administration password.";

/**
 * Also the Super Admin's Attendance page (public/legacy/js/super-admin.js
 * loadSAAttendanceData): every branch, a branch filter on the status board,
 * and its CSV export is not written to the audit trail (auditActor null).
 */
export function AttendancePage({
  refreshKey,
  onNavigate,
  maintenancePage = "adm-maintenance",
  terminalText = ADMIN_TERMINAL_TEXT,
  branchFilter = false,
  auditActor = "Admin",
}) {
  const { notify } = usePortalSession();
  const { version } = useAttendanceActions();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [collapsed, setCollapsed] = React.useState(() => new Set());
  const [search, setSearch] = React.useState("");

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: !current.data, error: null }));
    try {
      const data = await fetchJson("/api/admin/attendance");
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey, version]);

  const panels = state.data?.panels || {};
  const raw = state.data?.attendance_logs;

  const log = React.useMemo(() => {
    const list = oneRowPerDay((raw || []).map((row) => ({ ...row, log_date: row.log_date || row.date }))).filter((row) => matchesEmployee(row, search));
    const ctx = branchContext(list);
    const rows = sortByBranchDay(ctx, list);
    return {
      rows,
      grouping: {
        byBranch: true,
        ctx,
        branchCounts: branchCounts(ctx, list),
        dayCounts: countBy(rows, (row) => `${rowBranchId(ctx, row)}|${row.log_date}`),
        statusBreakdown: true,
      },
    };
  }, [raw, search]);

  function exportCsv() {
    const rows = raw || [];
    if (!rows.length) {
      notify("Nothing to export", "No attendance data available to export.", "info");
      return;
    }
    const dateKey = String(state.data?.date_key || "today").replaceAll("/", "-");
    downloadCsv(
      `sacs-attendance-${dateKey}.csv`,
      ["Employee", "Type", "Time In", "Time Out", "Hours", "Status"],
      rows.map((row) => [row.employee_name || "", row.employee_type || "", timeOnly(row.time_in), timeOnly(row.time_out), hoursText(row.total_hours), row.status || ""]),
    );
    if (!auditActor) return;
    logAuditMovement({
      module: "ui",
      action: "export_csv",
      entity_type: "attendance",
      entity_id: dateKey,
      description: `${auditActor} exported attendance CSV.`,
      source: "ui",
      metadata: { row_count: rows.length },
    });
  }

  const loading = state.loading && !state.data;

  return (
    <>
      <Card className="border-brand-gold/60 bg-gradient-to-r from-brand-gold/10 to-transparent shadow-xs">
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><RadioTowerIcon className="size-5" aria-hidden="true" /></span>
          <div className="flex-1">
            <p className="font-semibold">RFID Terminal</p>
            <p className="text-sm text-muted-foreground">{terminalText}</p>
          </div>
          <Button onClick={() => hardNavigate("/rfid-terminal")}>Open RFID Terminal</Button>
        </CardContent>
      </Card>

      <section aria-label="Today" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Present today" value={panels.present_today || 0} icon={CheckCircle2Icon} tone="success" loading={loading} />
        <StatCard label="Late today" value={panels.late_today || 0} icon={ClockAlertIcon} tone="gold" loading={loading} />
        <StatCard label="Absent today" value={panels.absent_today || 0} hint={`On leave: ${panels.on_leave_today || 0}`} icon={XCircleIcon} tone="danger" loading={loading} />
      </section>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Attendance log — {state.data?.date_label || "Today"}</CardTitle>
          <CardDescription>Grouped by branch and day. Select a name to open that employee&apos;s record.</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!raw?.length}><DownloadIcon aria-hidden="true" />Export CSV</Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <EmployeeSearch value={search} onChange={setSearch} />
          <GroupedAttendanceTable
            columns={COLUMNS}
            rows={log.rows}
            grouping={{
              ...log.grouping,
              collapsed,
              onToggle: (branch) => setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(branch)) next.delete(branch); else next.add(branch);
                return next;
              }),
            }}
            loading={loading}
            error={!state.data ? state.error : null}
            onRetry={load}
            pageSize={15}
            empty={search.trim() ? `No employees match "${search.trim()}".` : "No attendance records found for today."}
            caption="Today's attendance log"
            minWidth={1000}
          />
        </CardContent>
      </Card>

      <AttendanceStatusBoard refreshKey={refreshKey} branchFilter={branchFilter} />

      <p className="text-sm text-muted-foreground">
        Need to record a tap manually? Use the RFID scan input under{" "}
        <Button variant="link" className="h-auto p-0" onClick={() => onNavigate(maintenancePage)}>System Maintenance</Button>.
      </p>
    </>
  );
}
