"use client";

import * as React from "react";
import {
  AlertTriangleIcon, ArrowLeftIcon, CheckCircle2Icon, ChevronDownIcon, ChevronRightIcon, ClipboardCheckIcon,
  FileSpreadsheetIcon, FileTextIcon, HistoryIcon, Loader2Icon, PrinterIcon, RefreshCwIcon, SunriseIcon, UsersIcon,
  WalletIcon, XCircleIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { useUrlParam } from "@/components/portal/use-url-param";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { useLivePayrollRuns } from "@/components/portal/use-live-payroll-runs";
import { apiFetch, fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel, dateTime, money, shortDate } from "@/lib/portal/payroll-preview";
import { FLAG_LABELS, RUN_STATUS_LABELS, RUN_STATUS_TONES, runNoLabel } from "@/lib/payroll/runs";
import { CorrectionsCard } from "@/components/portal/payroll-corrections";
import { ExclusionsAlert, OpenExclusionsCard } from "@/components/portal/run-exclusions";
import { cn } from "@/lib/utils";
import { SEARCH_MAX } from "@/lib/input-limits";

/*
 * HR → Payroll Approval (/api/hr/payroll-runs). One row per branch per pay
 * period the Accountant submitted. HR opens a run, reviews every employee's
 * computation (the snapshot taken at submission, so the figures cannot
 * change under review), and approves or rejects it with a reason. Several
 * Pending branches can be approved in one decision (still one record per
 * branch). HR never edits a figure: the screen has no field for it, and the
 * server refuses it. Super Admin sees the same screen read-only.
 */

const TABS = [
  // The payroll status labels (RUN_STATUS_LABELS).
  { id: "pending", label: "Pending HR Approval" },
  { id: "approved", label: "Paid" },
  { id: "rejected", label: "Rejected by HR" },
  { id: "all", label: "All runs" },
  // Every approve / reject decision, kept for good (a rejected run that is
  // resubmitted keeps its rejection here).
  { id: "history", label: "History" },
];
const ANY = "__any__";

function RunStatusBadge({ status }) {
  return <StatusBadge tone={RUN_STATUS_TONES[status] || "muted"}>{RUN_STATUS_LABELS[status] || status}</StatusBadge>;
}

const cutoffLabel = (run) => (run.cutoff_type === "first" ? "1st cutoff (1–15)" : "2nd cutoff (16–end)");

/* ── Approve / reject dialogs ───────────────────────────────────────────── */

function DecisionDialog({ decision, onClose, onDone }) {
  const { notify } = usePortalSession();
  const [remarks, setRemarks] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setRemarks(""); setError(""); }, [decision]);
  if (!decision) return null;
  const { kind, runs } = decision;
  const grand = runs.reduce((acc, r) => ({
    employees: acc.employees + r.total_employees, gross: acc.gross + r.total_gross,
    deductions: acc.deductions + r.total_deductions, net: acc.net + r.total_net,
  }), { employees: 0, gross: 0, deductions: 0, net: 0 });

  async function submit() {
    if (kind === "reject" && remarks.trim().length < 5) {
      setError("Write the reason for rejecting (at least 5 characters). The Accountant sees it.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = kind === "approve"
        ? { action: "approve", run_ids: runs.map((r) => r.id), remarks: remarks.trim() }
        : { action: "reject", run_id: runs[0].id, remarks: remarks.trim() };
      const response = await apiFetch("/api/hr/payroll-runs", jsonBody("PATCH", body));
      const data = await response.json().catch(() => ({}));
      if (kind === "approve") {
        const failed = (data.results || []).filter((r) => !r.ok);
        const approved = data.approved || 0;
        if (!approved) throw new Error(failed[0]?.error || data.error || "Nothing was approved.");
        notify("Payroll Approved", `${approved} payroll run${approved === 1 ? "" : "s"} approved. Payslips are now visible to employees.`, "success");
        if (failed.length) {
          const names = failed.map((f) => `${runs.find((r) => r.id === f.run_id)?.branch_name || "A run"}: ${f.error}`).join(" · ");
          notify("Some runs were not approved", names, "info");
        }
      } else {
        if (!response.ok) throw new Error(data.error || "The run could not be rejected.");
        notify("Payroll Rejected", `${runs[0].branch_name}, ${runs[0].period_label} went back to the Accountant.`, "success");
      }
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{kind === "approve" ? `Approve ${runs.length === 1 ? "this payroll" : `${runs.length} payroll runs`}?` : "Reject this payroll?"}</DialogTitle>
          <DialogDescription>
            {kind === "approve"
              ? "Approved payroll is locked for good: payslips become visible to employees and the period's Early Bird winner is final."
              : "The run goes back to the Accountant with your reason. Nothing they did is cleared; they correct it and resubmit."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>Branch</TableHead><TableHead>Period</TableHead><TableHead className="text-right">Employees</TableHead><TableHead className="text-right">Net pay</TableHead></TableRow></TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.branch_name}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.period_label}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.total_employees}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.total_net)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {runs.length > 1 ? (
                <TableFooter><TableRow><TableCell colSpan={2}>Total</TableCell><TableCell className="text-right tabular-nums">{grand.employees}</TableCell><TableCell className="text-right tabular-nums">{money(grand.net)}</TableCell></TableRow></TableFooter>
              ) : null}
            </Table>
          </div>
          {runs.some((r) => r.excluded_employees > 0) ? (
            <Alert className="border-warning/40 bg-warning/5">
              <AlertTriangleIcon className="text-warning" aria-hidden="true" />
              <AlertDescription>
                Employees were left out: {runs.filter((r) => r.excluded_employees > 0).map((r) => `${r.branch_name} ${r.excluded_employees}`).join(", ")}.
                {runs.length > 1 ? " Open a run to see who and why." : " They are listed on the run, with the Accountant's notes."}
              </AlertDescription>
            </Alert>
          ) : null}
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div className="rounded-lg border bg-muted/40 px-3 py-2"><dt className="text-xs text-muted-foreground">Gross</dt><dd className="font-semibold tabular-nums">{money(grand.gross)}</dd></div>
            <div className="rounded-lg border bg-muted/40 px-3 py-2"><dt className="text-xs text-muted-foreground">Deductions</dt><dd className="font-semibold tabular-nums">{money(grand.deductions)}</dd></div>
            <div className="rounded-lg border bg-muted/40 px-3 py-2"><dt className="text-xs text-muted-foreground">Net pay</dt><dd className="font-semibold tabular-nums">{money(grand.net)}</dd></div>
          </dl>
          <div className="space-y-1.5">
            <Label htmlFor="pa-remarks">{kind === "reject" ? "Reason for rejecting" : "Note (optional)"}</Label>
            <Textarea id="pa-remarks" rows={3} maxLength={1000} value={remarks} onChange={(e) => { setRemarks(e.target.value); setError(""); }}
              placeholder={kind === "reject" ? "Required: what the Accountant must correct" : "Kept with the approval"} aria-invalid={Boolean(error) || undefined} autoFocus />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={kind === "reject" ? "destructive" : "default"} onClick={submit} disabled={busy}>
            {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
            {kind === "approve" ? (runs.length > 1 ? `Approve ${runs.length} runs` : "Approve") : "Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Run detail ─────────────────────────────────────────────────────────── */

function lineHow(line) {
  if (line.quantity === null || line.quantity === undefined) return line.note || "";
  const unit = line.unit ? `${line.unit}${Number(line.quantity) === 1 ? "" : "s"}` : "";
  const rate = line.rate === null || line.rate === undefined ? "" : ` × ${money(line.rate)}${line.unit === "minute" ? " per hour ÷ 60" : ""}`;
  const day = line.log_date ? ` · ${shortDate(line.log_date)}` : "";
  return `${line.quantity} ${unit}${rate}${day}${line.note ? ` · ${line.note}` : ""}`.trim();
}

function Breakdown({ item, firstCutoff }) {
  const b = item.breakdown || {};
  const lines = b.lines || {};
  const earnings = b.cutoff?.earnings || [
    { label: "Basic pay", amount: item.basic_pay },
    ...(lines.incentives || []).map((l) => ({ label: l.type.replaceAll("_", " "), amount: Number(l.amount) || 0, note: lineHow(l) })),
  ];
  const deductions = b.cutoff?.deductions || (lines.deductions || []).map((l) => ({ label: l.type.replaceAll("_", " "), amount: Number(l.amount) || 0 }));
  const attendanceLines = (lines.deductions || []).filter((l) => ["absent", "late", "undertime", "half_day", "leave_without_pay", "unpaid_holiday"].includes(l.type));
  return (
    <div className="grid gap-4 p-3 md:grid-cols-2">
      <div className="space-y-2">
        <p className="text-xs font-semibold tracking-wide text-gold-text uppercase">Earnings</p>
        <ul className="space-y-1 text-sm">
          {earnings.map((line, i) => (
            <li key={`${line.label}-${i}`} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">{line.label}{line.note ? <span className="block text-xs text-muted-foreground">{line.note}</span> : null}</span>
              <span className="shrink-0 tabular-nums text-success">+ {money(line.amount)}</span>
            </li>
          ))}
          <li className="flex justify-between border-t pt-1 font-semibold"><span>Gross pay</span><span className="tabular-nums">{money(item.gross_pay)}</span></li>
        </ul>
        <p className="pt-2 text-xs font-semibold tracking-wide text-gold-text uppercase">Attendance</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <div><dt className="text-muted-foreground">Days worked</dt><dd className="tabular-nums">{item.days_worked}</dd></div>
          <div><dt className="text-muted-foreground">Absences</dt><dd className="tabular-nums">{item.absent_days} day{item.absent_days === 1 ? "" : "s"}</dd></div>
          <div><dt className="text-muted-foreground">Late</dt><dd className="tabular-nums">{item.late_days} day{item.late_days === 1 ? "" : "s"} · {item.late_minutes} min</dd></div>
          <div><dt className="text-muted-foreground">Undertime</dt><dd className="tabular-nums">{item.undertime_minutes} min ({Math.round((item.undertime_minutes / 60) * 100) / 100} h)</dd></div>
          <div><dt className="text-muted-foreground">Half days</dt><dd className="tabular-nums">{item.half_days}</dd></div>
          <div><dt className="text-muted-foreground">Rates used</dt><dd className="tabular-nums">{b.rates?.daily ? `${money(b.rates.daily)}/day` : "—"} · {b.rates?.hourly ? `${money(b.rates.hourly)}/h` : "—"}</dd></div>
        </dl>
        {b.window ? <p className="text-xs text-muted-foreground">Attendance counted {shortDate(b.window.start_key)} – {dateLabel(b.window.end_key)} · schedule: {item.schedule_name || "—"}</p> : null}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-semibold tracking-wide text-gold-text uppercase">Deductions{firstCutoff ? " (attendance only on the 1st cutoff)" : ""}</p>
        {deductions.length ? (
          <ul className="space-y-1 text-sm">
            {deductions.map((line, i) => (
              <li key={`${line.label}-${i}`} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">{line.label}{line.note ? <span className="block text-xs text-muted-foreground">{line.note}</span> : null}</span>
                {/* A credit (the year-end tax refund) is added to the pay. */}
                <span className={cn("shrink-0 tabular-nums", line.credit ? "text-success" : "text-destructive")}>{line.credit ? "+" : "-"} {money(line.amount)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No deductions.</p>}
        {attendanceLines.length ? (
          <details className="rounded-md border bg-muted/30 px-2 py-1 text-xs">
            <summary className="cursor-pointer select-none text-muted-foreground">How the attendance deductions were computed ({attendanceLines.length} lines)</summary>
            <ul className="mt-1 space-y-0.5">
              {attendanceLines.map((l, i) => (
                <li key={`${l.type}-${l.log_date}-${i}`} className="flex justify-between gap-3"><span className="capitalize">{l.type.replaceAll("_", " ")}: {lineHow(l)}</span><span className="tabular-nums">{money(l.amount)}</span></li>
              ))}
            </ul>
          </details>
        ) : null}
        {b.taxable_income !== null && b.taxable_income !== undefined && !firstCutoff ? (
          <p className="text-xs text-muted-foreground">Withholding tax from the monthly table on the whole month&apos;s taxable income, {money(b.taxable_income)}.</p>
        ) : null}
        <div className="flex justify-between border-t pt-1 text-sm font-semibold"><span>Total deductions</span><span className="tabular-nums">{money(item.total_deductions)}</span></div>
        <div className="flex justify-between rounded-md bg-primary/8 px-2 py-1.5 text-sm font-semibold"><span>Net pay</span><span className="tabular-nums text-primary">{money(item.net_pay)}</span></div>
        {item.previous_net_pay !== null ? <p className="text-xs text-muted-foreground">Previous same cutoff: {money(item.previous_net_pay)}</p> : null}
      </div>
    </div>
  );
}

function RunDetail({ runId, onBack, onChanged }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [open, setOpen] = React.useState(() => new Set());
  const [decision, setDecision] = React.useState(null);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/hr/payroll-runs?run_id=${encodeURIComponent(runId)}`);
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState((c) => ({ loading: false, error: error.message, data: c.data }));
    }
  }, [runId]);
  React.useEffect(() => { load(); }, [load]);
  useLivePayrollRuns(load);

  if (state.error && !state.data) return <Card className="shadow-xs"><CardContent><ErrorState message={state.error} onRetry={load} /></CardContent></Card>;
  const data = state.data;
  const run = data?.run;
  const items = data?.items || [];
  const first = run?.cutoff_type === "first";
  const toggle = (id) => setOpen((c) => { const next = new Set(c); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const sum = (key) => items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  const columns = [
    ["Level", (i) => i.employee_level || "—"],
    ["Schedule used", (i) => i.schedule_name || "—"],
    ["Days worked", (i) => i.days_worked, true],
    ["Gross pay", (i) => money(i.gross_pay), true, "gross_pay"],
    ["Attendance ded.", (i) => money(i.attendance_deduction), true, "attendance_deduction"],
    ...(first ? [] : [
      ["W/tax", (i) => money(i.withholding_tax), true, "withholding_tax"],
      ["SSS", (i) => money(i.sss), true, "sss"],
      ["PhilHealth", (i) => money(i.philhealth), true, "philhealth"],
      ["Pag-IBIG", (i) => money(i.pagibig), true, "pagibig"],
      ["Loans", (i) => money(i.loans), true, "loans"],
      ["Other ded.", (i) => money(i.other_deductions), true, "other_deductions"],
    ]),
    ["Early Bird", (i) => (i.early_bird_incentive ? money(i.early_bird_incentive) : "—"), true, "early_bird_incentive"],
    ["Net pay", (i) => money(i.net_pay), true, "net_pay"],
  ];
  const exportUrl = (format) => `/api/hr/payroll-runs?run_id=${encodeURIComponent(runId)}&format=${format}`;

  return (
    <div className="flex flex-col gap-4" data-print-area>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="outline" size="sm" onClick={onBack}><ArrowLeftIcon aria-hidden="true" />All runs</Button>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild><a href={exportUrl("pdf")} download><FileTextIcon aria-hidden="true" />PDF</a></Button>
          <Button variant="outline" size="sm" asChild><a href={exportUrl("xlsx")} download><FileSpreadsheetIcon aria-hidden="true" />Excel</a></Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}><PrinterIcon aria-hidden="true" />Print</Button>
          {data?.can_review ? (
            <>
              <Button variant="destructive" size="sm" onClick={() => setDecision({ kind: "reject", runs: [run] })}><XCircleIcon aria-hidden="true" />Reject</Button>
              <Button size="sm" onClick={() => setDecision({ kind: "approve", runs: [run] })}><CheckCircle2Icon aria-hidden="true" />Approve</Button>
            </>
          ) : null}
        </div>
      </div>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {run ? <>{run.branch_name} · {run.period_label}{runNoLabel(run) ? ` · ${runNoLabel(run)}` : ""} <RunStatusBadge status={run.status} /></> : <Skeleton className="h-6 w-64" />}
          </CardTitle>
          <CardDescription>
            {run ? <>{cutoffLabel(run)}: {first ? "attendance deductions only (late, undertime, absences)" : "attendance for the 16th to month end, plus withholding tax, SSS, PhilHealth, Pag-IBIG, loans and other deductions"}. Submitted by {run.submitted_by_name || "—"}{run.submitted_at ? ` on ${dateTime(run.submitted_at)}` : ""} · snapshot {run.submission_no}.</> : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {run?.status === "rejected" && run.remarks ? (
            <Alert className="border-destructive/40 bg-destructive/5"><XCircleIcon className="text-destructive" aria-hidden="true" /><AlertDescription><strong className="text-foreground">Rejected by {run.reviewed_by_name}:</strong> {run.remarks}</AlertDescription></Alert>
          ) : null}
          {run?.status === "approved" ? (
            <Alert className="border-success/40 bg-success/5"><CheckCircle2Icon className="text-success" aria-hidden="true" /><AlertDescription>Approved by {run.reviewed_by_name} on {dateTime(run.reviewed_at)}{run.remarks ? ` — ${run.remarks}` : ""}. Locked; payslips are visible to employees.</AlertDescription></Alert>
          ) : null}
          <ExclusionsAlert exclusions={data?.exclusions} title="Left out of this run by the Accountant" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total employees" value={run?.totals.employees} icon={UsersIcon} loading={state.loading && !data} />
            <StatCard label="Total gross" value={run ? money(run.totals.gross) : null} icon={WalletIcon} tone="info" loading={state.loading && !data} />
            <StatCard label="Total deductions" value={run ? money(run.totals.deductions) : null} icon={WalletIcon} tone="warning" loading={state.loading && !data} />
            <StatCard label="Total net pay" value={run ? money(run.totals.net) : null} icon={WalletIcon} tone="success" loading={state.loading && !data} />
          </div>
          {data?.early_bird ? (
            <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm">
              <SunriseIcon className="mt-0.5 size-4 text-success" aria-hidden="true" />
              <p>
                <strong>Early Bird winner, {run?.period_label}:</strong>{" "}
                {data.early_bird.employee_name
                  ? <>{data.early_bird.employee_name} · {data.early_bird.early_count} early time-in{data.early_bird.early_count === 1 ? "" : "s"} · {money(data.early_bird.amount)}</>
                  : "no eligible employee"}
                {" "}· {data.early_bird.finalized ? "locked" : "locks when the first run of the period is approved"}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Employees</CardTitle>
          <CardDescription>Open a row to see the full computation. Highlighted rows need attention: net pay below zero, no days worked, or a large change against the previous same cutoff.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[1100px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"><span className="sr-only">Expand</span></TableHead>
                  <TableHead>Employee</TableHead>
                  {columns.map(([label, , right]) => <TableHead key={label} className={cn(right && "text-right")}>{label}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.loading && !data ? Array.from({ length: 4 }, (_, r) => (
                  <TableRow key={r}>{Array.from({ length: columns.length + 2 }, (__, c) => <TableCell key={c}><Skeleton className="h-4 w-14" /></TableCell>)}</TableRow>
                )) : !items.length ? (
                  <TableRow><TableCell colSpan={columns.length + 2}><EmptyState title="No employees in this run" /></TableCell></TableRow>
                ) : items.flatMap((item) => {
                  const expanded = open.has(item.id);
                  const flagged = item.flags.length > 0;
                  return [
                    <TableRow key={item.id} className={cn(flagged && "bg-warning/8 hover:bg-warning/12")}>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="size-7" onClick={() => toggle(item.id)} aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} ${item.employee_name}'s computation`}>
                          {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
                        </Button>
                      </TableCell>
                      <TableCell className="min-w-44">
                        <span className="font-medium">{item.employee_name}</span>
                        <span className="block text-xs text-muted-foreground">{item.employee_code || ""}{item.payslip_no ? ` · ${item.payslip_no}` : ""}</span>
                        {flagged ? (
                          <span className="mt-0.5 flex flex-wrap gap-1">
                            {item.flags.map((f) => <StatusBadge key={f} tone={f === "negative_net" ? "danger" : "warning"}>{FLAG_LABELS[f] || f}</StatusBadge>)}
                          </span>
                        ) : null}
                      </TableCell>
                      {columns.map(([label, cell, right]) => <TableCell key={label} className={cn("whitespace-nowrap", right && "text-right tabular-nums")}>{cell(item)}</TableCell>)}
                    </TableRow>,
                    expanded ? (
                      <TableRow key={`${item.id}-detail`} className="bg-muted/20 hover:bg-muted/20">
                        <TableCell colSpan={columns.length + 2} className="p-0 whitespace-normal"><Breakdown item={item} firstCutoff={first} /></TableCell>
                      </TableRow>
                    ) : null,
                  ].filter(Boolean);
                })}
              </TableBody>
              {items.length ? (
                <TableFooter>
                  <TableRow>
                    <TableCell />
                    <TableCell>Total ({items.length})</TableCell>
                    {columns.map(([label, , , key]) => (
                      <TableCell key={label} className="text-right tabular-nums whitespace-nowrap">{key ? money(sum(key)) : ""}</TableCell>
                    ))}
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader><CardTitle className="flex items-center gap-2"><HistoryIcon className="size-4 text-gold-text" aria-hidden="true" />History</CardTitle></CardHeader>
        <CardContent>
          {(data?.history || []).length ? (
            <ol className="space-y-2">
              {data.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-2 border-brand-gold/50 pl-3 text-sm">
                  <RunStatusBadge status={h.to_status} />
                  <span className="font-medium capitalize">{h.action}</span>
                  <span>by {h.actor_name || "—"} ({h.actor_role === "hr" ? "HR" : h.actor_role === "super_admin" ? "Super Admin" : h.actor_role === "accountant" ? "Accountant" : h.actor_role})</span>
                  <span className="text-xs text-muted-foreground">{dateTime(h.created_at)}</span>
                  {h.remarks ? <p className="w-full text-muted-foreground">“{h.remarks}”</p> : null}
                </li>
              ))}
            </ol>
          ) : <p className="text-sm text-muted-foreground">No actions yet.</p>}
        </CardContent>
      </Card>

      <DecisionDialog decision={decision} onClose={() => setDecision(null)} onDone={() => { setDecision(null); load(); onChanged?.(); }} />
    </div>
  );
}

/* ── The list ───────────────────────────────────────────────────────────── */

export function PayrollApprovalPage({ refreshKey, onChanged }) {
  // The tab and the open run stay in the address: a refresh mid-review
  // reopens the same run (useUrlParam).
  const [tabParam, setTab] = useUrlParam("pa_tab", "pending");
  const tab = TABS.some((t) => t.id === tabParam) ? tabParam : "pending";
  const [filters, setFilters] = React.useState({ branch: ANY, period: ANY, q: "" });
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [selected, setSelected] = React.useState(() => new Set());
  const [openRun, setOpenRun] = useUrlParam("pa_run", "");
  const [decision, setDecision] = React.useState(null);

  // Search waits for a pause in typing.
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(filters.q.trim()), 300);
    return () => clearTimeout(timer);
  }, [filters.q]);

  // The newest request wins: a slower, older one (another tab or filter)
  // never overwrites it.
  const seq = React.useRef(0);
  const load = React.useCallback(async () => {
    const mine = ++seq.current;
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const params = new URLSearchParams(tab === "history" ? { view: "history" } : { status: tab });
      if (filters.branch !== ANY) params.set("branch_id", filters.branch);
      if (filters.period !== ANY) params.set("period", filters.period);
      if (query) params.set("q", query);
      const data = await fetchJson(`/api/hr/payroll-runs?${params.toString()}`);
      if (mine !== seq.current) return;
      if (data.available === false) throw new Error(data.error);
      // Tagged with its tab: switching tabs shows the skeleton, never the
      // previous tab's rows or a false "nothing here", until this arrives.
      setState({ loading: false, error: null, data: { ...data, tab } });
      setSelected((c) => new Set([...c].filter((id) => (data.runs || []).some((r) => r.id === id && r.status === "pending"))));
      // The History tab selects nothing.
      if (tab === "history") setSelected(new Set());
    } catch (error) {
      if (mine !== seq.current) return;
      setState((c) => ({ loading: false, error: error.message, data: c.data }));
    }
  }, [tab, filters.branch, filters.period, query]);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  useLivePayrollRuns(() => { load(); onChanged?.(); });

  if (openRun) {
    return <RunDetail runId={openRun} onBack={() => { setOpenRun(""); load(); }} onChanged={() => { load(); onChanged?.(); }} />;
  }

  const data = state.data;
  const current = data?.tab === tab;
  const runs = current ? data?.runs || [] : [];
  const canReview = Boolean(data?.can_review);
  const pendingRuns = runs.filter((r) => r.status === "pending");
  const chosen = pendingRuns.filter((r) => selected.has(r.id));
  const toggle = (id, on) => setSelected((c) => { const next = new Set(c); if (on) next.add(id); else next.delete(id); return next; });

  const historyColumns = [
    { key: "period_start", header: "Pay period", sortable: true, cell: (r) => <span className="whitespace-nowrap">{r.period_label}<span className="block text-xs text-muted-foreground">{cutoffLabel(r)}</span></span>, searchValue: (r) => r.period_label },
    { key: "branch_name", header: "Branch", sortable: true, className: "font-medium" },
    { key: "submitted_by_name", header: "Submitted by", sortable: true, cell: (r) => r.submitted_by_name || "—" },
    { key: "submitted_at", header: "Submitted", sortable: true, className: "whitespace-nowrap", cell: (r) => (r.submitted_at ? dateTime(r.submitted_at) : "—") },
    { key: "decision", header: "Decision", sortable: true, cell: (r) => <RunStatusBadge status={r.decision} /> },
    { key: "decided_by_name", header: "Decided by", sortable: true, cell: (r) => r.decided_by_name || "—" },
    { key: "decided_at", header: "Decision date", sortable: true, className: "whitespace-nowrap", cell: (r) => (r.decided_at ? dateTime(r.decided_at) : "—") },
    { key: "remarks", header: "Rejection reason", cell: (r) => (r.decision === "rejected" ? <p className="max-w-64 text-xs whitespace-normal">{r.remarks || "—"}</p> : <span className="text-xs text-muted-foreground">{r.remarks || "—"}</span>) },
    { key: "open", header: <span className="sr-only">Open</span>, align: "right", cell: (r) => <Button variant="outline" size="sm" onClick={() => setOpenRun(r.run_id)}>View run</Button> },
  ];

  const columns = tab === "history" ? historyColumns : [
    ...(canReview && tab !== "approved" && tab !== "rejected" ? [{
      key: "pick",
      header: (
        <Checkbox
          checked={pendingRuns.length > 0 && chosen.length === pendingRuns.length}
          onCheckedChange={(v) => setSelected(v === true ? new Set(pendingRuns.map((r) => r.id)) : new Set())}
          aria-label="Select every pending run"
          disabled={!pendingRuns.length}
        />
      ),
      cell: (r) => (r.status === "pending"
        ? <Checkbox checked={selected.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} aria-label={`Select ${r.branch_name}, ${r.period_label}`} />
        : null),
    }] : []),
    { key: "branch_name", header: "Branch", sortable: true, className: "font-medium", searchValue: (r) => r.branch_name },
    { key: "period_start", header: "Period", sortable: true, cell: (r) => <span className="whitespace-nowrap">{r.period_label}<span className="block text-xs text-muted-foreground">{cutoffLabel(r)}</span></span>, searchValue: (r) => r.period_label },
    { key: "total_employees", header: "Employees", align: "right", sortable: true, className: "tabular-nums" },
    {
      key: "excluded_employees", header: "Left out", sortable: true,
      cell: (r) => (r.excluded_employees ? <StatusBadge tone="warning">{r.excluded_employees} left out</StatusBadge> : <span className="text-xs text-muted-foreground">None</span>),
    },
    { key: "total_gross", header: "Total gross", align: "right", sortable: true, className: "tabular-nums whitespace-nowrap", cell: (r) => money(r.total_gross) },
    { key: "total_deductions", header: "Total deductions", align: "right", sortable: true, className: "tabular-nums whitespace-nowrap", cell: (r) => money(r.total_deductions) },
    { key: "total_net", header: "Total net pay", align: "right", sortable: true, className: "tabular-nums whitespace-nowrap font-medium", cell: (r) => money(r.total_net) },
    { key: "submitted_by_name", header: "Submitted by", sortable: true, cell: (r) => r.submitted_by_name || "—", searchValue: (r) => r.submitted_by_name },
    { key: "submitted_at", header: "Date submitted", sortable: true, className: "whitespace-nowrap", cell: (r) => (r.submitted_at ? dateTime(r.submitted_at) : "—") },
    {
      key: "status", header: "Status", sortable: true,
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1">
          <RunStatusBadge status={r.status} />
          {r.flagged_employees ? <StatusBadge tone="warning"><AlertTriangleIcon className="size-3" aria-hidden="true" />{r.flagged_employees}</StatusBadge> : null}
        </span>
      ),
    },
    { key: "open", header: <span className="sr-only">Open</span>, align: "right", cell: (r) => <Button variant="outline" size="sm" onClick={() => setOpenRun(r.id)}>Review</Button> },
  ];

  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ClipboardCheckIcon className="size-4 text-gold-text" aria-hidden="true" />Payroll Approval</CardTitle>
          <CardDescription>
            {canReview
              ? "Each branch's payroll for a cutoff, as the Accountant submitted it. Review, then approve or reject with a reason. Approved payroll is locked and its payslips become visible to employees."
              : "Each branch's payroll for a cutoff and HR's decisions. View only."}
          </CardDescription>
          <CardAction className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
            {canReview && chosen.length ? (
              <Button size="sm" onClick={() => setDecision({ kind: "approve", runs: chosen })}><CheckCircle2Icon aria-hidden="true" />Approve selected ({chosen.length})</Button>
            ) : null}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={tab} onValueChange={(v) => { setTab(v); setSelected(new Set()); }}>
            <div className="-mx-1 overflow-x-auto px-1 pb-1">
              <TabsList className="w-max">{TABS.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}</TabsList>
            </div>
          </Tabs>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="pa-branch">Branch</Label>
              <Select value={filters.branch} onValueChange={(v) => setFilters((c) => ({ ...c, branch: v }))}>
                <SelectTrigger id="pa-branch" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All branches</SelectItem>
                  {(data?.branches || []).map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pa-period">Period / cutoff</Label>
              <Select value={filters.period} onValueChange={(v) => setFilters((c) => ({ ...c, period: v }))}>
                <SelectTrigger id="pa-period" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All periods</SelectItem>
                  {(data?.periods || []).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pa-search">Search</Label>
              <Input maxLength={SEARCH_MAX} id="pa-search" placeholder="Branch, submitter or employee name" value={filters.q} onChange={(e) => setFilters((c) => ({ ...c, q: e.target.value }))} />
            </div>
          </div>
          {state.error && !data ? <ErrorState message={state.error} onRetry={load} /> : (
            <DataTable
              columns={columns}
              rows={!current ? [] : tab === "history" ? data?.history || [] : runs}
              loading={state.loading && !current}
              error={state.error}
              onRetry={load}
              searchable={false}
              pageSize={15}
              rowKey={(r) => r.id}
              rowClassName={(r) => (r.flagged_employees ? "bg-warning/5" : undefined)}
              empty={{
                title: tab === "pending" ? "No payroll waiting for approval" : tab === "history" ? "No decisions yet" : "No payroll runs here",
                description: tab === "pending" ? "Runs appear here as soon as an Accountant submits them." : null,
              }}
              caption={tab === "history" ? "Payroll approval history" : "Payroll runs"}
              minWidth={1100}
            />
          )}
        </CardContent>
      </Card>
      <DecisionDialog decision={decision} onClose={() => setDecision(null)} onDone={() => { setDecision(null); setSelected(new Set()); load(); onChanged?.(); }} />
      {/* Employees left out of a submitted run and not paid for that period yet. */}
      <OpenExclusionsCard endpoint="/api/hr/payroll-runs?view=excluded" refreshKey={refreshKey} showBranch
        description="Left out of a submitted run by the Accountant and not paid for that period yet. The Accountant processes them and submits a supplemental run for you to approve." />
      {/* Corrections to approved payslips: HR approves or rejects them. */}
      <CorrectionsCard refreshKey={refreshKey} />
    </>
  );
}
