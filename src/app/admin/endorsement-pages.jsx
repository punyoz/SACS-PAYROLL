"use client";

import * as React from "react";
import { ArrowLeftRightIcon, CalendarDaysIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { dateLabel, dateTime } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { FileDialog, HistoryButton, RequestStatus, fileRequest, useBranchView } from "./oversight-shared";

/*
 * Leave Recommendation and Transfer Endorsement: the branch Admin endorses or
 * does not endorse (with a remark) before HR decides; HR sees the
 * recommendation on its own Leave Approval / Transfer Requests pages; the
 * Admin sees HR's final decision here afterwards.
 */

function Recommendation({ rec }) {
  if (!rec) return <span className="text-xs text-muted-foreground">Not given</span>;
  return (
    <div className="max-w-64 text-xs whitespace-normal">
      <RequestStatus status={rec.status} label={rec.status_label} />
      <p className="mt-1">{rec.admin_note}</p>
      <p className="text-muted-foreground">{rec.created_by_name} · {dateTime(rec.updated_at || rec.created_at)}</p>
    </div>
  );
}

const HR_TONE = (status) => (status === "approved" ? "success" : status === "rejected" || status === "cancelled" ? "danger" : "gold");

export function LeaveRecommendationsPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const view = useBranchView("leaves", {}, refreshKey);
  const [tab, setTab] = React.useState("pending");
  const [target, setTarget] = React.useState(null);
  const leaves = view.data?.leaves || [];
  const rows = tab === "pending" ? leaves.filter((l) => l.pending) : tab === "decided" ? leaves.filter((l) => !l.pending) : leaves;
  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (l) => l.employee_name },
    { key: "leave", header: "Leave", cell: (l) => <div className="text-xs"><p className="font-medium">{l.leave_type}{l.pay_status === "without_pay" ? " (without pay)" : ""}</p><p className="text-muted-foreground">{dateLabel(l.start_date)}{l.end_date !== l.start_date ? ` – ${dateLabel(l.end_date)}` : ""}</p></div>, searchValue: (l) => l.leave_type },
    { key: "reason", header: "Reason", cell: (l) => <p className="max-w-56 text-xs whitespace-normal">{l.reason}</p> },
    { key: "rec", header: "Your recommendation", cell: (l) => <Recommendation rec={l.recommendation} /> },
    { key: "hr", header: "HR decision", sortValue: (l) => l.hr_status_label, cell: (l) => <div className="text-xs"><StatusBadge tone={HR_TONE(l.status)}>{l.hr_status_label}</StatusBadge>{l.decided_at ? <p className="mt-1 text-muted-foreground">{l.decided_by_name || "HR"} · {dateTime(l.decided_at)}</p> : null}</div>, searchValue: (l) => l.hr_status_label },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (l) => (
      <div className="flex justify-end gap-1">
        {l.recommendation ? <HistoryButton request={l.recommendation} /> : null}
        {l.pending ? <Button size="sm" variant={l.recommendation ? "outline" : "default"} onClick={() => setTarget(l)}>{l.recommendation ? "Change" : "Recommend"}</Button> : null}
      </div>
    ) },
  ];
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CalendarDaysIcon className="size-4 text-gold-text" aria-hidden="true" />Leave recommendations</CardTitle>
        <CardDescription>Endorse or do not endorse each leave request of your branch, with a remark. HR makes the final decision and sees your recommendation.</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={view.load} disabled={view.loading}><RefreshCwIcon className={cn(view.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList><TabsTrigger value="pending">Waiting for HR</TabsTrigger><TabsTrigger value="decided">Decided</TabsTrigger><TabsTrigger value="all">All</TabsTrigger></TabsList>
        </Tabs>
        <DataTable columns={columns} rows={rows} loading={view.first} error={view.error} onRetry={view.load} pageSize={15}
          searchPlaceholder="Search employee or leave type…" empty={{ title: tab === "pending" ? "No leave waiting for HR" : "No leave requests", icon: CalendarDaysIcon }} caption="Leave recommendations" minWidth={1100} />
      </CardContent>
      <FileDialog open={Boolean(target)} onOpenChange={(o) => { if (!o) setTarget(null); }} decisions
        title={`Recommend — ${target?.employee_name || ""}`}
        description={target ? `${target.leave_type}, ${dateLabel(target.start_date)}${target.end_date !== target.start_date ? ` – ${dateLabel(target.end_date)}` : ""}. HR decides; this is your recommendation.` : ""}
        initial={{ note: target?.recommendation?.admin_note || "" }}
        onSubmit={async (values) => {
          await fileRequest("leave_endorsement", { ref_id: target.id, decision: values.decision, note: values.note });
          notify("Recommendation Sent", "HR sees it on the leave request.", "success");
          await view.load();
        }} />
    </Card>
  );
}

export function TransferEndorsementsPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const view = useBranchView("transfers", {}, refreshKey);
  const [target, setTarget] = React.useState(null);
  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (t) => t.employee_name },
    { key: "direction", header: "Move", cell: (t) => <div className="text-xs"><StatusBadge tone={t.direction === "incoming" ? "info" : "gold"} dot={false}>{t.direction === "incoming" ? "Incoming" : "Outgoing"}</StatusBadge><p className="mt-1">{t.from_branch} → {t.to_branch}</p></div> },
    { key: "remarks", header: "HR's note", cell: (t) => <p className="max-w-56 text-xs whitespace-normal">{t.remarks || "—"}</p> },
    { key: "created_at", header: "Raised", className: "whitespace-nowrap text-xs", cell: (t) => dateTime(t.created_at) },
    { key: "rec", header: "Your endorsement", cell: (t) => <Recommendation rec={t.endorsement} /> },
    { key: "hr", header: "HR decision", cell: (t) => <div className="text-xs"><StatusBadge tone={HR_TONE(t.status)}>{t.status_label}</StatusBadge>{t.reviewed_at ? <p className="mt-1 text-muted-foreground">{dateTime(t.reviewed_at)}</p> : null}</div> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (t) => (
      <div className="flex justify-end gap-1">
        {t.endorsement ? <HistoryButton request={t.endorsement} /> : null}
        {t.status === "pending" ? <Button size="sm" variant={t.endorsement ? "outline" : "default"} onClick={() => setTarget(t)}>{t.endorsement ? "Change" : "Endorse"}</Button> : null}
      </div>
    ) },
  ];
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ArrowLeftRightIcon className="size-4 text-gold-text" aria-hidden="true" />Transfer endorsements</CardTitle>
        <CardDescription>Transfers into and out of your branch that HR asked the branch Admins to endorse. Endorse or do not endorse with a remark; HR decides.</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={view.load} disabled={view.loading}><RefreshCwIcon className={cn(view.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={view.data?.transfers || []} loading={view.first} error={view.error} onRetry={view.load} pageSize={15}
          searchPlaceholder="Search employee…" empty={{ title: "No transfers for your branch", icon: ArrowLeftRightIcon }} caption="Transfer endorsements" minWidth={1100} />
      </CardContent>
      <FileDialog open={Boolean(target)} onOpenChange={(o) => { if (!o) setTarget(null); }} decisions
        title={`Endorse transfer — ${target?.employee_name || ""}`}
        description={target ? `${target.from_branch} → ${target.to_branch}. HR decides; HR sees your endorsement.` : ""}
        initial={{ note: target?.endorsement?.admin_note || "" }}
        onSubmit={async (values) => {
          await fileRequest("transfer_endorsement", { ref_id: target.id, decision: values.decision, note: values.note });
          notify("Endorsement Sent", "HR sees it on the transfer.", "success");
          await view.load();
        }} />
    </Card>
  );
}
