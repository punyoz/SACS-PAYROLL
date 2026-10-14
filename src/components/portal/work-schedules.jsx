"use client";

import * as React from "react";
import { ArchiveIcon, CalendarClockIcon, Loader2Icon, PencilIcon, PlusIcon, RefreshCwIcon, UsersIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { WEEKDAYS } from "@/lib/attendance/work-schedules";
import { cn } from "@/lib/utils";

/*
 * Employee Work Schedules (/api/admin/work-schedules). Super Admin and HR
 * create, edit and delete schedule profiles, assign them to each employee or
 * to a whole level, and set employees' levels; Admin sees its own branch
 * read-only (the server refuses its changes whatever this screen shows). Every change takes effect from a date (today or later),
 * so past attendance and payslips are never recalculated.
 *
 * Schedule priority: the employee's own → their level's → their branch's →
 * the default schedule.
 */

const FALLBACK = "__fallback__";
const SOURCE = {
  employee: { label: "Own schedule", tone: "success" },
  level: { label: "By level", tone: "info" },
  branch: { label: "Branch", tone: "gold" },
  default: { label: "Default", tone: "muted" },
};

const time12 = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm || "—";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const shift = (s) => `${time12(s.work_start)} – ${time12(s.work_end)}`;

const EMPTY_PROFILE = { schedule_key: "", name: "", work_start: "08:00", work_end: "17:00", grace_minutes: "15", work_hours: "8", working_days: [1, 2, 3, 4, 5], effective_from: "", note: "" };

export function WorkSchedulesPanel({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [dialog, setDialog] = React.useState(null);
  const [input, setInput] = React.useState({});
  const [dialogError, setDialogError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState(() => new Set());

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/admin/work-schedules");
      if (!data.available) throw new Error(data.error || "Employee work schedules are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const canEdit = Boolean(data?.can_edit);
  const today = data?.today || "";
  const activeProfiles = (data?.profiles || []).filter((p) => !p.archived);

  const open = (kind, values = {}) => {
    setDialogError("");
    setInput({ effective_from: today, note: "", ...values });
    setDialog({ kind });
  };

  async function submit(body, done) {
    setBusy(true);
    setDialogError("");
    try {
      await fetchJson("/api/admin/work-schedules", jsonBody("POST", body));
      notify("Work Schedules", done, "success");
      setDialog(null);
      setSelected(new Set());
      await load();
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const kind = dialog?.kind;
    if (kind === "profile") {
      submit({
        action: "save_schedule",
        schedule_key: input.schedule_key || undefined,
        name: input.name,
        work_start: input.work_start,
        work_end: input.work_end,
        grace_minutes: Number(input.grace_minutes),
        work_hours: Number(input.work_hours),
        working_days: input.working_days,
        effective_from: input.effective_from,
        note: input.note,
      }, input.schedule_key ? `"${input.name}" changes from ${dateLabel(input.effective_from)}.` : `"${input.name}" created.`);
    } else if (kind === "archive") {
      submit({ action: "delete_schedule", schedule_key: input.schedule_key, effective_from: input.effective_from, note: input.note }, `"${input.name}" deleted from ${dateLabel(input.effective_from)}.`);
    } else if (kind === "level") {
      submit({ action: "assign", target: "level", level: input.level, schedule_key: input.schedule_key === FALLBACK ? null : input.schedule_key, effective_from: input.effective_from, note: input.note },
        `Level schedule saved from ${dateLabel(input.effective_from)}.`);
    } else if (kind === "employees") {
      submit({ action: "assign", target: "employee", employee_ids: input.employee_ids, schedule_key: input.schedule_key === FALLBACK ? null : input.schedule_key, effective_from: input.effective_from, note: input.note },
        `Schedule assigned from ${dateLabel(input.effective_from)}.`);
    } else if (kind === "set_level") {
      submit({ action: "set_level", employee_ids: input.employee_ids, level: input.level === FALLBACK ? null : input.level }, "Employee level saved.");
    }
  }

  const employeeColumns = [
    ...(canEdit ? [{
      key: "pick",
      header: <span className="sr-only">Select</span>,
      cell: (row) => (
        <Checkbox
          checked={selected.has(row.id)}
          onCheckedChange={(v) => setSelected((c) => { const next = new Set(c); if (v === true) next.add(row.id); else next.delete(row.id); return next; })}
          aria-label={`Select ${row.full_name}`}
        />
      ),
    }] : []),
    { key: "full_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => `${r.full_name} ${r.employee_code || ""}`, cell: (r) => <span>{r.full_name}<span className="block text-xs text-muted-foreground">{r.employee_code || ""}{r.position ? ` · ${r.position}` : ""}</span></span> },
    { key: "branch_name", header: "Branch", sortable: true, cell: (r) => r.branch_name || "—" },
    { key: "level_label", header: "Level", sortable: true, cell: (r) => r.level_label || <span className="text-muted-foreground">Not set</span> },
    {
      key: "follows",
      header: "Schedule today",
      sortValue: (r) => r.follows.name,
      searchValue: (r) => r.follows.name,
      cell: (r) => (
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5"><span>{r.follows.name}</span><StatusBadge tone={SOURCE[r.follows.source]?.tone}>{SOURCE[r.follows.source]?.label}</StatusBadge></div>
          <p className="text-xs text-muted-foreground tabular-nums">{shift(r.follows)} · grace {r.follows.grace} min · {r.follows.work_hours} h · {r.follows.working_days_label}</p>
          {r.own_upcoming?.length ? (
            <p className="text-xs text-info">From {dateLabel(r.own_upcoming[0].effective_from)}: {r.own_upcoming[0].schedule_name || "level / branch schedule"}</p>
          ) : null}
        </div>
      ),
    },
    ...(canEdit ? [{
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (r) => <Button variant="outline" size="sm" onClick={() => open("employees", { employee_ids: [r.id], names: r.full_name, schedule_key: r.own?.schedule_key || FALLBACK })}>Assign</Button>,
    }] : []),
  ];

  if (state.error) {
    return <Alert className="border-warning/40 bg-warning/5"><AlertDescription>Employee Work Schedules: {state.error}</AlertDescription></Alert>;
  }

  const scheduleOptions = (allowFallback) => (
    <SelectContent>
      {allowFallback ? <SelectItem value={FALLBACK}>No own schedule (use level / branch / default)</SelectItem> : null}
      {activeProfiles.map((p) => <SelectItem key={p.schedule_key} value={p.schedule_key}>{p.name} — {shift(p)}</SelectItem>)}
    </SelectContent>
  );
  const effectiveField = (
    <div className="space-y-1.5">
      <Label htmlFor="ws-effective">Takes effect from</Label>
      <DatePicker id="ws-effective" value={input.effective_from} onChange={(v) => setInput((c) => ({ ...c, effective_from: v }))} min={today} />
      <p className="text-xs text-muted-foreground">Today or later. Earlier attendance and payslips stay as they are.</p>
    </div>
  );
  const noteField = (
    <div className="space-y-1.5">
      <Label htmlFor="ws-note">Note <span className="font-normal text-muted-foreground">(optional, kept in the audit log)</span></Label>
      <Input id="ws-note" maxLength={500} value={input.note || ""} onChange={(e) => setInput((c) => ({ ...c, note: e.target.value }))} />
    </div>
  );

  return (
    <>
      {!canEdit && data ? (
        <Alert className="border-info/30 bg-info/5"><AlertDescription>View only. Only Super Admin and HR can create or change schedules. Priority: the employee&apos;s own schedule, then their level&apos;s, then their branch&apos;s, then the default.</AlertDescription></Alert>
      ) : null}

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CalendarClockIcon className="size-4 text-gold-text" aria-hidden="true" />Employee work schedules</CardTitle>
          <CardDescription>Schedule profiles (for example Pre-school Teacher or Non-teaching Staff). An employee&apos;s own schedule comes first, then the one for their level, then their branch schedule above, then the default.</CardDescription>
          <CardAction className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
            {canEdit ? <Button size="sm" onClick={() => open("profile", { ...EMPTY_PROFILE, effective_from: today })}><PlusIcon aria-hidden="true" />New schedule</Button> : null}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Schedule</TableHead><TableHead>Hours</TableHead><TableHead>Grace</TableHead><TableHead>Required</TableHead><TableHead>Working days</TableHead><TableHead>Status</TableHead>{canEdit ? <TableHead className="text-right">Actions</TableHead> : null}</TableRow>
              </TableHeader>
              <TableBody>
                {(data?.profiles || []).length ? data.profiles.map((p) => (
                  <TableRow key={p.schedule_key}>
                    <TableCell className="font-medium">{p.name}{p.upcoming?.length ? <span className="block text-xs text-info">Changes {dateLabel(p.upcoming[0].effective_from)}: {p.upcoming[0].archived ? "archived" : `${shift(p.upcoming[0])}, ${p.upcoming[0].work_hours} h`}</span> : null}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{shift(p)}</TableCell>
                    <TableCell className="tabular-nums">{p.grace_minutes} min</TableCell>
                    <TableCell className="tabular-nums">{p.work_hours} h</TableCell>
                    <TableCell>{p.working_days_label}</TableCell>
                    <TableCell>{p.archived ? <StatusBadge>Deleted</StatusBadge> : p.starts_on ? <StatusBadge tone="info">From {dateLabel(p.starts_on)}</StatusBadge> : <StatusBadge tone="success">In use</StatusBadge>}</TableCell>
                    {canEdit ? (
                      <TableCell className="text-right whitespace-nowrap">
                        {!p.archived ? (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => open("profile", { ...p, grace_minutes: String(p.grace_minutes), work_hours: String(p.work_hours), effective_from: today, note: "" })}><PencilIcon aria-hidden="true" />Edit</Button>
                            <Button variant="ghost" size="sm" onClick={() => open("archive", { schedule_key: p.schedule_key, name: p.name })}><ArchiveIcon aria-hidden="true" />Delete</Button>
                          </>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                )) : (
                  <TableRow><TableCell colSpan={canEdit ? 7 : 6} className="text-muted-foreground">{state.loading ? "Loading…" : "No schedule profiles yet. Everyone follows their branch schedule or the default."}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Schedule by employee level</p>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader><TableRow><TableHead>Level</TableHead><TableHead>Schedule</TableHead><TableHead>Upcoming</TableHead>{canEdit ? <TableHead className="text-right">Actions</TableHead> : null}</TableRow></TableHeader>
                <TableBody>
                  {(data?.levels || []).map((l) => (
                    <TableRow key={l.level}>
                      <TableCell className="font-medium">{l.label}</TableCell>
                      <TableCell>{l.current?.schedule_name ? <>{l.current.schedule_name}<span className="block text-xs text-muted-foreground">since {dateLabel(l.current.effective_from)}</span></> : <span className="text-muted-foreground">None (branch / default)</span>}</TableCell>
                      <TableCell>{l.upcoming?.length ? `${dateLabel(l.upcoming[0].effective_from)}: ${l.upcoming[0].schedule_name || "none"}` : "—"}</TableCell>
                      {canEdit ? <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => open("level", { level: l.level, label: l.label, schedule_key: l.current?.schedule_key || FALLBACK })}>Assign</Button></TableCell> : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><UsersIcon className="size-4 text-gold-text" aria-hidden="true" />Employees and their schedules</CardTitle>
          <CardDescription>Employees in the same branch can follow different schedules. RFID Late, Undertime and Absent, timesheets and payroll deductions all use the schedule shown here for each day.</CardDescription>
          {canEdit && selected.size ? (
            <CardAction className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => open("employees", { employee_ids: [...selected], names: `${selected.size} employees`, schedule_key: FALLBACK })}>Assign schedule ({selected.size})</Button>
              <Button size="sm" variant="outline" onClick={() => open("set_level", { employee_ids: [...selected], names: `${selected.size} employees`, level: FALLBACK })}>Set level ({selected.size})</Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          <DataTable columns={employeeColumns} rows={data?.employees || []} loading={state.loading && !data} pageSize={15}
            searchPlaceholder="Search employee, ID or schedule…" empty={{ title: "No employees" }} caption="Employees and their schedules" minWidth={canEdit ? 900 : 760} />
        </CardContent>
      </Card>

      <Dialog open={Boolean(dialog)} onOpenChange={(value) => { if (!value) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "profile" ? (input.schedule_key ? `Change "${input.name}"` : "New schedule")
                : dialog?.kind === "archive" ? `Delete "${input.name}"?`
                  : dialog?.kind === "level" ? `Schedule for ${input.label}`
                    : dialog?.kind === "set_level" ? `Employee level — ${input.names}`
                      : `Assign a schedule — ${input.names}`}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === "set_level"
                ? "The level decides the schedule only when the employee has no schedule of their own."
                : "Recorded in Audit & Monitoring with your name. Attendance before the effective date is not recalculated."}
            </DialogDescription>
          </DialogHeader>

          {dialog?.kind === "profile" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="ws-name">Name</Label><Input id="ws-name" maxLength={80} placeholder="e.g. Pre-school Teacher" value={input.name || ""} onChange={(e) => setInput((c) => ({ ...c, name: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label htmlFor="ws-start">Work start</Label><Input id="ws-start" type="time" value={input.work_start || ""} onChange={(e) => setInput((c) => ({ ...c, work_start: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label htmlFor="ws-end">Work end</Label><Input id="ws-end" type="time" value={input.work_end || ""} onChange={(e) => setInput((c) => ({ ...c, work_end: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label htmlFor="ws-grace">Late grace period (minutes)</Label><Input id="ws-grace" type="number" min="0" max="120" inputMode="numeric" className="tabular-nums" value={input.grace_minutes ?? ""} onChange={(e) => setInput((c) => ({ ...c, grace_minutes: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label htmlFor="ws-hours">Required work hours / day</Label><Input id="ws-hours" type="number" min="0.5" max="24" step="0.5" inputMode="decimal" className="tabular-nums" value={input.work_hours ?? ""} onChange={(e) => setInput((c) => ({ ...c, work_hours: e.target.value }))} /></div>
              <fieldset className="space-y-1.5 sm:col-span-2">
                <legend className="text-sm font-medium">Working days</legend>
                <div className="flex flex-wrap gap-3">
                  {WEEKDAYS.map((d) => (
                    <label key={d.value} className="flex items-center gap-1.5 text-sm">
                      <Checkbox
                        checked={(input.working_days || []).includes(d.value)}
                        onCheckedChange={(v) => setInput((c) => {
                          const days = new Set(c.working_days || []);
                          if (v === true) days.add(d.value); else days.delete(d.value);
                          return { ...c, working_days: [...days].sort((a, b) => a - b) };
                        })}
                      />{d.short}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="sm:col-span-2">{effectiveField}</div>
              <div className="sm:col-span-2">{noteField}</div>
            </div>
          ) : dialog?.kind === "archive" ? (
            <div className="space-y-3">{effectiveField}{noteField}</div>
          ) : dialog?.kind === "set_level" ? (
            <div className="space-y-1.5">
              <Label htmlFor="ws-level">Employee level</Label>
              <Select value={input.level} onValueChange={(v) => setInput((c) => ({ ...c, level: v }))}>
                <SelectTrigger id="ws-level" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={FALLBACK}>Not set</SelectItem>
                  {(data?.levels_list || []).map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : dialog ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="ws-schedule">Schedule</Label>
                <Select value={input.schedule_key} onValueChange={(v) => setInput((c) => ({ ...c, schedule_key: v }))}>
                  <SelectTrigger id="ws-schedule" className="w-full"><SelectValue placeholder="Choose a schedule" /></SelectTrigger>
                  {scheduleOptions(true)}
                </Select>
              </div>
              {effectiveField}
              {noteField}
            </div>
          ) : null}

          {dialogError ? <p role="alert" className="text-sm text-destructive">{dialogError}</p> : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setDialog(null)} disabled={busy}>Cancel</Button>
            <Button variant={dialog?.kind === "archive" ? "destructive" : "default"} onClick={save} disabled={busy}>
              {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
              {dialog?.kind === "archive" ? "Delete" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
