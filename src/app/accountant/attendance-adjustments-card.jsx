"use client";

import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchJson } from "@/lib/portal/api";

/*
 * Action needed for the Accountant (2026-11-23): pay adjustments that HR
 * approved together with an attendance correction for a day already paid.
 * They are on the employee's next payslip by themselves (an incentive line
 * for a refund, a one-time recovery for a reduction): listed here to know,
 * never filed again.
 */

const peso = (n) => `₱${Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const isAttendanceAdjustment = (c) => c.status === "approved" && String(c.reason || "").startsWith("Attendance correction (");

export function AttendanceAdjustmentsCard({ refreshKey }) {
  const [rows, setRows] = React.useState([]);
  React.useEffect(() => {
    let alive = true;
    fetchJson("/api/payroll/corrections").then((d) => { if (alive) setRows((d.corrections || []).filter(isAttendanceAdjustment).slice(0, 20)); }).catch(() => {});
    return () => { alive = false; };
  }, [refreshKey]);
  if (!rows.length) return null;
  return (
    <Card className="border-brand-gold/40 shadow-xs" data-testid="attendance-adjustments">
      <CardHeader>
        <CardTitle>Action needed: attendance corrections on the next payslip</CardTitle>
        <CardDescription>Approved by HR with the correction (a day already paid). They go on the next payslip by themselves: nothing to file.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5 text-sm">
          {rows.map((c) => (
            <li key={c.id} className="flex flex-wrap justify-between gap-2 rounded-md border px-3 py-2" data-testid="attendance-adjustment">
              <span><strong>{c.employee_name}</strong> · {c.reason}</span>
              <span className="tabular-nums">{c.kind === "underpayment" ? "+" : "−"}{peso(c.amount)} · from {c.period_label}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
