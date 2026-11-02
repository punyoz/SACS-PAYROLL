"use client";

import * as React from "react";
import { CalendarHeartIcon, CheckIcon, Loader2Icon, PencilIcon, RefreshCwIcon, ShieldCheckIcon, Trash2Icon, UserPlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateTime } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Holidays & Duty (/api/holiday-duty, 20261102010000). The school is closed
 * on a holiday; HR picks who must still report (by person, branch or
 * position), with the shift and a note, and decides holiday work done
 * without an assignment. An Accountant sees their branch, read-only. Every
 * change is logged with who made it, and the employee is notified.
 */

const DUTY_NOTE_MAX = 200;

const TYPE_TONE = { holiday: "success", special: "gold", suspension: "info", special_working: "muted" };

function manilaYear() {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric" }).format(new Date()));
}

function longDate(key) {
  if (!key) return "";
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function clock(iso) {
  return iso ? new Date(iso).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" }) : "—";
}

export function HolidayDutyPage({ refreshKey }) {
  const [thisYear] = React.useState(manilaYear);
  const [year, setYear] = React.useState(thisYear);
  const [list, setList] = React.useState({ loading: true, error: null, rows: [], today: "", canAssign: false });
  const [selected, setSelected] = React.useState("");

  const loadList = React.useCallback(async () => {
    setList((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/holiday-duty?year=${year}`);
      setList({ loading: false, error: null, rows: data.holidays || [], today: data.today || "", canAssign: Boolean(data.can_assign) });
      // Start on the next day off from today.
      setSelected((current) => current || (data.holidays || []).find((h) => h.assignable && h.date >= (data.today || ""))?.date || "");
    } catch (error) {
      setList((c) => ({ ...c, loading: false, error: error.message || "Unable to load holidays." }));
    }
  }, [year]);
  React.useEffect(() => { loadList(); }, [loadList, refreshKey]);

  const columns = React.useMemo(() => [
    { key: "date", header: "Date", sortable: true, className: "whitespace-nowrap tabular-nums", cell: (r) => longDate(r.date) },
    {
      key: "name",
      header: "Holiday",
      sortable: true,
      cell: (r) => (
        <div className="space-y-1">
          <StatusBadge tone={TYPE_TONE[r.type] || "gold"} dot={false}>{r.label}</StatusBadge>
          {r.branch_ids?.length ? <p className="text-xs text-muted-foreground">Some branches only</p> : null}
        </div>
      ),
      searchValue: (r) => `${r.name} ${r.type_label}`,
    },
    { key: "assigned", header: "Required to report", align: "center", cell: (r) => (r.assignable ? r.assigned : "—") },
    {
      key: "open",
      header: <span className="sr-only">Open</span>,
      align: "right",
      cell: (r) => (
        <Button variant={selected === r.date ? "default" : "outline"} size="sm" onClick={() => setSelected(r.date)} aria-pressed={selected === r.date} aria-label={`Open ${r.name}`}>
          {selected === r.date ? "Open" : "View"}
        </Button>
      ),
    },
  ], [selected]);

  return (
    <div className="flex flex-col gap-4">
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CalendarHeartIcon className="size-4 text-gold-text" aria-hidden="true" />Holidays &amp; Duty</CardTitle>
          <CardDescription>
            The school is closed on a holiday: required hours are 0 and nobody is marked absent. {list.canAssign
              ? "Choose who must still report (guards, maintenance, registrar, event duty); they earn the holiday premium when they work."
              : "The staff HR requires to report are listed for each holiday."}
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={loadList} disabled={list.loading}><RefreshCwIcon className={cn(list.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={list.rows}
            rowKey={(r) => r.date}
            rowClassName={(r) => (r.date === selected ? "bg-brand-gold/8" : r.date < list.today ? "text-muted-foreground" : undefined)}
            loading={list.loading && !list.rows.length}
            error={list.error}
            onRetry={loadList}
            pageSize={10}
            searchPlaceholder="Search holidays…"
            toolbar={(
              <Select value={String(year)} onValueChange={(v) => { setSelected(""); setYear(Number(v)); }}>
                <SelectTrigger className="w-28" aria-label="Year"><SelectValue /></SelectTrigger>
                <SelectContent>{[thisYear - 1, thisYear, thisYear + 1].map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
              </Select>
            )}
            empty={{ title: `No holidays saved for ${year}`, description: "The Super Admin adds them from the year's proclamation.", icon: CalendarHeartIcon }}
            caption="Holidays"
            minWidth={560}
          />
        </CardContent>
      </Card>
      {selected ? <HolidayDetail key={selected} date={selected} refreshKey={refreshKey} onChanged={loadList} /> : null}
    </div>
  );
}

function HolidayDetail({ date, refreshKey, onChanged }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [editing, setEditing] = React.useState(null);
  const [busy, setBusy] = React.useState("");

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/holiday-duty?date=${encodeURIComponent(date)}`);
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState((c) => ({ ...c, loading: false, error: error.message || "Unable to load the holiday." }));
    }
  }, [date]);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const changed = React.useCallback(async () => { await load(); onChanged?.(); }, [load, onChanged]);
  const data = state.data;
  const canAssign = Boolean(data?.can_assign);

  const remove = React.useCallback(async (row) => {
    const ok = await confirm({
      title: `Remove ${row.employee_name}'s holiday duty?`,
      description: "They will no longer be required to report that day. They are notified.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchJson(`/api/holiday-duty?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      notify("Holiday duty removed", row.employee_name, "info");
      await changed();
    } catch (error) {
      notify("Unable to remove", error.message, "error");
    }
  }, [confirm, changed, notify]);

  const review = React.useCallback(async (row, decision) => {
    setBusy(`${row.employee_id}-${decision}`);
    try {
      await fetchJson("/api/holiday-duty", jsonBody("POST", { action: "review", holiday_date: date, employee_id: row.employee_id, decision }));
      notify(decision === "approved" ? "Holiday work approved" : "Holiday work not approved", row.employee_name, "success");
      await changed();
    } catch (error) {
      notify("Unable to save", error.message, "error");
    } finally {
      setBusy("");
    }
  }, [date, changed, notify]);

  const assignedColumns = React.useMemo(() => [
    {
      key: "employee_name",
      header: "Employee",
      sortable: true,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.employee_name}</p>
          <p className="text-xs text-muted-foreground">{[r.employee_code, r.position, r.branch_name].filter(Boolean).join(" · ")}</p>
        </div>
      ),
      searchValue: (r) => `${r.employee_name} ${r.position || ""} ${r.branch_name}`,
    },
    { key: "shift", header: "Shift", className: "whitespace-nowrap tabular-nums", cell: (r) => `${r.shift_start}–${r.shift_end}` },
    { key: "required_hours", header: "Hours", align: "center" },
    { key: "note", header: "Note", cell: (r) => r.note || <span className="text-muted-foreground">—</span> },
    {
      key: "taps",
      header: "Taps",
      className: "whitespace-nowrap",
      cell: (r) => (r.time_in
        ? <span className="tabular-nums">{clock(r.time_in)} – {clock(r.time_out)}</span>
        : r.no_show ? <StatusBadge tone="warning">No tap: for HR to decide</StatusBadge> : <span className="text-muted-foreground">—</span>),
    },
    { key: "assigned_by_name", header: "Assigned by", className: "text-muted-foreground", cell: (r) => r.updated_by_name ? `${r.assigned_by_name || "HR"} (changed by ${r.updated_by_name})` : r.assigned_by_name || "HR" },
    ...(canAssign ? [{
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="sm" onClick={() => setEditing(r)} aria-label={`Change ${r.employee_name}'s duty`}><PencilIcon aria-hidden="true" />Edit</Button>
          <Button variant="outline" size="sm" onClick={() => remove(r)} aria-label={`Remove ${r.employee_name}'s duty`}><Trash2Icon aria-hidden="true" /></Button>
        </div>
      ),
    }] : []),
  ], [canAssign, remove]);

  const workColumns = React.useMemo(() => [
    { key: "employee_name", header: "Employee", sortable: true, cell: (r) => <div><p className="font-medium">{r.employee_name}</p><p className="text-xs text-muted-foreground">{r.branch_name}</p></div> },
    { key: "taps", header: "Taps", className: "whitespace-nowrap tabular-nums", cell: (r) => `${clock(r.time_in)} – ${clock(r.time_out)}` },
    {
      key: "decision",
      header: "Holiday work",
      cell: (r) => (r.decision === "approved"
        ? <StatusBadge tone="success">Approved{r.decided_by_name ? ` by ${r.decided_by_name}` : ""}</StatusBadge>
        : r.decision === "rejected" ? <StatusBadge tone="muted">Not approved{r.decided_by_name ? ` by ${r.decided_by_name}` : ""}</StatusBadge>
          : <StatusBadge tone="warning">Waiting for HR</StatusBadge>),
    },
    ...(data?.can_assign || data?.candidates ? [{
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant={r.decision === "approved" ? "default" : "outline"} disabled={Boolean(busy)} onClick={() => review(r, "approved")} aria-label={`Approve ${r.employee_name}'s holiday work`}>
            {busy === `${r.employee_id}-approved` ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <CheckIcon aria-hidden="true" />}Approve
          </Button>
          <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => review(r, "rejected")} aria-label={`Do not approve ${r.employee_name}'s holiday work`}>
            {busy === `${r.employee_id}-rejected` ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <XIcon aria-hidden="true" />}Reject
          </Button>
        </div>
      ),
    }] : []),
  ], [data?.can_assign, data?.candidates, busy, review]);

  if (state.error && !data) return <Card className="shadow-xs"><CardContent><ErrorState message={state.error} onRetry={load} /></CardContent></Card>;
  if (!data) return <Card className="shadow-xs"><CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin" aria-hidden="true" />Loading the holiday…</CardContent></Card>;

  const h = data.holiday;
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {longDate(h.date)}
          <StatusBadge tone={TYPE_TONE[h.type] || "gold"} dot={false}>{h.label}</StatusBadge>
        </CardTitle>
        <CardDescription>
          {h.assignable
            ? "Closed: required hours 0 for everyone not listed below. Nobody listed is deducted for not tapping; HR decides each case."
            : "A special working day or a part-day suspension: an ordinary working day, no holiday duty."}
          {h.source ? ` Source: ${h.source}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {canAssign ? <AssignForm data={data} onAssigned={changed} /> : null}

        <section className="space-y-2" aria-labelledby="duty-assigned">
          <h3 id="duty-assigned" className="flex items-center gap-2 text-sm font-semibold"><ShieldCheckIcon className="size-4 text-gold-text" aria-hidden="true" />Required to report ({data.assigned.length})</h3>
          <DataTable
            columns={assignedColumns}
            rows={data.assigned}
            rowKey={(r) => r.id}
            rowClassName={(r) => (r.no_show ? "bg-warning/8" : undefined)}
            loading={state.loading && !data.assigned.length}
            pageSize={10}
            searchPlaceholder="Search assigned staff…"
            empty={{ title: "Nobody is required to report", description: h.assignable ? "The school is closed for everyone." : null, icon: ShieldCheckIcon }}
            caption="Staff required to report"
            minWidth={760}
          />
        </section>

        {h.assignable ? (
          <section className="space-y-2" aria-labelledby="duty-unassigned">
            <h3 id="duty-unassigned" className="text-sm font-semibold">Worked without an assignment ({data.unassigned_work.length})</h3>
            <p className="text-sm text-muted-foreground">Their taps are kept. The holiday premium is paid only when HR approves the work.</p>
            <DataTable
              columns={workColumns}
              rows={data.unassigned_work}
              rowKey={(r) => r.employee_id}
              searchable={false}
              paginate={false}
              empty={{ title: "Nobody tapped in without an assignment" }}
              caption="Holiday work without an assignment"
              minWidth={560}
            />
          </section>
        ) : null}

        {data.history.length ? (
          <section className="space-y-2" aria-labelledby="duty-history">
            <h3 id="duty-history" className="text-sm font-semibold">History</h3>
            <ul className="divide-y rounded-lg border text-sm">
              {data.history.slice(0, 15).map((e, i) => (
                <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                  <span>
                    <span className="font-medium">{e.actor_name || "HR"}</span>{" "}
                    {{ assigned: "assigned", changed: "changed the duty of", removed: "removed the duty of", work_approved: "approved the holiday work of", work_rejected: "did not approve the holiday work of" }[e.action] || e.action}{" "}
                    <span className="font-medium">{e.employee_name || "an employee"}</span>
                    {e.details?.shift ? <span className="text-muted-foreground"> · {e.details.shift}</span> : null}
                    {e.details?.to?.shift ? <span className="text-muted-foreground"> · now {e.details.to.shift}</span> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{dateTime(e.created_at)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
      {editing ? <EditDutyDialog row={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await changed(); }} /> : null}
      {confirmDialog}
    </Card>
  );
}

function AssignForm({ data, onAssigned }) {
  const { notify } = usePortalSession();
  const [mode, setMode] = React.useState("employee");
  const [picked, setPicked] = React.useState([]);
  const [search, setSearch] = React.useState("");
  const [branchId, setBranchId] = React.useState("");
  const [position, setPosition] = React.useState("");
  const [ownShift, setOwnShift] = React.useState(true);
  const [shift, setShift] = React.useState({ start: "08:00", end: "17:00", hours: "" });
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const open = (data.candidates || []).filter((c) => !c.assigned);
  const shown = open.filter((c) => `${c.full_name} ${c.position || ""} ${c.branch_name} ${c.employee_code || ""}`.toLowerCase().includes(search.trim().toLowerCase()));

  async function submit(event) {
    event.preventDefault();
    setError("");
    const target = mode === "employee" ? { employee_ids: picked } : mode === "branch" ? { branch_id: branchId } : { position };
    if (mode === "employee" && !picked.length) return setError("Tick at least one employee.");
    if (mode === "branch" && !branchId) return setError("Choose the branch.");
    if (mode === "position" && !position) return setError("Choose the position.");
    if (!ownShift && (!shift.start || !shift.end || shift.end <= shift.start)) return setError("The shift must end after it starts.");
    setSaving(true);
    try {
      const result = await fetchJson("/api/holiday-duty", jsonBody("POST", {
        action: "assign", holiday_date: data.holiday.date, ...target, note: note.trim(),
        ...(ownShift ? {} : { shift_start: shift.start, shift_end: shift.end, required_hours: shift.hours }),
      }));
      notify("Holiday duty assigned", `${result.assigned} assigned${result.skipped ? `, ${result.skipped} already were` : ""}. They are notified.`, "success");
      setPicked([]);
      setNote("");
      await onAssigned();
    } catch (err) {
      setError(err.message || "Unable to assign.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-lg border border-brand-gold/40 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold"><UserPlusIcon className="size-4 text-gold-text" aria-hidden="true" />Require staff to report</p>
      <Tabs value={mode} onValueChange={(v) => { setMode(v); setError(""); }}>
        <TabsList>
          <TabsTrigger value="employee">Employees</TabsTrigger>
          <TabsTrigger value="branch">Whole branch</TabsTrigger>
          <TabsTrigger value="position">Position</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "employee" ? (
        <div className="space-y-2">
          <Label htmlFor="duty-search">Employees <span className="font-normal text-muted-foreground">({picked.length} ticked)</span></Label>
          <Input id="duty-search" type="search" placeholder="Search name, position, branch…" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} />
          <div className="max-h-56 overflow-y-auto rounded-md border p-2" role="group" aria-label="Employees">
            {shown.length ? shown.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                <Checkbox checked={picked.includes(c.id)} onCheckedChange={(on) => setPicked((p) => (on ? [...p, c.id] : p.filter((id) => id !== c.id)))} />
                <span className="font-medium">{c.full_name}</span>
                <span className="text-xs text-muted-foreground">{[c.position, c.branch_name].filter(Boolean).join(" · ")}</span>
              </label>
            )) : <EmptyState title={open.length ? "No match" : "Everyone is already assigned"} className="py-4" />}
          </div>
        </div>
      ) : null}
      {mode === "branch" ? (
        <div className="max-w-sm space-y-2">
          <Label htmlFor="duty-branch">Branch</Label>
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger id="duty-branch" className="w-full"><SelectValue placeholder="Choose a branch" /></SelectTrigger>
            <SelectContent>{(data.branches || []).map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Everyone active in the branch. Each person can be changed or removed afterwards.</p>
        </div>
      ) : null}
      {mode === "position" ? (
        <div className="max-w-sm space-y-2">
          <Label htmlFor="duty-position">Position</Label>
          <Select value={position} onValueChange={setPosition}>
            <SelectTrigger id="duty-position" className="w-full"><SelectValue placeholder="Choose a position" /></SelectTrigger>
            <SelectContent>{(data.positions || []).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Everyone with this position in every branch the holiday applies to.</p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-4">
          <Checkbox checked={ownShift} onCheckedChange={(on) => setOwnShift(Boolean(on))} />
          Use each person&apos;s normal shift
        </label>
        {!ownShift ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="duty-start">Shift start</Label>
              <Input id="duty-start" type="time" value={shift.start} onChange={(e) => setShift((s) => ({ ...s, start: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="duty-end">Shift end</Label>
              <Input id="duty-end" type="time" value={shift.end} onChange={(e) => setShift((s) => ({ ...s, end: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="duty-hours">Required hours <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="duty-hours" type="number" min="0.25" max="12" step="0.25" placeholder="From the shift" value={shift.hours} onChange={(e) => setShift((s) => ({ ...s, hours: e.target.value }))} />
            </div>
          </>
        ) : null}
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="duty-note">Note <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Input id="duty-note" maxLength={DUTY_NOTE_MAX} placeholder="e.g. Guard duty" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving}>{saving ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Assigning…</> : "Assign"}</Button>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </div>
    </form>
  );
}

function EditDutyDialog({ row, onClose, onSaved }) {
  const [form, setForm] = React.useState({ start: row.shift_start, end: row.shift_end, hours: String(row.required_hours), note: row.note || "" });
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function save(event) {
    event.preventDefault();
    if (!form.start || !form.end || form.end <= form.start) return setError("The shift must end after it starts.");
    setSaving(true);
    setError("");
    try {
      await fetchJson("/api/holiday-duty", jsonBody("PATCH", { id: row.id, shift_start: form.start, shift_end: form.end, required_hours: form.hours, note: form.note.trim() }));
      await onSaved();
    } catch (err) {
      setError(err.message || "Unable to save.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={save} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Change {row.employee_name}&apos;s duty</DialogTitle>
            <DialogDescription>They are notified of the new shift.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="edit-duty-start">Shift start</Label>
              <Input id="edit-duty-start" type="time" value={form.start} onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-duty-end">Shift end</Label>
              <Input id="edit-duty-end" type="time" value={form.end} onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-duty-hours">Required hours</Label>
              <Input id="edit-duty-hours" type="number" min="0.25" max="12" step="0.25" value={form.hours} onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-duty-note">Note</Label>
            <Input id="edit-duty-note" maxLength={DUTY_NOTE_MAX} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The employee's own upcoming holiday duty (dashboard card); nothing when none. */
export function MyHolidayDuty({ refreshKey }) {
  const [rows, setRows] = React.useState([]);
  React.useEffect(() => {
    let live = true;
    fetchJson("/api/holiday-duty?mine=1").then((data) => { if (live) setRows(data.duty || []); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [refreshKey]);
  if (!rows.length) return null;
  return (
    <Card className="border-info/40 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ShieldCheckIcon className="size-4 text-info" aria-hidden="true" />Holiday duty</CardTitle>
        <CardDescription>HR requires you to report on these days, though the school is closed.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-lg border text-sm">
          {rows.map((d) => (
            <li key={d.date} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="font-medium">{longDate(d.date)}</span>
                <span className="ml-2"><StatusBadge tone="gold" dot={false} className="px-1.5 py-0 text-[10px]">{d.holiday_label}</StatusBadge></span>
                {d.note ? <span className="ml-2 text-muted-foreground">{d.note}</span> : null}
              </span>
              <span className="tabular-nums">{d.shift_start}–{d.shift_end} · {d.required_hours} h</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
