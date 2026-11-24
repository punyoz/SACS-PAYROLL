"use client";

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import {
  CATEGORY_OPTIONS, EMPLOYMENT_STATUS_OPTIONS, EMPLOYMENT_TYPE_OPTIONS, FIELD_LABELS, PAY_BASIS_LABELS, classificationLabel,
} from "@/lib/employees/classification";

const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const show = (field, value) => (field === "on_payroll" ? (value === "true" ? "On payroll" : "Not on payroll") : value || "—");
const fmt = (key) => (key ? new Date(`${key}T00:00:00`).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : "—");

/**
 * Category, employment status, on payroll and contract end
 * date of one employee, changed with an effective date and a reason (Part A).
 * Shows the dated history and this year's leave credits (with overrides).
 */
export function ClassificationDialog({ employee, open, onOpenChange, onSaved }) {
  const { role, notify } = usePortalSession();
  const canEdit = ["hr", "super_admin"].includes(role);
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({});
  const [override, setOverride] = React.useState(null);

  const load = React.useCallback(async () => {
    if (!employee?.id) return;
    setError("");
    try {
      const d = await fetchJson(`/api/hr/employee-classification?employee_id=${employee.id}`);
      setData(d);
      setForm({ ...d.current, contract_end_date: d.current.contract_end_date || "", effective_on: today(), reason: "" });
    } catch (e) {
      setError(e.message);
    }
  }, [employee?.id]);

  React.useEffect(() => { if (open) { setData(null); setOverride(null); load(); } }, [open, load]);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const cur = data?.current || {};
  const changes = data ? Object.fromEntries(["employee_type", "employment_status", "on_payroll", "contract_end_date"]
    .filter((k) => String(form[k] ?? "") !== String(cur[k] ?? ""))
    .map((k) => [k, k === "contract_end_date" ? form[k] || null : form[k]])) : {};
  const hasChanges = Object.keys(changes).length > 0;

  async function save() {
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/hr/employee-classification", jsonBody("POST", { employee_id: employee.id, changes, effective_on: form.effective_on, reason: form.reason }));
      notify?.("Saved. " + (form.effective_on <= today() ? "It applies now." : `It applies on ${fmt(form.effective_on)}.`));
      await load();
      onSaved?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmRecord() {
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/hr/employee-classification", jsonBody("POST", { action: "confirm", employee_id: employee.id }));
      notify?.("Confirmed.");
      await load();
      onSaved?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveOverride() {
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/hr/employee-classification", jsonBody("POST", { action: "override", employee_id: employee.id, ...override, year: data.leave.year }));
      setOverride(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const pick = (key, options) => (
    <Select value={form[key] || ""} onValueChange={(v) => set(key, v)} disabled={!canEdit}>
      <SelectTrigger id={`cls-${key}`} className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
      <SelectContent>{options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
    </Select>
  );
  const leaveRows = Object.entries(data?.leave?.by_type || {});

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Category and status: {employee?.full_name}</DialogTitle>
          <DialogDescription>Changes take effect on their date. Payroll and leave credits use the values in effect on each day.</DialogDescription>
        </DialogHeader>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {!data ? (error ? null : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin" aria-hidden="true" />Loading…</p>) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{classificationLabel(cur)}</span>
              {cur.on_payroll === false ? <StatusBadge tone="muted">Not on payroll</StatusBadge> : null}
              {data.pay_rule ? <span className="text-muted-foreground">· {PAY_BASIS_LABELS[data.pay_rule.pay_basis]}</span> : null}
              {cur.classification_unconfirmed ? <StatusBadge tone="warning">Needs HR confirmation</StatusBadge> : null}
            </div>
            {cur.classification_unconfirmed && canEdit ? (
              <Alert>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                  <span>Set to Regular / Full-time by default on Nov 20, 2026. Confirm it, or change it below.</span>
                  <Button size="sm" onClick={confirmRecord} disabled={busy}>Confirm as is</Button>
                </AlertDescription>
              </Alert>
            ) : null}

            {canEdit ? (
              <section className="grid gap-3 sm:grid-cols-2" aria-label="Change">
                <div className="space-y-1.5"><Label htmlFor="cls-employee_type">Category</Label>{pick("employee_type", CATEGORY_OPTIONS)}</div>
                <div className="space-y-1.5"><Label htmlFor="cls-employment_status">Employment status</Label>{pick("employment_status", EMPLOYMENT_STATUS_OPTIONS)}</div>
                <div className="space-y-1.5">
                  <Label htmlFor="cls-contract">Contract end date{form.employment_status === "Contractual" ? " *" : ""}</Label>
                  <DatePicker id="cls-contract" value={form.contract_end_date || ""} onChange={(v) => set("contract_end_date", v)} />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border p-3 sm:col-span-2">
                  <div>
                    <Label htmlFor="cls-on_payroll">On payroll</Label>
                    <p className="text-xs text-muted-foreground">Off: a system account with no attendance, payslips or place in employee lists.</p>
                  </div>
                  <Switch id="cls-on_payroll" checked={form.on_payroll !== false} onCheckedChange={(v) => set("on_payroll", v)} />
                </div>
                <div className="space-y-1.5"><Label htmlFor="cls-effective">Effective date *</Label><DatePicker id="cls-effective" value={form.effective_on} onChange={(v) => set("effective_on", v)} /></div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="cls-reason">Reason *</Label>
                  <Textarea id="cls-reason" rows={2} maxLength={500} placeholder="e.g. Completed probation; regularized per HR memo" value={form.reason} onChange={(e) => set("reason", e.target.value)} />
                </div>
              </section>
            ) : null}

            <section aria-label="History">
              <h3 className="mb-2 text-sm font-semibold">History</h3>
              {data.history.length ? (
                <ul className="divide-y rounded-md border text-sm">
                  {data.history.map((h) => (
                    <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-2 p-2.5">
                      <span><span className="font-medium">{FIELD_LABELS[h.field]}</span>: {show(h.field, h.old_value)} → {show(h.field, h.new_value)}</span>
                      <span className="text-xs text-muted-foreground">from {fmt(h.effective_on)}{h.applied_at ? "" : " (scheduled)"} · {h.changed_by_name || "System"} · {h.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground">No changes since the record was created.</p>}
            </section>

            <section aria-label="Leave credits">
              <h3 className="mb-2 text-sm font-semibold">Leave credits {data.leave.year}</h3>
              <ul className="divide-y rounded-md border text-sm">
                {leaveRows.map(([type, b]) => (
                  <li key={type} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
                    <span>{type}</span>
                    <span className="flex items-center gap-3 tabular-nums">
                      <span>{b.used} of {b.allotment} used</span>
                      {b.override ? <StatusBadge tone="info">Override (computed {b.computed})</StatusBadge> : null}
                      {canEdit ? <Button size="sm" variant="outline" onClick={() => setOverride({ leave_type: type, days: String(b.allotment), reason: "" })}>Override</Button> : null}
                    </span>
                  </li>
                ))}
              </ul>
              {data.leave.conversion?.eligible && data.leave.conversion.text ? (
                <p className="mt-2 text-xs text-muted-foreground" data-testid="hr-leave-conversion-preview">{data.leave.conversion.text}</p>
              ) : null}
              {override ? (
                <div className="mt-3 grid gap-3 rounded-md border p-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
                  <div className="space-y-1.5"><Label htmlFor="cls-ov-days">{override.leave_type} days</Label>
                    <Input id="cls-ov-days" inputMode="decimal" value={override.days} onChange={(e) => setOverride((o) => ({ ...o, days: e.target.value }))} /></div>
                  <div className="space-y-1.5"><Label htmlFor="cls-ov-reason">Reason *</Label>
                    <Input id="cls-ov-reason" maxLength={500} value={override.reason} onChange={(e) => setOverride((o) => ({ ...o, reason: e.target.value }))} /></div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveOverride} disabled={busy}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setOverride(null)}>Cancel</Button>
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          {canEdit ? (
            <Button onClick={save} disabled={busy || !hasChanges || !form.reason?.trim() || !form.effective_on}>
              {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save change
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
