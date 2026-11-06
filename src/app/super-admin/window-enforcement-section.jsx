"use client";

import * as React from "react";
import { Loader2Icon, ShieldAlertIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { TestingModeBanner } from "@/components/portal/testing-mode-banner";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel, dateTime } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Processing window enforcement (the testing switch; /api/admin/window-enforcement,
 * src/lib/payroll/window-enforcement.js). Super Admin only. ON is the normal
 * state. OFF lets the Accountant process any cutoff of their own branch on
 * any date (testing and the final defense); every other payroll rule stays.
 */

const OFF_MEANING = "While OFF, the Accountant can process, generate, reprocess and submit payroll for ANY cutoff of their own branch on ANY date, and can override Absent, Late, Undertime, Half day and Leave without pay on any date (still with a reason, still logged). Everything else stays: own branch only, government deductions and tax read-only, HR approval, approved payroll locked. Payslips and runs made while OFF are marked \"created in testing mode\". Use it for testing or the demo only, and turn it back ON before real payroll.";

const tomorrow = () => {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  now.setUTCDate(now.getUTCDate() + 1);
  return now.toISOString().slice(0, 10);
};

/** The switch's state for the page banner (Super Admin pages). */
export function useWindowEnforcement(refreshKey) {
  const [state, setState] = React.useState(null);
  const load = React.useCallback(() => {
    fetchJson("/api/admin/window-enforcement").then(setState).catch(() => setState(null));
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  return [state, load];
}

/** The red banner at the top of System Configuration while OFF. */
export function WindowEnforcementBanner({ refreshKey }) {
  const [data] = useWindowEnforcement(refreshKey);
  return <TestingModeBanner enforcement={data?.enforcement} detail="Turn it back ON in Payroll → Processing window enforcement." />;
}

export function WindowEnforcementSection({ refreshKey, onChanged }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [data, load] = useWindowEnforcement(refreshKey);
  const [form, setForm] = React.useState({ reason: "", expires: "" });
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);

  if (data && data.available === false) {
    return <Alert className="border-warning/40 bg-warning/5"><AlertDescription>Processing window enforcement: {data.error}</AlertDescription></Alert>;
  }
  const enforcement = data?.enforcement || null;
  const on = enforcement ? enforcement.enforced !== false : true;
  const production = data?.environment === "production";

  async function change(nextEnforced) {
    const reason = form.reason.trim();
    if (!reason) { setFeedback({ text: "A reason is required.", ok: false }); return; }
    if (!nextEnforced && form.expires && form.expires <= (enforcement?.today || "")) {
      setFeedback({ text: "The automatic return to ON must be a future date.", ok: false });
      return;
    }
    // Production: turning it OFF needs the Super Admin's confirmation of what it means.
    let confirmed = false;
    if (!nextEnforced && production) {
      confirmed = await confirm({
        title: "Turn processing window enforcement OFF on the live system?",
        description: `${OFF_MEANING}${form.expires ? ` It turns back ON by itself on ${dateLabel(form.expires)}.` : " It stays OFF until you turn it back ON."}`,
        confirmLabel: "I understand, turn it OFF",
        destructive: true,
      });
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      await fetchJson("/api/admin/window-enforcement", jsonBody("POST", {
        enforced: nextEnforced,
        reason,
        expires_on: nextEnforced ? null : form.expires || null,
        confirm: confirmed,
      }));
      notify(nextEnforced ? "Processing Window Enforced" : "Testing Mode On", nextEnforced ? "The processing window is enforced again." : "The processing window is not enforced.", nextEnforced ? "success" : "warning");
      setFeedback({ text: nextEnforced ? "Enforcement is ON." : "Enforcement is OFF (testing mode).", ok: true });
      setForm({ reason: "", expires: "" });
      load();
      onChanged?.();
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={cn("min-w-0 shadow-xs", !on && "border-destructive/40")} data-testid="window-enforcement-section">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ShieldAlertIcon className="size-4 text-gold-text" aria-hidden="true" />Processing window enforcement
          {enforcement ? <StatusBadge tone={on ? "success" : "danger"}>{on ? "ON" : "OFF — testing mode"}</StatusBadge> : null}
        </CardTitle>
        <CardDescription>ON (normal): the Accountant processes payroll and attendance overrides only inside the Payslip Schedule&apos;s processing window. OFF is for testing and the demo only.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <TestingModeBanner enforcement={enforcement} />
        {enforcement?.expired ? (
          <p className="text-sm text-muted-foreground">Its automatic return date has arrived: it is enforced again.</p>
        ) : null}
        {enforcement?.changed_at ? (
          <p className="text-xs text-muted-foreground">Last change {dateTime(enforcement.changed_at)}{enforcement.changed_by_name ? ` by ${enforcement.changed_by_name}` : ""}{enforcement.reason ? ` — ${enforcement.reason}` : ""}</p>
        ) : null}
        {on ? <p className="text-sm text-muted-foreground">{OFF_MEANING}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="we-reason">Reason for the change</Label>
            <Input id="we-reason" maxLength={500} placeholder="Required" value={form.reason} onChange={(e) => setForm((c) => ({ ...c, reason: e.target.value }))} /></div>
          {on ? (
            <div className="space-y-1.5"><Label htmlFor="we-expires">Turn back ON automatically on (optional)</Label>
              <DatePicker id="we-expires" value={form.expires} min={tomorrow()} onChange={(v) => setForm((c) => ({ ...c, expires: v || "" }))} placeholder="No automatic date" />
              <p className="text-xs text-muted-foreground">Checked every time payroll is read, so it is ON from this date even if the nightly job runs late.</p></div>
          ) : null}
        </div>

        {(data?.history || []).length ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">Change history</p>
            <ul className="space-y-1 text-xs text-muted-foreground" data-testid="window-enforcement-history">
              {data.history.slice(0, 10).map((h) => (
                <li key={h.id} className="break-words">{dateTime(h.changed_at)} · {h.actor_name || "—"} · {h.old_enforced === false ? "OFF" : "ON"}→{h.new_enforced ? "ON" : "OFF"}{h.new_expires_on ? ` (until ${dateLabel(h.new_expires_on)})` : ""}{h.source === "auto_expiry" ? " · automatic" : ""} — {h.reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-3 border-t pt-4">
        {on ? (
          <Button variant="destructive" onClick={() => change(false)} disabled={busy || !enforcement}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Turn OFF (testing mode)</Button>
        ) : (
          <Button onClick={() => change(true)} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Turn ON (enforce the window)</Button>
        )}
        <p role="status" aria-live="polite" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p>
      </CardFooter>
      {confirmDialog}
    </Card>
  );
}
