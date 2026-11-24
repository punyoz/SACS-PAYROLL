"use client";

import { DecisionRemarkDialog } from "@/components/portal/remark-field";
import { RECEIVED_HOW } from "@/lib/awol/replies";

import * as React from "react";
import { AlertTriangleIcon, FilePlus2Icon, HourglassIcon, Loader2Icon, MailIcon, MoreHorizontalIcon, PauseCircleIcon, RefreshCwIcon, UserXIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EMPTY_REMARK, RemarkField, remarkProblem } from "@/components/portal/remark-field";
import { useApprovalFilters } from "@/components/portal/approval-filters";
import { downloadFile } from "@/lib/portal/download";
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
import { useUrlParam } from "@/components/portal/use-url-param";
import { currentPageHref } from "@/lib/portal/navigate";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { AWOL_RECORD_MAX } from "@/lib/input-limits";
import { SearchableSelect } from "@/components/portal/searchable-select";

/*
 * AWOL Cases (/api/hr/awol-cases; docs/payroll-schedule-loans-awol.md §5).
 * The nightly check opens a case at 3 consecutive unexcused working-day
 * absences. HR confirms (status AWOL, pay held), sends the two notices,
 * records replies and decides separation itself (no Admin approval).
 * Closing as returned / excused / false alarm sets the
 * employee back to Active and releases pay.
 */

const STAGE_TONE = { flagged: "gold", confirmed: "danger", first_notice: "danger", second_notice: "danger", for_decision: "info", closed: "muted" };
const NEXT_STEP = {
  flagged: ["confirm", "Confirm AWOL"],
  confirmed: ["first_notice", "Send 1st notice"],
  first_notice: ["second_notice", "Send 2nd notice"],
  second_notice: ["separate", "Separate employee"],
  for_decision: ["separate", "Separate employee"],
};
const plusDays = (key, n) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The case's automation (2026-11-24): automatic until separation, with automatic stops. */
const AUTOMATION = {
  auto: ["Automatic", "info"],
  needs_review: ["Needs review", "warning"],
  response: ["Response received: HR decides", "warning"],
  stopped: ["Automation stopped", "muted"],
};

/** Files chosen in a file input, as { name, type, data (base64) } (the server checks type and size). */
async function readFiles(list) {
  const out = [];
  for (const f of Array.from(list || []).slice(0, 3)) {
    const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] || ""); r.onerror = reject; r.readAsDataURL(f); });
    out.push({ name: f.name, type: f.type, data });
  }
  return out;
}

/** What happens next on an open case, in words (2026-11-26). */
function nextStepOf(c) {
  if (!c.open) return "—";
  if (c.automation === "response") return "Reply received: you decide (Separate or Close)";
  if (c.stage === "for_decision") return "Reply period ended: you decide (Separate or Close)";
  if (c.stage === "flagged") return c.automation === "auto" ? "The system confirms it tonight" : "Needs your review: Proceed or Close";
  if (c.stage === "first_notice") return `Waiting for the reply${c.first_notice_reply_by ? ` (by ${dateLabel(c.first_notice_reply_by)})` : ""}`;
  if (c.stage === "second_notice") return c.separation_scheduled_on ? `Separation on ${dateLabel(c.separation_scheduled_on)}` : "Notice of separation sent";
  return c.stage_label || "—";
}

/** A template with sample values, for the settings Preview. */
const SAMPLE = { today: "Nov 26, 2026", employee_name: "Juan Dela Cruz", employee_code: "SACS-010", branch: "Main Branch", first_absent_on: "Nov 18, 2026", reply_by: "Nov 29, 2026", separation_on: "Dec 2, 2026" };
const previewOf = (text) => String(text || "").replace(/\{(\w+)\}/g, (m, k) => SAMPLE[k] ?? m);

export function AwolCasesPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [filter, setFilter] = useUrlParam("awol_filter", "open");
  const [dialog, setDialog] = React.useState(null);   // { action, row } | { action: "open" }
  const [input, setInput] = React.useState({});
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [detail, setDetail] = React.useState(null);   // the case shown in the drawer
  const [tplTab, setTplTab] = React.useState("first");

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/hr/awol-cases");
      if (!data.available) throw new Error(data.error || "AWOL cases are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((c) => ({ loading: false, error: err.message || "Unable to load AWOL cases.", data: c.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const today = manilaDateKey();
  const replyDays = state.data?.reply_days || 5;

  function open(action, row = null) {
    setDialog({ action, row });
    setError("");
    setInput({
      sent_on: today, reply_by: plusDays(today, replyDays), conference_on: plusDays(today, replyDays + 2), separation_effective: today,
      outcome: "returned", returned_on: today, note: "", text: "", employee: "", first_absent_on: "", last_present_on: "",
      remark: EMPTY_REMARK,
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
        if (action === "record_reply") Object.assign(body, { employee_reply: input.text, received_on: input.received_on || today, received_how: input.received_how || "in_person", attachments: input.files || [] });
        if (action === "separate") {
          const problem = remarkProblem(input.remark, "approve", true);
          if (problem) throw new Error(problem);
          Object.assign(body, { remark: input.remark });
        }
        if (action === "close") {
          // Part H: why it is closed is a preset remark (required).
          const problem = remarkProblem(input.remark, "resolve", true);
          if (problem) throw new Error(problem);
          Object.assign(body, { outcome: input.outcome, returned_on: input.returned_on, remark: input.remark });
        }
        await fetchJson("/api/hr/awol-cases", jsonBody("PATCH", body));
        const words = {
          confirm: ["Confirmed AWOL", "Pay is held until the case is closed."],
          first_notice: ["1st Notice Recorded", `Reply due ${dateLabel(input.reply_by)}.`],
          second_notice: ["2nd Notice Recorded", `Reply due ${dateLabel(input.reply_by)}.`],
          record_reply: ["Reply Recorded", ""],
          separate: ["Employee Separated", `Effective ${dateLabel(input.separation_effective)}. Paid only through final pay.`],
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
  const openRows = (state.data?.cases || []).filter((c) => (filter === "all" ? true : filter === "closed" ? !c.open : c.open));
  // Part F: search, stage (with counts), branch, category, employment status, dates and sort (in the address).
  const caseFilters = useApprovalFilters(openRows, {
    prefix: "awol", typeLabel: "Stage",
    get: { name: (c) => c.employee_name, code: (c) => c.employee_code, type: (c) => c.outcome_label || c.stage_label, filed: (c) => c.created_at || c.first_absent_on, requested: (c) => c.first_absent_on, branch: (c) => c.branch_id, employeeId: (c) => c.employee_id },
  });
  const rows = caseFilters.rows;
  const first = state.loading && !state.data;

  // 2026-11-24: HR's ONE button on a case the system left for review: confirmed (pay held) + 1st notice sent.
  const confirmSend = async (c) => {
    try {
      await fetchJson("/api/hr/awol-cases", jsonBody("PATCH", { case_id: c.id, action: "confirm_send" }));
      notify("Confirmed and 1st notice sent", `${c.employee_name} must reply by ${dateLabel(plusDays(today, replyDays))}. Pay is on hold.`, "success");
      await load();
    } catch (e) { notify("Not sent", e.message, "error"); }
  };
  const [stopping, setStopping] = React.useState(null);
  const resume = async (c) => {
    try {
      await fetchJson("/api/hr/awol-cases", jsonBody("PATCH", { case_id: c.id, action: "resume_automation" }));
      notify("Automation resumed", `${c.employee_name}'s case continues automatically.`, "success");
      await load();
    } catch (e) { notify("Not resumed", e.message, "error"); }
  };
  // Part D: the 1st notice's editable template (fields in braces, e.g. {reply_by}).
  const [template, setTemplate] = React.useState(null); // { text, fields } while open
  const [templateBusy, setTemplateBusy] = React.useState(false);
  const openTemplate = async () => {
    try { setTemplate(await fetchJson("/api/hr/awol-cases/template")); } catch (e) { notify("Not loaded", e.message, "error"); }
  };
  // 2026-11-24: the AWOL settings: both notice templates and the days (threshold, reply period, separation delay).
  const saveTemplate = async () => {
    setTemplateBusy(true);
    try {
      await fetchJson("/api/hr/awol-cases/template", jsonBody("POST", { days: { flag_days: Number(template.days.flag_days), reply_days: Number(template.days.reply_days), separation_days: Number(template.days.separation_days) } }));
      await fetchJson("/api/hr/awol-cases/template", jsonBody("POST", { text: template.text }));
      await fetchJson("/api/hr/awol-cases/template", jsonBody("POST", { kind: "second", text: template.second_text }));
      notify("AWOL settings saved", "New cases and notices use them.", "success");
      setTemplate(null);
    } catch (e) { notify("Not saved", e.message, "error"); } finally { setTemplateBusy(false); }
  };
  const setDay = (k) => (e) => setTemplate((t) => ({ ...t, days: { ...t.days, [k]: e.target.value } }));

  const pdf = (href, name) => downloadFile(href, {}, { fallbackName: name }).catch((e) => notify("Not downloaded", e.message, "error"));
  // One primary action per case (2026-11-26); the rest sit in the ⋯ menu.
  const primaryOf = (c) => {
    if (!canEdit || !c.open) return null;
    if (c.stage === "flagged" && c.automation !== "auto") return <Button size="sm" onClick={() => open("proceed", c)} data-testid="awol-proceed">Proceed</Button>;
    if (c.stage === "for_decision" || (c.automation === "response" && c.stage === "first_notice")) return <Button size="sm" onClick={() => open("separate", c)} data-testid="awol-separate">Separate</Button>;
    return <Button size="sm" variant="outline" onClick={() => open("record_reply", c)}>Record reply</Button>;
  };
  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, cell: (c) => (
      <div className="space-y-1">
        <button type="button" className="font-medium hover:underline" onClick={() => setDetail(c)}>{c.employee_name}</button>
        <p className="text-xs text-muted-foreground">{c.employee_code}{c.employee_status ? ` · ${c.employee_status}` : ""}</p>
        {c.open ? <span data-testid="awol-automation"><StatusBadge tone={AUTOMATION[c.automation]?.[1] || "muted"}>{AUTOMATION[c.automation]?.[0] || c.automation}</StatusBadge></span> : null}
      </div>
    ), searchValue: (c) => `${c.employee_name} ${c.employee_code}` },
    { key: "absent", header: "Absent", cell: (c) => <div><p>{dateLabel(c.first_absent_on)}{c.last_absent_on && c.last_absent_on !== c.first_absent_on ? ` – ${dateLabel(c.last_absent_on)}` : ""}</p><p className="text-xs text-muted-foreground">{c.open ? `${c.absent_days} working day${c.absent_days === 1 ? "" : "s"}` : ""}</p></div> },
    { key: "stage", header: "Stage", cell: (c) => <StatusBadge tone={STAGE_TONE[c.stage] || "muted"}>{c.outcome_label || c.stage_label}</StatusBadge> },
    { key: "next", header: "Next step", cell: (c) => <p className="max-w-64 text-sm whitespace-normal" data-testid="awol-next-step">{nextStepOf(c)}</p> },
    {
      key: "actions", header: <span className="sr-only">Actions</span>, align: "right",
      cell: (c) => (
        <div className="flex items-center justify-end gap-1.5">
          {primaryOf(c)}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-8" aria-label={`More for ${c.employee_name}`}><MoreHorizontalIcon aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDetail(c)}>View details</DropdownMenuItem>
              {(c.notices || []).map((n) => (
                <DropdownMenuItem key={n.id} onSelect={() => pdf(`/api/hr/awol-cases/notice?notice=${n.id}`, `awol-${n.kind}-notice.pdf`)}>{n.kind === "second" ? "Notice of separation (PDF)" : "1st notice (PDF)"}</DropdownMenuItem>
              ))}
              {c.stage === "flagged" ? <DropdownMenuItem onSelect={() => pdf(`/api/hr/awol-cases/notice?id=${c.id}`, "awol-first-notice.pdf")}>Review notice (PDF)</DropdownMenuItem> : null}
              {canEdit && c.open ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => open("record_reply", c)}>Record reply</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => open("close", c)}>Close</DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  const titles = {
    open: ["Open an AWOL case", "Normally the nightly check opens cases. Use this when absences were recorded late."],
    confirm: ["Confirm AWOL", "You tried the employee and the emergency contact and could not reach them. Status becomes AWOL and pay is held."],
    first_notice: ["1st notice", "Return-to-Work Order + Notice to Explain, by email and courier to the last known address."],
    second_notice: ["2nd notice", "Final Return-to-Work Order and invitation to an administrative conference."],
    record_reply: ["Record a reply", "A reply received by letter, phone or in person. It stops the automation; you decide next."],
    separate: ["Separate", "Sends the notice of separation now. The employee is separated automatically on its effective date unless they respond first; you can still Close the case before then."],
    proceed: ["Proceed", "Confirms AWOL (pay on hold) and sends the 1st notice now; from here the case runs automatically."],
    close: ["Close the case", "The employee goes back to Active and pay is released."],
  };
  const fieldFor = (id, label, el) => <div className="space-y-1.5"><Label htmlFor={`hr-awol-${id}`}>{label}</Label>{el}</div>;

  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open cases" value={summary.open || 0} hint="Not closed yet" icon={UserXIcon} tone="danger" loading={first} href={currentPageHref({ awol_filter: "open" })} onClick={() => setFilter("open")} scrollTo="awol-table" actionLabel="Show open cases" />
        <StatCard label="Waiting for reply" value={(state.data?.cases || []).filter((c) => c.open && c.stage === "first_notice" && c.automation === "auto").length} hint="1st notice sent" icon={MailIcon} tone="gold" loading={first} />
        <StatCard label="Ready for HR decision" value={(state.data?.cases || []).filter((c) => c.open && (c.stage === "for_decision" || c.automation === "response" || (c.stage === "flagged" && c.automation !== "auto"))).length} hint="Separate or Close" icon={HourglassIcon} tone="info" loading={first} />
        <StatCard label="Pay on hold" value={summary.held || 0} hint="AWOL or separated" icon={PauseCircleIcon} tone="danger" loading={first} />
      </section>

      <DecisionRemarkDialog open={Boolean(stopping)} title={`Stop the automation · ${stopping?.employee_name || ""}`}
        description="Nothing happens automatically on this case until you resume it. You take the next steps (or close it)."
        decision="override" entityType="awol_case" confirmLabel="Stop automation" destructive idPrefix="awol-stop"
        onClose={() => setStopping(null)}
        onConfirm={async (remark) => {
          await fetchJson("/api/hr/awol-cases", jsonBody("PATCH", { case_id: stopping.id, action: "stop_automation", remark }));
          notify("Automation stopped", `${stopping.employee_name}'s case waits for you.`, "success");
          setStopping(null);
          await load();
        }} />

      <Card id="awol-table" className="min-w-0 scroll-mt-20 shadow-xs">
        <CardHeader>
          <CardTitle>AWOL cases</CardTitle>
          <CardAction className="flex flex-wrap gap-2">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger size="sm" className="w-28" aria-label="Show"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="open">Open</SelectItem><SelectItem value="closed">Closed</SelectItem><SelectItem value="all">All</SelectItem></SelectContent>
            </Select>
            {canEdit ? <Button size="sm" variant="outline" onClick={() => open("open")}><FilePlus2Icon aria-hidden="true" />Open case</Button> : null}
            {canEdit ? <Button size="sm" variant="outline" onClick={openTemplate}>AWOL settings</Button> : null}
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable toolbar={caseFilters.toolbar} columns={columns} rows={rows} loading={first} error={state.error} onRetry={load}
            searchPlaceholder="Search employee…" empty={{ title: "No AWOL cases", icon: UserXIcon }} caption="AWOL cases" minWidth={980} />
          <p className="mt-3 text-xs text-muted-foreground">Automatic only when every guard passes: AWOL confirmed (pay on hold) with the 1st notice. When the reply period ends ({replyDays} days), the case is ready for your decision: Separate (notice of separation; separated on its date) or Close. A reply, a tap or a request stops the automation for you to decide.</p>
        </CardContent>
      </Card>
      <Sheet open={Boolean(detail)} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg" data-testid="awol-drawer">
          {detail ? (
            <>
              <SheetHeader>
                <SheetTitle>{detail.employee_name}</SheetTitle>
                <SheetDescription>{detail.employee_code} · absent since {dateLabel(detail.first_absent_on)} · {detail.outcome_label || detail.stage_label}</SheetDescription>
              </SheetHeader>
              <div className="space-y-5 px-4 pb-6 text-sm">
                <section aria-label="Timeline">
                  <h3 className="mb-2 font-semibold">Timeline</h3>
                  <ol className="space-y-1.5 border-l pl-3">
                    {detail.last_present_on ? <li>Last present: {dateLabel(detail.last_present_on)}</li> : null}
                    <li>Opened{detail.auto_flagged ? " by System" : ""}: absent since {dateLabel(detail.first_absent_on)}</li>
                    {detail.first_notice_sent_on ? <li>1st notice sent {dateLabel(detail.first_notice_sent_on)}{detail.first_notice_reply_by ? `, reply by ${dateLabel(detail.first_notice_reply_by)}` : ""}</li> : null}
                    {(detail.replies || []).map((r) => <li key={r.id}>{r.kind === "hr_record" ? "Reply recorded by HR" : r.kind === "follow_up" ? "Follow-up" : "Reply"} {dateLabel(r.received_on)}</li>)}
                    {detail.second_notice_sent_on ? <li>Notice of separation sent {dateLabel(detail.second_notice_sent_on)}{detail.separation_scheduled_on ? `, effective ${dateLabel(detail.separation_scheduled_on)}` : ""}</li> : null}
                    {!detail.open ? <li>Closed: {detail.outcome_label}</li> : <li className="font-medium">Next: {nextStepOf(detail)}</li>}
                  </ol>
                  {detail.automation_reason ? <p className="mt-2 text-xs text-muted-foreground">{detail.automation_reason}</p> : null}
                </section>
                {detail.guards?.checks ? (
                  <section aria-label="Guards">
                    <h3 className="mb-2 font-semibold">Guards</h3>
                    <ul className="space-y-0.5 text-xs" data-testid="awol-guards">
                      {detail.guards.checks.map((g) => <li key={g.key} className={g.ok ? "text-muted-foreground" : "text-destructive"}>{g.ok ? "✓" : "✗"} {g.label}{g.ok ? "" : `: ${g.detail}`}</li>)}
                    </ul>
                  </section>
                ) : null}
                <section aria-label="Notices">
                  <h3 className="mb-2 font-semibold">Notices</h3>
                  {(detail.notices || []).length ? (
                    <div className="flex flex-wrap gap-2">
                      {detail.notices.map((n) => <Button key={n.id} size="sm" variant="outline" onClick={() => pdf(`/api/hr/awol-cases/notice?notice=${n.id}`, `awol-${n.kind}-notice.pdf`)}>{n.kind === "second" ? "Notice of separation" : "1st notice"} (PDF)</Button>)}
                    </div>
                  ) : <p className="text-muted-foreground">None sent yet.</p>}
                </section>
                <section aria-label="Replies">
                  <h3 className="mb-2 font-semibold">Replies</h3>
                  {(detail.replies || []).length ? (
                    <ul className="space-y-2" data-testid="awol-replies">
                      {detail.replies.map((r) => (
                        <li key={r.id} className="rounded-md bg-muted/40 p-2">
                          <p className="text-xs text-muted-foreground">{r.kind === "hr_record" ? `Recorded by ${r.author_name} (${String(r.received_how).replace("_", " ")})` : r.kind === "follow_up" ? "Follow-up" : "Reply"} · {dateLabel(r.received_on)}{r.return_on ? ` · return ${dateLabel(r.return_on)}` : ""}</p>
                          <p className="whitespace-pre-wrap">{r.explanation}</p>
                          {(r.attachments || []).map((f) => <Button key={f.path} size="sm" variant="ghost" className="h-7 px-2" onClick={() => pdf(`/api/hr/awol-cases/notice?reply_file=${encodeURIComponent(f.path)}`, f.name)}>{f.name}</Button>)}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-muted-foreground">{detail.recommendation || "No reply yet."}</p>}
                </section>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={Boolean(template)} onOpenChange={(o) => { if (!o && !templateBusy) setTemplate(null); }}>
        <DialogContent className="sm:max-w-2xl" data-testid="awol-notice-template">
          <DialogHeader>
            <DialogTitle>AWOL settings</DialogTitle>
            <DialogDescription>The days the automation uses and the two notices. The first paragraph of a notice is its title; tap a placeholder to add it.</DialogDescription>
          </DialogHeader>
          {template?.days ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {fieldFor("flag-days", "Days absent", <Input id="hr-awol-flag-days" type="number" min={3} max={30} value={template.days.flag_days} onChange={setDay("flag_days")} />)}
              {fieldFor("reply-days", "Reply period (days)", <Input id="hr-awol-reply-days" type="number" min={1} max={30} value={template.days.reply_days} onChange={setDay("reply_days")} />)}
              {fieldFor("separation-days", "Separation after decision (days)", <Input id="hr-awol-separation-days" type="number" min={1} max={30} value={template.days.separation_days} onChange={setDay("separation_days")} />)}
            </div>
          ) : null}
          <Tabs value={tplTab} onValueChange={setTplTab}>
            <TabsList>
              <TabsTrigger value="first">1st notice</TabsTrigger>
              <TabsTrigger value="second">Notice of separation</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="first" className="space-y-2">
              <Textarea id="hr-awol-template-1" aria-label="Notice template" rows={9} maxLength={4000} value={template?.text || ""} onChange={(e) => setTemplate((t) => ({ ...t, text: e.target.value }))} />
            </TabsContent>
            <TabsContent value="second" className="space-y-2">
              <Textarea id="hr-awol-template-2" aria-label="Notice of separation template" rows={9} maxLength={4000} value={template?.second_text || ""} onChange={(e) => setTemplate((t) => ({ ...t, second_text: e.target.value }))} />
            </TabsContent>
            <TabsContent value="preview">
              <pre className="max-h-72 overflow-y-auto rounded-md border bg-muted/30 p-3 font-sans text-sm whitespace-pre-wrap" data-testid="awol-template-preview">{previewOf(template?.text)}{"\n\n— — —\n\n"}{previewOf(template?.second_text)}</pre>
            </TabsContent>
          </Tabs>
          {tplTab !== "preview" ? (
            <div className="flex flex-wrap gap-1.5" aria-label="Placeholders">
              {(template?.fields || []).map((f) => (
                <Button key={f} type="button" size="sm" variant="outline" className="h-7 px-2 font-mono text-xs"
                  onClick={() => setTemplate((t) => (tplTab === "second" ? { ...t, second_text: `${t.second_text || ""}{${f}}` } : { ...t, text: `${t.text || ""}{${f}}` }))}>{`{${f}}`}</Button>
              ))}
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setTemplate(null)} disabled={templateBusy}>Cancel</Button>
            <Button onClick={saveTemplate} disabled={templateBusy}>{templateBusy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save settings</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                      <SearchableSelect id="hr-awol-employee" label="Employee" value={input.employee} onValueChange={(v) => setInput((c) => ({ ...c, employee: v }))}
                        placeholder="Select employee" searchPlaceholder="Search name or employee ID…"
                        options={(state.data?.people || []).map((p) => ({ value: p.id, label: `${p.full_name} — ${p.employee_id}` }))} />
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
                {dialog.action === "separate" ? (
                  <div className="sm:col-span-2">
                    <RemarkField id="hr-awol-sep" decision="approve" entityType="awol_case" required label="Grounds"
                      value={input.remark} onChange={(v) => setInput((c) => ({ ...c, remark: v }))} error={error} disabled={busy} />
                  </div>
                ) : null}
                {dialog.action === "record_reply" ? (
                  <>
                    {fieldFor("received", "Received on", <DatePicker id="hr-awol-received" value={input.received_on || today} max={today} onChange={(v) => setInput((c) => ({ ...c, received_on: v }))} />)}
                    {fieldFor("how", "How", (
                      <Select value={input.received_how || "in_person"} onValueChange={(v) => setInput((c) => ({ ...c, received_how: v }))}>
                        <SelectTrigger id="hr-awol-how" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>{Object.entries(RECEIVED_HOW).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                      </Select>
                    ))}
                    <div className="sm:col-span-2">{fieldFor("text", "Summary", <Textarea id="hr-awol-text" rows={4} maxLength={AWOL_RECORD_MAX} value={input.text} onChange={(e) => setInput((c) => ({ ...c, text: e.target.value }))} />)}</div>
                    <div className="sm:col-span-2">{fieldFor("file", "Attachment (optional, PDF / JPG / PNG, 5 MB)", <Input id="hr-awol-file" type="file" accept="application/pdf,image/jpeg,image/png" onChange={async (e) => { const files = await readFiles(e.target.files); setInput((c) => ({ ...c, files })); }} />)}</div>
                  </>
                ) : null}
                {dialog.action === "close" ? (
                  <div className="sm:col-span-2">
                    <RemarkField id="hr-awol-remark" decision="resolve" entityType="awol_case" required label="Why it is closed"
                      value={input.remark} onChange={(v) => setInput((c) => ({ ...c, remark: v }))} />
                  </div>
                ) : null}
                {["open", "confirm"].includes(dialog.action) ? (
                  <div className="sm:col-span-2">{fieldFor("note", dialog.action === "close" ? "Why it is closed" : "Note", <Input id="hr-awol-note" maxLength={1000} placeholder={dialog.action === "confirm" ? "e.g. Called Nov 12 and the emergency contact; no answer" : ""} value={input.note} onChange={(e) => setInput((c) => ({ ...c, note: e.target.value }))} />)}</div>
                ) : null}
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
                <Button onClick={submit} disabled={busy} variant={dialog.action === "separate" ? "destructive" : "default"}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save</Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
