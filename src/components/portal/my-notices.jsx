"use client";

import * as React from "react";
import { AlertTriangleIcon, FileTextIcon, Loader2Icon, MailWarningIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { downloadFile } from "@/lib/portal/download";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { manilaDateKey } from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/*
 * My Notices (2026-11-24): the employee's attendance (AWOL) notices, with the
 * PDF and the deadline; "Reply" (an explanation, a reason, optional
 * attachments, the date they intend to return). A reply stops the automation
 * and HR decides; it is never edited, a follow-up adds to it. Open while the
 * case is open and after separation.
 */

const API = "/api/me/awol-notices";

async function readFiles(list) {
  const out = [];
  for (const f of Array.from(list || []).slice(0, 3)) {
    const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] || ""); r.onerror = reject; r.readAsDataURL(f); });
    out.push({ name: f.name, type: f.type, data });
  }
  return out;
}

/** The Dashboard banner while a notice waits for the employee's reply. */
export function AwolNoticeBanner({ onOpen }) {
  const [banner, setBanner] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    fetchJson(API).then((d) => { if (alive) setBanner(d.banner || null); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!banner) return null;
  return (
    <Alert className="border-destructive/40 bg-destructive/5" data-testid="awol-banner">
      <MailWarningIcon className="text-destructive" aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span><strong className="text-foreground">You have an attendance notice.</strong> Please reply{banner.deadline ? ` by ${dateLabel(banner.deadline)}` : ""}.</span>
        <Button size="sm" onClick={onOpen}>Open My Notices</Button>
      </AlertDescription>
    </Alert>
  );
}

function ReplyForm({ caseId, kind, reasons, onSent }) {
  const { notify } = usePortalSession();
  const [f, setF] = React.useState({ reason_code: "", explanation: "", return_on: "", files: [] });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const id = `reply-${caseId}-${kind}`;
  async function send() {
    setError("");
    if (kind === "reply" && !f.reason_code) { setError("Choose the reason."); return; }
    if (f.explanation.trim().length < 10) { setError("Write your explanation (at least 10 characters)."); return; }
    setBusy(true);
    try {
      const res = await fetchJson(API, jsonBody("POST", { case_id: caseId, kind, reason_code: f.reason_code || undefined, explanation: f.explanation, return_on: f.return_on || undefined, attachments: f.files }));
      notify(kind === "reply" ? "Reply received" : "Follow-up sent", `Received on ${dateLabel(res.received_on)}. HR reviews it and decides.`, "success");
      setF({ reason_code: "", explanation: "", return_on: "", files: [] });
      onSent();
    } catch (e) { setError(e.message || "Not sent."); } finally { setBusy(false); }
  }
  return (
    <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2" data-testid={`awol-${kind}-form`}>
      {kind === "reply" ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-reason`}>Reason</Label>
          <Select value={f.reason_code} onValueChange={(v) => setF((c) => ({ ...c, reason_code: v }))}>
            <SelectTrigger id={`${id}-reason`} className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
            <SelectContent>{Object.entries(reasons || {}).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      ) : null}
      {kind === "reply" ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-return`}>I intend to return on <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <DatePicker id={`${id}-return`} value={f.return_on} min={manilaDateKey()} onChange={(v) => setF((c) => ({ ...c, return_on: v }))} />
        </div>
      ) : null}
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${id}-text`}>{kind === "reply" ? "Explanation" : "Follow-up message"}</Label>
        <Textarea id={`${id}-text`} rows={4} maxLength={2000} value={f.explanation} onChange={(e) => setF((c) => ({ ...c, explanation: e.target.value }))} />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${id}-files`}>Attachments <span className="font-normal text-muted-foreground">(optional: medical certificate etc.; PDF / JPG / PNG, up to 3, 5 MB each)</span></Label>
        <Input id={`${id}-files`} type="file" multiple accept="application/pdf,image/jpeg,image/png" onChange={async (e) => { const files = await readFiles(e.target.files); setF((c) => ({ ...c, files })); }} />
      </div>
      {error ? <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p> : null}
      <div className="flex justify-end sm:col-span-2">
        <Button onClick={send} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{kind === "reply" ? "Send reply" : "Send follow-up"}</Button>
      </div>
    </div>
  );
}

export function MyNoticesPage({ refreshKey = 0 }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: "", data: null });
  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try { setState({ loading: false, error: "", data: await fetchJson(API) }); }
    catch (e) { setState((s) => ({ ...s, loading: false, error: e.message })); }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  const cases = state.data?.cases || [];
  const reasons = state.data?.reasons || {};
  return (
    <Card className="min-w-0 shadow-xs" data-testid="my-notices">
      <CardHeader>
        <CardTitle>My Notices</CardTitle>
        <CardDescription>Attendance notices from HR, with the deadline to reply. If you cannot sign in, reply in person at the HR office before the deadline.</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
        {!state.loading && !cases.length ? <p className="text-sm text-muted-foreground">You have no notices.</p> : null}
        {cases.map((c) => {
          const replied = c.replies.some((r) => r.kind === "reply" || r.kind === "hr_record");
          return (
            <section key={c.id} className="space-y-3 rounded-lg border p-4" aria-label="Notice" data-testid="my-notice">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={c.open ? "warning" : c.decision?.text === "Separated" ? "danger" : "success"}>{c.stage_text}</StatusBadge>
                  {c.open && c.deadline ? <span className="text-sm">Reply by <strong>{dateLabel(c.deadline)}</strong></span> : null}
                </div>
                <span className="text-xs text-muted-foreground">Absent since {dateLabel(c.first_absent_on)}</span>
              </div>
              <ul className="space-y-1">
                {c.notices.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span><FileTextIcon className="mr-1 inline size-4" aria-hidden="true" />{n.title} · sent {dateLabel(n.sent_on)}{n.kind === "second" && n.separation_on ? ` · effective ${dateLabel(n.separation_on)}` : n.reply_by ? ` · reply by ${dateLabel(n.reply_by)}` : ""}</span>
                    <Button size="sm" variant="outline" onClick={() => downloadFile(`${API}?notice=${n.id}`, {}, { fallbackName: "notice.pdf" }).catch((e) => notify("Not downloaded", e.message, "error"))}>PDF</Button>
                  </li>
                ))}
              </ul>
              {c.replies.length ? (
                <ol className="space-y-2" aria-label="Replies">
                  {c.replies.map((r) => (
                    <li key={r.id} className="rounded-md bg-muted/40 p-2 text-sm">
                      <p className="text-xs text-muted-foreground">{r.kind === "hr_record" ? `Recorded by HR (${r.received_how.replace("_", " ")})` : r.kind === "follow_up" ? "Your follow-up" : "Your reply"} · received {dateLabel(r.received_on)}{r.return_on ? ` · return on ${dateLabel(r.return_on)}` : ""}</p>
                      <p className="whitespace-pre-wrap">{r.explanation}</p>
                      {(r.attachments || []).map((a) => (
                        <Button key={a.path} size="sm" variant="ghost" className="h-7 px-2" onClick={() => downloadFile(`${API}?file=${encodeURIComponent(a.path)}`, {}, { fallbackName: a.name }).catch((e) => notify("Not downloaded", e.message, "error"))}>{a.name}</Button>
                      ))}
                    </li>
                  ))}
                </ol>
              ) : null}
              {replied && c.open ? <p className="text-sm text-success" data-testid="reply-received">Your reply was received on {dateLabel(c.replies.find((r) => r.kind !== "follow_up")?.received_on)}. HR reviews it and decides.</p> : null}
              {c.decision ? (
                <Alert className="border-info/40 bg-info/5"><AlertTriangleIcon className="text-info" aria-hidden="true" /><AlertDescription>HR&apos;s decision: <strong className="text-foreground">{c.decision.text}</strong>{c.decision.at ? ` on ${dateLabel(String(c.decision.at).slice(0, 10))}` : ""}.</AlertDescription></Alert>
              ) : null}
              {c.open ? <ReplyForm caseId={c.id} kind={replied ? "follow_up" : "reply"} reasons={reasons} onSent={load} /> : null}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
