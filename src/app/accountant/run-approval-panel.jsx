"use client";

import * as React from "react";
import { AlertTriangleIcon, ChevronRightIcon, Loader2Icon, RefreshCwIcon, SendIcon, XCircleIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { ExclusionsAlert, OpenExclusionsCard } from "@/components/portal/run-exclusions";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch, fetchJson, jsonBody } from "@/lib/portal/api";
import { dateTime, money } from "@/lib/portal/payroll-preview";
import { isPlainClick, portalHref } from "@/lib/portal/navigate";
import { RUN_STATUS_LABELS, RUN_STATUS_TONES } from "@/lib/payroll/runs";
import { LEFT_OUT_LABELS } from "@/lib/payroll/run-roster";
import { cn } from "@/lib/utils";
import { useAccountant } from "./accountant-data";

/*
 * Payroll Approval, the Accountant's part (/api/accountant/payroll-runs):
 * one card per run of the chosen period, per branch (2026-11-15):
 *
 *   - the open card (not submitted yet, Rejected by HR, or a supplemental
 *     run): Included in this run / Drafts, not finalized / Left out, and the
 *     Final payslips outside the branch's active list (in only if ticked);
 *   - every submitted run (Pending HR Approval, Paid), read only, with the
 *     payslips HR received.
 *
 * The server says why a run cannot be submitted (card.blockers); this page
 * adds the confirmation and lists every reason under the button.
 */

const sum = (rows, key) => Math.round(rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0) * 100) / 100;

/** The client-side reasons, after the server's. */
function submitReasons(card, { ticked, ack }) {
  const reasons = [...(card.blockers || [])];
  const inRun = card.included.length + card.outside.filter((r) => ticked.has(r.entry_id)).length;
  if (!card.blockers?.some((b) => b.startsWith("No Final payslip")) && inRun === 0) reasons.push("Nothing to submit: no payslip is included (tick one under \"Not in this branch's active list\", or process an employee).");
  if (leftOutOf(card, ticked).length && !ack) reasons.push("Confirm the employees left out first (checkbox under \"Left out\").");
  return reasons;
}

/** Everyone not going to HR with this run: left out, plus unticked payslips outside the list. */
function leftOutOf(card, ticked) {
  return [
    ...card.missing,
    ...card.outside.filter((r) => !ticked.has(r.entry_id)).map((r) => ({ id: r.employee_id, name: r.employee_name, code: r.employee_code, left_out_as: "outside_list" })),
  ];
}

function Group({ title, count, open = false, testId, children, tone }) {
  return (
    <details open={open} className="group rounded-md border" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-sm font-medium select-none hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
        <span className={cn(tone === "warning" && "text-warning")}>{title}</span>
        <span className="text-muted-foreground tabular-nums" data-testid={testId ? `${testId}-count` : undefined}>({count})</span>
      </summary>
      <div className="border-t px-3 py-2">{children}</div>
    </details>
  );
}

/** A Draft row has no action here (its "Review and finalize" link was removed 2026-11-16): it is finalized from Process Payroll. */
function PayslipRows({ rows, onView, onRecompute, recomputing, extra, footer }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">None.</p>;
  return (
    // relative: the sr-only header labels stay inside the scroll box (as the house Table does), so a phone page never widens.
    <div className="relative w-full overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="text-left">
            {extra ? <th className="w-8 py-1 font-normal"><span className="sr-only">Include</span></th> : null}
            <th className="py-1 font-normal">Employee</th>
            <th className="py-1 font-normal">Type</th>
            <th className="py-1 font-normal">Period</th>
            <th className="py-1 text-right font-normal">Gross</th>
            <th className="py-1 text-right font-normal">Deductions</th>
            <th className="py-1 text-right font-normal">Net pay</th>
            <th className="py-1 font-normal"><span className="sr-only">Payslip</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.entry_id} className="border-t align-top" data-testid="run-row" data-employee={r.employee_name}>
              {extra ? <td className="py-1.5">{extra(r)}</td> : null}
              <td className="py-1.5">
                <span className="font-medium">{r.employee_name}</span>
                <span className="block text-xs text-muted-foreground">{[r.employee_code, r.payslip_no].filter(Boolean).join(" · ")}</span>
                {r.needs_recompute ? (
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-warning" data-testid="needs-recompute">
                    <AlertTriangleIcon className="size-3.5" aria-hidden="true" />Needs recompute: {r.needs_recompute}
                    {onRecompute ? (
                      <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => onRecompute(r)} disabled={recomputing === r.entry_id} data-testid="recompute">
                        {recomputing === r.entry_id ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <RefreshCwIcon aria-hidden="true" />}Recompute
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </td>
              <td className="py-1.5">{r.employee_type || "—"}</td>
              <td className="py-1.5 whitespace-nowrap">{r.period_label}</td>
              <td className="py-1.5 text-right tabular-nums">{money(r.gross_pay)}</td>
              <td className="py-1.5 text-right tabular-nums">{money(r.total_deductions)}</td>
              <td className="py-1.5 text-right font-medium tabular-nums">{money(r.net_pay)}</td>
              <td className="py-1.5 text-right">
                {r.status === "draft" ? null : <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onView(r)}>View payslip</Button>}
              </td>
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

export function RunApprovalPanel() {
  const { data: payrollData, period, load: reloadPayroll, openPayslip, editDraft } = useAccountant();
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, error: null, runs: [] });
  const [busy, setBusy] = React.useState("");
  const [recomputing, setRecomputing] = React.useState("");
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  // Per card: the confirmation that the employees listed are left out on
  // purpose, a note for each (sent to HR), and the outside-list payslips ticked in.
  const [ack, setAck] = React.useState({});
  const [notes, setNotes] = React.useState({});
  const [tickedBy, setTickedBy] = React.useState({});
  const [listKey, setListKey] = React.useState(0);
  const panelRef = React.useRef(null);

  const load = React.useCallback(async () => {
    if (!period) return;
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/accountant/payroll-runs?period=${encodeURIComponent(period)}`);
      setState({ loading: false, error: null, runs: data.runs || [] });
    } catch (error) {
      setState((c) => ({ loading: false, error: error.message, runs: c.runs || [] }));
    }
  }, [period]);
  // Reloaded with the payroll data too, so a Draft finalized in the form leaves "Drafts, not finalized".
  React.useEffect(() => { load(); }, [load, payrollData?.generated_at]);

  // A link with ?focus=runs | left-out lands on this panel.
  React.useEffect(() => {
    if (typeof window === "undefined" || state.loading) return;
    const focus = new URLSearchParams(window.location.search).get("focus");
    const target = focus === "left-out" ? document.querySelector("[data-testid='open-exclusions']") : focus === "runs" ? panelRef.current : null;
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [state.loading]);

  const tickedOf = (card) => tickedBy[card.key] || new Set();
  const toggleTick = (card, entryId, on) => setTickedBy((c) => {
    const next = new Set(c[card.key] || []);
    if (on) next.add(entryId); else next.delete(entryId);
    return { ...c, [card.key]: next };
  });

  async function recompute(row) {
    setRecomputing(row.entry_id);
    setFeedback({ text: `Recomputing ${row.employee_name}…`, ok: true });
    try {
      const response = await apiFetch("/api/accountant/payroll", jsonBody("PATCH", {
        action: "generate", reprocess: true, recompute: true, employee_id: row.employee_id, pay_period: row.period_label, confirm_incomplete: true,
      }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The payslip could not be recomputed.");
      setFeedback({ text: `${row.employee_name}'s ${row.period_label} payslip was recomputed with the current 1st half.`, ok: true });
      await Promise.all([load(), reloadPayroll({ period })]);
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    } finally {
      setRecomputing("");
    }
  }

  async function submit(card) {
    const resubmit = card.status === "rejected";
    const ticked = tickedOf(card);
    const leftOut = leftOutOf(card, ticked);
    const reasons = submitReasons(card, { ticked, ack: ack[card.key] });
    // Never silently: every reason is on the card; this is the same list.
    if (reasons.length) {
      setFeedback({ text: reasons.join(" "), ok: false });
      return;
    }
    const included = [...card.included, ...card.outside.filter((r) => ticked.has(r.entry_id))];
    const ok = await confirm({
      title: `${resubmit ? "Resubmit" : "Submit"} ${card.branch_name}'s ${card.supplemental ? `supplemental run ${card.run_no}` : "payroll"} for HR approval?`,
      description: `${card.period_label} · ${included.length} employee${included.length === 1 ? "" : "s"} · net ${money(sum(included, "net_pay"))}${leftOut.length ? ` · ${leftOut.length} left out (HR sees who and why)` : ""}. Once submitted, the run is locked: no payslip of it can be changed or reprocessed unless HR rejects it.`,
      confirmLabel: resubmit ? "Resubmit" : "Submit for HR Approval",
    });
    if (!ok) return;
    setBusy(card.key);
    setFeedback({ text: "", ok: false });
    try {
      const exclusionNotes = Object.fromEntries(leftOut.map((m) => [m.id, String(notes[`${card.key}|${m.id}`] || "").trim()]).filter(([, note]) => note));
      const response = await apiFetch("/api/accountant/payroll-runs", jsonBody("PATCH", {
        action: "submit", branch_id: card.branch_id, period: card.period_label,
        acknowledge_exclusions: leftOut.length > 0 && Boolean(ack[card.key]), exclusion_notes: exclusionNotes,
        include_outside: [...ticked],
      }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The payroll could not be submitted.");
      notify("Submitted for HR Approval", `${card.branch_name}, ${card.period_label}${leftOut.length ? `: ${leftOut.length} left out` : ""}: HR has been notified.`, "success");
      setFeedback({ text: `${card.branch_name} submitted. Status: Pending HR Approval.`, ok: true });
      setAck((c) => ({ ...c, [card.key]: false }));
      setListKey((k) => k + 1);
      await Promise.all([load(), reloadPayroll({ period })]);
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    } finally {
      setBusy("");
    }
  }

  if (!period) return null;
  if (state.error && !state.runs?.length) return <Alert className="border-warning/40 bg-warning/5"><AlertDescription>Payroll Approval: {state.error}</AlertDescription></Alert>;
  if (state.runs.length && state.runs.every((r) => r.available === false)) {
    return <Alert className="border-warning/40 bg-warning/5"><AlertDescription>Payroll Approval is not set up yet: apply supabase/migrations/20261014010000_payroll_run_approval.sql.</AlertDescription></Alert>;
  }

  return (
    <>
    <Card className="min-w-0 shadow-xs" ref={panelRef} data-testid="run-panel">
      <CardHeader>
        <CardTitle>HR approval — {period}</CardTitle>
        <CardDescription>Check who is going to HR, then submit the run. Drafts and anyone not processed are left out (you confirm who, HR sees who and why) and are paid later in a supplemental run. HR approves (payslips become visible to employees) or sends it back with a reason.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.loading && !state.runs.length ? <Skeleton className="h-16 w-full" /> : null}
        {state.runs.map((card) => {
          const ticked = tickedOf(card);
          const included = [...card.included, ...card.outside.filter((r) => ticked.has(r.entry_id))];
          const net = sum(included, "net_pay");
          const leftOut = card.locked ? [] : leftOutOf(card, ticked);
          const reasons = card.locked ? [] : submitReasons(card, { ticked, ack: ack[card.key] });
          return (
            <div key={card.key} data-testid="run-card" data-status={card.status} data-branch={card.branch_name}
              className={cn("space-y-2 rounded-lg border p-3", card.status === "rejected" && "border-destructive/40", card.status === "pending" && "border-warning/40")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{card.branch_name}</span>
                <StatusBadge tone={RUN_STATUS_TONES[card.status]}>{RUN_STATUS_LABELS[card.status]}</StatusBadge>
                {card.supplemental || card.run_no > 1 ? <StatusBadge tone="info">Supplemental run {card.run_no}</StatusBadge> : null}
                <span className="text-xs text-muted-foreground" data-testid="run-card-counts">
                  {card.locked
                    ? `${card.final_count} payslip${card.final_count === 1 ? "" : "s"} sent to HR`
                    : card.supplemental
                      ? `${card.final_count} processed since the approved run`
                      : `${card.processed_count} of ${card.expected_count} processed`}
                  {!card.locked && card.draft_count ? ` · ${card.draft_count} draft${card.draft_count === 1 ? "" : "s"}` : ""}
                  {!card.locked && card.outside.length ? ` · ${card.outside.length} not in active list` : ""}
                  {" · net "}<span data-testid="run-card-net">{money(net)}</span>
                </span>
                <div className="ml-auto">
                  {!card.locked ? (
                    <Button size="sm" onClick={() => submit(card)} disabled={reasons.length > 0 || busy === card.key}
                      title={reasons.join(" ")} aria-describedby={reasons.length ? `why-${card.key}` : undefined} data-testid="submit-run">
                      {busy === card.key ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <SendIcon aria-hidden="true" />}
                      {card.status === "rejected" ? "Resubmit for HR Approval" : card.supplemental ? `Submit supplemental run ${card.run_no}` : "Submit for HR Approval"}
                    </Button>
                  ) : null}
                </div>
              </div>
              {/* Element ids use the branch: a branch has one open card (ids kept from before 2026-11-15). */}
              {reasons.length ? (
                <ul id={`why-${card.key}`} className="space-y-0.5 text-xs text-warning" data-testid="submit-reasons">
                  {reasons.map((r) => <li key={r} className="flex items-start gap-1.5"><AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 [overflow-wrap:anywhere]">{r}</span></li>)}
                </ul>
              ) : null}
              {card.supplemental && card.approved_run ? (
                <p className="text-sm text-muted-foreground">Run {card.approved_run.run_no} of this period was approved by {card.approved_run.reviewed_by_name} on {dateTime(card.approved_run.reviewed_at)}. The employees processed since then go to HR as supplemental run {card.run_no}.</p>
              ) : null}
              {card.status === "rejected" && card.run?.remarks ? (
                <Alert className="border-destructive/40 bg-destructive/5">
                  <XCircleIcon className="text-destructive" aria-hidden="true" />
                  <AlertDescription><strong className="text-foreground">Rejected by {card.run.reviewed_by_name} ({dateTime(card.run.reviewed_at)}):</strong> {card.run.remarks} Correct the payslips (Reprocess) and resubmit.</AlertDescription>
                </Alert>
              ) : null}
              {card.status === "pending" ? <p className="text-sm text-muted-foreground">Submitted by {card.run?.submitted_by_name} on {dateTime(card.run?.submitted_at)}. Locked until HR decides.</p> : null}
              {card.status === "approved" ? <p className="text-sm text-success">Approved by {card.run?.reviewed_by_name} on {dateTime(card.run?.reviewed_at)}{card.run?.remarks ? ` — ${card.run.remarks}` : ""}. Locked; employees can see their payslips.</p> : null}
              {card.locked && card.recompute_count ? (
                <Alert className="border-warning/40 bg-warning/10" data-testid="run-first-half-changed">
                  <AlertTriangleIcon className="text-warning" aria-hidden="true" />
                  <AlertDescription>
                    {card.status === "pending"
                      ? `1st half changed after ${card.recompute_count === 1 ? "this 2nd half was" : `${card.recompute_count} of these 2nd halves were`} computed. HR has been warned and should reject the run so you can recompute; nothing is changed until then.`
                      : `1st half changed after ${card.recompute_count === 1 ? "this Paid 2nd half was" : `${card.recompute_count} of these Paid 2nd halves were`} computed. The Paid payslip is not changed: file a correction on the next payslip (Action needed → Correct).`}
                  </AlertDescription>
                </Alert>
              ) : null}

              <Group title={card.locked ? `Sent to HR (${RUN_STATUS_LABELS[card.status]})` : "Included in this run"} count={included.length} open testId="group-included">
                <PayslipRows rows={included} onView={(r) => openPayslip(r.entry_id)} onRecompute={card.locked ? null : recompute} recomputing={recomputing}
                  footer={included.length ? (
                    <tr className="border-t font-medium" data-testid="included-total">
                      <td className="py-1.5" colSpan={3}>Total</td>
                      <td className="py-1.5 text-right tabular-nums">{money(sum(included, "gross_pay"))}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(sum(included, "total_deductions"))}</td>
                      <td className="py-1.5 text-right tabular-nums" data-testid="included-total-net">{money(net)}</td>
                      <td />
                    </tr>
                  ) : null} />
              </Group>

              {!card.locked && card.outside.length ? (
                <Group title="Not in this branch's active list" count={card.outside.length} open testId="group-outside">
                  <p className="pb-1 text-xs text-muted-foreground">Final payslips of people who are not on the branch&apos;s active list for this period (archived, on hold, moved, or hired later). They go to HR only if you tick them; otherwise they are listed as left out.</p>
                  <PayslipRows rows={card.outside} onView={(r) => openPayslip(r.entry_id)} onRecompute={recompute} recomputing={recomputing}
                    extra={(r) => <Checkbox aria-label={`Include ${r.employee_name} in this run`} checked={ticked.has(r.entry_id)} onCheckedChange={(v) => toggleTick(card, r.entry_id, v === true)} data-testid="include-outside" />} />
                </Group>
              ) : null}

              {!card.locked ? (
                <Group title="Drafts, not finalized" count={card.drafts.length} testId="group-drafts" tone={card.drafts.length ? "warning" : undefined}>
                  <p className="pb-1 text-xs text-muted-foreground">A Draft is never sent to HR: these employees are left out unless you finalize them first.</p>
                  <PayslipRows rows={card.drafts} onView={(r) => editDraft(r.entry_id)} />
                </Group>
              ) : null}

              {!card.locked ? (
                <Group title="Left out" count={leftOut.length} open={leftOut.length > 0} testId="group-left-out" tone={leftOut.length ? "warning" : undefined}>
                  {leftOut.length ? (
                    <div className="space-y-2" data-testid="exclusion-ack">
                      <ul className="space-y-2">
                        {leftOut.map((m) => (
                          <li key={m.id} className="grid gap-1 sm:grid-cols-[minmax(10rem,16rem)_1fr] sm:items-center" data-testid="left-out-row">
                            <Label htmlFor={`ex-note-${card.branch_id}-${m.id}`} className="block font-normal">
                              <span className="font-medium">{m.name}</span>{m.code ? <span className="text-muted-foreground"> ({m.code})</span> : null}
                              <span className="block text-xs text-muted-foreground">{LEFT_OUT_LABELS[m.left_out_as] || ""}</span>
                            </Label>
                            <Input id={`ex-note-${card.branch_id}-${m.id}`} maxLength={500} placeholder="Why (optional): e.g. new hire, pending documents"
                              value={notes[`${card.key}|${m.id}`] || ""} onChange={(e) => setNotes((c) => ({ ...c, [`${card.key}|${m.id}`]: e.target.value }))} />
                          </li>
                        ))}
                      </ul>
                      <div className="flex items-start gap-2 pt-1">
                        <Checkbox id={`ex-ack-${card.branch_id}`} checked={Boolean(ack[card.key])} onCheckedChange={(v) => setAck((c) => ({ ...c, [card.key]: v === true }))} />
                        <Label htmlFor={`ex-ack-${card.branch_id}`} className="text-sm leading-snug font-normal">I confirm these employees are intentionally excluded from this payroll run. They are paid later in a supplemental run of this period.</Label>
                      </div>
                    </div>
                  ) : <p className="text-sm text-muted-foreground">Nobody: every active employee has a Final payslip in this run.</p>}
                </Group>
              ) : null}

              {card.locked ? <ExclusionsAlert exclusions={card.exclusions} /> : null}
            </div>
          );
        })}
        {feedback.text ? <p role="status" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
      </CardContent>
      {confirmDialog}
    </Card>
    {/* Employees left out of a submitted run and not paid for that period yet. */}
    <div data-testid="open-exclusions"><OpenExclusionsCard endpoint="/api/accountant/payroll-runs?view=excluded" refreshKey={listKey} /></div>
    </>
  );
}
