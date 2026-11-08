"use client";

import * as React from "react";
import { CalendarIcon, CheckCircle2Icon, InfoIcon, Loader2Icon, RefreshCwIcon, UsersIcon, WalletIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
      setState((c) => ({ loading: false, error: error.message || "Unable to load the 13th month pay.", data: c.data }));
    }
  }, [year]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const rows = data?.rows || [];
  const processed = rows.filter((r) => r.processed).length;
  // What a December run would pay now (separated employees are paid in Final Pay).
  const pending = rows.filter((r) => !r.processed && !r.separated_on && r.amount > 0);
  const pendingTotal = pending.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const [preview, setPreview] = React.useState(false);
  const blockedReason = !data ? "" : !data.available ? (data.error || "13th month pay is not set up yet.")
    : !data.can_process ? `Opens ${dateLabel(data.process_opens)}: the ${data.year} 13th month pay is generated in December. The figures below are the year so far.`
      : !pending.length ? "Nothing left to generate: everyone is processed, paid in Final Pay, or earned no basic pay." : "";

  async function processAll() {
    if (!data?.can_process || !pending.length) return;
    setPreview(false);
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
    { key: "employee_name", header: "Employee", sortable: true, cell: (r) => (
      <div>
        <p className="font-medium">{r.employee_name}</p>
        <p className="text-xs text-muted-foreground">{r.employee_code || ""} · {r.employee_type || ""}</p>
        {r.date_hired && String(r.date_hired).slice(0, 4) === String(data?.year) ? <p className="text-xs text-info">Joined {dateLabel(String(r.date_hired).slice(0, 10))}</p> : null}
        {r.separated_on ? <p className="text-xs text-warning">Separated {dateLabel(r.separated_on)}</p> : null}
      </div>
    ), searchValue: (r) => `${r.employee_name} ${r.employee_code || ""}` },
    { key: "months", header: "Months covered", className: "text-xs whitespace-nowrap", cell: (r) => (r.months_covered?.length ? `${r.months_covered.length} (${monthName(r.months_covered[0])}–${monthName(r.months_covered[r.months_covered.length - 1])})` : "—") },
    { key: "periods", header: "Payslips", align: "right", className: "tabular-nums", cell: (r) => (r.periods || []).length },
    { key: "basic", header: "Basic earned", align: "right", className: "tabular-nums", cell: (r) => money(r.processed ? r.processed.basic_earned : r.total_basic_earned) },
    { key: "amount", header: "13th month", align: "right", className: "tabular-nums font-semibold", sortValue: (r) => Number(r.processed ? r.processed.amount : r.amount), cell: (r) => money(r.processed ? Number(r.processed.amount) : r.amount) },
    {
      key: "status",
      header: "Status",
      cell: (r) => (r.processed ? (
        <div className="space-y-1">
          <StatusBadge tone="success">{r.paid_in_final_pay ? "Paid in Final Pay" : "Processed"}</StatusBadge>
          <p className="text-xs text-muted-foreground">{dateTime(r.processed.processed_at)}{r.processed.processed_by_name ? ` · ${r.processed.processed_by_name}` : ""}</p>
        </div>
      ) : r.separated_on ? (
        <div className="space-y-1">
          <StatusBadge tone="info">Pro-rated: paid in Final Pay</StatusBadge>
          <p className="max-w-52 text-xs whitespace-normal text-muted-foreground">Basic earned up to the separation ÷ 12. Generate it on the Final Pay page.</p>
        </div>
      ) : <StatusBadge tone="gold">Not processed</StatusBadge>),
    },
  ];

  return (
    <>
      {data ? (
        <Alert className="border-info/40 bg-info/8" data-testid="thirteenth-period">
          <InfoIcon aria-hidden="true" />
          <AlertDescription className="space-y-1">
            <p><strong className="text-foreground">Year {data.year}.</strong> Covers {data.covers?.label || `${data.year}`}.</p>
            <p>13th month = {data.formula || "total basic salary earned in the year ÷ 12"}. Included: basic pay actually earned on each Final payslip (unpaid absences and leave without pay already taken off). Not included: overtime, incentives, holiday pay, allowances, the 13th month itself.</p>
            <p>{data.can_process ? "Generating is open. Each payout is recorded once and locked." : `Generating opens ${dateLabel(data.process_opens)}; until then these are the figures so far.`} Employees who left this year are paid a pro-rated 13th month in Final Pay, never twice.</p>
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
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p role="status" className="text-sm text-muted-foreground" data-testid="thirteenth-generate-note">
              {blockedReason || `${pending.length} employee${pending.length === 1 ? "" : "s"} ready · ${money(pendingTotal)} in all.`}
            </p>
            <Button onClick={() => setPreview(true)} disabled={busy || Boolean(blockedReason)} data-testid="thirteenth-generate">
              {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <WalletIcon aria-hidden="true" />}Generate 13th month pay
            </Button>
          </div>
          {feedback.text ? <p role="status" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
        </CardContent>
      </Card>
      <Dialog open={preview} onOpenChange={(o) => { if (!busy) setPreview(o); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" data-testid="thirteenth-preview">
          <DialogHeader>
            <DialogTitle>Preview: {data?.year} 13th month pay</DialogTitle>
            <DialogDescription>{pending.length} employee{pending.length === 1 ? "" : "s"}, {money(pendingTotal)} in all. Check the figures, then save. Each payout is recorded once and locked.</DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground"><tr>
                <th className="px-3 py-2 text-left">Employee</th><th className="px-3 py-2 text-left">Months</th>
                <th className="px-3 py-2 text-right">Basic earned</th><th className="px-3 py-2 text-right">13th month (÷ 12)</th>
              </tr></thead>
              <tbody>{pending.map((r) => (
                <tr key={r.employee_id} className="border-t">
                  <td className="px-3 py-1.5">{r.employee_name}</td>
                  <td className="px-3 py-1.5 text-xs">{r.months_covered?.length || 0}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{money(r.total_basic_earned)}</td>
                  <td className="px-3 py-1.5 text-right font-medium tabular-nums">{money(r.amount)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">Included: basic pay earned on Final payslips. Excluded: overtime, incentives, holiday pay, allowances, and employees who left this year (paid in Final Pay).</p>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setPreview(false)} disabled={busy}>Back</Button>
            <Button onClick={processAll} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save 13th month pay</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthName(key) {
  return MONTHS[Number(String(key).slice(5, 7)) - 1] || key;
}
