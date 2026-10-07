"use client";

import * as React from "react";
import { CalendarIcon, CheckCircle2Icon, InfoIcon, Loader2Icon, RefreshCwIcon, UsersIcon, WalletIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel, dateTime, money, moneyCompact } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * 13th Month Pay (loadThirteenthMonth / processThirteenthMonth,
 * accountant.js): GET ?view=thirteenth_month&year=, PATCH process_13th_month.
 */

export function ThirteenthMonthPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const thisYear = Number(manilaDateKey().slice(0, 4));
  const years = [];
  for (let y = thisYear; y >= Math.min(2026, thisYear); y -= 1) years.push(y);
  const [year, setYear] = React.useState(thisYear);
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/accountant/payroll?view=thirteenth_month&year=${year}`);
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message || "Unable to load the 13th month pay.", data: null });
    }
  }, [year]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const rows = data?.rows || [];
  const processed = rows.filter((r) => r.processed).length;

  async function processAll() {
    if (!data?.can_process) return;
    const pending = rows.filter((r) => !r.processed && r.amount > 0);
    if (!pending.length) return;
    const ok = await confirm({
      title: `Process the ${data.year} 13th month pay for ${pending.length} employee${pending.length === 1 ? "" : "s"}?`,
      description: "Each payout is recorded once and cannot be processed again.",
      confirmLabel: "Process",
    });
    if (!ok) return;
    setBusy(true);
    setFeedback({ text: "Processing…", ok: true });
    try {
      const result = await fetchJson("/api/accountant/payroll", jsonBody("PATCH", { action: "process_13th_month", year: data.year }));
      const message = `Processed ${result.processed.length} payout${result.processed.length === 1 ? "" : "s"}.${result.skipped.length ? ` ${result.skipped.length} skipped.` : ""}`;
      setFeedback({ text: message, ok: true });
      notify("13th Month Pay Processed", message, "success");
      await load();
    } catch (error) {
      setFeedback({ text: error.message || "Unable to process the 13th month pay.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, cell: (r) => <div><p className="font-medium">{r.employee_name}</p><p className="text-xs text-muted-foreground">{r.employee_code || ""} · {r.employee_type || ""}</p></div>, searchValue: (r) => `${r.employee_name} ${r.employee_code || ""}` },
    { key: "periods", header: "Payslips", align: "right", className: "tabular-nums", cell: (r) => (r.periods || []).length },
    { key: "basic", header: "Basic earned", align: "right", className: "tabular-nums", cell: (r) => money(r.processed ? r.processed.basic_earned : r.total_basic_earned) },
    { key: "amount", header: "13th month", align: "right", className: "tabular-nums font-semibold", sortValue: (r) => Number(r.processed ? r.processed.amount : r.amount), cell: (r) => money(r.processed ? Number(r.processed.amount) : r.amount) },
    {
      key: "status",
      header: "Status",
      cell: (r) => (r.processed ? (
        <div className="space-y-1">
          <StatusBadge tone="success">Processed</StatusBadge>
          <p className="text-xs text-muted-foreground">{dateTime(r.processed.processed_at)}{r.processed.processed_by_name ? ` · ${r.processed.processed_by_name}` : ""}</p>
        </div>
      ) : <StatusBadge tone="gold">Not processed</StatusBadge>),
    },
  ];

  return (
    <>
      {data ? (
        <Alert className="border-info/40 bg-info/8">
          <InfoIcon aria-hidden="true" />
          <AlertDescription>
            <p><strong className="text-foreground">{data.year}:</strong> {data.can_process ? "processing is open. Each payout is recorded once and locked." : `figures so far. The 13th month pay is processed in December, from ${dateLabel(data.process_opens)}.`}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Employees" value={rows.length} hint={data ? `Year ${data.year}` : "This year"} icon={UsersIcon} loading={state.loading && !data} />
        <StatCard label="Total 13th month" value={moneyCompact(data?.total_amount || 0)} hint="Computed from Final payslips" icon={WalletIcon} tone="gold" loading={state.loading && !data} />
        <StatCard label="Processed" value={`${processed} / ${rows.length}`} hint="Recorded payouts" icon={CheckCircle2Icon} tone="success" loading={state.loading && !data} />
      </section>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Employees</CardTitle>
          <CardDescription>Only unpaid absences (Absent days and Leave Without Pay) reduce it. Paid leave, late, undertime, incentives and overtime do not.</CardDescription>
          <CardAction className="flex gap-2">
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger size="sm" className="w-28" aria-label="Year"><SelectValue /></SelectTrigger>
              <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTable
            columns={columns}
            rows={rows}
            loading={state.loading && !data}
            error={state.error}
            onRetry={load}
            pageSize={15}
            searchPlaceholder="Search employee…"
            empty={{ title: "No employees found", icon: CalendarIcon }}
            caption="13th month pay"
            minWidth={760}
          />
          <Button className="w-full" size="lg" onClick={processAll} disabled={busy || !data?.can_process || processed === rows.length} title={data?.can_process ? "" : `Opens ${dateLabel(data?.process_opens)}`}>
            {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Process 13th month pay →
          </Button>
          {feedback.text ? <p role="status" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
        </CardContent>
      </Card>
      {confirmDialog}
    </>
  );
}
