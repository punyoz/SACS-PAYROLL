"use client";

import * as React from "react";
import { ClockIcon, Loader2Icon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { RequestStatusBadge, StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch, jsonBody } from "@/lib/portal/api";

/*
 * Overtime requests (Part B, 2026-11-22): filed ahead like leave; HR approves
 * or rejects. MyOvertimeRequests is the employee's form and list (Leave page,
 * My Account); HrOvertimeRequests is HR's list with the facts the system
 * prepared. The server checks every rule (src/lib/overtime-requests/rules.js).
 */

function useRequests(url) {
  const [state, setState] = React.useState({ rows: [], settings: null, loading: true, error: "" });
  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const res = await apiFetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load the overtime requests.");
      setState({ rows: data.requests || [], settings: data.settings || null, loading: false, error: "" });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e.message }));
    }
  }, [url]);
  React.useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

const hoursText = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h ? `${h} h` : ""}${h && m ? " " : ""}${m ? `${m} min` : ""}` || "0 h";
};

/** Shown instead of a filing form once the person is separated (the server refuses too). */
export const SEPARATED_NOTE = "You can't file new requests after separation.";

export function MyOvertimeRequests({ apiBase = "/api/me/overtime-requests" }) {
  const { notify, me } = usePortalSession();
  const separated = Boolean(me?.user?.separated);
  const list = useRequests(apiBase);
  const [form, setForm] = React.useState({ request_date: "", planned_start: "", planned_end: "", reason: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e?.target ? e.target.value : e }));
  const s = list.settings;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch(apiBase, jsonBody("POST", form));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The request was not filed.");
      notify("Overtime request filed", `${form.request_date} · ${form.planned_start}-${form.planned_end}${data.request?.late_filing ? " · Late filing" : ""}`, "success");
      setForm({ request_date: "", planned_start: "", planned_end: "", reason: "" });
      list.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(row) {
    const res = await apiFetch(apiBase, jsonBody("PATCH", { id: row.id, action: "cancel" }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) notify("Not cancelled", data.error || "The request was not cancelled.", "error");
    else { notify("Overtime request cancelled", row.request_date, "success"); list.reload(); }
  }

  const columns = [
    { key: "request_date", header: "Date", sortable: true, className: "font-medium", cell: (r) => (
      <div><p>{r.request_date}</p>{r.late_filing ? <p className="text-xs font-normal text-warning">Late filing</p> : null}</div>
    ) },
    { key: "planned_start", header: "Planned", cell: (r) => (
      <div><p>{r.planned_start}-{r.planned_end} ({hoursText(r.minutes)})</p><p className="text-xs text-muted-foreground line-clamp-2">{r.reason}</p></div>
    ), searchValue: (r) => `${r.request_date} ${r.reason}` },
    { key: "status", header: "Status", sortable: true, cell: (r) => (
      <div className="space-y-0.5"><RequestStatusBadge status={r.status} />{r.decision_note ? <p className="text-xs text-muted-foreground">{r.decision_note}</p> : null}</div>
    ) },
    { key: "actions", header: "", cell: (r) => (r.status === "pending" && !separated ? <Button size="sm" variant="outline" onClick={() => cancel(r)}>Cancel</Button> : null) },
  ];

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]" data-testid="my-overtime-requests">
      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle>Overtime request</CardTitle>
          <CardDescription>
            {s ? `File at least ${s.file_days_before} day${s.file_days_before === 1 ? "" : "s"} before (late filing up to ${s.late_filing_days_after} days after). Up to ${s.overtime_max_hours_day} h a day and ${s.overtime_max_hours_cutoff} h a cutoff. Only approved overtime is paid: the smaller of the approved hours and the hours you work past your shift end.` : "Only approved overtime is paid."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {separated ? <p className="text-sm text-muted-foreground" data-testid="separated-note">{SEPARATED_NOTE}</p> : (
          <form className="space-y-3" onSubmit={submit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="ot-date">Date</Label>
              <DatePicker id="ot-date" value={form.request_date} onChange={set("request_date")} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label htmlFor="ot-start">Planned start</Label><Input id="ot-start" type="time" value={form.planned_start} onChange={set("planned_start")} /></div>
              <div className="space-y-1.5"><Label htmlFor="ot-end">Planned end</Label><Input id="ot-end" type="time" value={form.planned_end} onChange={set("planned_end")} /></div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ot-reason">Reason / task</Label>
              <Textarea id="ot-reason" rows={3} maxLength={500} value={form.reason} onChange={set("reason")} placeholder="What the overtime is for" />
            </div>
            {error ? <p role="alert" className="text-sm text-destructive" data-testid="ot-error">{error}</p> : null}
            <Button type="submit" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <SendIcon aria-hidden="true" />}File overtime request</Button>
          </form>
          )}
        </CardContent>
      </Card>
      <Card className="min-w-0 shadow-xs">
        <CardHeader><CardTitle>My overtime requests</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={columns} rows={list.rows} loading={list.loading} error={list.error} onRetry={list.reload}
            searchPlaceholder="Search overtime…" empty={{ title: "No overtime requests yet", icon: ClockIcon }} caption="My overtime requests" minWidth={480} />
        </CardContent>
      </Card>
    </div>
  );
}

export function HrOvertimeRequests() {
  const { notify } = usePortalSession();
  const [status, setStatus] = React.useState("pending");
  const list = useRequests(`/api/hr/overtime-requests?status=${status}`);
  const [deciding, setDeciding] = React.useState(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function decide() {
    setBusy(true);
    try {
      const res = await apiFetch("/api/hr/overtime-requests", jsonBody("PATCH", { id: deciding.row.id, decision: deciding.decision, note }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Not saved.");
      notify(deciding.decision === "approve" ? "Overtime approved" : "Overtime rejected", `${deciding.row.employee_name} · ${deciding.row.request_date}`, "success");
      setDeciding(null);
      setNote("");
      list.reload();
    } catch (e) {
      notify("Not saved", e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", cell: (r) => (
      <div><p>{r.employee_name}</p><p className="text-xs font-normal text-muted-foreground">{r.employee_code}</p></div>
    ), searchValue: (r) => `${r.employee_name} ${r.employee_code}` },
    { key: "request_date", header: "Date", sortable: true, cell: (r) => (
      <div><p>{r.request_date}</p>{r.late_filing ? <StatusBadge tone="warning">Late filing</StatusBadge> : null}</div>
    ) },
    { key: "planned_start", header: "Requested", cell: (r) => (
      <div><p>{r.planned_start}-{r.planned_end} ({r.hours_text})</p><p className="text-xs text-muted-foreground line-clamp-2">{r.reason}</p></div>
    ) },
    { key: "facts", header: "Prepared by the system", cell: (r) => (
      <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="ot-facts">
        <li>Taps: {r.facts.time_in || "—"} to {r.facts.time_out || "—"} · shift ends {r.facts.shift_end || "—"}</li>
        <li>{r.facts.pay_text}</li>
        <li>Approved this cutoff: {r.facts.approved_in_cutoff_text}</li>
        {r.facts.pay_rule ? <li>{r.facts.pay_rule}</li> : null}
      </ul>
    ) },
    { key: "status", header: "Status", cell: (r) => (
      <div className="space-y-0.5"><RequestStatusBadge status={r.status} />{r.decided_by_name ? <p className="text-xs text-muted-foreground">{r.decided_by_name}{r.decision_note ? ` · ${r.decision_note}` : ""}</p> : null}</div>
    ) },
    { key: "actions", header: "", cell: (r) => (r.status === "pending" ? (
      <div className="flex gap-2">
        <Button size="sm" onClick={() => setDeciding({ row: r, decision: "approve" })}>Approve</Button>
        <Button size="sm" variant="outline" onClick={() => setDeciding({ row: r, decision: "reject" })}>Reject</Button>
      </div>
    ) : null) },
  ];

  return (
    <Card className="min-w-0 shadow-xs" data-testid="hr-overtime-requests">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Overtime requests</CardTitle>
          <CardDescription>Approving pays the smaller of the approved hours and the hours worked past the shift end.</CardDescription>
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["pending", "approved", "rejected", "cancelled", "all"].map((v) => <SelectItem key={v} value={v}>{v === "all" ? "All" : v.charAt(0).toUpperCase() + v.slice(1)}</SelectItem>)}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={list.rows} loading={list.loading} error={list.error} onRetry={list.reload}
          searchPlaceholder="Search employees…" empty={{ title: "No overtime requests", icon: ClockIcon }} caption="Overtime requests" minWidth={860} />
      </CardContent>
      <Dialog open={Boolean(deciding)} onOpenChange={(open) => { if (!open) { setDeciding(null); setNote(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deciding?.decision === "approve" ? "Approve overtime" : "Reject overtime"}</DialogTitle>
            <DialogDescription>{deciding ? `${deciding.row.employee_name} · ${deciding.row.request_date} · ${deciding.row.planned_start}-${deciding.row.planned_end} (${deciding.row.hours_text})` : ""}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="ot-note">{deciding?.decision === "reject" ? "Reason (required)" : "Note (optional)"}</Label>
            <Textarea id="ot-note" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeciding(null)}>Back</Button>
            <Button onClick={decide} disabled={busy || (deciding?.decision === "reject" && !note.trim())}>{deciding?.decision === "approve" ? "Approve" : "Reject"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
