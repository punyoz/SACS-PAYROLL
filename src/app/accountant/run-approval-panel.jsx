"use client";

import * as React from "react";
import { AlertTriangleIcon, Loader2Icon, SendIcon, XCircleIcon } from "lucide-react";
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
import { RUN_STATUS_LABELS, RUN_STATUS_TONES } from "@/lib/payroll/runs";
import { cn } from "@/lib/utils";
import { useAccountant } from "./accountant-data";

/*
 * Payroll Approval, the Accountant's part (/api/accountant/payroll-runs):
 * each branch's run for the chosen period, its status and HR's reason when
 * rejected, and "Submit for HR Approval". A Pending or Approved run cannot be
 * changed or reprocessed; a Rejected one can be corrected (Reprocess on the
 * payslip) and resubmitted.
 */

export function RunApprovalPanel() {
  const { period, load: reloadPayroll } = useAccountant();
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, error: null, runs: [] });
  const [busy, setBusy] = React.useState("");
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  // Per branch: the confirmation that the employees listed are left out on
  // purpose, and a note for each (sent to HR with the run).
  const [ack, setAck] = React.useState({});
  const [notes, setNotes] = React.useState({});
  const [listKey, setListKey] = React.useState(0);

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
  React.useEffect(() => { load(); }, [load]);

  async function submit(run) {
    const resubmit = run.status === "rejected";
    const leftOut = run.missing.length;
    // Never silently: anyone left out must be confirmed on the card first.
    if (leftOut && !ack[run.branch_id]) {
      setFeedback({ text: "Confirm that the employees listed are intentionally left out of this run first.", ok: false });
      return;
    }
    const ok = await confirm({
      title: `${resubmit ? "Resubmit" : "Submit"} ${run.branch_name}'s ${run.supplemental ? `supplemental run ${run.run_no}` : "payroll"} for HR approval?`,
      description: `${run.period_label} · ${run.final_count} employee${run.final_count === 1 ? "" : "s"} · net ${money(run.totals_preview.net)}${leftOut ? ` · ${leftOut} left out (HR sees who and why)` : ""}. Once submitted, the run is locked: no payslip of it can be changed or reprocessed unless HR rejects it.`,
      confirmLabel: resubmit ? "Resubmit" : "Submit for HR Approval",
    });
    if (!ok) return;
    setBusy(run.branch_id);
    setFeedback({ text: "", ok: false });
    try {
      const exclusionNotes = Object.fromEntries(run.missing.map((m) => [m.id, String(notes[`${run.branch_id}|${m.id}`] || "").trim()]).filter(([, note]) => note));
      const response = await apiFetch("/api/accountant/payroll-runs", jsonBody("PATCH", {
        action: "submit", branch_id: run.branch_id, period: run.period_label,
        acknowledge_exclusions: leftOut > 0 && Boolean(ack[run.branch_id]), exclusion_notes: exclusionNotes,
      }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The payroll could not be submitted.");
      notify("Submitted for HR Approval", `${run.branch_name}, ${run.period_label}${leftOut ? `: ${leftOut} left out` : ""}: HR has been notified.`, "success");
      setFeedback({ text: `${run.branch_name} submitted. Status: Pending HR Approval.`, ok: true });
      setAck((c) => ({ ...c, [run.branch_id]: false }));
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
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>HR approval — {period}</CardTitle>
        <CardDescription>Process the branch&apos;s employees, then submit the run. Anyone left out is listed for you to confirm, and HR sees who and why. HR approves (payslips become visible to employees) or sends it back with a reason.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.loading && !state.runs.length ? <Skeleton className="h-16 w-full" /> : null}
        {state.runs.map((run) => {
          const locked = run.status === "pending" || run.status === "approved";
          const leftOut = !locked && run.final_count > 0 ? run.missing : [];
          const needsAck = leftOut.length > 0 && !ack[run.branch_id];
          return (
            <div key={run.branch_id} className={cn("space-y-2 rounded-lg border p-3", run.status === "rejected" && "border-destructive/40", run.status === "pending" && "border-warning/40")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{run.branch_name}</span>
                <StatusBadge tone={RUN_STATUS_TONES[run.status]}>{RUN_STATUS_LABELS[run.status]}</StatusBadge>
                {run.supplemental || run.run_no > 1 ? <StatusBadge tone="info">Supplemental run {run.run_no}</StatusBadge> : null}
                <span className="text-xs text-muted-foreground">
                  {run.final_count} {run.supplemental ? "processed since the approved run" : `of ${run.expected_count} processed`}{run.draft_count ? ` · ${run.draft_count} draft${run.draft_count === 1 ? "" : "s"}` : ""} · net {money(run.totals_preview.net)}
                </span>
                <div className="ml-auto">
                  {!locked ? (
                    <Button size="sm" onClick={() => submit(run)} disabled={!run.can_submit || needsAck || busy === run.branch_id}
                      title={!run.can_submit ? "Generate the Final payslips (no Drafts left) first." : needsAck ? "Confirm the employees left out first." : ""}>
                      {busy === run.branch_id ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <SendIcon aria-hidden="true" />}
                      {run.status === "rejected" ? "Resubmit for HR Approval" : run.supplemental ? `Submit supplemental run ${run.run_no}` : "Submit for HR Approval"}
                    </Button>
                  ) : null}
                </div>
              </div>
              {run.supplemental && run.approved_run ? (
                <p className="text-sm text-muted-foreground">Run {run.approved_run.run_no} of this period was approved by {run.approved_run.reviewed_by_name} on {dateTime(run.approved_run.reviewed_at)}. The employees processed since then go to HR as supplemental run {run.run_no}.</p>
              ) : null}
              {leftOut.length ? (
                <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3" data-testid="exclusion-ack">
                  <p className="flex items-start gap-1.5 text-sm font-medium"><AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />{leftOut.length} employee{leftOut.length === 1 ? " is" : "s are"} not in this run (no Final payslip):</p>
                  <ul className="space-y-2">
                    {leftOut.map((m) => (
                      <li key={m.id} className="grid gap-1 sm:grid-cols-[minmax(10rem,14rem)_1fr] sm:items-center">
                        <Label htmlFor={`ex-note-${run.branch_id}-${m.id}`} className="font-normal">
                          <span className="font-medium">{m.name}</span>{m.code ? <span className="text-muted-foreground"> ({m.code})</span> : null}
                        </Label>
                        <Input id={`ex-note-${run.branch_id}-${m.id}`} maxLength={500} placeholder="Why (optional): e.g. new hire, pending documents"
                          value={notes[`${run.branch_id}|${m.id}`] || ""} onChange={(e) => setNotes((c) => ({ ...c, [`${run.branch_id}|${m.id}`]: e.target.value }))} />
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-start gap-2 pt-1">
                    <Checkbox id={`ex-ack-${run.branch_id}`} checked={Boolean(ack[run.branch_id])} onCheckedChange={(v) => setAck((c) => ({ ...c, [run.branch_id]: v === true }))} />
                    <Label htmlFor={`ex-ack-${run.branch_id}`} className="text-sm leading-snug font-normal">I confirm these employees are intentionally excluded from this payroll run. They are paid later in a supplemental run of this period.</Label>
                  </div>
                </div>
              ) : null}
              {locked ? <ExclusionsAlert exclusions={run.exclusions} /> : null}
              {run.status === "rejected" && run.run?.remarks ? (
                <Alert className="border-destructive/40 bg-destructive/5">
                  <XCircleIcon className="text-destructive" aria-hidden="true" />
                  <AlertDescription><strong className="text-foreground">Rejected by {run.run.reviewed_by_name} ({dateTime(run.run.reviewed_at)}):</strong> {run.run.remarks} Correct the payslips (Reprocess) and resubmit.</AlertDescription>
                </Alert>
              ) : null}
              {run.status === "pending" ? <p className="text-sm text-muted-foreground">Submitted by {run.run?.submitted_by_name} on {dateTime(run.run?.submitted_at)}. Locked until HR decides.</p> : null}
              {run.status === "approved" ? <p className="text-sm text-success">Approved by {run.run?.reviewed_by_name} on {dateTime(run.run?.reviewed_at)}{run.run?.remarks ? ` — ${run.run.remarks}` : ""}. Locked; employees can see their payslips.</p> : null}
              {!locked && run.missing.length && !run.final_count ? (
                <p className="flex items-start gap-1.5 text-xs text-warning"><AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />No Final payslip yet: {run.missing.map((m) => m.name).join(", ")}.</p>
              ) : null}
            </div>
          );
        })}
        {feedback.text ? <p role="status" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
      </CardContent>
      {confirmDialog}
    </Card>
    {/* Employees left out of a submitted run and not paid for that period yet. */}
    <OpenExclusionsCard endpoint="/api/accountant/payroll-runs?view=excluded" refreshKey={listKey} />
    </>
  );
}
