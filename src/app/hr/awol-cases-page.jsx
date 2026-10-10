"use client";

import * as React from "react";
import { AlertTriangleIcon, FilePlus2Icon, HourglassIcon, Loader2Icon, PauseCircleIcon, RefreshCwIcon, UserXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * AWOL Cases (/api/hr/awol-cases; docs/payroll-schedule-loans-awol.md §5).
 * The nightly check opens a case at 3 consecutive unexcused working-day
 * absences. HR confirms (status AWOL, pay held), sends the two notices,
 * records replies and recommends separation; the branch Admin decides on
 * the Approvals page. Closing as returned / excused / false alarm sets the
 * employee back to Active and releases pay.
 */

const STAGE_TONE = { flagged: "gold", confirmed: "danger", first_notice: "danger", second_notice: "danger", for_decision: "info", closed: "muted" };
const NEXT_STEP = {
  flagged: ["confirm", "Confirm AWOL"],
  confirmed: ["first_notice", "Send 1st notice"],
  first_notice: ["second_notice", "Send 2nd notice"],
  second_notice: ["recommend", "Recommend separation"],
};
const plusDays = (key, n) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function AwolCasesPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [filter, setFilter] = React.useState("open");
  const [dialog, setDialog] = React.useState(null);   // { action, row } | { action: "open" }
  const [input, setInput] = React.useState({});
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/hr/awol-cases");
      if (!data.available) throw new Error(data.error || "AWOL cases are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState({ loading: false, error: err.message || "Unable to load AWOL cases.", data: null });
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const today = manilaDateKey();
  const replyDays = state.data?.reply_days || 5;

  function open(action, row = null) {
    setDialog({ action, row });
    setError("");
    setInput({
      sent_on: today, reply_by: plusDays(today, replyDays), conference_on: plusDays(today, replyDays + 2),
      outcome: "returned", returned_on: today, note: "", text: "", employee: "", first_absent_on: "", last_present_on: "",
    });
  }

  async function submit() {
    const { action, row } = dialog;
    setBusy(true);
    setError("");
    try {
      if (action === "open") {
        await fetchJson("/api/hr/awol-cases", jsonBody("POST", { employee_id: input.employee, first_absent_on: input.first_absent_on, last_present_on: input.last_present_on, notes: input.note }));
        notify("AWOL Case Opened", "Confirm it after trying to reach the employee.", "info");
      } else {
        const body = { case_id: row.id, action };
        if (action === "confirm") body.note = input.note;
        if (action === "first_notice" || action === "second_notice") Object.assign(body, { sent_on: input.sent_on, reply_by: input.reply_by });
        if (action === "second_notice") body.conference_on = input.conference_on;
        if (action === "record_reply") body.employee_reply = input.text;
        if (action === "recommend") body.recommendation = input.text;
        if (action === "close") Object.assign(body, { outcome: input.outcome, returned_on: input.returned_on, note: input.note });
        await fetchJson("/api/hr/awol-cases", jsonBody("PATCH", body));
        const words = {
          confirm: ["Confirmed AWOL", "Pay is held until the case is closed."],
          first_notice: ["1st Notice Recorded", `Reply due ${dateLabel(input.reply_by)}.`],
          second_notice: ["2nd Notice Recorded", `Reply due ${dateLabel(input.reply_by)}.`],
          record_reply: ["Reply Recorded", ""],
          recommend: ["Sent to the Admin", "The branch Admin decides on the Approvals page."],
          close: ["Case Closed", "Status Active; pay released. Held payslips need a Super Admin override."],
        };
        notify(words[action][0], words[action][1], "success");
      }
      setDialog(null);
      await load();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  const summary = state.data?.summary || {};
  const canEdit = Boolean(state.data?.can_edit);
  const rows = (state.data?.cases || []).filter((c) => (filter === "all" ? true : filter === "closed" ? !c.open : c.open));
  const first = state.loading && !state.data;

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, cell: (c) => <div><p className="font-medium">{c.employee_name}</p><p className="text-xs text-muted-foreground">{c.employee_code}{c.employee_status ? ` · ${c.employee_status}` : ""}</p></div>, searchValue: (c) => `${c.employee_name} ${c.employee_code}` },
    { key: "absent", header: "Absent", cell: (c) => <div><p>{dateLabel(c.first_absent_on)}{c.last_absent_on && c.last_absent_on !== c.first_absent_on ? ` – ${dateLabel(c.last_absent_on)}` : ""}</p><p className="text-xs text-muted-foreground">{c.open ? `${c.absent_days} working day${c.absent_days === 1 ? "" : "s"}` : ""}{c.last_present_on ? ` · last present ${dateLabel(c.last_present_on)}` : ""}</p></div> },
    { key: "stage", header: "Stage", cell: (c) => <div className="space-y-1"><StatusBadge tone={STAGE_TONE[c.stage] || "muted"}>{c.outcome_label || c.stage_label}</StatusBadge>{c.second_notice_reply_by || c.first_notice_reply_by ? <p className="text-xs text-muted-foreground">Reply by {dateLabel(c.second_notice_reply_by || c.first_notice_reply_by)}</p> : null}</div> },
    { key: "notes", header: "Notes", cell: (c) => <p className="max-w-64 text-xs whitespace-normal text-muted-foreground">{c.employee_reply ? `Reply: ${c.employee_reply}` : c.recommendation || c.notes || "—"}</p> },
    {
      key: "actions", header: <span className="sr-only">Actions</span>, align: "right",
      cell: (c) => (canEdit && c.open ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {NEXT_STEP[c.stage] ? <Button size="sm" onClick={() => open(NEXT_STEP[c.stage][0], c)}>{NEXT_STEP[c.stage][1]}</Button> : null}
          {c.stage !== "flagged" && c.stage !== "for_decision" ? <Button size="sm" variant="outline" onClick={() => open("record_reply", c)}>Reply</Button> : null}
          <Button size="sm" variant="outline" onClick={() => open("close", c)}>Close</Button>
        </div>
      ) : null),
    },
  ];

  const titles = {
    open: ["Open an AWOL case", "Normally the nightly check opens cases. Use this when absences were recorded late."],
    confirm: ["Confirm AWOL", "You tried the employee and the emergency contact and could not reach them. Status becomes AWOL and pay is held."],
    first_notice: ["1st notice", "Return-to-Work Order + Notice to Explain, by email and courier to the last known address."],
    second_notice: ["2nd notice", "Final Return-to-Work Order and invitation to an administrative conference."],
    record_reply: ["Employee's reply", "Write what the employee said or submitted."],
    recommend: ["Recommend separation", "Explain the grounds. The branch Admin approves or returns it on the Approvals page."],
    close: ["Close the case", "The employee goes back to Active and pay is released."],
  };
  const fieldFor = (id, label, el) => <div className="space-y-1.5"><Label htmlFor={`hr-awol-${id}`}>{label}</Label>{el}</div>;

  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open cases" value={summary.open || 0} hint="Flagged to waiting for Admin" icon={UserXIcon} tone="danger" loading={first} />
        <StatCard label="To confirm" value={summary.flagged || 0} hint="Flagged by the nightly check" icon={AlertTriangleIcon} tone="gold" loading={first} />
        <StatCard label="Waiting for Admin" value={summary.waiting_admin || 0} hint="Separation recommended" icon={HourglassIcon} tone="info" loading={first} />
        <StatCard label="Pay on hold" value={summary.held || 0} hint="AWOL or separated" icon={PauseCircleIcon} tone="danger" loading={first} />
      </section>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>AWOL cases</CardTitle>
          <CardAction className="flex flex-wrap gap-2">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger size="sm" className="w-28" aria-label="Show"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="open">Open</SelectItem><SelectItem value="closed">Closed</SelectItem><SelectItem value="all">All</SelectItem></SelectContent>
            </Select>
            {canEdit ? <Button size="sm" variant="outline" onClick={() => open("open")}><FilePlus2Icon aria-hidden="true" />Open case</Button> : null}
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={columns} rows={rows} loading={first} error={state.error} onRetry={load} pageSize={15}
            searchPlaceholder="Search employee…" empty={{ title: "No AWOL cases", icon: UserXIcon }} caption="AWOL cases" minWidth={980} />
          <p className="mt-3 text-xs text-muted-foreground">An AWOL case is not automatically abandonment: separation needs both notices, a chance to reply, and the Admin&apos;s decision. Reply periods are at least {replyDays} calendar days.</p>
        </CardContent>
      </Card>

      <Dialog open={Boolean(dialog)} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          {dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>{titles[dialog.action][0]}{dialog.row ? ` — ${dialog.row.employee_name}` : ""}</DialogTitle>
                <DialogDescription>{titles[dialog.action][1]}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                {dialog.action === "open" ? (
                  <>
                    <div className="sm:col-span-2">{fieldFor("employee", "Employee", (
                      <Select value={input.employee} onValueChange={(v) => setInput((c) => ({ ...c, employee: v }))}>
                        <SelectTrigger id="hr-awol-employee" className="w-full"><SelectValue placeholder="Select employee" /></SelectTrigger>
                        <SelectContent>{(state.data?.people || []).map((p) => <SelectItem key={p.id} value={p.id}>{`${p.full_name} — ${p.employee_id}`}</SelectItem>)}</SelectContent>
                      </Select>
                    ))}</div>
                    {fieldFor("first", "First day absent", <DatePicker id="hr-awol-first" value={input.first_absent_on} onChange={(v) => setInput((c) => ({ ...c, first_absent_on: v }))} />)}
                    {fieldFor("last", "Last day present (optional)", <DatePicker id="hr-awol-last" value={input.last_present_on} onChange={(v) => setInput((c) => ({ ...c, last_present_on: v }))} />)}
                  </>
                ) : null}
                {dialog.action === "first_notice" || dialog.action === "second_notice" ? (
                  <>
                    {fieldFor("sent", "Sent on", <DatePicker id="hr-awol-sent" value={input.sent_on} onChange={(v) => setInput((c) => ({ ...c, sent_on: v, reply_by: plusDays(v, replyDays) }))} />)}
                    {fieldFor("reply", "Reply by", <DatePicker id="hr-awol-reply" value={input.reply_by} onChange={(v) => setInput((c) => ({ ...c, reply_by: v }))} />)}
                    {dialog.action === "second_notice" ? <div className="sm:col-span-2">{fieldFor("conf", "Administrative conference (optional)", <DatePicker id="hr-awol-conf" value={input.conference_on} onChange={(v) => setInput((c) => ({ ...c, conference_on: v }))} />)}</div> : null}
                  </>
                ) : null}
                {dialog.action === "close" ? (
                  <>
                    {fieldFor("outcome", "Outcome", (
                      <Select value={input.outcome} onValueChange={(v) => setInput((c) => ({ ...c, outcome: v }))}>
                        <SelectTrigger id="hr-awol-outcome" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="returned">Returned to work</SelectItem><SelectItem value="excused_by_leave">Excused by leave</SelectItem><SelectItem value="false_alarm">False alarm</SelectItem></SelectContent>
                      </Select>
                    ))}
                    {input.outcome === "returned" ? fieldFor("returned", "Returned on", <DatePicker id="hr-awol-returned" value={input.returned_on} onChange={(v) => setInput((c) => ({ ...c, returned_on: v }))} />) : null}
                  </>
                ) : null}
                {["record_reply", "recommend"].includes(dialog.action) ? (
                  <div className="sm:col-span-2">{fieldFor("text", dialog.action === "recommend" ? "Recommendation" : "Reply", <Textarea id="hr-awol-text" rows={4} maxLength={2000} value={input.text} onChange={(e) => setInput((c) => ({ ...c, text: e.target.value }))} />)}</div>
                ) : null}
                {["open", "confirm", "close"].includes(dialog.action) ? (
                  <div className="sm:col-span-2">{fieldFor("note", dialog.action === "close" ? "Why it is closed" : "Note", <Input id="hr-awol-note" maxLength={1000} placeholder={dialog.action === "confirm" ? "e.g. Called Nov 12 and the emergency contact; no answer" : ""} value={input.note} onChange={(e) => setInput((c) => ({ ...c, note: e.target.value }))} />)}</div>
                ) : null}
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
                <Button onClick={submit} disabled={busy} variant={dialog.action === "confirm" ? "destructive" : "default"}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save</Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
