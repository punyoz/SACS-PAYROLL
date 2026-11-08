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
import { recordColumns } from "@/components/portal/attendance/grouped-table";
import { AttendanceStatusBoard } from "@/components/portal/attendance/status-board";
import { apiFetch, fetchJson, jsonBody } from "@/lib/portal/api";
import { downloadCsv, matchesEmployee } from "@/lib/portal/attendance";
import { cn } from "@/lib/utils";
import { DateRangeFilter } from "@/components/portal/date-range-filter";

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
const ALL_BRANCHES = "all";

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
        <form onSubmit={add} noValidate className="grid items-start gap-3 lg:grid-cols-[10rem_1fr_13rem_auto_auto]">
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
          ) : <div className="hidden lg:block" />}
          <Button type="submit" className="lg:mt-[1.375rem]" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Add suspension</Button>
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
  // Alpha test A1 / B3: a date range (today by default), a branch filter, and
  // a paged table (10 / 25 / 50, page numbers, total). One day keeps the
  // day view, which also lists who has not tapped in yet today.
  const today = localDateKey();
  const [range, setRange] = React.useState({ from: today, to: today });
  const [branch, setBranch] = React.useState(ALL_BRANCHES);
  const [branches, setBranches] = React.useState([]);
  const [paging, setPaging] = React.useState({ page: 1, pageSize: 25, query: "" });
  const [state, setState] = React.useState({ loading: true, error: null, logs: [], total: 0, summary: {} });
  const [reloadKey, setReloadKey] = React.useState(0);
  const [exporting, setExporting] = React.useState(false);
  const seq = React.useRef(0);
  const oneDay = range.from === range.to;

  React.useEffect(() => {
    fetchJson("/api/admin/branches").then((d) => setBranches(d.branches || [])).catch(() => setBranches([]));
  }, []);

  const query = React.useCallback((page, pageSize) => {
    const params = new URLSearchParams({ from: range.from, to: range.to, page: String(page), page_size: String(pageSize) });
    if (branch !== ALL_BRANCHES) params.set("branch_id", branch);
    if (paging.query.trim()) params.set("q", paging.query.trim());
    return `/api/hr/attendance?${params}`;
  }, [range, branch, paging.query]);

  const load = React.useCallback(async () => {
    const mine = ++seq.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      if (oneDay) {
        // One day: the day view (with today's not-yet-tapped), paged here.
        const data = await fetchJson(`/api/hr/attendance?date=${range.from}`);
        if (mine !== seq.current) return;
        const q = paging.query.trim().toLowerCase();
        const all = (data.logs || []).map((row) => ({ ...row, log_date: row.log_date || row.date }))
          .filter((row) => (branch === ALL_BRANCHES || String(row.branch_id || "") === branch) && (!q || matchesEmployee(row, q)));
        const offset = (paging.page - 1) * paging.pageSize;
        setState({ loading: false, error: null, logs: all.slice(offset, offset + paging.pageSize), total: all.length, summary: data.summary || {}, all });
        return;
      }
      const data = await fetchJson(query(paging.page, paging.pageSize));
      if (mine !== seq.current) return;
      setState({ loading: false, error: null, logs: data.logs || [], total: Number(data.total) || 0, summary: data.summary || {} });
    } catch (error) {
      if (mine !== seq.current) return;
      setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load attendance." }));
    }
  }, [oneDay, range, branch, paging, query]);

  React.useEffect(() => { load(); }, [load, refreshKey, version, reloadKey]);

  const csvRow = (r) => [
    r.employee_name || r.employee_id || "", r.employee_code || "", r.branch_name || "", r.employee_type || "", r.log_date || r.date || "",
    r.time_in ? timeOnly(r.time_in) : "", r.time_out ? timeOnly(r.time_out) : "",
    r.time_out ? Number(r.total_hours || 0).toFixed(2) : "", r.status || "",
  ];

  // Every record of the range and branch, page by page (not only this page).
  async function exportCsv() {
    if (!state.total) { notify("Nothing to export", "No attendance data to export.", "info"); return; }
    setExporting(true);
    try {
      let rows = state.all || [];
      if (!oneDay) {
        rows = [];
        for (let page = 1; rows.length < state.total; page += 1) {
          const data = await fetchJson(query(page, 100));
          rows.push(...(data.logs || []));
          if (!(data.logs || []).length) break;
        }
      }
      downloadCsv(`sacs-hr-attendance-${range.from}-to-${range.to}.csv`,
        ["Employee Name", "Employee ID", "Branch", "Employee Type", "Date", "Time In", "Time Out", "Hours Worked", "Status"], rows.map(csvRow));
    } catch (error) {
      notify("Export failed", error.message || "Try again.", "error");
    } finally {
      setExporting(false);
    }
  }

  const s = state.summary;
  const first = state.loading && !state.logs.length;
  const title = oneDay ? (range.from === today ? "Today" : range.from) : `${range.from} to ${range.to}`;

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
          <CardDescription>Every branch, newest first. Choose the dates and a branch; select a name to open that employee&apos;s record.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={exportCsv} disabled={!state.total || exporting}>{exporting ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}Export CSV</Button></CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTable
            columns={COLUMNS}
            rows={state.logs}
            rowKey={(r) => `${r.id || r.employee_id}-${r.log_date || r.date}`}
            loading={first}
            error={state.error}
            onRetry={load}
            searchPlaceholder="Search employee name…"
            pageSize={paging.pageSize}
            server={{
              total: state.total, page: paging.page, pageSize: paging.pageSize, query: paging.query,
              onChange: (next) => setPaging((c) => ({ page: next.page ?? c.page, pageSize: next.pageSize ?? c.pageSize, query: next.query ?? c.query })),
            }}
            toolbar={(
              <>
                <DateRangeFilter idPrefix="hr-att" value={range} count={state.loading ? null : state.total}
                  onChange={(next) => { setRange(next); setPaging((c) => ({ ...c, page: 1 })); }} />
                <Select value={branch} onValueChange={(v) => { setBranch(v); setPaging((c) => ({ ...c, page: 1 })); }}>
                  <SelectTrigger className="w-44" aria-label="Branch"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_BRANCHES}>All branches</SelectItem>
                    {branches.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </>
            )}
            empty={{ title: "No attendance records in this range", description: "Try other dates or another branch." }}
            caption="Attendance log"
            minWidth={1000}
          />
        </CardContent>
      </Card>

      <AttendanceStatusBoard refreshKey={refreshKey} />
    </>
  );
}
