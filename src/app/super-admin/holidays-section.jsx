"use client";

import * as React from "react";
import { CalendarPlusIcon, Loader2Icon, PartyPopperIcon, RefreshCwIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { cn } from "@/lib/utils";
import { holidayDate } from "./config-format";

/*
 * Holidays (loadSAHolidays / addSAHoliday / generateSAHolidays /
 * removeSAHoliday, public/legacy/js/super-admin.js): /api/admin/holidays.
 * Nobody is marked Absent on these days and payroll never deducts them; a
 * day that has already started cannot be removed.
 */

const TYPES = [
  { value: "holiday", label: "Regular Holiday" },
  { value: "special", label: "Special Non-Working Day" },
  { value: "suspension", label: "Suspension (typhoon / declared)" },
];
const PARTS = [
  { value: "whole", label: "Whole day" },
  { value: "pm", label: "Afternoon (work ends early)" },
  { value: "am", label: "Morning (work starts late)" },
];

function manilaYear() {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric" }).format(new Date()));
}

function typeTone(type) {
  if (type === "special") return "gold";
  if (type === "suspension") return "info";
  return "success";
}

export function HolidaysSection({ refreshKey }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [thisYear] = React.useState(manilaYear);
  const [year, setYear] = React.useState(thisYear);
  const [state, setState] = React.useState({ loading: true, error: null, rows: [], today: "" });
  const [form, setForm] = React.useState({ date: "", name: "", type: "holiday", part: "whole", cutoff: "" });
  const [errors, setErrors] = React.useState({});
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState("");

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/admin/holidays?year=${encodeURIComponent(year)}`);
      setState({ loading: false, error: null, rows: data.holidays || [], today: data.today || "" });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message || "Unable to load holidays." }));
    }
  }, [year]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const suspension = form.type === "suspension";
  const part = suspension ? form.part : "whole";
  const set = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }));
  };

  // Not yet happened, or added by mistake today for today.
  const removable = React.useCallback((row) => {
    const addedToday = row.created_at && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date(row.created_at)) === state.today;
    return row.holiday_date > state.today || (row.holiday_date === state.today && addedToday);
  }, [state.today]);

  async function add(event) {
    event.preventDefault();
    const name = form.name.trim();
    const nextErrors = {};
    if (!form.date) nextErrors.date = "Choose the date.";
    if (!name) nextErrors.name = "Enter the name.";
    if (part !== "whole" && !form.cutoff) nextErrors.cutoff = "Enter the time.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setFeedback({ text: "Fill in the highlighted fields.", ok: false });
      document.getElementById(`sa-hol-${Object.keys(nextErrors)[0]}`)?.focus();
      return;
    }
    setBusy("add");
    try {
      const data = await fetchJson("/api/admin/holidays", jsonBody("POST", {
        holiday_date: form.date, name, type: form.type, day_part: part, cutoff: part === "whole" ? "" : form.cutoff,
      }));
      const n = data.remarked_records;
      const absentNote = n ? ` ${n} attendance record${n === 1 ? "" : "s"} for that day ${n === 1 ? "was" : "were"} updated.` : "";
      setFeedback({ text: `Added ${name} (${holidayDate(form.date)}).${absentNote}`, ok: true });
      notify("Holiday Added", `${name} (${holidayDate(form.date)}).`, "success");
      const addedYear = Number(form.date.slice(0, 4));
      setForm((current) => ({ ...current, date: "", name: "" }));
      if (addedYear !== year) setYear(addedYear); else await load();
    } catch (error) {
      setFeedback({ text: error.message || "Unable to add the holiday.", ok: false });
    } finally {
      setBusy("");
    }
  }

  async function generate() {
    const ok = await confirm({
      title: `Generate the ${year} holidays?`,
      description: "Adds the holidays fixed by law and Holy Week for the year. Days already saved are kept as they are.",
      confirmLabel: "Generate",
    });
    if (!ok) return;
    setBusy("generate");
    try {
      const data = await fetchJson("/api/admin/holidays", jsonBody("POST", { action: "generate", year }));
      setFeedback({
        text: data.added
          ? `Added ${data.added} holiday${data.added === 1 ? "" : "s"} for ${year}. Add the proclaimed days (Eid, Chinese New Year, declared days) by hand.`
          : `${year} already has every holiday fixed by law.`,
        ok: true,
      });
      await load();
    } catch (error) {
      setFeedback({ text: error.message || "Unable to generate the holidays.", ok: false });
    } finally {
      setBusy("");
    }
  }

  const remove = React.useCallback(async (date) => {
    const ok = await confirm({
      title: `Remove the holiday on ${holidayDate(date)}?`,
      description: "Employees will be expected to tap in that day.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchJson(`/api/admin/holidays?date=${encodeURIComponent(date)}`, { method: "DELETE" });
      setFeedback({ text: `Removed the holiday on ${holidayDate(date)}.`, ok: true });
      notify("Holiday Removed", holidayDate(date), "info");
      await load();
    } catch (error) {
      setFeedback({ text: error.message || "Unable to remove the holiday.", ok: false });
    }
  }, [confirm, load, notify]);

  const columns = React.useMemo(() => [
    { key: "holiday_date", header: "Date", sortable: true, className: "whitespace-nowrap tabular-nums", cell: (r) => holidayDate(r.holiday_date) },
    {
      key: "name",
      header: "Holiday",
      sortable: true,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.name}</p>
          {r.day_part_label ? <p className="text-xs text-muted-foreground">{r.day_part_label}</p> : null}
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (r) => <StatusBadge tone={typeTone(r.type)} dot={false}>{r.type_label || (r.type === "special" ? "Special Non-Working Day" : "Regular Holiday")}</StatusBadge>,
    },
    { key: "created_by_name", header: "Added by", className: "text-muted-foreground", cell: (r) => r.created_by_name || "System" },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (r) => (removable(r)
        ? <Button variant="outline" size="sm" onClick={() => remove(r.holiday_date)} aria-label={`Remove ${r.name}`}><Trash2Icon aria-hidden="true" />Remove</Button>
        : <span className="text-xs text-muted-foreground">Passed</span>),
    },
  ], [removable, remove]);

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PartyPopperIcon className="size-4 text-gold-text" aria-hidden="true" />Holidays</CardTitle>
        <CardDescription>
          Regular holidays, special non-working days and suspensions. Nobody is marked Absent on them (the day reads Holiday), and work on a holiday earns the holiday premium in Payroll Rates; a suspension earns none.
          Each year&apos;s holidays fixed by law and Holy Week are added automatically every December 1 (or with Generate year). Add proclaimed days (Eid&apos;l Fitr, Eid&apos;l Adha, Chinese New Year, All Souls&apos; Day, Christmas Eve, declared days) as soon as they are announced. HR can add suspensions too.
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button variant="outline" size="sm" onClick={generate} disabled={Boolean(busy)}>
            {busy === "generate" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <SparklesIcon aria-hidden="true" />}Generate year
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataTable
          columns={columns}
          rows={state.rows}
          rowKey={(r) => r.holiday_date}
          loading={state.loading && !state.rows.length}
          error={state.error}
          onRetry={load}
          pageSize={10}
          searchPlaceholder="Search holidays…"
          toolbar={(
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger className="w-28" aria-label="Year"><SelectValue /></SelectTrigger>
              <SelectContent>{[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
          )}
          empty={{ title: `No holidays saved for ${year}`, description: "Add them from the year's proclamation, or use Generate year.", icon: PartyPopperIcon }}
          caption="Holidays"
          minWidth={720}
        />

        <Separator />

        <form onSubmit={add} noValidate className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <p className="flex items-center gap-2 text-sm font-semibold sm:col-span-2 lg:col-span-4"><CalendarPlusIcon className="size-4 text-gold-text" aria-hidden="true" />Add a holiday or suspension</p>
          <div className="space-y-2">
            <Label htmlFor="sa-hol-date">Date</Label>
            <DatePicker id="sa-hol-date" value={form.date} onChange={(v) => set("date", v)} aria-invalid={errors.date ? true : undefined} />
            {errors.date ? <p className="text-sm text-destructive">{errors.date}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="sa-hol-name">Name</Label>
            <Input id="sa-hol-name" maxLength={100} placeholder="e.g. Eid'l Fitr" value={form.name} onChange={(e) => set("name", e.target.value)} aria-invalid={errors.name ? true : undefined} />
            {errors.name ? <p className="text-sm text-destructive">{errors.name}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="sa-hol-type">Type</Label>
            <Select value={form.type} onValueChange={(v) => set("type", v)}>
              <SelectTrigger id="sa-hol-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {suspension ? (
            <div className="space-y-2">
              <Label htmlFor="sa-hol-part">Part of the day</Label>
              <Select value={form.part} onValueChange={(v) => set("part", v)}>
                <SelectTrigger id="sa-hol-part" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{PARTS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : null}
          {part !== "whole" ? (
            <div className="space-y-2">
              <Label htmlFor="sa-hol-cutoff">{part === "am" ? "Work resumes at" : "Suspended from"}</Label>
              <Input id="sa-hol-cutoff" type="time" value={form.cutoff} onChange={(e) => set("cutoff", e.target.value)} aria-invalid={errors.cutoff ? true : undefined} />
              {errors.cutoff ? <p className="text-sm text-destructive">{errors.cutoff}</p> : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={Boolean(busy)}>{busy === "add" ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Adding…</> : "Add holiday"}</Button>
            <p role="status" aria-live="polite" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p>
          </div>
        </form>
      </CardContent>
      {confirmDialog}
    </Card>
  );
}
