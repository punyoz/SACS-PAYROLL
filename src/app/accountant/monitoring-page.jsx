"use client";

import * as React from "react";
import { CheckCircle2Icon, ListIcon, PauseCircleIcon, ReceiptTextIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateTime, moneyCompact, statusMeta } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { useAccountant } from "./accountant-data";

/*
 * Payroll Monitoring (renderMonitoringPage / monFilter / editDraftEntry /
 * cancelDraft, accountant.js): processed records and saved drafts together.
 */

export function MonitoringPage() {
  const { data, loading, load, editDraft, openPayslip, entryId, setEntryId } = useAccountant();
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [filter, setFilter] = React.useState("all");
  const all = [...(data?.records || []), ...(data?.draft_entries || [])];
  const rows = filter === "all" ? all : all.filter((r) => String(r.status || "").toLowerCase() === filter);
  const paid = all.filter((r) => r.status === "paid" || r.status === "approved").length;
  const hold = all.filter((r) => r.status === "on_hold").length;
  const first = loading && !data;

  async function cancelDraft(id) {
    const ok = await confirm({ title: "Withdraw this payroll draft?", description: "The draft will be permanently removed and cannot be recovered.", confirmLabel: "Withdraw draft", destructive: true });
    if (!ok) return;
    try {
      await fetchJson("/api/accountant/payroll", jsonBody("PATCH", { action: "cancel_draft", entry_id: id }));
      if (String(entryId) === String(id)) setEntryId("");
      await load();
      notify("Draft Withdrawn", "The payroll draft has been removed.", "info");
    } catch (error) {
      notify("Error", error.message || "Unable to withdraw draft.", "error");
    }
  }

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => r.employee_name },
    { key: "pay_period", header: "Pay period", sortable: true },
    { key: "gross_pay", header: "Gross pay", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.gross_pay || 0), cell: (r) => moneyCompact(r.gross_pay) },
    { key: "total_deductions", header: "Deductions", align: "right", className: "tabular-nums", cell: (r) => moneyCompact(r.total_deductions) },
    { key: "net_pay", header: "Net pay", align: "right", className: "tabular-nums font-medium", sortValue: (r) => Number(r.net_pay || 0), cell: (r) => moneyCompact(r.net_pay) },
    { key: "status", header: "Status", cell: (r) => { const s = statusMeta(r.status); return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>; } },
    { key: "date", header: "Date", className: "whitespace-nowrap text-xs text-muted-foreground", sortValue: (r) => r.submitted_at || r.updated_at || "", cell: (r) => { const d = r.submitted_at || r.updated_at; return d ? dateTime(d) : "—"; } },
    {
      key: "action",
      header: <span className="sr-only">Action</span>,
      align: "right",
      cell: (r) => (String(r.status || "").toLowerCase() === "draft" ? (
        <div className="flex justify-end gap-1.5">
          <Button variant="outline" size="sm" onClick={() => editDraft(r.id)}>Edit</Button>
          <Button variant="destructive" size="sm" onClick={() => cancelDraft(r.id)}>Cancel</Button>
        </div>
      ) : <Button variant="outline" size="sm" onClick={() => openPayslip(r.id)}>Payslip</Button>),
    },
  ];

  return (
    <>
      <section aria-label="Totals" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Total records" value={all.length} icon={ListIcon} loading={first} />
        <StatCard label="Paid" value={paid} icon={CheckCircle2Icon} tone="success" loading={first} />
        <StatCard label="On hold" value={hold} icon={PauseCircleIcon} tone="danger" loading={first} />
      </section>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Payroll history</CardTitle>
          <CardAction><Button variant="outline" size="sm" onClick={() => load()} disabled={loading}><RefreshCwIcon className={cn(loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="paid">Paid</TabsTrigger>
              <TabsTrigger value="draft">Draft</TabsTrigger>
              <TabsTrigger value="on_hold">On hold</TabsTrigger>
            </TabsList>
          </Tabs>
          <DataTable
            columns={columns}
            rows={rows}
            loading={first}
            pageSize={15}
            searchPlaceholder="Search employee name…"
            empty={{ title: "No payroll records found", icon: ReceiptTextIcon }}
            caption="Payroll history"
            minWidth={980}
          />
        </CardContent>
      </Card>
      {confirmDialog}
    </>
  );
}
