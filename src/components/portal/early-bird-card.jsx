"use client";

import * as React from "react";
import { Loader2Icon, SunriseIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel, money, shortDate } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Early Bird incentive (/api/admin/early-bird; src/lib/payroll/early-bird.js):
 * one winner per pay period, the employee with the most time-ins at least
 * the threshold before THEIR OWN work start. Super Admin and HR set the
 * threshold, who is eligible and the amount; Admin and Accountant view.
 * Winners are worked out when payroll is generated and lock once the period
 * has a Final payslip.
 */

/** The latest early time-in for an 8:00 AM start: 15 -> "7:45 AM". */
function latestEarly(threshold) {
  const at = 480 - (Number(threshold) || 15);
  const h = Math.floor(Math.max(0, at) / 60);
  return `${h % 12 || 12}:${String(Math.max(0, at) % 60).padStart(2, "0")} AM`;
}

function offsetLabel(minutes) {
  if (minutes === null || minutes === undefined) return "—";
  const n = Math.abs(Number(minutes));
  return `${Math.round(n)} min ${Number(minutes) <= 0 ? "early" : "late"}`;
}

export function EarlyBirdCard({ refreshKey }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [form, setForm] = React.useState({ threshold: "15", amount: "0", exclude: true });
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/admin/early-bird");
      setState({ loading: false, error: data.available === false ? data.error : null, data });
      setForm({
        threshold: String(data.settings?.threshold_minutes ?? 15),
        amount: String(data.settings?.incentive_amount ?? 0),
        exclude: data.settings?.exclude_unexcused_absence !== false,
      });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const canSettings = Boolean(data?.can_edit_settings);
  const canAmount = Boolean(data?.can_edit_amount);

  async function save() {
    const body = { incentive_amount: Number(form.amount) };
    if (canSettings) {
      body.threshold_minutes = Number(form.threshold);
      body.exclude_unexcused_absence = form.exclude;
    }
    const ok = await confirm({
      title: "Save the Early Bird settings?",
      description: "Applies to winners worked out from now on. A period whose payroll is already finalized keeps its winner and amount.",
      confirmLabel: "Save",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await fetchJson("/api/admin/early-bird", jsonBody("PATCH", body));
      notify("Early Bird Incentive", "Settings saved.", "success");
      setFeedback({ text: "Saved.", ok: true });
      await load();
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><SunriseIcon className="size-4 text-gold-text" aria-hidden="true" />Early Bird incentive</CardTitle>
        <CardDescription>
          One winner per pay period: the employee with the most RFID time-ins at least {form.threshold || 15} minutes before their own work start
          (8:00 AM start: {latestEarly(form.threshold)} or earlier). Ties go to the earliest average time-in, then the fewest late days, then the fewest absences.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.error ? <Alert className="border-warning/40 bg-warning/5"><AlertDescription>{state.error}</AlertDescription></Alert> : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="eb-threshold">Early by at least (minutes)</Label>
            <Input id="eb-threshold" type="number" min="1" max="120" inputMode="numeric" className="tabular-nums" value={form.threshold} disabled={!canSettings}
              onChange={(e) => setForm((c) => ({ ...c, threshold: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eb-amount">Incentive amount (₱)</Label>
            <Input id="eb-amount" type="number" min="0" step="0.01" inputMode="decimal" className="tabular-nums" value={form.amount} disabled={!canAmount}
              onChange={(e) => setForm((c) => ({ ...c, amount: e.target.value }))} />
            <p className="text-xs text-muted-foreground">₱0 switches the incentive off.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eb-exclude">Unexcused absence makes ineligible</Label>
            <div className="flex h-9 items-center gap-2">
              <Switch id="eb-exclude" checked={form.exclude} disabled={!canSettings} onCheckedChange={(v) => setForm((c) => ({ ...c, exclude: v === true }))} />
              <span className="text-sm text-muted-foreground">{form.exclude ? "Yes" : "No"}</span>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Winners</p>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>Pay period</TableHead><TableHead>Winner</TableHead><TableHead>Early time-ins</TableHead><TableHead>Average arrival</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {(data?.winners || []).length ? data.winners.map((w) => (
                  <TableRow key={w.period_label}>
                    <TableCell className="whitespace-nowrap">{w.period_label}<span className="block text-xs text-muted-foreground">{shortDate(w.window.start_key)} – {dateLabel(w.window.end_key)}</span></TableCell>
                    <TableCell>{w.employee_name || <span className="text-muted-foreground">No eligible employee</span>}</TableCell>
                    <TableCell className="tabular-nums">{w.employee_name ? w.early_count : "—"}</TableCell>
                    <TableCell className="tabular-nums">{w.employee_name ? offsetLabel(w.average_offset_minutes) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{w.employee_name ? money(w.amount) : "—"}</TableCell>
                    <TableCell>{w.finalized ? <StatusBadge tone="success">Final</StatusBadge> : <StatusBadge tone="info">Until payroll is final</StatusBadge>}</TableCell>
                  </TableRow>
                )) : (
                  <TableRow><TableCell colSpan={6} className="text-muted-foreground">{state.loading ? "Loading…" : "No winners yet. A winner is worked out when payroll is generated."}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
      {canAmount ? (
        <CardFooter className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button onClick={save} disabled={busy || state.loading}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save"}</Button>
          <p role="status" aria-live="polite" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p>
        </CardFooter>
      ) : null}
      {confirmDialog}
    </Card>
  );
}
