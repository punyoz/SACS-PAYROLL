"use client";

import * as React from "react";
import { CalendarCheckIcon, InfoIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/portal/data-table";
import { AttendanceStatusBoard } from "@/components/portal/attendance/status-board";
import { useAccountant } from "./accountant-data";
import { fetchJson } from "@/lib/portal/api";
import { portalHref } from "@/lib/portal/navigate";
import { INCOMPLETE_TAB_KEY } from "./process-page";

/*
 * View Attendance (renderAttendanceTable and the read-only status board,
 * accountant.js): the period's per-employee counts for payroll reference.
 * The Accountant cannot change attendance; the API decides what is shown.
 */

export function AttendancePage({ refreshKey }) {
  const { data, loading, error, load } = useAccountant();
  // Process Payroll's "View in attendance" opens the Incomplete queue.
  const [initialTab] = React.useState(() => {
    try {
      const tab = sessionStorage.getItem(INCOMPLETE_TAB_KEY);
      sessionStorage.removeItem(INCOMPLETE_TAB_KEY);
      return tab || "all";
    } catch {
      return "all";
    }
  });

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => r.employee_name },
    { key: "present_days", header: "Present", align: "right", sortable: true, className: "tabular-nums", cell: (r) => Number(r.present_days || 0) },
    { key: "late_days", header: "Late", align: "right", sortable: true, className: "tabular-nums", cell: (r) => Number(r.late_days || 0) },
    { key: "absent_days", header: "Absent", align: "right", sortable: true, className: "tabular-nums", cell: (r) => Number(r.absent_days || 0) },
    { key: "deduction_days", header: "Deduction days", align: "right", sortable: true, className: "tabular-nums", cell: (r) => Number(r.deduction_days || 0) },
  ];

  return (
    <>
      <Alert className="border-border bg-muted/30">
        <InfoIcon aria-hidden="true" />
        <AlertDescription>You can view attendance to assist with payroll. You cannot modify attendance records.</AlertDescription>
      </Alert>
      {/* The shared attendance view (redesign 2026-11-09): own branch, view only. */}
      <AttendanceStatusBoard refreshKey={refreshKey} initialTab={initialTab} readOnly urlKey="ac_att" title="Attendance"
        help="Your branch, view only: the attendance payroll uses." />
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Attendance for payroll</CardTitle>
          <CardDescription>{data?.active_period?.label || "This period"}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={data?.attendance_rows || []}
            loading={loading && !data}
            error={error}
            onRetry={() => load()}
            rowKey={(r) => r.employee_id}
           
            searchPlaceholder="Search employee…"
            empty={{ title: "No attendance rows available", icon: CalendarCheckIcon }}
            caption="Attendance for payroll"
            minWidth={560}
          />
        </CardContent>
      </Card>
      {/* 2026-11-26: what HR approved and what the payslips paid (no Admin endorsement any more). */}
      <ApprovedOvertimeCard refreshKey={refreshKey} />
    </>
  );
}

const money = (n) => (n === null || n === undefined ? "—" : `₱${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** Read-only: HR-approved overtime requests and substitutions (paid as overtime), with what the payslip paid. */
function ApprovedOvertimeCard({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, rows: [] });
  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try { const d = await fetchJson("/api/accountant/approved-overtime"); setState({ loading: false, error: null, rows: d.rows || [] }); }
    catch (e) { setState((c) => ({ ...c, loading: false, error: e.message || "Not loaded." })); }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => `${r.employee_name} ${r.detail}` },
    { key: "kind", header: "Type", cell: (r) => r.kind },
    { key: "date", header: "Date", sortable: true, cell: (r) => r.date_label },
    { key: "hours", header: "Hours", align: "right", className: "tabular-nums", cell: (r) => r.hours },
    { key: "rate", header: "Rate", align: "right", className: "tabular-nums", cell: (r) => money(r.rate) },
    { key: "amount", header: "Amount", align: "right", className: "tabular-nums font-medium", cell: (r) => (r.amount === null ? <span className="text-muted-foreground">Not paid yet</span> : money(r.amount)) },
    { key: "pay_period", header: "Cutoff", cell: (r) => (r.pay_period ? <a className="underline-offset-2 hover:underline" href={portalHref("ac-records")}>{r.pay_period}</a> : "—") },
    { key: "detail", header: "Details", className: "max-w-72 whitespace-normal text-xs text-muted-foreground", cell: (r) => r.detail },
  ];
  return (
    <Card className="min-w-0 shadow-xs" data-testid="approved-overtime">
      <CardHeader>
        <CardTitle>Approved overtime &amp; substitutions</CardTitle>
        <CardDescription>What HR approved and what the payslip paid. Substitute teaching is paid as overtime. View only.</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={state.rows} loading={state.loading} error={state.error} onRetry={load} rowKey={(r) => `${r.kind}-${r.employee_id}-${r.date}`}
          searchPlaceholder="Search employee or details…" empty={{ title: "Nothing approved in the last two months", icon: CalendarCheckIcon }} caption="Approved overtime and substitutions" minWidth={900} />
      </CardContent>
    </Card>
  );
}
