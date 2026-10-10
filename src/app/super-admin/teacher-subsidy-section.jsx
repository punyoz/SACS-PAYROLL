"use client";

import * as React from "react";
import { GiftIcon, Loader2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { LicensedTeachersCard } from "@/components/portal/licensed-teachers-card";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel, money } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Licensed Teacher Subsidy (docs/payroll-schedule-loans-awol.md §6.2, §9.2;
 * /api/admin/teacher-subsidy). A change applies from the NEXT subsidy year;
 * this year's balances keep their amount. The exempt ceiling it shares with
 * the 13th month is a Payroll Rate (Rates tab). Licensed teachers are listed
 * read-only (HR edits them).
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const OPTIONS = {
  proration: [["monthly", "Prorate by month"], ["none", "Full amount"]],
  advance_limit: [["full_year", "Full-year balance"], ["earned_to_date", "Earned to date"]],
  on_resignation: [["prorate", "Prorate (earned part in final pay)"], ["forfeit", "Forfeit"]],
  on_dismissal: [["forfeit", "Forfeit the unpaid part"], ["prorate", "Prorate"]],
  tax_treatment: [["other_benefit", "Other benefit — shares the exempt ceiling with the 13th month"], ["taxable", "Taxable"], ["exempt", "Exempt"]],
};

export function TeacherSubsidySection({ refreshKey }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [form, setForm] = React.useState(null);
  const [warning, setWarning] = React.useState("60");
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const data = await fetchJson("/api/admin/teacher-subsidy");
      if (!data.available) throw new Error(data.error || "Not set up yet.");
      setState({ loading: false, error: null, data });
      setWarning(String(data.warning_days));
      const v = data.versions?.[0] || {};
      const currentEnd = data.current_year?.year_end;
      const nextYear = currentEnd ? Number(String(currentEnd).slice(0, 4)) + (String(currentEnd).slice(5) === "12-31" ? 1 : 0) : new Date().getFullYear() + 1;
      const basis = v.year_basis || "calendar";
      const startMonth = Number(v.year_start_month || 1);
      setForm({
        amount: String(v.annual_amount || 24000), basis, startMonth: String(startMonth),
        payout: v.payout_month ? String(v.payout_month) : "", proration: v.proration || "monthly", advance_limit: v.advance_limit || "full_year",
        on_resignation: v.on_resignation || "prorate", on_dismissal: v.on_dismissal || "forfeit", tax_treatment: v.tax_treatment || "other_benefit",
        effective: `${nextYear}-${String(startMonth).padStart(2, "0")}-01`, note: "",
      });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const set = (key, value) => setForm((c) => {
    const next = { ...c, [key]: value };
    if (key === "basis" && value === "calendar") next.startMonth = "1";
    const month = String(next.basis === "calendar" ? 1 : Number(next.startMonth)).padStart(2, "0");
    next.effective = `${String(next.effective).slice(0, 4)}-${month}-01`;
    return next;
  });

  async function save() {
    if (form.note.trim().length < 5) { setFeedback({ text: "Give the reason for the change (at least 5 characters).", ok: false }); return; }
    const ok = await confirm({ title: "Save the subsidy settings?", description: `Applies from the subsidy year starting ${dateLabel(form.effective)}. ${state.data.current_year ? `This year's balances stay at ${money(state.data.current_year.annual_amount)}.` : ""}`, confirmLabel: "Save settings" });
    if (!ok) return;
    setBusy(true);
    try {
      await fetchJson("/api/admin/teacher-subsidy", jsonBody("POST", {
        action: "save", effective_year_start: form.effective, annual_amount: form.amount, year_basis: form.basis,
        year_start_month: Number(form.startMonth), payout_month: form.payout || null, proration: form.proration,
        advance_limit: form.advance_limit, on_resignation: form.on_resignation, on_dismissal: form.on_dismissal,
        tax_treatment: form.tax_treatment, note: form.note.trim(),
      }));
      notify("Subsidy Settings Saved", `From ${dateLabel(form.effective)}.`, "success");
      setFeedback({ text: "Saved.", ok: true });
      await load();
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function saveWarning() {
    try {
      await fetchJson("/api/admin/teacher-subsidy", jsonBody("POST", { action: "set_warning_days", days: Number(warning) }));
      notify("Saved", `HR is warned ${warning} days before a license expires.`, "success");
    } catch (error) {
      notify("Not Saved", error.message, "error");
    }
  }

  if (state.error) return <Alert className="border-warning/40 bg-warning/5"><AlertDescription>Licensed Teacher Subsidy: {state.error}</AlertDescription></Alert>;
  if (!form) return null;
  const data = state.data;
  const year = data.current_year;
  const select = (id, key, options) => (
    <Select value={form[key]} onValueChange={(v) => set(key, v)}>
      <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
    </Select>
  );

  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><GiftIcon className="size-4 text-gold-text" aria-hidden="true" />Licensed Teacher Subsidy</CardTitle>
          <CardDescription>Annual subsidy for verified licensed teachers: advanced through Loans (never from salary) or paid on the 2nd-half payslip of the payout month.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {year ? (
            <p className="rounded-md bg-muted/50 p-3 text-sm">This year ({dateLabel(year.year_start)} – {dateLabel(year.year_end)}): {money(year.annual_amount)} · {data.totals.teachers} licensed teacher{data.totals.teachers === 1 ? "" : "s"} · {money(data.totals.advanced)} advanced · {money(data.totals.to_pay)} to pay out on the 16–end payslip of {MONTHS[Number(String(year.payout_period_start).slice(5, 7)) - 1]} {String(year.payout_period_start).slice(0, 4)}</p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="sub-amount">Annual subsidy amount (₱)</Label>
              <Input id="sub-amount" type="number" min="0" step="0.01" value={form.amount} onChange={(e) => set("amount", e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="sub-basis">Subsidy year</Label>
              {select("sub-basis", "basis", [["calendar", "Calendar year (Jan 1 – Dec 31)"], ["school_year", "School year"]])}</div>
            {form.basis === "school_year" ? (
              <div className="space-y-1.5"><Label htmlFor="sub-start">School year starts on the 1st of</Label>
                <Select value={form.startMonth} onValueChange={(v) => set("startMonth", v)}>
                  <SelectTrigger id="sub-start" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
                </Select></div>
            ) : null}
            <div className="space-y-1.5"><Label htmlFor="sub-payout">Year-end payout: 2nd-half payslip of</Label>
              <Select value={form.payout || "last"} onValueChange={(v) => set("payout", v === "last" ? "" : v)}>
                <SelectTrigger id="sub-payout" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="last">The year&apos;s last month</SelectItem>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1.5"><Label htmlFor="sub-pro">Mid-year hire / newly licensed</Label>{select("sub-pro", "proration", OPTIONS.proration)}</div>
            <div className="space-y-1.5"><Label htmlFor="sub-adv">Advance limit</Label>{select("sub-adv", "advance_limit", OPTIONS.advance_limit)}</div>
            <div className="space-y-1.5"><Label htmlFor="sub-res">On resignation</Label>{select("sub-res", "on_resignation", OPTIONS.on_resignation)}</div>
            <div className="space-y-1.5"><Label htmlFor="sub-dis">On dismissal (AWOL / for cause)</Label>{select("sub-dis", "on_dismissal", OPTIONS.on_dismissal)}</div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="sub-tax">Tax treatment</Label>{select("sub-tax", "tax_treatment", OPTIONS.tax_treatment)}
              <p className="text-xs text-muted-foreground">The exempt ceiling (now set in the Rates tab as &quot;Other benefits exempt ceiling&quot;) covers the 13th month and the subsidy together.</p></div>
            <div className="space-y-1.5"><Label htmlFor="sub-eff">Takes effect from the subsidy year starting</Label>
              <Input id="sub-eff" readOnly value={dateLabel(form.effective)} className="bg-muted" />
              <div className="flex gap-1.5"><Button type="button" size="sm" variant="outline" onClick={() => setForm((c) => ({ ...c, effective: `${Number(c.effective.slice(0, 4)) + 1}${c.effective.slice(4)}` }))}>Later year</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setForm((c) => ({ ...c, effective: `${Number(c.effective.slice(0, 4)) - 1}${c.effective.slice(4)}` }))}>Earlier</Button></div>
              <p className="text-xs text-muted-foreground">The current year keeps its amount; the database refuses an earlier start.</p></div>
            <div className="space-y-1.5"><Label htmlFor="sub-note">Reason for the change</Label>
              <Input id="sub-note" maxLength={500} placeholder="Required" value={form.note} onChange={(e) => set("note", e.target.value)} /></div>
          </div>

          <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
            <div className="space-y-1.5"><Label htmlFor="sub-warn">Warn HR before a license expires (days)</Label>
              <Input id="sub-warn" type="number" min="1" max="365" className="w-32" value={warning} onChange={(e) => setWarning(e.target.value)} /></div>
            <Button type="button" variant="outline" onClick={saveWarning}>Save warning</Button>
          </div>

          {(data.history || []).length ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">Change history</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {data.history.slice(0, 8).map((h) => (
                  <li key={h.id}>{new Date(h.changed_at).toLocaleString("en-PH")} · {h.changed_by_name || "—"} · from {dateLabel(h.effective_from)} · {money(h.old_value?.annual_amount)} → {money(h.new_value?.annual_amount)}, {String(h.new_value?.tax_treatment || "").replace("_", " ")} — {h.reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button onClick={save} disabled={busy}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save settings"}</Button>
          <p role="status" aria-live="polite" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p>
        </CardFooter>
        {confirmDialog}
      </Card>
      <LicensedTeachersCard refreshKey={refreshKey} />
    </>
  );
}
