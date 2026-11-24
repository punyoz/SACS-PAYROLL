"use client";

import * as React from "react";
import { CalendarClockIcon, InfoIcon, Loader2Icon, RefreshCwIcon, StarIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel, money, shortDate } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { useAccountant } from "./accountant-data";
import { AdjustmentApprovalsPanel } from "@/components/portal/adjustment-approvals";
import { INCENTIVE_MAX } from "@/lib/input-limits";
import { SearchableSelect } from "@/components/portal/searchable-select";
import { Checkbox } from "@/components/ui/checkbox";

/*
 * Incentives & Overload (loadMonthlyItems / submitMonthlyItem /
 * archiveMonthlyItem, accountant.js): GET ?view=monthly_items&month=,
 * POST add_monthly_item, PATCH archive_monthly_item.
 */

export function HowItWorks({ title, rows, note }) {
  return (
    <Card className="shadow-xs">
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <dl className="divide-y rounded-lg border">
          {rows.map(([a, b]) => (
            <div key={a} className="flex items-baseline justify-between gap-4 px-3 py-2 text-sm"><dt className="text-muted-foreground">{a}</dt><dd className="text-right font-medium">{b}</dd></div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

// Additional Pay kinds (2026-11-23): Honorarium, Bonus, Adjustment next to Incentive and Overload.
const ITEM_KINDS = { incentive: "Incentive (₱)", overload: "Overload (hours)", honorarium: "Honorarium (₱)", bonus: "Bonus (₱)", adjustment: "Adjustment (+/− ₱)" };
const ITEM_LABEL = (kind) => ({ overload: "Overload", honorarium: "Honorarium", bonus: "Bonus", adjustment: "Adjustment" }[kind] || "Incentive");
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11" -> "November 2026". */
export function monthLabel(key) {
  const [y, m] = String(key || "").split("-").map(Number);
  return y && m ? `${MONTH_NAMES[m - 1]} ${y}` : String(key || "");
}

/**
 * The month whose 2nd-half payroll pays an item dated `dateKey` and filed on
 * `filedKey` (payrollMonthFor, src/lib/payroll/semi-monthly.js): an item
 * dated or filed after its month's cutoff (the day before the 2nd-half payslip
 * day; cutoffs from GET ?view=monthly_items) moves to next month.
 */
export function deferredPayrollMonth(dateKey, filedKey, cutoffs = {}) {
  const anchor = filedKey && filedKey > dateKey ? filedKey : dateKey;
  const [y, m, d] = String(anchor || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const monthKey = `${y}-${String(m).padStart(2, "0")}`;
  const cutoff = cutoffs?.[monthKey]?.cutoff_date;
  if (!cutoff || anchor <= cutoff) return monthKey;
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The badge a deferred item carries everywhere it is listed. */
export function DeferredBadge({ item }) {
  return <StatusBadge tone="warning">{`Deferred to next month's payroll [${item.payroll_month_label}]`}</StatusBadge>;
}

/**
 * Process Payroll's notice: the incentives and overload dated in `monthKey`
 * that were filed after its cutoff, so they are paid next month (by
 * design), listed so nothing seems to have gone missing.
 */
export function DeferredIncentivesNotice({ monthKey }) {
  const [state, setState] = React.useState({ items: [], cutoff: null });
  React.useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(String(monthKey || ""))) return undefined;
    let alive = true;
    fetchJson(`/api/accountant/payroll?view=monthly_items&month=${encodeURIComponent(monthKey)}`)
      .then((data) => {
        if (!alive) return;
        setState({ items: (data.items || []).filter((i) => i.moved_to_next_month && String(i.item_date).slice(0, 7) === monthKey), cutoff: data.cutoff || null });
      })
      .catch(() => { /* the notice is informational; the Incentives page shows any error */ });
    return () => { alive = false; };
  }, [monthKey]);
  const { items, cutoff } = state;
  if (!cutoff && !items.length) return null;
  const moved = items.length > 0;
  return (
    <Alert className={moved ? "border-warning/40 bg-warning/5" : "border-info/40 bg-info/8"}>
      <CalendarClockIcon className={moved ? "text-warning" : "text-info"} aria-hidden="true" />
      <AlertDescription>
        {cutoff ? (
          <p><strong className="text-foreground">Incentive &amp; overload cutoff for {monthLabel(monthKey)}: {cutoff.cutoff_label}</strong> (the day before the 2nd-half payslip day, {cutoff.payslip_day_label}). Anything filed after {cutoff.cutoff_label} is paid with {cutoff.next_month_label}&apos;s payroll.</p>
        ) : null}
        {moved ? (
          <>
            <p className="mt-1"><strong className="text-foreground">{items.length} item{items.length === 1 ? "" : "s"} dated in {monthLabel(monthKey)} {items.length === 1 ? "was" : "were"} filed after the cutoff and moved to {items[0].payroll_month_label}&apos;s payroll.</strong> This is intended: they are not missing from this payroll. See Incentives &amp; Overload → Deferred incentives.</p>
            <ul className="mt-1 list-disc pl-5 text-xs">
              {items.slice(0, 6).map((i) => <li key={i.id}>{i.employee_name}: {i.kind === "overload" ? `${i.hours} h overload` : money(i.amount)} ({dateLabel(i.item_date)}) → {i.payroll_month_label}</li>)}
              {items.length > 6 ? <li>and {items.length - 6} more</li> : null}
            </ul>
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function EmployeeSelect({ id, value, onChange, employees, invalid }) {
  return (
    <SearchableSelect id={id} value={value} onValueChange={onChange} disabled={!employees.length} label="Employee"
      className="w-full min-w-0 overflow-hidden [contain:inline-size]" aria-invalid={invalid || undefined}
      placeholder={employees.length ? "Select employee" : "No employees found"} searchPlaceholder="Search name or employee ID…"
      options={employees.map((e) => ({ value: e.id, label: `${e.full_name} — ${e.employee_id}` }))} />
  );
}

export function IncentivesPage({ refreshKey }) {
  const { data: payroll, load: reloadPayroll } = useAccountant();
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const employees = React.useMemo(() => payroll?.employees || [], [payroll]);
  const [month, setMonth] = React.useState(() => manilaDateKey().slice(0, 7));
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [form, setForm] = React.useState({ employee: "", kind: "incentive", date: manilaDateKey(), amount: "", hours: "", description: "", reason: "", nonTaxable: false, also: [] });
  const [errors, setErrors] = React.useState({});
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!form.employee && employees[0]) setForm((c) => ({ ...c, employee: employees[0].id }));
  }, [employees, form.employee]);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/accountant/payroll?view=monthly_items&month=${encodeURIComponent(month)}`);
      if (!data.available) throw new Error(data.error || "Incentives are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState((c) => ({ loading: false, error: error.message || "Unable to load incentives.", data: c.data }));
    }
  }, [month]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  async function submit(event) {
    event.preventDefault();
    const next = {
      employee: !form.employee ? "Select an employee." : "",
      date: !form.date ? "Choose the date it is for." : "",
      amount: form.kind === "adjustment" ? (!Number(form.amount) ? "Enter the adjustment (below 0 to deduct)." : "")
        : form.kind !== "overload" && !(Number(form.amount) > 0) ? "Enter an amount greater than 0." : "",
      reason: form.kind === "adjustment" && form.reason.trim().length < 5 ? "Give the reason (at least 5 characters)." : "",
      hours: form.kind === "overload" && !(Number(form.hours) > 0) ? "Enter the overload hours." : "",
      description: !form.description.trim() ? "Describe what it is for." : "",
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    setFeedback({ text: "Saving…", ok: true });
    try {
      const data = await fetchJson("/api/accountant/payroll", jsonBody("POST", {
        action: "add_monthly_item",
        employee_id: form.employee,
        // The same item for more employees (one item each; 2026-11-23).
        employee_ids: form.also.length ? [form.employee, ...form.also.filter((id) => id !== form.employee)] : undefined,
        kind: form.kind,
        item_date: form.date,
        description: form.description.trim(),
        amount: form.kind !== "overload" ? form.amount : undefined,
        hours: form.kind === "overload" ? form.hours : undefined,
        reason: form.kind === "adjustment" ? form.reason.trim() : undefined,
        non_taxable: form.kind === "adjustment" ? form.nonTaxable : undefined,
      }));
      setFeedback({ text: data.deferred ? `Sent for HR approval — deferred to next month's payroll [${data.payroll_month_label}] (filed after the cutoff).` : `Sent for HR approval — counted in the ${data.payroll_month_label} payroll once HR approves it.`, ok: true });
      setForm((c) => ({ ...c, amount: "", hours: "", description: "", reason: "", nonTaxable: false, also: [] }));
      notify("Sent for HR Approval", `Paid in the ${data.payroll_month_label} 2nd half payroll once HR approves it.`, "success");
      await load();
      reloadPayroll();
    } catch (error) {
      setFeedback({ text: error.message || "Unable to add it.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function remove(item) {
    const ok = await confirm({ title: "Remove this item from payroll?", description: "It will no longer be paid. The record is kept in the history.", confirmLabel: "Remove", destructive: true });
    if (!ok) return;
    try {
      await fetchJson("/api/accountant/payroll", jsonBody("PATCH", { action: "archive_monthly_item", item_id: item.id }));
      notify("Removed", "The item was removed from payroll.", "info");
      await load();
      reloadPayroll();
    } catch (error) {
      notify("Not Removed", error.message, "error");
    }
  }

  const info = state.data;
  // Today is the filing date: an item for a month whose cutoff has passed
  // is paid with the next month (intended; the form says so before saving).
  const deferTo = form.date ? deferredPayrollMonth(form.date, manilaDateKey(), info?.cutoffs) : null;
  const formCutoff = form.date ? info?.cutoffs?.[form.date.slice(0, 7)] || null : null;
  // Deferred until paid or cancelled: a rejected item is not waiting for any payroll.
  const deferred = (info?.items || []).filter((i) => i.moved_to_next_month && i.approval_status !== "rejected");
  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, cell: (i) => <div><p className="font-medium">{i.employee_name}</p><p className="text-xs text-muted-foreground">{i.employee_code || ""}</p></div>, searchValue: (i) => `${i.employee_name} ${i.employee_code || ""}` },
    { key: "item_date", header: "Date", sortable: true, className: "whitespace-nowrap tabular-nums", cell: (i) => dateLabel(i.item_date) },
    { key: "kind", header: "Type", cell: (i) => <StatusBadge tone={i.kind === "overload" ? "info" : i.kind === "adjustment" ? "warning" : "success"}>{ITEM_LABEL(i.kind)}</StatusBadge> },
    { key: "description", header: "Description", className: "max-w-64 whitespace-normal", searchValue: (i) => i.description },
    { key: "amount", header: "Amount / hours", align: "right", className: "tabular-nums", cell: (i) => (i.kind === "overload" ? `${i.hours} h` : money(i.amount)) },
    // HR approval (20261027020000): only an approved item is paid.
    {
      key: "approval", header: "HR approval",
      cell: (i) => <div className="max-w-52 space-y-1 whitespace-normal"><StatusBadge tone={i.approval_tone || "success"}>{i.approval_label || "Approved by HR"}</StatusBadge>{i.decision_note ? <p className="text-xs text-muted-foreground">{i.decided_by_name ? `${i.decided_by_name}: ` : ""}{i.decision_note}</p> : null}</div>,
    },
    { key: "month", header: "Counted in", cell: (i) => (i.approval_status === "rejected" ? <span className="text-muted-foreground">Not paid</span> : i.moved_to_next_month ? <DeferredBadge item={i} /> : <p>{i.payroll_month_label}</p>) },
    { key: "by", header: "Added by", className: "text-xs text-muted-foreground", cell: (i) => i.created_by_name || "" },
    { key: "remove", header: <span className="sr-only">Remove</span>, align: "right", cell: (i) => <Button variant="outline" size="sm" onClick={() => remove(i)}>Remove</Button> },
  ];

  return (
    <>
      {info ? (
        <Alert className="border-info/40 bg-info/8">
          <InfoIcon aria-hidden="true" />
          <AlertDescription><p><strong className="text-foreground">{info.month?.label || ""}:</strong> attendance {shortDate(info.window?.start_key)} – {dateLabel(info.window?.end_key)}. {info.cutoff ? <>Incentive &amp; overload cutoff: <strong className="text-foreground">{info.cutoff.cutoff_label}</strong> (the day before the 2nd-half payslip day, {info.cutoff.payslip_day_label}). Anything filed after it is added to {info.cutoff.next_month_label}&apos;s payroll (intended); it is marked &quot;Deferred to next month&apos;s payroll [{info.cutoff.next_month_label}]&quot; and listed under Deferred incentives below.</> : "Locked at month end."}</p></AlertDescription>
        </Alert>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card className="shadow-xs">
          <CardHeader><CardTitle>Add additional pay</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={submit} noValidate className="grid items-start gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ac-item-employee">Employee</Label>
                <EmployeeSelect id="ac-item-employee" value={form.employee} onChange={(v) => setForm((c) => ({ ...c, employee: v }))} employees={employees} invalid={Boolean(errors.employee)} />
                {errors.employee ? <p className="text-sm text-destructive">{errors.employee}</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ac-item-kind">Type</Label>
                <Select value={form.kind} onValueChange={(v) => setForm((c) => ({ ...c, kind: v }))}>
                  <SelectTrigger id="ac-item-kind" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(ITEM_KINDS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ac-item-date">Date it is for</Label>
                <DatePicker id="ac-item-date" value={form.date} onChange={(v) => setForm((c) => ({ ...c, date: v < "2026-10-01" ? "2026-10-01" : v }))} aria-invalid={Boolean(errors.date) || undefined} />
                {errors.date ? <p className="text-sm text-destructive">{errors.date}</p> : null}
              {formCutoff ? (
                deferTo && deferTo !== form.date.slice(0, 7) ? (
                  <p className="text-xs text-warning" role="status">The {monthLabel(form.date.slice(0, 7))} cutoff was {formCutoff.cutoff_label}: filed today, this item is deferred to next month&apos;s payroll [{monthLabel(deferTo)}].</p>
                ) : (
                  <p className="text-xs text-muted-foreground" role="status">Cutoff for {monthLabel(form.date.slice(0, 7))}: {formCutoff.cutoff_label}. Filed today, it is paid with the {monthLabel(deferTo || form.date.slice(0, 7))} payroll.</p>
                )
              ) : null}
              </div>
              {form.kind !== "overload" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="ac-item-amount">Amount (₱){form.kind === "adjustment" ? <span className="font-normal text-muted-foreground"> (below 0 to deduct)</span> : null}</Label>
                  <Input id="ac-item-amount" type="number" min={form.kind === "adjustment" ? -INCENTIVE_MAX : 0} max={INCENTIVE_MAX} step="0.01" inputMode="decimal" value={form.amount} onChange={(e) => setForm((c) => ({ ...c, amount: e.target.value }))} aria-invalid={Boolean(errors.amount) || undefined} />
                  {errors.amount ? <p className="text-sm text-destructive">{errors.amount}</p> : null}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="ac-item-hours">Overload hours <span className="font-normal text-muted-foreground">(hourly rate × hours)</span></Label>
                  <Input id="ac-item-hours" type="number" min="0" max="744" step="0.25" inputMode="decimal" value={form.hours} onChange={(e) => setForm((c) => ({ ...c, hours: e.target.value }))} aria-invalid={Boolean(errors.hours) || undefined} />
                  {errors.hours ? <p className="text-sm text-destructive">{errors.hours}</p> : null}
                </div>
              )}
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="ac-item-description">Description</Label>
                <Input id="ac-item-description" maxLength={200} placeholder="e.g. Coaching incentive, extra Math class" value={form.description} onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))} aria-invalid={Boolean(errors.description) || undefined} />
                {errors.description ? <p className="text-sm text-destructive">{errors.description}</p> : null}
              </div>
              {form.kind === "adjustment" ? (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="ac-item-reason">Reason</Label>
                  <Input id="ac-item-reason" maxLength={300} placeholder="e.g. Underpaid overtime on Nov 5" value={form.reason} onChange={(e) => setForm((c) => ({ ...c, reason: e.target.value }))} aria-invalid={Boolean(errors.reason) || undefined} />
                  {errors.reason ? <p className="text-sm text-destructive">{errors.reason}</p> : null}
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.nonTaxable} onCheckedChange={(v) => setForm((c) => ({ ...c, nonTaxable: v === true }))} />It corrects a non-taxable item (not taxed)</label>
                </div>
              ) : null}
              {form.kind !== "overload" ? (
                <details className="space-y-1.5 sm:col-span-2" data-testid="also-for">
                  <summary className="cursor-pointer text-sm font-medium">Also for other employees{form.also.length ? ` (${form.also.length})` : ""}</summary>
                  <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                    {employees.filter((e) => e.id !== form.employee).map((e) => (
                      <label key={e.id} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={form.also.includes(e.id)} onCheckedChange={(on) => setForm((c) => ({ ...c, also: on ? [...c.also, e.id] : c.also.filter((id) => id !== e.id) }))} aria-label={`Also for ${e.full_name}`} />
                        {e.full_name}
                      </label>
                    ))}
                  </div>
                </details>
              ) : null}
              <Button type="submit" className="sm:col-span-2" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Send for HR approval →</Button>
              {feedback.text ? <p role="status" className={cn("text-sm sm:col-span-2", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
            </form>
          </CardContent>
        </Card>
        <HowItWorks
          title="How it is paid"
          rows={[["1st half (1–15)", "Monthly salary ÷ 2, no deductions"], ["2nd half (16–end)", "Whole month settled"], ["Incentive", "+ amount"], ["Overload", "+ hourly rate × hours"], ["Honorarium", "+ amount, taxable"], ["Bonus", "+ amount; tax-free with the 13th month up to ₱90,000 a year"], ["Adjustment", "+ or −, with a reason; taxable unless it corrects a non-taxable item"], ["Filed after the cutoff", info?.cutoff ? `${info.cutoff.next_month_label} (cutoff ${info.cutoff.cutoff_label})` : "Next month"]]}
          note="Each is its own line on the payslip and counts toward the month's gross pay. An item already paid on a Final payslip cannot be removed."
        />
      </div>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Items</CardTitle>
          <CardDescription>Incentives and overload counted in the chosen month.</CardDescription>
          <CardAction className="flex gap-2">
            <Input type="month" aria-label="Month" className="h-8 w-40" value={month} onChange={(e) => setMonth(e.target.value || manilaDateKey().slice(0, 7))} />
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={info?.items || []}
            loading={state.loading && !info}
            error={state.error}
            onRetry={load}
           
            searchPlaceholder="Search employee or description…"
            empty={{ title: "No incentives or overload for this month", icon: StarIcon }}
            caption="Incentives and overload"
            minWidth={980}
          />
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CalendarClockIcon className="size-4 text-warning" aria-hidden="true" />Deferred incentives</CardTitle>
          <CardDescription>Items filed after their month&apos;s cutoff (the day before the 2nd-half payslip day), moved to the next month&apos;s payroll: exactly what moved, from which month, and where it is paid.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={[
              { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (i) => i.employee_name },
              { key: "item_date", header: "Dated", sortable: true, className: "whitespace-nowrap tabular-nums", cell: (i) => dateLabel(i.item_date) },
              { key: "created_at", header: "Filed", className: "whitespace-nowrap text-xs", cell: (i) => (i.created_at ? dateLabel(String(manilaDateKey(new Date(i.created_at)))) : "—") },
              { key: "kind", header: "Type", cell: (i) => ITEM_LABEL(i.kind) },
              { key: "amount", header: "Amount / hours", align: "right", className: "tabular-nums", cell: (i) => (i.kind === "overload" ? `${i.hours} h` : money(i.amount)) },
              { key: "from", header: "Moved from", cell: (i) => monthLabel(String(i.item_date).slice(0, 7)) },
              { key: "deferred", header: "Moved to", cell: (i) => <DeferredBadge item={i} /> },
            ]}
            rows={deferred}
            loading={state.loading && !info}
            error={state.error}
            onRetry={load}
            pageSize={10}
            searchPlaceholder="Search employee…"
            empty={{ title: "Nothing deferred for this month", icon: CalendarClockIcon }}
            caption="Deferred incentives"
            minWidth={820}
          />
        </CardContent>
      </Card>
      {/* What HR approved, rejected or has not decided yet (20261027020000). */}
      <AdjustmentApprovalsPanel refreshKey={refreshKey} />
      {confirmDialog}
    </>
  );
}
