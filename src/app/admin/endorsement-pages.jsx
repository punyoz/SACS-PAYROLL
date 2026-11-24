"use client";

import { SystemRecommendation } from "@/components/portal/system-recommendation";
import { LeaveBalanceNote } from "@/components/portal/leave-balance-note";
import * as React from "react";
import { ArrowLeftRightIcon, CalendarDaysIcon, RefreshCwIcon } from "lucide-react";
import { useApprovalFilters } from "@/components/portal/approval-filters";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/portal/data-table";
import { FilterTabs } from "@/components/portal/filter-tabs";
import { StatusBadge } from "@/components/portal/status-badge";
import { ItemThread, useThreadCounts } from "@/components/portal/item-thread";
import { dateLabel, dateTime } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { useBranchView } from "./oversight-shared";

/*
 * Branch Review: Leave and Transfers (2026-11-24: view and monitor only). The
 * system checks each item and sends it straight to HR; HR decides. The branch
 * Admin sees each one with its live status (waiting for HR / approved /
 * rejected), who decided, when and HR's remark, and can message HR on it.
 */

const HR_TONE = (status) => (status === "approved" ? "success" : status === "rejected" || status === "cancelled" ? "danger" : "gold");

/** HR's decision: the status, who and when, and HR's remark. */
export function HrDecision({ status, label, by, at, remark }) {
  return (
    <div className="max-w-64 text-xs whitespace-normal" data-testid="hr-decision">
      <StatusBadge tone={HR_TONE(status)}>{label}</StatusBadge>
      {at ? <p className="mt-1 text-muted-foreground">{by || "HR"} · {dateTime(at)}</p> : null}
      {remark ? <p className="mt-1">{remark}</p> : null}
    </div>
  );
}

export function LeaveRecommendationsPage({ refreshKey }) {
  const view = useBranchView("leaves", {}, refreshKey);
  const [tab, setTab] = React.useState("pending");
  const leaves = view.data?.leaves || [];
  const tabRows = tab === "pending" ? leaves.filter((l) => l.pending) : tab === "decided" ? leaves.filter((l) => !l.pending) : leaves;
  const filters = useApprovalFilters(tabRows, {
    prefix: "adml", typeLabel: "Leave type", people: false,
    get: { name: (l) => l.employee_name, code: (l) => l.employee_code, type: (l) => l.leave_type, filed: (l) => l.submitted_at || l.created_at, requested: (l) => l.start_date },
  });
  const counts = useThreadCounts("leave_request", filters.rows.map((l) => l.id), view.data);
  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (l) => l.employee_name },
    { key: "leave", header: "Leave", cell: (l) => <div className="text-xs"><p className="font-medium">{l.leave_type}{l.half_day ? ` (half day, ${l.half_day})` : ""}{l.pay_status === "without_pay" ? " (without pay)" : ""}</p><p className="text-muted-foreground">{dateLabel(l.start_date)}{l.end_date !== l.start_date ? ` – ${dateLabel(l.end_date)}` : ""}</p>{l.pending ? <LeaveBalanceNote balance={view.data?.balances?.[l.employee_id]} request={l} className="mt-1 max-w-56 whitespace-normal" /> : null}</div>, searchValue: (l) => l.leave_type },
    { key: "reason", header: "Reason", cell: (l) => <p className="max-w-56 text-xs whitespace-normal">{l.reason}</p> },
    { key: "system", header: "The system's check", cell: (l) => <SystemRecommendation rec={l.system_recommendation} /> },
    { key: "hr", header: "HR decision", sortValue: (l) => l.hr_status_label, searchValue: (l) => l.hr_status_label,
      cell: (l) => <HrDecision status={l.status} label={l.pending ? "Waiting for HR" : l.hr_status_label} by={l.decided_by_name} at={l.decided_at} remark={l.decision_reason} /> },
    { key: "msg", header: <span className="sr-only">Messages</span>, align: "right", cell: (l) => <ItemThread itemType="leave_request" itemId={l.id} count={counts[l.id] || 0} title={`Messages · ${l.employee_name}`} /> },
  ];
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CalendarDaysIcon className="size-4 text-gold-text" aria-hidden="true" />Leave</CardTitle>
        <CardDescription>Every leave and half-day request of your branch. The system checks each one and sends it straight to HR; HR decides. View only: message HR on a request if you need to.</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={view.load} disabled={view.loading}><RefreshCwIcon className={cn(view.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataTable toolbar={<><FilterTabs value={tab} onValueChange={setTab} label="Leave filter" options={[{ value: "pending", label: "Waiting for HR" }, { value: "decided", label: "Decided" }, { value: "all", label: "All" }]} />{filters.toolbar}</>}
          columns={columns} rows={filters.rows} loading={view.first} error={view.error} onRetry={view.load}
          searchPlaceholder="Search name, ID or details…" empty={{ title: tab === "pending" ? "No leave waiting for HR" : "No leave requests", icon: CalendarDaysIcon }} caption="Branch leave requests" minWidth={1000} />
      </CardContent>
    </Card>
  );
}

export function TransferEndorsementsPage({ refreshKey }) {
  const view = useBranchView("transfers", {}, refreshKey);
  const filters = useApprovalFilters(view.data?.transfers || [], {
    prefix: "admt", people: false,
    get: { name: (t) => t.employee_name, code: (t) => t.employee_code, filed: (t) => t.created_at, requested: (t) => t.created_at },
  });
  const counts = useThreadCounts("transfer_request", filters.rows.map((t) => t.id), view.data);
  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (t) => t.employee_name },
    { key: "direction", header: "Move", cell: (t) => <div className="text-xs"><StatusBadge tone={t.direction === "incoming" ? "info" : "gold"} dot={false}>{t.direction === "incoming" ? "Incoming" : "Outgoing"}</StatusBadge><p className="mt-1">{t.from_branch} → {t.to_branch}</p></div> },
    { key: "created_at", header: "Raised", className: "whitespace-nowrap text-xs", cell: (t) => dateTime(t.created_at) },
    { key: "hr", header: "HR decision", cell: (t) => <HrDecision status={t.status} label={t.status === "pending" ? "Waiting for HR" : t.status_label} by={t.reviewed_by_name} at={t.reviewed_at} remark={t.remarks} /> },
    { key: "msg", header: <span className="sr-only">Messages</span>, align: "right", cell: (t) => <ItemThread itemType="transfer_request" itemId={t.id} count={counts[t.id] || 0} title={`Messages · ${t.employee_name}`} /> },
  ];
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ArrowLeftRightIcon className="size-4 text-gold-text" aria-hidden="true" />Transfers</CardTitle>
        <CardDescription>Transfers into and out of your branch. The system checks each one and sends it straight to HR; HR decides. View only.</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={view.load} disabled={view.loading}><RefreshCwIcon className={cn(view.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent>
        <DataTable toolbar={filters.toolbar} columns={columns} rows={filters.rows} loading={view.first} error={view.error} onRetry={view.load}
          searchPlaceholder="Search name, ID or details…" empty={{ title: "No transfers for your branch", icon: ArrowLeftRightIcon }} caption="Branch transfers" minWidth={900} />
      </CardContent>
    </Card>
  );
}
