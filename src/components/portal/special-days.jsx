"use client";

import * as React from "react";
import { CalendarPlusIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { SPECIAL_DAY_AUDIENCES, SPECIAL_DAY_PAY } from "@/lib/attendance/special-days";

/*
 * Special working days (2026-11-23): HR declares a date as a working day
 * (e.g. Saturday classes) for some branches and people, with hours and a pay
 * type; the covered employees are notified and see it ahead of time
 * (MySpecialDays). Attendance and payroll apply it automatically.
 */

const EMPTY = { work_date: "", start_time: "08:00", end_time: "12:00", audience: "all", employee_ids: [], branch_ids: [], pay_type: "makeup", premium_pct: "", reason: "" };

export function SpecialDaysPanel({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, days: [], canManage: false });
  const [branches, setBranches] = React.useState([]);
  const [people, setPeople] = React.useState([]);
  const [form, setForm] = React.useState(EMPTY);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const d = await fetchJson("/api/hr/special-days");
      setState({ loading: false, error: d.available === false ? d.error : null, days: d.days || [], canManage: Boolean(d.can_manage) });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message || "Unable to load special working days." }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  React.useEffect(() => {
    if (!state.canManage) return;
    fetchJson("/api/admin/branches").then((d) => setBranches(d.branches || [])).catch(() => {});
    fetchJson("/api/hr/employees").then((d) => setPeople((d.employees || []).filter((e) => !e.archived))).catch(() => {});
  }, [state.canManage]);

  async function save(event) {
    event.preventDefault();
    setError("");
    if (!form.work_date) { setError("Choose the date."); return; }
    if (form.reason.trim().length < 3) { setError("Give the reason."); return; }
    setBusy(true);
    try {
      const res = await fetchJson("/api/hr/special-days", jsonBody("POST", { ...form, reason: form.reason.trim() }));
      notify("Special working day saved", `${res.notified} employee${res.notified === 1 ? "" : "s"} notified.`, "success");
      setForm(EMPTY);
      await load();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(day) {
    const reason = window.prompt("Reason for cancelling this special working day (at least 5 characters):");
    if (!reason) return;
    try {
      await fetchJson("/api/hr/special-days", jsonBody("PATCH", { id: day.id, action: "cancel", reason }));
      notify("Cancelled", "The day is a normal day again.", "info");
      await load();
    } catch (err) {
      notify("Not cancelled", err.message, "error");
    }
  }

  const columns = [
    { key: "work_date", header: "Date", sortable: true, className: "whitespace-nowrap", cell: (d) => d.label?.date },
    { key: "pay_type", header: "Type", cell: (d) => <StatusBadge tone={d.pay_type === "extra" ? "success" : "info"}>{d.label?.kind}</StatusBadge> },
    { key: "hours", header: "Hours", className: "whitespace-nowrap", cell: (d) => d.label?.hours },
    { key: "who", header: "Who", cell: (d) => `${d.label?.who}${d.branch_ids?.length ? ` · ${d.branch_ids.length} branch${d.branch_ids.length === 1 ? "" : "es"}` : " · all branches"}` },
    { key: "reason", header: "Reason", className: "min-w-48 whitespace-normal", cell: (d) => d.reason },
    {
      key: "status", header: "Status",
      cell: (d) => (d.cancelled_at ? <StatusBadge tone="muted">Cancelled</StatusBadge>
        : state.canManage && d.work_date >= manilaDateKey() ? <Button size="sm" variant="outline" onClick={() => cancel(d)}>Cancel</Button> : <StatusBadge tone="gold">Declared</StatusBadge>),
    },
  ];

  return (
    <Card className="min-w-0 shadow-xs" data-testid="special-days">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CalendarPlusIcon className="size-4 text-gold-text" aria-hidden="true" />Special working days</CardTitle>
        <CardDescription>
          A date that is a working day for some staff, e.g. Saturday classes. A make-up day counts like a normal workday (Late and Absent apply, no extra pay).
          An extra working day is paid on top of the salary at the daily rate × the premium, only to those who tapped in. Nobody else is affected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.canManage ? (
          <form onSubmit={save} noValidate className="grid items-start gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5"><Label htmlFor="swd-date">Date</Label><DatePicker id="swd-date" value={form.work_date} onChange={(v) => set("work_date", v)} /></div>
            <div className="space-y-1.5"><Label htmlFor="swd-start">Start</Label><Input id="swd-start" type="time" value={form.start_time} onChange={(e) => set("start_time", e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="swd-end">End</Label><Input id="swd-end" type="time" value={form.end_time} onChange={(e) => set("end_time", e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label htmlFor="swd-pay">Pay type</Label>
              <Select value={form.pay_type} onValueChange={(v) => set("pay_type", v)}>
                <SelectTrigger id="swd-pay" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(SPECIAL_DAY_PAY).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {form.pay_type === "extra" ? (
              <div className="space-y-1.5"><Label htmlFor="swd-pct">Rate (% of the daily rate)</Label><Input id="swd-pct" type="number" min="100" max="400" placeholder="130 (setting)" value={form.premium_pct} onChange={(e) => set("premium_pct", e.target.value)} /></div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="swd-who">Who works</Label>
              <Select value={form.audience} onValueChange={(v) => set("audience", v)}>
                <SelectTrigger id="swd-who" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(SPECIAL_DAY_AUDIENCES).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <fieldset className="space-y-1 sm:col-span-2 lg:col-span-3">
              <legend className="text-sm font-medium">Branches <span className="font-normal text-muted-foreground">(none ticked = all)</span></legend>
              <div className="flex flex-wrap gap-3">
                {branches.map((b) => (
                  <label key={b.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={form.branch_ids.includes(b.id)} onCheckedChange={(on) => set("branch_ids", on ? [...form.branch_ids, b.id] : form.branch_ids.filter((x) => x !== b.id))} />{b.name}
                  </label>
                ))}
              </div>
            </fieldset>
            {form.audience === "employees" ? (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2 sm:col-span-2 lg:col-span-3" aria-label="Employees">
                {people.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={form.employee_ids.includes(p.id)} onCheckedChange={(on) => set("employee_ids", on ? [...form.employee_ids, p.id] : form.employee_ids.filter((x) => x !== p.id))} />{p.full_name}
                  </label>
                ))}
              </div>
            ) : null}
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-3"><Label htmlFor="swd-reason">Reason</Label><Input id="swd-reason" maxLength={300} placeholder="e.g. Saturday make-up classes for the typhoon suspension" value={form.reason} onChange={(e) => set("reason", e.target.value)} /></div>
            {error ? <p className="text-sm text-destructive sm:col-span-2 lg:col-span-3" role="alert">{error}</p> : null}
            <Button type="submit" disabled={busy} className="sm:col-span-2 lg:col-span-3">{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Declare and notify</Button>
          </form>
        ) : null}
        <DataTable columns={columns} rows={state.days} rowKey={(d) => d.id} loading={state.loading} error={state.error} onRetry={load}
          caption="Special working days" minWidth={760} empty={{ title: "No special working days declared", icon: CalendarPlusIcon }} />
      </CardContent>
    </Card>
  );
}

/** The signed-in person's upcoming special working days (dashboard and My Attendance). Hidden when none. */
export function MySpecialDays() {
  const { can } = usePortalSession();
  const allowed = can("my_account");
  const [days, setDays] = React.useState([]);
  React.useEffect(() => {
    // A separated account (no My Account pages) is not asked: the server would refuse it.
    if (!allowed) return undefined;
    let alive = true;
    fetchJson("/api/me/special-days").then((d) => { if (alive) setDays(d.days || []); }).catch(() => {});
    return () => { alive = false; };
  }, [allowed]);
  if (!days.length) return null;
  return (
    <Card className="min-w-0 border-brand-gold/50 shadow-xs" data-testid="my-special-days">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><CalendarPlusIcon className="size-4 text-gold-text" aria-hidden="true" />Upcoming special working days</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-sm">
          {days.map((d) => (
            <li key={d.id}><span className="font-medium">{d.label.date}</span>: {d.label.kind}, {d.label.hours}. {d.reason}{d.pay_type === "extra" ? " (paid on top when you tap in)" : " (a normal working day: tap in and out)"}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
