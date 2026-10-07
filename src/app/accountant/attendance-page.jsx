"use client";

import * as React from "react";
import { CalendarCheckIcon, InfoIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/portal/data-table";
import { AttendanceStatusBoard } from "@/components/portal/attendance/status-board";
import { useAccountant } from "./accountant-data";
import { INCOMPLETE_TAB_KEY } from "./process-page";

/*
 * View Attendance (renderAttendanceTable and the read-only status board,
 * accountant.js): the period's per-employee counts for payroll reference.
 * The Accountant cannot change attendance; the API decides what is shown.
 */

export function AttendancePage({ refreshKey }) {
  const { data, loading } = useAccountant();
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
      <Alert className="border-info/40 bg-info/8">
        <InfoIcon aria-hidden="true" />
        <AlertDescription>You can view attendance to assist with payroll. You cannot modify attendance records.</AlertDescription>
      </Alert>
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
            rowKey={(r) => r.employee_id}
            pageSize={15}
            searchPlaceholder="Search employee…"
            empty={{ title: "No attendance rows available", icon: CalendarCheckIcon }}
            caption="Attendance for payroll"
            minWidth={560}
          />
        </CardContent>
      </Card>
      <AttendanceStatusBoard refreshKey={refreshKey} initialTab={initialTab} />
    </>
  );
}
