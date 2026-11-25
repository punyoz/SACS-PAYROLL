"use client";

/**
 * HR → Employees → Government loans (2026-11-25): SSS and Pag-IBIG loans HR encodes from the
 * agency's notice (/api/hr/government-loans). Deducted on 16–end payslips; no amount cap and no
 * salary limit (the agencies set them). Nobody encodes or changes their own; every change has a
 * reason and is audited.
 */

import * as React from "react";
import { Loader2Icon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { money } from "@/lib/portal/payroll-preview";
import { EmployeeSelect } from "@/app/accountant/incentives-page";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** This month's and the next five 16–end payslips (government loans are deducted on the 2nd half). */
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
const AGENCIES = [["sss_loan", "SSS"], ["pagibig_loan", "Pag-IBIG"]];
const OTHER = "__other";

function statusOf(l) {
  if (l.status === "paid") return <StatusBadge tone="success">Paid</StatusBadge>;
  if (l.ended) return <StatusBadge tone="muted">Ended</StatusBadge>;
  if (l.status === "suspended") return <StatusBadge tone="danger">Suspended</StatusBadge>;
  return <StatusBadge tone="info">Deducting</StatusBadge>;
}

export function GovernmentLoansPage({ refreshKey = 0 }) {
  const { notify } = usePortalSession();
  const starts = React.useMemo(startOptions, []);
  const [state, setState] = React.useState({ loading: true, error: "", data: null });
  const [open, setOpen] = React.useState(false);
  const [change, setChange] = React.useState(null);   // { loan, action }
  const blank = { employee: "", loan_type: "sss_loan", kind: "", other: "", reference: "", total: "", per: "", start: starts[0].value, payrolls: "", notes: "", authority: false };
  const [form, setForm] = React.useState(blank);
  const [edit, setEdit] = React.useState({ amortization: "", reason: "" });
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const data = await fetchJson("/api/hr/government-loans?status=all");
      setState({ loading: false, error: data.available ? "" : data.error, data });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e.message || "Could not load the government loans." }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const kinds = state.data?.kinds?.[form.loan_type] || [];
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v, ...(k === "loan_type" ? { kind: "" } : {}) }));

  async function save(event) {
    event.preventDefault();
    setError("");
    const loanKind = form.kind === OTHER ? form.other.trim() : form.kind;
    if (!form.employee) return setError("Choose the employee.");
    if (!loanKind) return setError("Choose the loan kind (or write it).");
    setBusy(true);
    try {
      await fetchJson("/api/hr/government-loans", jsonBody("POST", {
        employee_id: form.employee, loan_type: form.loan_type, loan_kind: loanKind, reference_no: form.reference.trim(),
        principal: form.total, amortization: form.per, start_period: form.start, number_of_payrolls: form.payrolls,
        notes: form.notes.trim(), final_pay_authorized: form.authority,
      }));
      notify?.("Government loan encoded", "Deducted on 16–end payslips from the period chosen.", "success");
      setOpen(false);
      setForm(blank);
      await load();
    } catch (e) {
      setError(e.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function saveChange(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await fetchJson("/api/hr/government-loans", jsonBody("PATCH", {
        id: change.loan.id, action: change.action, reason: edit.reason.trim(),
        ...(change.action === "edit" ? { amortization: edit.amortization } : {}),
      }));
      setChange(null);
      await load();
    } catch (e) {
      setError(e.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  const canEncode = Boolean(state.data?.can_encode);
  const columns = [
    { key: "employee", header: "Employee", sortable: true, sortValue: (l) => l.employee_name, cell: (l) => <div><p className="font-medium">{l.employee_name}</p><p className="text-xs text-muted-foreground">{l.employee_code}</p></div>, searchValue: (l) => `${l.employee_name} ${l.employee_code} ${l.reference_no || ""}` },
    { key: "label", header: "Loan", cell: (l) => <div><p>{l.label}</p><p className="text-xs text-muted-foreground">{l.reference_no ? `Ref. ${l.reference_no}` : "No reference number"}</p></div> },
    { key: "total", header: "Total", align: "right", className: "tabular-nums", cell: (l) => money(l.principal) },
    { key: "per", header: "Per 16–end payslip", align: "right", className: "tabular-nums", cell: (l) => money(l.amortization) },
    { key: "from", header: "From", cell: (l) => l.start_period },
    { key: "balance", header: "Remaining", align: "right", className: "tabular-nums", cell: (l) => money(l.remaining_balance) },
    { key: "status", header: "Status", cell: (l) => <div className="space-y-0.5">{statusOf(l)}{l.status_reason ? <p className="text-xs text-muted-foreground">{l.status_reason}</p> : null}</div> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (l) => (!canEncode || l.status === "paid" ? null : (
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="outline" onClick={() => { setEdit({ amortization: String(l.amortization), reason: "" }); setChange({ loan: l, action: "edit" }); }}>Edit</Button>
        {l.status === "suspended"
          ? <Button size="sm" variant="outline" onClick={() => { setEdit({ amortization: "", reason: "" }); setChange({ loan: l, action: "resume" }); }}>Resume</Button>
          : <Button size="sm" variant="outline" onClick={() => { setEdit({ amortization: "", reason: "" }); setChange({ loan: l, action: "suspend" }); }}>Suspend</Button>}
        {l.ended ? null : <Button size="sm" variant="outline" onClick={() => { setEdit({ amortization: "", reason: "" }); setChange({ loan: l, action: "end" }); }}>End</Button>}
      </div>
    )) },
  ];

  return (
    <Card className="min-w-0 shadow-xs" data-testid="government-loans">
      <CardHeader>
        <CardTitle>Government loans</CardTitle>
        <CardDescription>
          SSS and Pag-IBIG loans from the agency&apos;s deduction notice. Deducted on 16–end payslips (what fits when pay is short; the rest stays on the balance).
          The agencies set these amounts: no salary limit. Nobody encodes their own.
        </CardDescription>
        <CardAction className="flex gap-2">
          {canEncode ? <Button size="sm" onClick={() => { setError(""); setOpen(true); }} data-testid="encode-government-loan"><PlusIcon aria-hidden="true" />Encode a loan</Button> : null}
          <Button size="sm" variant="outline" onClick={load} disabled={state.loading}><RefreshCwIcon aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={state.data?.loans || []} loading={state.loading && !state.data} error={state.data ? null : state.error || null} onRetry={load}
          empty={{ title: "No government loans encoded", description: "Encode one from the agency's notice." }} />
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl" data-testid="government-loan-form">
          <DialogHeader>
            <DialogTitle>Encode a government loan</DialogTitle>
            <DialogDescription>From the agency&apos;s deduction notice. It is deducted on 16–end payslips from the period you choose.</DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2" noValidate>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="gl-employee">Employee</Label>
              <EmployeeSelect id="gl-employee" value={form.employee} onChange={set("employee")} employees={state.data?.people || []} /></div>
            <div className="space-y-1.5"><Label htmlFor="gl-agency">Agency</Label>
              <Select value={form.loan_type} onValueChange={set("loan_type")}><SelectTrigger id="gl-agency" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{AGENCIES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5"><Label htmlFor="gl-kind">Loan kind</Label>
              <Select value={form.kind} onValueChange={set("kind")}><SelectTrigger id="gl-kind" className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent>{kinds.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}<SelectItem value={OTHER}>Other (write it)</SelectItem></SelectContent></Select></div>
            {form.kind === OTHER ? <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="gl-other">Loan kind (as on the notice)</Label><Input id="gl-other" maxLength={80} value={form.other} onChange={set("other")} /></div> : null}
            <div className="space-y-1.5"><Label htmlFor="gl-ref">Reference / loan number</Label><Input id="gl-ref" maxLength={40} value={form.reference} onChange={set("reference")} placeholder="Letters and numbers" /></div>
            <div className="space-y-1.5"><Label htmlFor="gl-total">Total amount (₱)</Label><Input id="gl-total" type="number" min="0" step="0.01" inputMode="decimal" value={form.total} onChange={set("total")} /></div>
            <div className="space-y-1.5"><Label htmlFor="gl-per">Amount per payroll (₱)</Label><Input id="gl-per" type="number" min="0" step="0.01" inputMode="decimal" value={form.per} onChange={set("per")} /></div>
            <div className="space-y-1.5"><Label htmlFor="gl-payrolls">Number of payrolls <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="gl-payrolls" type="number" min="1" max="120" step="1" value={form.payrolls} onChange={set("payrolls")} placeholder="Total ÷ per payroll" /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="gl-start">First payslip to deduct</Label>
              <Select value={form.start} onValueChange={set("start")}><SelectTrigger id="gl-start" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{starts.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="gl-notes">Notes <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="gl-notes" maxLength={500} value={form.notes} onChange={set("notes")} /></div>
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <Checkbox checked={form.authority} onCheckedChange={(v) => setForm((f) => ({ ...f, authority: v === true }))} className="mt-0.5" />
              <span>The employee signed authority to deduct any balance from final pay. Without it, the deduction stops at separation and the employee pays the agency directly.</span>
            </label>
            {error ? <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p> : null}
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Encode</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(change)} onOpenChange={(v) => { if (!v) setChange(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{change?.action === "edit" ? "Change the amount per payroll" : change?.action === "end" ? "End this loan" : change?.action === "resume" ? "Resume deductions" : "Suspend deductions"}</DialogTitle>
            <DialogDescription>{change?.loan?.label} of {change?.loan?.employee_name}. {change?.action === "edit" ? "Applies from the next payslip computed; processed payslips never change." : "Recorded with your reason."}</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveChange} className="space-y-3" noValidate>
            {change?.action === "edit" ? <div className="space-y-1.5"><Label htmlFor="gl-edit-per">Amount per payroll (₱)</Label><Input id="gl-edit-per" type="number" min="0" step="0.01" value={edit.amortization} onChange={(e) => setEdit((x) => ({ ...x, amortization: e.target.value }))} /></div> : null}
            <div className="space-y-1.5"><Label htmlFor="gl-reason">Reason</Label><Input id="gl-reason" maxLength={300} value={edit.reason} onChange={(e) => setEdit((x) => ({ ...x, reason: e.target.value }))} placeholder="At least 5 characters" /></div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setChange(null)}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
