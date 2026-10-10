"use client";

import * as React from "react";
import { GiftIcon, HandCoinsIcon, HourglassIcon, Loader2Icon, RefreshCwIcon, WalletIcon, CoinsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
 * Loans (/api/accountant/loans; docs/payroll-schedule-loans-awol.md §4, §6):
 * salary loans, cash advances, emergency loans, and licensed-teacher subsidy
 * advances. Deducted on the 16–end payslip, partial when pay is short; a
 * subsidy advance is never deducted from salary. Balances are kept by the
 * database from the Final payslips' repayments.
 */

const TYPES = [
  ["salary_loan", "Salary loan"],
  ["cash_advance", "Cash advance"],
  ["emergency_loan", "Emergency loan"],
  ["other", "Other"],
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** This month's and the next five 16–end payslips. */
function startOptions() {
  const [year, month] = manilaDateKey().split("-").map(Number);
  return Array.from({ length: 6 }, (_, offset) => {
    const index = (month - 1) + offset;
    const y = year + Math.floor(index / 12);
    const m = (index % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { value: `${y}-${String(m).padStart(2, "0")}-16`, label: `${MONTHS[m - 1]} 16-${last}, ${y}` };
  });
}

const round2 = (n) => Math.round(n * 100) / 100;
const totalOf = (principal, pct) => round2((Number(principal) || 0) * (1 + (Number(pct) || 0) / 100));
const perPayroll = (total, n) => (Number(n) > 0 ? Math.ceil((total / Number(n)) * 100) / 100 : 0);

function statusBadge(loan) {
  if (loan.awaiting_decision) return <StatusBadge tone="gold">Awaiting decision</StatusBadge>;
  if (loan.status === "paid") return <StatusBadge tone="success">Paid</StatusBadge>;
  if (loan.status === "suspended") return <StatusBadge tone="danger">Suspended</StatusBadge>;
  return <StatusBadge tone="info">Active</StatusBadge>;
}

export function LoansPage({ refreshKey }) {
  const { load: reloadPayroll } = useAccountant();
  const { notify } = usePortalSession();
  const starts = React.useMemo(startOptions, []);
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [filter, setFilter] = React.useState("open");
  const [form, setForm] = React.useState({ employee: "", type: "salary_loan", principal: "", interest: "0", payrolls: "6", amortization: "", granted: manilaDateKey(), start: starts[0].value, description: "", authority: true });
  const [advance, setAdvance] = React.useState({ balance: "", amount: "", granted: manilaDateKey(), description: "" });
  const [errors, setErrors] = React.useState({});
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);
  const [dialog, setDialog] = React.useState(null);   // { kind: suspend | refusal | convert | history, loan }
  const [dialogInput, setDialogInput] = React.useState({ reason: "", payrolls: "3", start: starts[0].value, signed: false });
  const [dialogError, setDialogError] = React.useState("");

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/accountant/loans");
      if (!data.available) throw new Error(data.error || "Loans are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message || "Unable to load loans.", data: null });
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const people = React.useMemo(() => (state.data?.people || []).filter((p) => !p.payroll_hold), [state.data]);
  const balances = React.useMemo(() => state.data?.subsidy_balances || [], [state.data]);
  React.useEffect(() => {
    if (!form.employee && people[0]) setForm((c) => ({ ...c, employee: people[0].id }));
    if (!advance.balance && balances[0]) setAdvance((c) => ({ ...c, balance: balances[0].id }));
  }, [people, balances, form.employee, advance.balance]);

  const total = totalOf(form.principal, form.interest);
  const suggested = perPayroll(total, form.payrolls);

  async function submitLoan(event) {
    event.preventDefault();
    const amort = form.amortization === "" ? suggested : Number(form.amortization);
    const next = {
      employee: !form.employee ? "Select an employee." : "",
      principal: !(Number(form.principal) > 0) ? "Enter the amount lent." : "",
      interest: !(Number(form.interest) >= 0 && Number(form.interest) <= 100) ? "0 to 100%." : "",
      payrolls: !(Number.isInteger(Number(form.payrolls)) && Number(form.payrolls) >= 1 && Number(form.payrolls) <= 120) ? "1 to 120 payrolls." : "",
      amortization: !(amort > 0) ? "Enter the amount per payroll." : amort > total ? "It cannot be more than the total payable." : "",
      granted: !form.granted ? "Choose the date it was given." : "",
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    setFeedback({ text: "Saving…", ok: true });
    try {
      await fetchJson("/api/accountant/loans", jsonBody("POST", {
        action: "create_loan", employee_id: form.employee, loan_type: form.type, principal: form.principal,
        interest_pct: form.interest || 0, number_of_payrolls: Number(form.payrolls), amortization: amort,
        date_granted: form.granted, start_period: form.start, description: form.description.trim(),
        final_pay_authorized: form.authority,
      }));
      const startLabel = starts.find((s) => s.value === form.start)?.label || form.start;
      setFeedback({ text: `Added — ${money(amort)} deducted from the ${startLabel} payslip on.`, ok: true });
      notify("Loan Added", `Deducted on 16–end payslips from ${startLabel}.`, "success");
      setForm((c) => ({ ...c, principal: "", amortization: "", description: "" }));
      await load();
      reloadPayroll();
    } catch (error) {
      setFeedback({ text: error.message || "Unable to add the loan.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function submitAdvance(event) {
    event.preventDefault();
    const balance = balances.find((b) => b.id === advance.balance);
    const next = {
      balance: !balance ? "Select a licensed teacher." : "",
      amount: !(Number(advance.amount) > 0) ? "Enter the advance." : balance && Number(advance.amount) > Number(balance.available) ? `At most ${money(balance.available)}.` : "",
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    setFeedback({ text: "Saving…", ok: true });
    try {
      await fetchJson("/api/accountant/loans", jsonBody("POST", {
        action: "create_subsidy_advance", employee_id: balance.employee_id, subsidy_balance_id: balance.id,
        principal: advance.amount, date_granted: advance.granted, description: advance.description.trim(),
      }));
      setFeedback({ text: `Advance recorded — not deducted from salary; the year-end payout is reduced by ${money(advance.amount)}.`, ok: true });
      notify("Subsidy Advance Recorded", "Release it in cash or by bank transfer.", "success");
      setAdvance((c) => ({ ...c, amount: "", description: "" }));
      await load();
    } catch (error) {
      setFeedback({ text: error.message || "Unable to record the advance.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  function openDialog(kind, loan) {
    setDialog({ kind, loan });
    setDialogInput({ reason: "", payrolls: "3", start: starts[0].value, signed: false });
    setDialogError("");
  }

  async function confirmDialog() {
    const { kind, loan } = dialog;
    try {
      if (kind === "suspend") {
        if (dialogInput.reason.trim().length < 5) { setDialogError("Give a reason (at least 5 characters)."); return; }
        await fetchJson("/api/accountant/loans", jsonBody("PATCH", { action: "set_status", loan_id: loan.id, status: "suspended", reason: dialogInput.reason.trim() }));
        notify("Loan Suspended", "Payroll skips it until resumed.", "info");
      } else if (kind === "refusal") {
        if (dialogInput.reason.trim().length < 5) { setDialogError("Record what the teacher said (at least 5 characters)."); return; }
        await fetchJson("/api/accountant/loans", jsonBody("PATCH", { action: "record_refusal", loan_id: loan.id, reason: dialogInput.reason.trim() }));
        notify("Sent to HR and Admin", "Nothing is deducted from salary until they decide.", "info");
      } else if (kind === "convert") {
        if (!dialogInput.signed) { setDialogError("The teacher's signed consent is required."); return; }
        await fetchJson("/api/accountant/loans", jsonBody("PATCH", { action: "convert_excess", loan_id: loan.id, consent_signed: true, number_of_payrolls: Number(dialogInput.payrolls) || 1, start_period: dialogInput.start }));
        notify("Converted to a Cash Advance", "Repaid on 16–end payslips.", "success");
      }
      setDialog(null);
      await load();
      reloadPayroll();
    } catch (error) {
      setDialogError(error.message || "Not saved.");
    }
  }

  async function resume(loan) {
    try {
      await fetchJson("/api/accountant/loans", jsonBody("PATCH", { action: "set_status", loan_id: loan.id, status: "active" }));
      notify("Loan Resumed", "Deducted again from the next 16–end payslip.", "info");
      await load();
      reloadPayroll();
    } catch (error) {
      notify("Not Updated", error.message, "error");
    }
  }

  const summary = state.data?.summary || {};
  const canEdit = Boolean(state.data?.can_edit);
  const rows = (state.data?.loans || []).filter((loan) => {
    if (filter === "all") return true;
    if (filter === "paid") return loan.status === "paid";
    if (filter === "subsidy") return loan.loan_type === "subsidy_advance";
    return loan.status !== "paid";
  });
  const first = state.loading && !state.data;

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, cell: (l) => <div><p className="font-medium">{l.employee_name}</p><p className="text-xs text-muted-foreground">{l.employee_code}{l.description ? ` · ${l.description}` : ""}</p></div>, searchValue: (l) => `${l.employee_name} ${l.employee_code} ${l.description || ""} ${l.type_label}` },
    { key: "type", header: "Type", cell: (l) => l.type_label },
    { key: "date_granted", header: "Given", sortable: true, className: "whitespace-nowrap", cell: (l) => dateLabel(l.date_granted) },
    { key: "total", header: "Total payable", align: "right", className: "tabular-nums", sortValue: (l) => Number(l.total_payable || 0), cell: (l) => <span title={Number(l.interest_pct) ? `${money(l.principal)} + ${l.interest_pct}% interest` : ""}>{money(l.total_payable)}</span> },
    { key: "per", header: "Per 16–end payslip", align: "right", className: "tabular-nums", cell: (l) => (l.loan_type === "subsidy_advance" ? <span className="text-muted-foreground">Not from salary</span> : <div><p>{money(l.amortization)}</p><p className="text-xs text-muted-foreground">from {dateLabel(l.start_period)}</p></div>) },
    { key: "repaid", header: "Repaid", align: "right", className: "tabular-nums", cell: (l) => <button type="button" className="underline-offset-2 hover:underline" onClick={() => openDialog("history", l)}>{money(l.repaid)}</button> },
    { key: "balance", header: "Balance", align: "right", className: "tabular-nums font-semibold", sortValue: (l) => Number(l.remaining_balance || 0), cell: (l) => money(l.remaining_balance) },
    { key: "status", header: "Status", cell: (l) => <div className="space-y-1">{statusBadge(l)}{l.status_reason ? <p className="max-w-52 text-xs whitespace-normal text-muted-foreground">{l.status_reason}</p> : null}</div> },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (l) => {
        if (!canEdit || l.status === "paid") return null;
        if (l.loan_type === "subsidy_advance") {
          return l.awaiting_decision ? null : (
            <div className="flex justify-end gap-1.5">
              <Button variant="outline" size="sm" onClick={() => openDialog("convert", l)} title="Only when the advance exceeds the teacher's subsidy">Convert (signed)</Button>
              <Button variant="outline" size="sm" className="text-destructive" onClick={() => openDialog("refusal", l)}>Refused</Button>
            </div>
          );
        }
        return l.status === "suspended"
          ? <Button variant="outline" size="sm" onClick={() => resume(l)}>Resume</Button>
          : <Button variant="outline" size="sm" onClick={() => openDialog("suspend", l)}>Suspend</Button>;
      },
    },
  ];

  const field = (key, label, input, hint) => (
    <div className="space-y-1.5">
      <Label htmlFor={`ac-ln-${key}`}>{label}</Label>
      {input}
      {hint && !errors[key] ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {errors[key] ? <p className="text-sm text-destructive">{errors[key]}</p> : null}
    </div>
  );
  const selectedBalance = balances.find((b) => b.id === advance.balance);

  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open loans" value={summary.open_count || 0} hint="Active, suspended or awaiting a decision" icon={HandCoinsIcon} tone="info" loading={first} />
        <StatCard label="Outstanding balance" value={moneyCompact(summary.outstanding || 0)} hint="Still to be repaid" icon={WalletIcon} tone="danger" loading={first} />
        <StatCard label="Repaid" value={moneyCompact(summary.repaid || 0)} hint="From Final payslips and final pay" icon={CoinsIcon} tone="success" loading={first} />
        <StatCard label="Awaiting decision" value={summary.awaiting_decision || 0} hint="Excess subsidy advances (HR / Admin)" icon={HourglassIcon} tone="gold" loading={first} />
      </section>

      {canEdit ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Card className="shadow-xs">
            <CardHeader><CardTitle>Record</CardTitle></CardHeader>
            <CardContent>
              <Tabs defaultValue="loan" onValueChange={() => { setErrors({}); setFeedback({ text: "", ok: false }); }}>
                <TabsList className="mb-4"><TabsTrigger value="loan">Loan / cash advance</TabsTrigger><TabsTrigger value="advance">Subsidy advance</TabsTrigger></TabsList>
                <TabsContent value="loan">
                  <form onSubmit={submitLoan} noValidate className="grid items-start gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">{field("employee", "Employee", <EmployeeSelect id="ac-ln-employee" value={form.employee} onChange={(v) => setForm((c) => ({ ...c, employee: v }))} employees={people} invalid={Boolean(errors.employee)} />, "Employees on AWOL / separation hold are not listed.")}</div>
                    {field("type", "Type", (
                      <Select value={form.type} onValueChange={(v) => setForm((c) => ({ ...c, type: v }))}>
                        <SelectTrigger id="ac-ln-type" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>{TYPES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                      </Select>
                    ))}
                    {field("granted", "Date given", <DatePicker id="ac-ln-granted" value={form.granted} onChange={(v) => setForm((c) => ({ ...c, granted: v }))} aria-invalid={Boolean(errors.granted) || undefined} />)}
                    {field("principal", "Amount lent (₱)", <Input id="ac-ln-principal" type="number" min="0" step="0.01" inputMode="decimal" value={form.principal} onChange={(e) => setForm((c) => ({ ...c, principal: e.target.value }))} aria-invalid={Boolean(errors.principal) || undefined} />)}
                    {field("interest", "Interest (%, flat)", <Input id="ac-ln-interest" type="number" min="0" max="100" step="0.01" inputMode="decimal" value={form.interest} onChange={(e) => setForm((c) => ({ ...c, interest: e.target.value }))} aria-invalid={Boolean(errors.interest) || undefined} />, total ? `Total payable ${money(total)}` : null)}
                    {field("payrolls", "Number of payrolls", <Input id="ac-ln-payrolls" type="number" min="1" max="120" step="1" inputMode="numeric" value={form.payrolls} onChange={(e) => setForm((c) => ({ ...c, payrolls: e.target.value }))} aria-invalid={Boolean(errors.payrolls) || undefined} />, "16–end payslips")}
                    {field("amortization", "Per payroll (₱)", <Input id="ac-ln-amortization" type="number" min="0" step="0.01" inputMode="decimal" placeholder={suggested ? suggested.toFixed(2) : ""} value={form.amortization} onChange={(e) => setForm((c) => ({ ...c, amortization: e.target.value }))} aria-invalid={Boolean(errors.amortization) || undefined} />, suggested ? `Blank = ${money(suggested)}` : null)}
                    <div className="sm:col-span-2">{field("start", "First payslip to deduct", (
                      <Select value={form.start} onValueChange={(v) => setForm((c) => ({ ...c, start: v }))}>
                        <SelectTrigger id="ac-ln-start" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>{starts.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
                      </Select>
                    ))}</div>
                    <div className="sm:col-span-2">{field("description", <>Description <span className="font-normal text-muted-foreground">(optional)</span></>, <Input id="ac-ln-description" maxLength={200} placeholder="e.g. Salary loan — tuition" value={form.description} onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))} />)}</div>
                    <label className="flex items-start gap-2 text-sm sm:col-span-2">
                      <Checkbox checked={form.authority} onCheckedChange={(v) => setForm((c) => ({ ...c, authority: v === true }))} className="mt-0.5" />
                      <span>The employee signed authority to deduct any balance from final pay.</span>
                    </label>
                    <Button type="submit" className="sm:col-span-2" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Add loan →</Button>
                    {feedback.text ? <p role="status" className={cn("text-sm sm:col-span-2", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
                  </form>
                </TabsContent>
                <TabsContent value="advance">
                  <form onSubmit={submitAdvance} noValidate className="grid items-start gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">{field("balance", "Licensed teacher", (
                      <Select value={advance.balance} onValueChange={(v) => setAdvance((c) => ({ ...c, balance: v }))} disabled={!balances.length}>
                        <SelectTrigger id="ac-ln-balance" className="w-full" aria-invalid={Boolean(errors.balance) || undefined}><SelectValue placeholder={balances.length ? "Select teacher" : "No eligible licensed teachers"} /></SelectTrigger>
                        <SelectContent>{balances.map((b) => <SelectItem key={b.id} value={b.id}>{`${b.employee_name} — ${String(b.subsidy_year_start).slice(0, 4)} · up to ${money(b.available)}`}</SelectItem>)}</SelectContent>
                      </Select>
                    ), "Verified, unexpired licenses only (HR → Employees).")}</div>
                    {field("amount", "Advance (₱)", <Input id="ac-ln-amount" type="number" min="0" step="0.01" inputMode="decimal" value={advance.amount} onChange={(e) => setAdvance((c) => ({ ...c, amount: e.target.value }))} aria-invalid={Boolean(errors.amount) || undefined} />, selectedBalance ? `Available ${money(selectedBalance.available)} of ${money(selectedBalance.entitlement)}` : null)}
                    {field("adv-granted", "Release date", <DatePicker id="ac-ln-adv-granted" value={advance.granted} onChange={(v) => setAdvance((c) => ({ ...c, granted: v }))} />)}
                    <div className="sm:col-span-2">{field("adv-description", <>Note <span className="font-normal text-muted-foreground">(optional)</span></>, <Input id="ac-ln-adv-description" maxLength={200} value={advance.description} onChange={(e) => setAdvance((c) => ({ ...c, description: e.target.value }))} />)}</div>
                    <Button type="submit" className="sm:col-span-2" disabled={busy || !balances.length}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <GiftIcon aria-hidden="true" />}Record subsidy advance</Button>
                    {feedback.text ? <p role="status" className={cn("text-sm sm:col-span-2", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
                  </form>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
          <HowItWorks
            title="How it is deducted"
            rows={[["1–15 payslip", "Nothing deducted"], ["16–end payslip", "− amount per payroll"], ["Last payroll", "Only the balance left"], ["Net pay too low", "Deducts what fits; the rest stays"], ["Suspended", "Skipped until resumed"], ["Subsidy advance", "Never from salary"], ["Separated", "Balance from final pay (with authority)"]]}
            note="Loans are repaid in the same database transaction as the Final payslip, and a regenerated payslip reverses its earlier repayment first. Old cash advances stay under Cash Advances as history."
          />
        </div>
      ) : null}

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Loans</CardTitle>
          <CardAction className="flex gap-2">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger size="sm" className="w-36" aria-label="Show"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="open">Open</SelectItem><SelectItem value="all">All</SelectItem><SelectItem value="paid">Paid</SelectItem><SelectItem value="subsidy">Subsidy advances</SelectItem></SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={columns} rows={rows} loading={first} error={state.error} onRetry={load} pageSize={15}
            searchPlaceholder="Search employee, type or description…" empty={{ title: "No loans here", icon: HandCoinsIcon }} caption="Loans" minWidth={1150} />
        </CardContent>
      </Card>

      <Dialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          {dialog?.kind === "history" ? (
            <>
              <DialogHeader>
                <DialogTitle>Repayments</DialogTitle>
                <DialogDescription>{dialog.loan.employee_name} · {dialog.loan.type_label} · total {money(dialog.loan.total_payable)}</DialogDescription>
              </DialogHeader>
              <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border text-sm">
                {(dialog.loan.payments || []).length ? dialog.loan.payments.map((p) => (
                  <li key={p.id} className={cn("flex items-baseline justify-between gap-3 px-3 py-2", p.reversed && "text-muted-foreground line-through")}>
                    <span>{p.pay_period || dateLabel(String(p.created_at).slice(0, 10))} · {p.kind.replace("_", " ")}{p.note ? <span className="block text-xs text-muted-foreground no-underline">{p.note}</span> : null}</span>
                    <span className="tabular-nums">{money(p.amount)}</span>
                  </li>
                )) : <li className="px-3 py-2 text-muted-foreground">Nothing repaid yet.</li>}
              </ul>
              <DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Close</Button></DialogFooter>
            </>
          ) : dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>{dialog.kind === "suspend" ? "Suspend this loan?" : dialog.kind === "refusal" ? "Teacher refused to sign" : "Convert the excess to a cash advance"}</DialogTitle>
                <DialogDescription>
                  {dialog.kind === "suspend" ? "Payroll skips it until resumed. The balance stays." : dialog.kind === "refusal"
                    ? "The excess advance goes to HR (recommends) and the Admin (approves). Nothing is deducted from salary meanwhile."
                    : "Only with the teacher's signed consent: the excess becomes a cash advance repaid on 16–end payslips."}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {dialog.kind === "convert" ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5"><Label htmlFor="ac-ln-cv-payrolls">Number of payrolls</Label><Input id="ac-ln-cv-payrolls" type="number" min="1" max="120" value={dialogInput.payrolls} onChange={(e) => setDialogInput((c) => ({ ...c, payrolls: e.target.value }))} /></div>
                      <div className="space-y-1.5"><Label htmlFor="ac-ln-cv-start">First payslip</Label>
                        <Select value={dialogInput.start} onValueChange={(v) => setDialogInput((c) => ({ ...c, start: v }))}>
                          <SelectTrigger id="ac-ln-cv-start" className="w-full"><SelectValue /></SelectTrigger>
                          <SelectContent>{starts.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                    </div>
                    <label className="flex items-start gap-2 text-sm"><Checkbox checked={dialogInput.signed} onCheckedChange={(v) => setDialogInput((c) => ({ ...c, signed: v === true }))} className="mt-0.5" /><span>The teacher signed consent to the salary deduction.</span></label>
                  </>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="ac-ln-reason">{dialog.kind === "refusal" ? "What the teacher said" : "Reason"}</Label>
                    <Input id="ac-ln-reason" maxLength={300} placeholder="Required, at least 5 characters" value={dialogInput.reason} onChange={(e) => { setDialogInput((c) => ({ ...c, reason: e.target.value })); setDialogError(""); }} autoFocus />
                  </div>
                )}
                {dialogError ? <p className="text-sm text-destructive">{dialogError}</p> : null}
              </div>
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
                <Button variant={dialog.kind === "convert" ? "default" : "destructive"} onClick={confirmDialog}>
                  {dialog.kind === "suspend" ? "Suspend" : dialog.kind === "refusal" ? "Send to HR & Admin" : "Convert"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
