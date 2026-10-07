"use client";

import * as React from "react";
import { CheckCircle2Icon, ClockAlertIcon, CloudRainIcon, DownloadIcon, Loader2Icon, RefreshCwIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatCard } from "@/components/portal/stat-card";
import { usePortalSession } from "@/components/portal/session";
import { useAttendanceActions } from "@/components/portal/attendance/dialogs";
import { GroupedAttendanceTable, recordColumns } from "@/components/portal/attendance/grouped-table";
import { AttendanceStatusBoard } from "@/components/portal/attendance/status-board";
import { apiFetch, fetchJson, jsonBody } from "@/lib/portal/api";
import { branchContext, branchCounts, countBy, downloadCsv, oneRowPerDay, rowBranchId, sortByBranchDay } from "@/lib/portal/attendance";
import { cn } from "@/lib/utils";

/*
 * HR Attendance Monitoring (loadHRAttendance / loadHRAllAttendance /
 * exportHRAttendanceCsv and the suspensions block, public/legacy/js/hr.js):
 * GET /api/hr/attendance?date= or ?view=all; suspensions through
 * /api/admin/holidays (type "suspension").
 */

/** The browser's local YYYY-MM-DD (localDateKey, app.js). */
function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function timeOnly(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-PH", { hour: "2-digit", minute: "2-digit", hour12: true }).format(date);
}

function suspensionDate(key) {
  const date = new Date(`${key}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date);
}

const COLUMNS = recordColumns({ canReview: true, showType: true });

function SuspensionsCard({ onChanged, refreshKey }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, error: null, rows: [], today: "" });
  const [form, setForm] = React.useState({ date: "", name: "", part: "whole", cutoff: "" });
  const [errors, setErrors] = React.useState({});
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const data = await fetchJson("/api/admin/holidays?upcoming=20");
      const today = data.today || "";
      setState({ loading: false, error: null, rows: (data.holidays || []).filter((row) => row.type === "suspension"), today });
      setForm((current) => (current.date ? current : { ...current, date: today }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message || "Unable to load suspensions." }));
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  async function add(event) {
    event.preventDefault();
    const next = {
      date: !form.date ? "Choose the date." : "",
      name: !form.name.trim() ? "Enter the reason." : "",
      cutoff: form.part !== "whole" && !form.cutoff ? "Enter the time." : "",
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) { setFeedback({ text: "Fill in the highlighted fields.", ok: false }); return; }
    setBusy(true);
    try {
      const data = await fetchJson("/api/admin/holidays", jsonBody("POST", {
        holiday_date: form.date,
        name: form.name.trim(),
        type: "suspension",
        day_part: form.part,
        cutoff: form.part === "whole" ? "" : form.cutoff,
      }));
      const n = data.remarked_records;
      const updated = n ? ` ${n} attendance record${n === 1 ? "" : "s"} for that day ${n === 1 ? "was" : "were"} updated.` : "";
      setFeedback({ text: `Suspension added for ${suspensionDate(form.date)}.${updated}`, ok: true });
      notify("Suspension Added", `${form.name.trim()} · ${suspensionDate(form.date)}`, "success");
      setForm((current) => ({ ...current, name: "" }));
      await load();
      onChanged();
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function remove(date) {
    const ok = await confirm({ title: `Remove the suspension on ${suspensionDate(date)}?`, description: "Employees will be expected to work the full day.", confirmLabel: "Remove" });
    if (!ok) return;
    try {
      const response = await apiFetch(`/api/admin/holidays?date=${encodeURIComponent(date)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Unable to remove the suspension.");
      setFeedback({ text: `Removed the suspension on ${suspensionDate(date)}.`, ok: true });
      await load();
      onChanged();
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    }
  }

  const columns = [
    { key: "holiday_date", header: "Date", className: "whitespace-nowrap tabular-nums", cell: (r) => suspensionDate(r.holiday_date) },
    { key: "name", header: "Reason", className: "font-medium whitespace-normal" },
    { key: "part", header: "Part of the day", cell: (r) => r.day_part_label || "Whole day" },
    { key: "by", header: "Added by", className: "text-muted-foreground", cell: (r) => r.created_by_name || "System" },
    {
      key: "action",
      header: <span className="sr-only">Action</span>,
      align: "right",
      cell: (r) => {
        const addedToday = r.created_at && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date(r.created_at)) === state.today;
        const removable = r.holiday_date > state.today || (r.holiday_date === state.today && addedToday);
        return removable ? <Button variant="outline" size="sm" onClick={() => remove(r.holiday_date)}>Remove</Button> : <span className="text-xs text-muted-foreground">Started</span>;
      },
    },
  ];

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CloudRainIcon className="size-4 text-gold-text" aria-hidden="true" />Suspensions</CardTitle>
        <CardDescription>Declare a typhoon or LGU suspension, even the same morning. Nobody is marked Absent on a whole-day suspension; on a half day, leaving at the cutoff is not undertime.</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={load}><RefreshCwIcon aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={add} noValidate className="grid items-start gap-3 md:grid-cols-[10rem_1fr_13rem_auto_auto]">
          <div className="space-y-2">
            <Label htmlFor="hr-susp-date">Date</Label>
            <DatePicker id="hr-susp-date" value={form.date} onChange={(v) => setForm((c) => ({ ...c, date: state.today && v < state.today ? state.today : v }))} aria-invalid={Boolean(errors.date) || undefined} />
            {errors.date ? <p className="text-sm text-destructive">{errors.date}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="hr-susp-name">Reason</Label>
            <Input id="hr-susp-name" maxLength={100} placeholder="e.g. Typhoon Kristine (LGU suspension)" value={form.name} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} aria-invalid={Boolean(errors.name) || undefined} />
            {errors.name ? <p className="text-sm text-destructive">{errors.name}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="hr-susp-part">Part of the day</Label>
            <Select value={form.part} onValueChange={(v) => setForm((c) => ({ ...c, part: v }))}>
              <SelectTrigger id="hr-susp-part" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="whole">Whole day</SelectItem>
                <SelectItem value="pm">Afternoon (work ends early)</SelectItem>
                <SelectItem value="am">Morning (work starts late)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.part !== "whole" ? (
            <div className="space-y-2">
              <Label htmlFor="hr-susp-cutoff">{form.part === "am" ? "Work resumes at" : "Suspended from"}</Label>
              <Input id="hr-susp-cutoff" type="time" value={form.cutoff} onChange={(e) => setForm((c) => ({ ...c, cutoff: e.target.value }))} aria-invalid={Boolean(errors.cutoff) || undefined} />
              {errors.cutoff ? <p className="text-sm text-destructive">{errors.cutoff}</p> : null}
            </div>
          ) : <div className="hidden md:block" />}
          <Button type="submit" className="md:mt-[1.375rem]" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Add suspension</Button>
        </form>
        {feedback.text ? <p role="status" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
        <DataTable
          columns={columns}
          rows={state.rows}
          loading={state.loading}
          error={state.error}
          onRetry={load}
          searchable={false}
          paginate={state.rows.length > 10}
          rowKey={(r) => r.holiday_date}
          empty={{ title: "No suspensions declared from today on", icon: CloudRainIcon }}
          caption="Upcoming suspensions"
          minWidth={620}
        />
      </CardContent>
      {confirmDialog}
    </Card>
  );
}

export function AttendancePage({ refreshKey }) {
  const { notify } = usePortalSession();
  const { version } = useAttendanceActions();
  const [view, setView] = React.useState({ mode: "date", date: localDateKey() });
  const [state, setState] = React.useState({ loading: true, error: null, logs: [], summary: {} });
  const [collapsed, setCollapsed] = React.useState(() => new Set());
  const [reloadKey, setReloadKey] = React.useState(0);
  const seq = React.useRef(0);

  const load = React.useCallback(async () => {
    const mine = ++seq.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await fetchJson(view.mode === "all" ? "/api/hr/attendance?view=all" : `/api/hr/attendance?date=${view.date}`);
      if (mine !== seq.current) return;
      setState({ loading: false, error: null, logs: data.logs || [], summary: data.summary || {} });
    } catch (error) {
      if (mine !== seq.current) return;
      setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load attendance." }));
    }
  }, [view]);

  React.useEffect(() => { load(); }, [load, refreshKey, version, reloadKey]);

  const log = React.useMemo(() => {
    const list = oneRowPerDay(state.logs.map((row) => ({ ...row, log_date: row.log_date || row.date })));
    const ctx = branchContext(list);
    const rows = sortByBranchDay(ctx, list);
    return { rows, ctx, branchCounts: branchCounts(ctx, list), dayCounts: countBy(rows, (row) => `${rowBranchId(ctx, row)}|${row.log_date}`) };
  }, [state.logs]);

  function exportCsv() {
    if (!state.logs.length) { notify("Nothing to export", "No attendance data to export.", "info"); return; }
    downloadCsv(
      `sacs-hr-attendance-${localDateKey()}.csv`,
      ["Employee Name", "Employee Type", "Date", "Time In", "Time Out", "Hours Worked", "Status"],
      state.logs.map((r) => [
        r.employee_name || r.employee_id || "", r.employee_type || "", r.date || "",
        r.time_in ? timeOnly(r.time_in) : "", r.time_out ? timeOnly(r.time_out) : "",
        r.time_out ? Number(r.total_hours || 0).toFixed(2) : "", r.status || "",
      ]),
    );
  }

  const s = state.summary;
  const first = state.loading && !state.logs.length;
  const today = localDateKey();
  const title = view.mode === "all" ? "All records" : view.date === today ? "Today" : view.date;

  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Present" value={s.present ?? 0} icon={CheckCircle2Icon} tone="success" loading={first} />
        <StatCard label="Late" value={s.late ?? 0} icon={ClockAlertIcon} tone="gold" loading={first} />
        <StatCard label="Absent" value={s.absent ?? 0} hint={`On leave: ${s.on_leave ?? 0}`} icon={XCircleIcon} tone="danger" loading={first} />
      </section>

      <SuspensionsCard refreshKey={refreshKey} onChanged={() => setReloadKey((n) => n + 1)} />

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Attendance log — {title}</CardTitle>
          <CardDescription>Grouped by branch and day. Select a name to open that employee&apos;s record.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={exportCsv} disabled={!state.logs.length}><DownloadIcon aria-hidden="true" />Export CSV</Button></CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-48 space-y-2">
              <Label htmlFor="hr-att-date">Date</Label>
              <DatePicker id="hr-att-date" value={view.mode === "date" ? view.date : ""} placeholder="Pick a date" onChange={(date) => setView({ mode: "date", date: date || today })} />
            </div>
            <Button variant={view.mode === "all" ? "secondary" : "outline"} onClick={() => setView({ mode: "all", date: view.date })} aria-pressed={view.mode === "all"}>View all records</Button>
          </div>
          <GroupedAttendanceTable
            columns={COLUMNS}
            rows={log.rows}
            grouping={{
              byBranch: true,
              ctx: log.ctx,
              branchCounts: log.branchCounts,
              dayCounts: log.dayCounts,
              statusBreakdown: true,
              collapsed,
              onToggle: (b) => setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(b)) next.delete(b); else next.add(b);
                return next;
              }),
            }}
            loading={state.loading}
            error={state.error}
            onRetry={load}
            empty="No attendance records found."
            caption="Attendance log"
            minWidth={1000}
          />
        </CardContent>
      </Card>

      <AttendanceStatusBoard refreshKey={refreshKey} />
    </>
  );
}
