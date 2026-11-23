"use client";

import * as React from "react";
import { BotIcon, PauseIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DecisionRemarkDialog } from "@/components/portal/remark-field";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { AUTOMATION_MODULES, NOTE_MAX, NOTE_MIN, STATUS_LABEL } from "@/lib/automation/shared";

/*
 * The Automation card (Part E step 1) on the Admin and HR dashboards: what the
 * system did, what waits for you, what it could not decide (and why). The
 * branch Admin checks what was prepared (Note / Object; with no objection in
 * time it goes to HR by itself); HR undoes an applied action with a reason;
 * HR / the Super Admin pause or resume automation. Never an approval.
 */

const TONE = { done: "success", admin_check: "warning", with_hr: "info", open: "warning", couldnt_decide: "danger", undone: "muted", closed: "muted" };
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

export function AutomationCard({ role, refreshKey = 0 }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: "", data: null });
  const [noting, setNoting] = React.useState(null);
  const [note, setNote] = React.useState("");
  const [objecting, setObjecting] = React.useState(null);
  const [undoing, setUndoing] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const data = await fetchJson("/api/automation?limit=200");
      setState({ loading: false, error: "", data });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e.message }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const d = state.data;
  const c = d?.counts || {};
  const actions = d?.actions || [];
  const isAdmin = role === "admin";
  const canPause = role === "hr" || role === "super_admin";
  const forYou = actions.filter((a) => (isAdmin ? a.status === "admin_check" : ["with_hr", "open", "couldnt_decide"].includes(a.status)));
  const recentDone = role === "hr" ? actions.filter((a) => a.status === "done").slice(0, 5) : [];

  const patch = async (payload, done) => {
    await fetchJson("/api/automation", jsonBody("PATCH", payload));
    notify(done, "", "success");
    await load();
  };

  async function togglePause() {
    setBusy(true);
    try {
      await fetchJson("/api/automation", jsonBody("PATCH", { action: "pause", paused: !d.paused }));
      notify(d.paused ? "Automation resumed" : "Automation paused", "", "success");
      await load();
    } catch (e) { notify("Not changed", e.message, "error"); } finally { setBusy(false); }
  }

  async function toggleModule(module, paused) {
    setBusy(true);
    try {
      await fetchJson("/api/automation", jsonBody("PATCH", { action: "pause", module, paused }));
      notify(`${AUTOMATION_MODULES[module]} ${paused ? "paused" : "resumed"}`, "", "success");
      await load();
    } catch (e) { notify("Not changed", e.message, "error"); } finally { setBusy(false); }
  }

  async function sendNote() {
    const text = note.trim();
    if (text.length < NOTE_MIN) { notify("Write a note", `At least ${NOTE_MIN} characters.`, "error"); return; }
    setBusy(true);
    try { await patch({ id: noting.id, action: "note", note: text }, "Sent to HR with your note"); setNoting(null); }
    catch (e) { notify("Not sent", e.message, "error"); } finally { setBusy(false); }
  }

  const item = (a, buttons) => (
    <li key={a.id} className="space-y-1 rounded-lg border p-3" data-testid="automation-item">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={TONE[a.status] || "muted"}>{STATUS_LABEL[a.status] || a.status}</StatusBadge>
        {a.escalated_at ? <StatusBadge tone="danger">Waiting too long</StatusBadge> : null}
        {a.admin_objected ? <StatusBadge tone="warning">Admin objected</StatusBadge> : null}
        <span className="text-xs text-muted-foreground">{when(a.created_at)}</span>
      </div>
      <p className="text-sm font-medium">{a.summary}</p>
      <p className="text-xs text-muted-foreground">by System, rule: {a.rule}</p>
      {a.reason ? <p className="text-xs text-destructive">Couldn&apos;t decide: {a.reason}</p> : null}
      {a.admin_note ? <p className="text-xs text-muted-foreground">{a.admin_noted_by_name}: {a.admin_note}</p> : null}
      {a.status === "admin_check" && a.admin_due_on ? <p className="text-xs text-muted-foreground">Goes to HR by itself on {a.admin_due_on} if nobody objects.</p> : null}
      {buttons ? <div className="flex flex-wrap gap-2 pt-1">{buttons}</div> : null}
    </li>
  );

  return (
    <Card className="min-w-0 shadow-xs" data-testid="automation-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><BotIcon className="size-4" aria-hidden="true" />Automation</CardTitle>
        <CardDescription>
          {isAdmin ? "What the system prepared for your branch: check it (Note / Object). With no objection it goes to HR by itself." : "What the system did and prepared. HR approvals stay manual; undo an applied action with a reason."}
        </CardDescription>
        {canPause && d ? (
          <CardAction>
            <Button size="sm" variant="outline" onClick={togglePause} disabled={busy} data-testid="automation-pause">
              {d.paused ? <><PlayIcon aria-hidden="true" />Resume automation</> : <><PauseIcon aria-hidden="true" />Pause automation</>}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {state.error && !d ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
        {d?.paused ? <p className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm" data-testid="automation-paused">Automation is paused: nothing automatic runs until HR resumes it.</p> : null}
        {canPause && d?.modules_paused ? (
          <ul className="flex flex-wrap gap-2" aria-label="Modules" data-testid="automation-modules">
            {Object.entries(AUTOMATION_MODULES).map(([m, label]) => (
              <li key={m} className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
                <span>{label}: {d.modules_paused[m] ? "paused" : "on"}</span>
                <Button size="sm" variant="ghost" className="h-7 px-2" disabled={busy} onClick={() => toggleModule(m, !d.modules_paused[m])}>
                  {d.modules_paused[m] ? "Resume" : "Pause"}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {d ? (
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" data-testid="automation-counts">
            <div className="rounded-md border p-2"><dt className="text-xs text-muted-foreground">Done (24 h)</dt><dd className="font-semibold tabular-nums">{c.done_today ?? 0}</dd></div>
            <div className="rounded-md border p-2"><dt className="text-xs text-muted-foreground">Waiting for you</dt><dd className="font-semibold tabular-nums">{c.for_you ?? 0}</dd></div>
            <div className="rounded-md border p-2"><dt className="text-xs text-muted-foreground">Couldn&apos;t decide</dt><dd className="font-semibold tabular-nums">{c.couldnt_decide ?? 0}</dd></div>
            <div className="rounded-md border p-2"><dt className="text-xs text-muted-foreground">Waiting too long</dt><dd className="font-semibold tabular-nums">{c.escalated ?? 0}</dd></div>
          </dl>
        ) : null}
        {forYou.length ? (
          <ul className="space-y-2" aria-label="Waiting for you">
            {forYou.slice(0, 10).map((a) => item(a, isAdmin ? (
              <>
                <Button size="sm" variant="outline" onClick={() => { setNoting(a); setNote(""); }}>Note</Button>
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => setObjecting(a)}>Object</Button>
              </>
            ) : null))}
          </ul>
        ) : d ? <p className="text-sm text-muted-foreground">Nothing waiting for you.</p> : null}
        {recentDone.length ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Recently done by the system</p>
            <ul className="space-y-2">{recentDone.map((a) => item(a, <Button size="sm" variant="outline" onClick={() => setUndoing(a)}>Undo</Button>))}</ul>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={Boolean(noting)} onOpenChange={(open) => { if (!open && !busy) setNoting(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Note for HR</DialogTitle>
            <DialogDescription>{noting?.summary} Your note goes to HR with it now.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="automation-note">Note</Label>
            <Textarea id="automation-note" rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoting(null)} disabled={busy}>Cancel</Button>
            <Button onClick={sendNote} disabled={busy}>Send to HR</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DecisionRemarkDialog open={Boolean(objecting)} title="Object" description={objecting ? `${objecting.summary} It goes to HR now, with your objection.` : ""}
        decision="object" entityType="automation_action" confirmLabel="Object" destructive idPrefix="automation-object"
        onClose={() => setObjecting(null)}
        onConfirm={async (remark) => { await patch({ id: objecting.id, action: "object", remark }, "Sent to HR with your objection"); setObjecting(null); }} />

      <DecisionRemarkDialog open={Boolean(undoing)} title="Undo this automatic action" description={undoing?.summary}
        decision="revoke" entityType="automation_action" confirmLabel="Undo" destructive idPrefix="automation-undo"
        onClose={() => setUndoing(null)}
        onConfirm={async (remark) => { await patch({ id: undoing.id, action: "undo", remark }, "Undone"); setUndoing(null); }} />
    </Card>
  );
}
