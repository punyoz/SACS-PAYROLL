"use client";

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { REASON_MAX, SALARY_MAX, pesoLimit } from "@/lib/input-limits";

/*
 * Change salary (HR → User Management, 2026-10-26): a new basic salary from
 * the 1st of a month, with a reason; the history below it. Payroll uses the
 * salary in force on each pay period's first day, so earlier periods and
 * processed payslips keep the old one (/api/hr/salary-changes).
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const peso = (v) => `₱${Number(v || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

/** This month and the next 12, as "YYYY-MM-01". */
function startMonths() {
  const now = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date()) + "T00:00:00Z");
  return Array.from({ length: 13 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    return d.toISOString().slice(0, 10);
  });
}

export function SalaryChangeDialog({ employee, open, onOpenChange, onSaved }) {
  const { notify } = usePortalSession();
  const months = React.useMemo(() => startMonths(), []);
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [form, setForm] = React.useState({ salary: "", month: months[1], reason: "", note: "" });
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!employee?.id) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, data: await fetchJson(`/api/hr/salary-changes?employee_id=${employee.id}`) });
    } catch (err) {
      setState({ loading: false, error: err.message || "Unable to load the salary history.", data: null });
    }
  }, [employee?.id]);

  React.useEffect(() => {
    if (!open) return;
    setForm({ salary: "", month: months[1], reason: "", note: "" });
    setError("");
    load();
  }, [open, load, months]);

  const data = state.data;
  const set = (key) => (value) => setForm((c) => ({ ...c, [key]: value }));

  async function save(event) {
    event.preventDefault();
    const amount = Number(form.salary);
    if (!(amount > 0) || amount > SALARY_MAX) { setError(`Enter the new monthly salary (more than ₱0, at most ${pesoLimit(SALARY_MAX)}).`); return; }
    if (!form.reason) { setError("Choose the reason."); return; }
    if (["Correction", "Other"].includes(form.reason) && form.note.trim().length < 10) { setError("Explain the change in the note (at least 10 characters)."); return; }
    setBusy(true);
    setError("");
    try {
      const result = await fetchJson("/api/hr/salary-changes", jsonBody("POST", {
        employee_id: employee.id, new_salary: amount, effective_date: form.month, reason: form.reason, note: form.note.trim(),
      }));
      notify("Salary Change Saved", `${employee.full_name}: ${peso(result.change?.old_salary)} → ${peso(amount)} from ${monthLabel(form.month)}.`, "success");
      onOpenChange(false);
      await onSaved?.();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={save} className="contents" noValidate>
          <DialogHeader>
            <DialogTitle>Change salary — {employee?.full_name}</DialogTitle>
            <DialogDescription>
              {data ? <>Current basic salary <strong className="tabular-nums text-foreground">{peso(data.in_force)}</strong> a month. </> : null}
              The new salary starts on the 1st of the month you choose; earlier pay periods and processed payslips keep the old one.
            </DialogDescription>
          </DialogHeader>
          {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sal-new">New monthly salary (₱)</Label>
              <Input id="sal-new" type="number" min="0.01" max={SALARY_MAX} step="0.01" inputMode="decimal" value={form.salary} onChange={(e) => set("salary")(e.target.value)} className="tabular-nums" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sal-month">Starts</Label>
              <Select value={form.month} onValueChange={set("month")}>
                <SelectTrigger id="sal-month" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{months.map((m) => <SelectItem key={m} value={m}>{`${monthLabel(m)} (1st)`}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="sal-reason">Reason</Label>
              <Select value={form.reason} onValueChange={set("reason")}>
                <SelectTrigger id="sal-reason" className="w-full"><SelectValue placeholder="Select reason" /></SelectTrigger>
                <SelectContent>{(data?.reasons || []).map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="sal-note">{["Correction", "Other"].includes(form.reason) ? "Note (required)" : "Note (optional)"}</Label>
              <Textarea id="sal-note" rows={2} maxLength={REASON_MAX} value={form.note} onChange={(e) => set("note")(e.target.value)} placeholder="e.g. Annual review, rating Very Satisfactory" />
            </div>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

          <div className="space-y-2">
            <p className="text-sm font-medium">History</p>
            {state.loading && !data ? <Skeleton className="h-12 w-full" /> : (data?.changes || []).length ? (
              <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">
                {data.changes.map((c) => (
                  <li key={c.id} className="rounded-md border px-3 py-2">
                    <p className="tabular-nums"><strong>{peso(c.old_salary)} → {peso(c.new_salary)}</strong> from {monthLabel(c.effective_date)}{c.applied ? "" : " (upcoming)"}</p>
                    <p className="text-xs text-muted-foreground">{c.reason}{c.note ? `: ${c.note}` : ""} · {c.created_by_name || "HR"}, {new Date(c.created_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" })}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No salary changes yet.</p>}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !data}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save salary change</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
