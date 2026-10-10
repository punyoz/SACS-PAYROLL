"use client";

import * as React from "react";
import { BanknoteIcon, CoinsIcon, HandCoinsIcon, InfoIcon, Loader2Icon, RefreshCwIcon, WalletIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel, money, moneyCompact } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { useAccountant } from "./accountant-data";
import { EmployeeSelect, HowItWorks } from "./incentives-page";

/*
 * Cash Advances (loadCashAdvances / submitCashAdvance / setCashAdvanceStatus,
 * accountant.js): GET ?view=cash_advances, POST add_cash_advance, PATCH
 * set_cash_advance_status. Repayments are read from Final payslips.
 */

const DEDUCT_ON = { both: "Every payslip", first: "1–15 only", second: "16–end only" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The next four 16–end payslips (cashAdvancePeriodOptions). */
function startOptions() {
  const [year, month] = manilaDateKey().split("-").map(Number);
  return Array.from({ length: 4 }, (_, offset) => {
    const index = (month - 1) + offset;
    const y = year + Math.floor(index / 12);
    const m = (index % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { value: `${y}-${String(m).padStart(2, "0")}-16`, label: `${MONTHS[m - 1]} 16-${last}, ${y}` };
  });
}

function statusBadge(a) {
  if (a.status === "cancelled") return <StatusBadge tone="danger">Cancelled</StatusBadge>;
  if (a.fully_paid) return <StatusBadge tone="success">Repaid</StatusBadge>;
  if (a.status === "on_hold") return <StatusBadge tone="gold">On hold</StatusBadge>;
  return <StatusBadge tone="info">Active</StatusBadge>;
}

// One loan system (docs/payroll-schedule-loans-awol.md decision 5): new cash
// advances are Loans; this page keeps the earlier ones as history.
const NEW_ADVANCES_IN_LOANS = true;

export function CashAdvancesPage({ refreshKey, onNavigate }) {
  const { data: payroll, load: reloadPayroll } = useAccountant();
  const { notify } = usePortalSession();
  const employees = React.useMemo(() => payroll?.employees || [], [payroll]);
  const starts = React.useMemo(startOptions, []);
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [filter, setFilter] = React.useState("open");
  const [form, setForm] = React.useState({ employee: "", principal: "", installment: "", granted: manilaDateKey(), deductOn: "second", start: starts[0].value, description: "" });
  const [errors, setErrors] = React.useState({});
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(null);
  const [cancelReason, setCancelReason] = React.useState("");
  const [cancelError, setCancelError] = React.useState("");

  React.useEffect(() => {
    if (!form.employee && employees[0]) setForm((c) => ({ ...c, employee: employees[0].id }));
  }, [employees, form.employee]);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/accountant/payroll?view=cash_advances");
      if (!data.available) throw new Error(data.error || "Cash advances are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message || "Unable to load cash advances.", data: null });
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  async function submit(event) {
    event.preventDefault();
    const next = {
      employee: !form.employee ? "Select an employee." : "",
      principal: !(Number(form.principal) > 0) ? "Enter the amount advanced." : "",
      installment: !(Number(form.installment) > 0) ? "Enter the amount deducted per payslip." : Number(form.installment) > Number(form.principal) ? "It cannot be more than the amount advanced." : "",
      granted: !form.granted ? "Choose the date it was given." : "",
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    setFeedback({ text: "Saving…", ok: true });
    try {
      const data = await fetchJson("/api/accountant/payroll", jsonBody("POST", {
        action: "add_cash_advance",
        employee_id: form.employee,
        principal: form.principal,
        installment_amount: form.installment,
        date_granted: form.granted,
        deduct_on: form.deductOn || "both",
        start_date: form.start,
        description: form.description.trim(),
      }));
      setFeedback({ text: `Added — deducted from ${data.start_period} on.`, ok: true });
      setForm((c) => ({ ...c, principal: "", installment: "", description: "" }));
      notify("Cash Advance Added", `Deducted from the ${data.start_period} payslip on.`, "success");
      await load();
      reloadPayroll();
    } catch (error) {
      setFeedback({ text: error.message || "Unable to add the cash advance.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(advance, status, reason = "") {
    try {
      await fetchJson("/api/accountant/payroll", jsonBody("PATCH", { action: "set_cash_advance_status", advance_id: advance.id, status, reason }));
      const words = { active: "Resumed", on_hold: "On Hold", cancelled: "Cancelled" };
      notify(`Cash Advance ${words[status] || "Updated"}`, status === "on_hold" ? "It is skipped until resumed." : "Payroll will use the change on the next payslip computed.", "info");
      setCancelling(null);
      await load();
      reloadPayroll();
    } catch (error) {
      notify("Not Updated", error.message, "error");
    }
  }

  async function confirmCancel() {
    if (cancelReason.trim().length < 5) { setCancelError("Give a reason (at least 5 characters)."); return; }
    await setStatus(cancelling, "cancelled", cancelReason.trim());
  }

  const summary = state.data?.summary || {};
  const rows = (state.data?.advances || []).filter((a) => {
    if (filter === "all") return true;
    if (filter === "cancelled") return a.status === "cancelled";
    if (filter === "repaid") return a.status !== "cancelled" && a.fully_paid;
    return a.status !== "cancelled" && !a.fully_paid;
  });
  const first = state.loading && !state.data;

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, cell: (a) => <div><p className="font-medium">{a.employee_name}</p><p className="text-xs text-muted-foreground">{a.employee_code || ""}{a.description ? ` · ${a.description}` : ""}</p></div>, searchValue: (a) => `${a.employee_name} ${a.employee_code || ""} ${a.description || ""}` },
    { key: "date_granted", header: "Date given", sortable: true, className: "whitespace-nowrap", cell: (a) => dateLabel(a.date_granted) },
    { key: "principal", header: "Amount", align: "right", className: "tabular-nums", sortValue: (a) => Number(a.principal || 0), cell: (a) => money(a.principal) },
    { key: "installment", header: "Per payslip", align: "right", className: "tabular-nums", cell: (a) => money(a.installment_amount) },
    { key: "deduct", header: "Deduct from", cell: (a) => <div><p>{DEDUCT_ON[a.deduct_on] || a.deduct_on}</p><p className="text-xs text-muted-foreground">from {dateLabel(a.start_date)}</p></div> },
    { key: "repaid", header: "Repaid", align: "right", className: "tabular-nums", cell: (a) => <span title={(a.payments || []).map((p) => `${p.pay_period}: ${money(p.amount)}`).join("\n")}>{money(a.repaid)}</span> },
    { key: "balance", header: "Balance", align: "right", className: "tabular-nums font-semibold", sortValue: (a) => Number(a.balance || 0), cell: (a) => money(a.balance) },
    { key: "status", header: "Status", cell: (a) => <div className="space-y-1">{statusBadge(a)}{a.status_reason ? <p className="max-w-48 text-xs whitespace-normal text-muted-foreground">{a.status_reason}</p> : null}</div> },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (a) => (a.status !== "cancelled" && !a.fully_paid ? (
        <div className="flex justify-end gap-1.5">
          <Button variant="outline" size="sm" onClick={() => setStatus(a, a.status === "on_hold" ? "active" : "on_hold")}>{a.status === "on_hold" ? "Resume" : "Hold"}</Button>
          <Button variant="outline" size="sm" className="text-destructive" onClick={() => { setCancelling(a); setCancelReason(""); setCancelError(""); }}>Cancel</Button>
        </div>
      ) : null),
    },
  ];

  const field = (key, label, input) => (
    <div className="space-y-1.5">
      <Label htmlFor={`ac-ca-${key}`}>{label}</Label>
      {input}
      {errors[key] ? <p className="text-sm text-destructive">{errors[key]}</p> : null}
    </div>
  );

  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Open advances" value={summary.open_count || 0} hint="Active or on hold, not yet repaid" icon={HandCoinsIcon} tone="info" loading={first} />
        <StatCard label="Outstanding balance" value={moneyCompact(summary.outstanding || 0)} hint="Still to be deducted" icon={WalletIcon} tone="danger" loading={first} />
        <StatCard label="Repaid" value={moneyCompact(summary.repaid || 0)} hint="From Final payslips" icon={CoinsIcon} tone="success" loading={first} />
      </section>

      {NEW_ADVANCES_IN_LOANS ? (
        <Alert className="border-info/40 bg-info/8">
          <InfoIcon aria-hidden="true" />
          <AlertDescription>
            <p><strong className="text-foreground">New cash advances are recorded under Loans</strong> (one loan system). This page keeps the cash advances recorded before, with their repayments.</p>
            {onNavigate ? <Button variant="outline" size="sm" className="mt-2" onClick={() => onNavigate("ac-loans")}>Open Loans →</Button> : null}
          </AlertDescription>
        </Alert>
      ) : (
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card className="shadow-xs">
          <CardHeader><CardTitle>Add cash advance</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={submit} noValidate className="grid items-start gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">{field("employee", "Employee", <EmployeeSelect id="ac-ca-employee" value={form.employee} onChange={(v) => setForm((c) => ({ ...c, employee: v }))} employees={employees} invalid={Boolean(errors.employee)} />)}</div>
              {field("principal", "Amount advanced (₱)", <Input id="ac-ca-principal" type="number" min="0" max="9999999.99" step="0.01" inputMode="decimal" value={form.principal} onChange={(e) => setForm((c) => ({ ...c, principal: e.target.value }))} aria-invalid={Boolean(errors.principal) || undefined} />)}
              {field("installment", "Deduct per payslip (₱)", <Input id="ac-ca-installment" type="number" min="0" max="9999999.99" step="0.01" inputMode="decimal" value={form.installment} onChange={(e) => setForm((c) => ({ ...c, installment: e.target.value }))} aria-invalid={Boolean(errors.installment) || undefined} />)}
              {field("granted", "Date given", <DatePicker id="ac-ca-granted" value={form.granted} onChange={(v) => setForm((c) => ({ ...c, granted: v }))} aria-invalid={Boolean(errors.granted) || undefined} />)}
              {field("deduct-on", "Deduct from", (
                <Select value={form.deductOn} onValueChange={(v) => setForm((c) => ({ ...c, deductOn: v }))}>
                  <SelectTrigger id="ac-ca-deduct-on" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="second">16–end payslip</SelectItem></SelectContent>
                </Select>
              ))}
              <div className="sm:col-span-2">{field("start", "First payslip to deduct", (
                <Select value={form.start} onValueChange={(v) => setForm((c) => ({ ...c, start: v }))}>
                  <SelectTrigger id="ac-ca-start" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{starts.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
                </Select>
              ))}</div>
              <div className="sm:col-span-2">{field("description", <>Description <span className="font-normal text-muted-foreground">(optional)</span></>, <Input id="ac-ca-description" maxLength={200} placeholder="e.g. Emergency cash advance" value={form.description} onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))} />)}</div>
              <Button type="submit" className="sm:col-span-2" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Add cash advance →</Button>
              {feedback.text ? <p role="status" className={cn("text-sm sm:col-span-2", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
            </form>
          </CardContent>
        </Card>
        <HowItWorks
          title="How it is deducted"
          rows={[["1–15 payslip", "Nothing deducted"], ["16–end payslip", "− installment"], ["Last installment", "Only the balance left"], ["Net pay too low", "Deducts what it can; the rest stays"], ["On hold", "Skipped until resumed"], ["Repaid", "From Final payslips only"]]}
          note="The deduction shows on the payslip and in the Cash Advance column of the Payroll Sheet report. A Draft payslip repays nothing until it is Final."
        />
      </div>
      )}

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Advances</CardTitle>
          <CardAction className="flex gap-2">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger size="sm" className="w-32" aria-label="Show"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="open">Open</SelectItem><SelectItem value="all">All</SelectItem><SelectItem value="repaid">Repaid</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem></SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={rows}
            loading={first}
            error={state.error}
            onRetry={load}
            pageSize={15}
            searchPlaceholder="Search employee or description…"
            empty={{ title: "No cash advances here", icon: BanknoteIcon }}
            caption="Cash advances"
            minWidth={1100}
          />
        </CardContent>
      </Card>

      <Dialog open={Boolean(cancelling)} onOpenChange={(open) => { if (!open) setCancelling(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this cash advance?</DialogTitle>
            <DialogDescription>Nothing more will be deducted. What was already repaid stays on the payslips.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ac-ca-cancel-reason">Reason for cancelling</Label>
            <Input id="ac-ca-cancel-reason" maxLength={300} placeholder="Required, at least 5 characters" value={cancelReason} onChange={(e) => { setCancelReason(e.target.value); setCancelError(""); }} aria-invalid={Boolean(cancelError) || undefined} autoFocus />
            {cancelError ? <p className="text-sm text-destructive">{cancelError}</p> : null}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setCancelling(null)}>Keep advance</Button>
            <Button variant="destructive" onClick={confirmCancel}>Cancel advance</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
