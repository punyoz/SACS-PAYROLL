"use client";

import * as React from "react";
import { CalendarRangeIcon, Loader2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Payslip Schedule (docs/payroll-schedule-loans-awol.md §1, §9.1;
 * /api/admin/payslip-schedule). Super Admin only. Each save is a new
 * version from an upcoming pay period; generated payslips never change.
 */

const RULES = [
  ["previous_working_day", "Move to the previous working day"],
  ["same_day", "Generate on the same day"],
  ["next_working_day", "Move to the next working day"],
];
const WEEKDAY = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", timeZone: "UTC" });

export function PayslipScheduleSection({ refreshKey }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [form, setForm] = React.useState({ first: "", second: "", window: "5", firstRule: "next_working_day", rule: "previous_working_day", from: "", note: "" });
  const [preview, setPreview] = React.useState(null);
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/admin/payslip-schedule");
      if (!data.available) throw new Error(data.error || "Not set up yet.");
      setState({ loading: false, error: null, data });
      const latest = data.versions?.[0];
      setForm((c) => ({
        ...c,
        first: latest?.first_half_day ? String(latest.first_half_day) : "",
        second: latest?.second_half_day ? String(latest.second_half_day) : "",
        window: String(latest?.window_days || 5),
        firstRule: latest?.first_half_rule || "next_working_day",
        rule: latest?.non_working_day_rule || "previous_working_day",
        from: c.from || data.upcoming?.[0]?.value || "",
      }));
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const body = React.useCallback((action) => ({
    action, effective_from: form.from, first_half_day: form.first || null, second_half_day: form.second || null,
    window_days: Number(form.window), first_half_rule: form.firstRule, non_working_day_rule: form.rule, note: form.note.trim(),
  }), [form]);

  // Live preview of the dates the form would produce.
  React.useEffect(() => {
    if (!form.from) return undefined;
    const timer = setTimeout(() => {
      fetchJson("/api/admin/payslip-schedule", jsonBody("POST", body("preview")))
        .then((data) => setPreview(data.periods))
        .catch((error) => setFeedback({ text: error.message, ok: false }));
    }, 250);
    return () => clearTimeout(timer);
  }, [form.from, form.first, form.second, form.window, form.firstRule, form.rule, body]);

  async function save() {
    if (form.note.trim().length < 5) { setFeedback({ text: "Give the reason for the change (at least 5 characters).", ok: false }); return; }
    const label = state.data.upcoming.find((u) => u.value === form.from)?.label || form.from;
    const ok = await confirm({ title: "Save the payslip schedule?", description: `Applies from ${label}. Payslips already generated are not changed.`, confirmLabel: "Save schedule" });
    if (!ok) return;
    setBusy(true);
    try {
      await fetchJson("/api/admin/payslip-schedule", jsonBody("POST", body("save")));
      notify("Payslip Schedule Saved", `Applies from ${label}.`, "success");
      setFeedback({ text: "Saved.", ok: true });
      setForm((c) => ({ ...c, note: "" }));
      await load();
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  if (state.error) {
    return <Alert className="border-warning/40 bg-warning/5"><AlertDescription>Payslip Schedule: {state.error}</AlertDescription></Alert>;
  }
  const data = state.data;
  const holidayName = (key) => (data?.holidays || []).find((h) => String(h.holiday_date).slice(0, 10) === key)?.name;
  const rows = preview || data?.periods || [];

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CalendarRangeIcon className="size-4 text-gold-text" aria-hidden="true" />Payslip Schedule</CardTitle>
        <CardDescription>When payslips are generated. The 2nd half deducts attendance up to the day before its generation day; that day carries to next month.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="sch-first">1st half (1–15) generation day</Label>
            <Input id="sch-first" type="number" min="1" max="15" placeholder="15 — last day of the period" value={form.first} onChange={(e) => setForm((c) => ({ ...c, first: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label htmlFor="sch-second">2nd half (16–end) generation day</Label>
            <Input id="sch-second" type="number" min="16" max="31" placeholder="Last day of the month" value={form.second} onChange={(e) => setForm((c) => ({ ...c, second: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label htmlFor="sch-window">Generation stays open for (days)</Label>
            <Input id="sch-window" type="number" min="1" max="15" value={form.window} onChange={(e) => setForm((c) => ({ ...c, window: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label htmlFor="sch-first-rule">1st half: when the day is a weekend or holiday</Label>
            <Select value={form.firstRule} onValueChange={(v) => setForm((c) => ({ ...c, firstRule: v }))}>
              <SelectTrigger id="sch-first-rule" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{RULES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1.5"><Label htmlFor="sch-rule">2nd half: when the day is a weekend or holiday</Label>
            <Select value={form.rule} onValueChange={(v) => setForm((c) => ({ ...c, rule: v }))}>
              <SelectTrigger id="sch-rule" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{RULES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1.5"><Label htmlFor="sch-from">Takes effect from</Label>
            <Select value={form.from} onValueChange={(v) => setForm((c) => ({ ...c, from: v }))}>
              <SelectTrigger id="sch-from" className="w-full"><SelectValue placeholder="Choose a pay period" /></SelectTrigger>
              <SelectContent>{(data?.upcoming || []).map((u) => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Only periods whose generation day has not arrived.</p></div>
          <div className="space-y-1.5"><Label htmlFor="sch-note">Reason for the change</Label>
            <Input id="sch-note" maxLength={500} placeholder="Required" value={form.note} onChange={(e) => setForm((c) => ({ ...c, note: e.target.value }))} /></div>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>Period</TableHead><TableHead>Generation</TableHead><TableHead>Open until</TableHead><TableHead>Attendance counted</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((p) => {
                const moved = p.period_start.endsWith("-01") ? `${p.period_start.slice(0, 8)}${String(Number(form.first) || 15).padStart(2, "0")}` : null;
                const holiday = holidayName(p.generation_date) || (p.period_end && p.generation_date !== p.period_end && p.period_start.endsWith("-16") ? holidayName(p.period_end) : null);
                return (
                  <TableRow key={p.period_start}>
                    <TableCell className="whitespace-nowrap">{p.label}</TableCell>
                    <TableCell className="whitespace-nowrap">{WEEKDAY(p.generation_date)} {dateLabel(p.generation_date)}{holiday ? <span className="ml-1 text-xs text-muted-foreground">({holiday})</span> : moved && moved !== p.generation_date ? <span className="ml-1 text-xs text-muted-foreground">(moved)</span> : null}</TableCell>
                    <TableCell className="whitespace-nowrap">{WEEKDAY(p.closes_on)} {dateLabel(p.closes_on)}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.attendance_cutoff ? `to ${dateLabel(p.attendance_cutoff)}` : <span className="text-muted-foreground">— no deductions</span>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {(data?.history || []).length ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">Change history</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {data.history.slice(0, 8).map((h) => (
                <li key={h.id}>{new Date(h.changed_at).toLocaleString("en-PH")} · {h.changed_by_name || "—"} · from {dateLabel(h.effective_from)} · window {h.old_value?.window_days ?? "—"}→{h.new_value?.window_days}, {String(h.old_value?.non_working_day_rule || "").replaceAll("_", " ")}→{String(h.new_value?.non_working_day_rule || "").replaceAll("_", " ")} — {h.reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button onClick={save} disabled={busy || !form.from}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save schedule"}</Button>
        <p role="status" aria-live="polite" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p>
      </CardFooter>
      {confirmDialog}
    </Card>
  );
}
