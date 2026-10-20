"use client";

import * as React from "react";
import { HistoryIcon, Loader2Icon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateTime } from "@/lib/portal/payroll-preview";
import { STATUS_LABELS, STATUS_TONES } from "@/lib/branch-requests";
import { cn } from "@/lib/utils";

/*
 * Shared pieces of the branch Admin's oversight pages
 * (/api/admin/branch-oversight): a loader that never drops what it already
 * shows, the status badge, the history dialog, a filing dialog and the
 * request table every "sent to HR" page uses.
 */

export const API = "/api/admin/branch-oversight";

/**
 * GET a view. The newest request wins; a failed reload keeps the data
 * already on screen (with the error), so nothing vanishes on a blip.
 */
export function useBranchView(view, params = {}, refreshKey = 0) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const seq = React.useRef(0);
  const query = new URLSearchParams({ view, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")) }).toString();
  const load = React.useCallback(async () => {
    const mine = ++seq.current;
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(`${API}?${query}`);
      if (mine !== seq.current) return;
      if (data.available === false) throw new Error(data.error || "Not available yet.");
      setState({ loading: false, error: null, data });
    } catch (error) {
      if (mine !== seq.current) return;
      setState((c) => ({ loading: false, error: error.message || "Unable to load.", data: c.data }));
    }
  }, [query]);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  return { ...state, load, first: state.loading && !state.data };
}

export function RequestStatus({ status, label }) {
  return <StatusBadge tone={STATUS_TONES[status] || "muted"}>{label || STATUS_LABELS[status] || status}</StatusBadge>;
}

/** "Who, when, status, remark" for every step of a request. */
export function HistoryButton({ request }) {
  const [open, setOpen] = React.useState(false);
  const entries = request?.history || [];
  if (!entries.length) return null;
  return (
    <>
      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setOpen(true)} aria-label="History"><HistoryIcon aria-hidden="true" />History</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>History</DialogTitle>
            <DialogDescription>{request.kind_label}{request.employee_name ? ` · ${request.employee_name}` : ""}</DialogDescription>
          </DialogHeader>
          <ol className="space-y-3 border-l pl-4">
            {entries.map((h, i) => (
              <li key={`${h.at}-${i}`} className="relative">
                <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full bg-primary" aria-hidden="true" />
                <div className="flex flex-wrap items-center gap-2">
                  <RequestStatus status={h.status} />
                  <span className="text-xs text-muted-foreground">{h.at ? dateTime(h.at) : ""}</span>
                </div>
                <p className="mt-1 text-sm"><span className="font-medium">{h.by_name || "—"}</span>{h.role ? <span className="text-muted-foreground"> ({h.role === "hr" ? "HR" : h.role === "super_admin" ? "Super Admin" : "Branch Admin"})</span> : null}</p>
                {h.note ? <p className="text-sm whitespace-pre-wrap text-muted-foreground">{h.note}</p> : null}
              </li>
            ))}
          </ol>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** HR's (or the Super Admin's) decision, under a request. */
export function DecisionCell({ request }) {
  if (!request?.decided_at) return <span className="text-xs text-muted-foreground">{request?.status === "pending" ? "Waiting for HR" : "—"}</span>;
  return (
    <div className="max-w-64 text-xs whitespace-normal">
      <p className="font-medium">{request.decided_by_name}{request.decided_by_role === "super_admin" ? " (Super Admin)" : " (HR)"}</p>
      <p className="text-muted-foreground">{dateTime(request.decided_at)}</p>
      {request.decision_note ? <p className="mt-0.5">{request.decision_note}</p> : null}
    </div>
  );
}

export function FiledCell({ request }) {
  return (
    <div className="text-xs whitespace-nowrap">
      <p>{request.created_by_name || "—"}</p>
      <p className="text-muted-foreground">{request.created_at ? dateTime(request.created_at) : ""}</p>
    </div>
  );
}

/**
 * A filing dialog. fields: [{ id, label, type: "employee"|"select"|"date"|"number"|"text"|"textarea", options?, min?, max?, placeholder? }].
 * `note` (the remark for HR) is always last and required.
 */
export function FileDialog({ open, onOpenChange, title, description, fields, employees = [], initial = {}, submitLabel = "Send to HR", decisions = null, onSubmit }) {
  const [values, setValues] = React.useState(initial);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setValues(initial); setError(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (id, v) => setValues((c) => ({ ...c, [id]: v }));

  async function submit(decision) {
    if (!String(values.note || "").trim()) { setError("Write a remark for HR."); return; }
    setBusy(true); setError("");
    try {
      await onSubmit({ ...values, decision });
      onOpenChange(false);
    } catch (err) {
      setError(err.message || "Not sent.");
    } finally {
      setBusy(false);
    }
  }

  const field = (f) => {
    const id = `ov-${f.id}`;
    let control;
    if (f.type === "employee") {
      control = (
        <Select value={values[f.id] || ""} onValueChange={(v) => set(f.id, v)}>
          <SelectTrigger id={id} className="w-full"><SelectValue placeholder={employees.length ? "Select employee" : "No employees"} /></SelectTrigger>
          <SelectContent>{employees.map((e) => <SelectItem key={e.id} value={e.id}>{`${e.full_name}${e.employee_code ? ` — ${e.employee_code}` : ""}`}</SelectItem>)}</SelectContent>
        </Select>
      );
    } else if (f.type === "select") {
      control = (
        <Select value={values[f.id] || ""} onValueChange={(v) => set(f.id, v)}>
          <SelectTrigger id={id} className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
          <SelectContent>{Object.entries(f.options || {}).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>
      );
    } else if (f.type === "date") {
      control = <DatePicker id={id} value={values[f.id] || ""} onChange={(v) => set(f.id, v)} min={f.min} max={f.max} />;
    } else if (f.type === "textarea") {
      control = <Textarea id={id} rows={3} maxLength={500} placeholder={f.placeholder} value={values[f.id] || ""} onChange={(e) => set(f.id, e.target.value)} />;
    } else {
      control = <Input id={id} type={f.type === "number" ? "number" : "text"} min={f.min} max={f.max} step={f.step} inputMode={f.type === "number" ? "decimal" : undefined} placeholder={f.placeholder} value={values[f.id] || ""} onChange={(e) => set(f.id, e.target.value)} />;
    }
    if (f.when && !f.when(values)) return null;
    return <div key={f.id} className={cn("space-y-1.5", f.wide && "sm:col-span-2")}><Label htmlFor={id}>{f.label}</Label>{control}{f.hint ? <p className="text-xs text-muted-foreground">{typeof f.hint === "function" ? f.hint(values) : f.hint}</p> : null}</div>;
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {(fields || []).map(field)}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ov-note">Remark for HR <span className="font-normal text-muted-foreground">(required)</span></Label>
            <Textarea id="ov-note" rows={3} maxLength={1000} value={values.note || ""} onChange={(e) => set("note", e.target.value)} aria-invalid={Boolean(error) || undefined} />
          </div>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          {decisions ? (
            <>
              <Button variant="outline" className="text-destructive" onClick={() => submit("not_endorse")} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Not endorse</Button>
              <Button onClick={() => submit("endorse")} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Endorse</Button>
            </>
          ) : (
            <Button onClick={() => submit()} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{submitLabel}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** POST a filing; the server checks everything again. */
export async function fileRequest(kind, { employee_id, ref_id, decision, note, ...details }) {
  return fetchJson(API, jsonBody("POST", { action: "file", kind, employee_id: employee_id || undefined, ref_id: ref_id || undefined, decision, note, details }));
}

/**
 * A "sent to HR" page: the filing button and dialog, and every request of the
 * kind with its status, HR's decision and history (kept for good).
 */
export function RequestsPage({ refreshKey, kind, title, description, icon: Icon, fields, columns = [], buttonLabel, dialogTitle, dialogDescription, decisions = false, banner = null, initial = {}, empty }) {
  const { notify } = usePortalSession();
  const view = useBranchView("requests", { kind }, refreshKey);
  const [open, setOpen] = React.useState(false);
  const data = view.data;
  const allColumns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", cell: (r) => r.employee_name || r.details?.employee_name || "—", searchValue: (r) => r.employee_name || r.details?.employee_name },
    ...columns,
    { key: "admin_note", header: "Your remark", cell: (r) => <p className="max-w-64 text-xs whitespace-normal">{r.admin_note}</p>, searchValue: (r) => r.admin_note },
    { key: "filed", header: "Sent", sortValue: (r) => r.created_at, cell: (r) => <FiledCell request={r} /> },
    { key: "status", header: "Status", sortValue: (r) => r.status_label, cell: (r) => <RequestStatus status={r.status} label={r.status_label} />, searchValue: (r) => r.status_label },
    { key: "decision", header: "HR decision", cell: (r) => <DecisionCell request={r} /> },
    { key: "history", header: <span className="sr-only">History</span>, align: "right", cell: (r) => <HistoryButton request={r} /> },
  ];
  return (
    <>
      {typeof banner === "function" ? banner(data) : banner}
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">{Icon ? <Icon className="size-4 text-gold-text" aria-hidden="true" /> : null}{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
          <CardAction className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={view.load} disabled={view.loading}><RefreshCwIcon className={cn(view.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
            <Button size="sm" onClick={() => setOpen(true)} disabled={!data}><PlusIcon aria-hidden="true" />{buttonLabel}</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={allColumns} rows={data?.requests || []} loading={view.first} error={view.error} onRetry={view.load} pageSize={15}
            searchPlaceholder="Search employee, remark or status…" empty={empty || { title: "Nothing sent yet", icon: Icon }} caption={title} minWidth={1100} />
        </CardContent>
      </Card>
      <FileDialog open={open} onOpenChange={setOpen} title={dialogTitle || buttonLabel} description={dialogDescription} fields={fields}
        employees={data?.employees || []} initial={initial} decisions={decisions ? true : null}
        onSubmit={async (values) => {
          await fileRequest(kind, values);
          notify("Sent to HR", "HR has been notified. The status is shown here.", "success");
          await view.load();
        }} />
    </>
  );
}
