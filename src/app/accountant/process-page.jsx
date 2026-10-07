"use client";

import * as React from "react";
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { EmptyState } from "@/components/portal/empty-state";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch, jsonBody } from "@/lib/portal/api";
import {
  SALARY_MAX,
  batchRowBase,
  batchRowNet,
  batchTaxDefault,
  computeSummary,
  dateLabel,
  defaultForm,
  describeBlockingDays,
  employeePayInfo,
  formDeviations,
  formFromDraft,
  money,
  same,
  semiHalf,
  shortDate,
  submissionPayload,
  toAmount,
  usesLegalTables,
} from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { useAccountant } from "./accountant-data";

/*
 * Process Payroll (loadBatchPayrollTable / processBatchPayroll /
 * generateEmployeePayslip / recalc / processPayroll / savePayrollDraft,
 * public/legacy/js/accountant.js). The figures are a preview; the server
 * recomputes every entry (POST / PATCH /api/accountant/payroll).
 */

/** View Attendance opens on its Incomplete Queue tab (openAcctIncompleteQueue). */
export const INCOMPLETE_TAB_KEY = "sacs-ac-att-tab";

function openIncompleteQueue(onNavigate) {
  try { sessionStorage.setItem(INCOMPLETE_TAB_KEY, "incomplete"); } catch { /* private mode */ }
  onNavigate("ac-attendance");
}

/** Keeps a salary to 7 whole digits and the maximum (clampSalaryInput). */
function clampSalary(raw) {
  if (!raw) return raw;
  let value = raw;
  const intPart = value.split(".")[0].replace(/^-/, "");
  if (intPart.length > 7) {
    const dot = value.indexOf(".");
    value = dot >= 0 ? `${intPart.slice(0, 7)}${value.slice(dot)}` : intPart.slice(0, 7);
  }
  const n = Number(value);
  return Number.isFinite(n) && n > SALARY_MAX ? String(SALARY_MAX) : value;
}

function Banners({ data }) {
  const win = data?.generation_window || null;
  const semi = data?.semi_monthly || null;
  const period = data?.active_period?.label || "This period";
  return (
    <>
      {data && data.payroll_ready === false ? (
        <Alert className="border-warning/40 bg-warning/10 text-warning">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertDescription className="text-warning">{data.payroll_not_ready_message}</AlertDescription>
        </Alert>
      ) : null}
      {win ? (
        <Alert className={cn(win.state === "final" ? "border-success/40 bg-success/8" : win.state === "draft" ? "border-info/40 bg-info/8" : "border-warning/40 bg-warning/10")}>
          {win.state === "final" || win.state === "draft" ? <InfoIcon aria-hidden="true" /> : <AlertTriangleIcon aria-hidden="true" />}
          <AlertDescription>
            <p><strong className="text-foreground">{period}:</strong> {win.message}</p>
            <p className="text-xs">Window {dateLabel(win.opens_on)} – {dateLabel(win.pay_date)}{win.pay_date_scheduled ? " (pay date from the Pay Calendar)" : ""}.</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {semi ? (
        <Alert className="border-info/40 bg-info/8">
          <InfoIcon aria-hidden="true" />
          <AlertDescription>
            {semi.half === "first" ? (
              <p><strong className="text-foreground">1st half:</strong> the full semi-monthly salary (monthly salary ÷ 2) with no deductions. Absences, leave, incentives, contributions and withholding tax for {semi.month_label} are settled on the {semi.second_half_label} payslip.</p>
            ) : (
              <p><strong className="text-foreground">2nd half settles {semi.month_label}:</strong> attendance {shortDate(semi.window?.start_key)} – {dateLabel(semi.window?.end_key)}{semi.lock_day ? ` (locked on day ${semi.lock_day}; later items go to next month)` : ""}, approved leave, incentives and overload, the month&apos;s SSS / PhilHealth / Pag-IBIG and withholding tax from the monthly table. Net pay is the month&apos;s net less what the 1st half paid.</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/** The Payslip cell of an employee's batch row (acctPayslipCell). */
function PayslipCell({ data, employee, onGenerate, onView, busy }) {
  const win = data?.generation_window;
  const state = (data?.attendance_rows || []).find((r) => r.employee_id === employee.id)?.payslip || null;
  if (state?.status === "final") {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5"><StatusBadge tone="success">Final</StatusBadge><Button variant="outline" size="sm" className="h-7" onClick={() => onView(state.entry_id)}>View</Button></div>
        <p className="text-xs text-muted-foreground">{state.payslip_no || ""} · locked</p>
      </div>
    );
  }
  const canGenerate = Boolean(win?.can_generate);
  const isDraft = state?.status === "draft";
  const finalNext = win?.state === "final";
  const title = canGenerate
    ? (finalNext ? "Creates the Final payslip (locked once saved)" : `Draft with attendance up to ${dateLabel(win.attendance_through)}`)
    : (win?.message || "");
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {isDraft ? <StatusBadge tone="gold">Draft</StatusBadge> : null}
        <Button size="sm" className="h-7" variant={finalNext && canGenerate ? "default" : "outline"} title={title} disabled={!canGenerate || busy} onClick={() => onGenerate(employee.id)}>
          {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
          {finalNext && canGenerate ? "Generate final" : isDraft ? "Regenerate" : "Generate"}
        </Button>
        {isDraft ? <Button variant="outline" size="sm" className="h-7" onClick={() => onView(state.entry_id)}>View</Button> : null}
      </div>
      {isDraft ? <p className="text-xs text-muted-foreground">Up to {dateLabel(state.attendance_through)}</p>
        : !canGenerate && win?.state === "not_open" ? <p className="text-xs text-muted-foreground">Opens {dateLabel(win.opens_on)}</p>
          : !canGenerate && win?.state === "closed" ? <p className="text-xs text-muted-foreground">Window closed</p> : null}
    </div>
  );
}

function BatchCard({ onNavigate }) {
  const { data, loading, period, setPeriod, load, openPayslip } = useAccountant();
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [edits, setEdits] = React.useState({});
  const [reason, setReason] = React.useState("");
  const [reasonError, setReasonError] = React.useState("");
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);
  const [generating, setGenerating] = React.useState("");

  // New data: every row starts again from its computed defaults.
  React.useEffect(() => { setEdits({}); }, [data]);

  const employees = data?.employees || [];
  const ready = data?.payroll_ready !== false;
  const win = data?.generation_window || null;
  const finalWindow = !win || win.state === "final";

  const rows = employees.map((employee) => {
    const base = batchRowBase(data, employee);
    const e = edits[employee.id] || {};
    const value = (field, def) => (e[field] !== undefined ? e[field] : String(def));
    const sss = value("sss", base.contributions.sss);
    const philhealth = value("philhealth", base.contributions.philhealth);
    const pagibig = value("pagibig", base.contributions.pagibig);
    const lwop = value("lwop", base.lwop);
    const nums = { sss: toAmount(sss), philhealth: toAmount(philhealth), pagibig: toAmount(pagibig), lwop: toAmount(lwop) };
    // With the legal tables the tax follows this row's figures until typed.
    const taxDefault = base.legal ? batchTaxDefault(data, base, nums) : batchTaxDefault(data, base, { sss: base.contributions.sss, philhealth: base.contributions.philhealth, pagibig: base.contributions.pagibig, lwop: base.lwop });
    const tax = e.tax !== undefined ? e.tax : String(taxDefault);
    const net = batchRowNet({
      basic_salary: base.basic, sss: nums.sss, philhealth: nums.philhealth, pagibig: nums.pagibig, tax: toAmount(tax),
      leave_without_pay_days: nums.lwop, daily_rate: base.info.unit.daily, attendance_deductions: base.attendanceDeductions,
      incentives: base.incentives, earnings: base.earnings, other_incentives: base.extras.other,
      first_half_paid: base.extras.firstHalfPaid, carry_in: base.extras.carryIn, cash_advance: base.cashAdvance,
    });
    const defaults = { sss: base.contributions.sss, philhealth: base.contributions.philhealth, pagibig: base.contributions.pagibig, lwop: base.lwop, tax: taxDefault };
    const values = { sss, philhealth, pagibig, lwop, tax };
    // Withholding tax counts as a change only with the legal tables.
    const fields = ["sss", "philhealth", "pagibig", "lwop", ...(base.legal ? ["tax"] : [])];
    const changed = fields.filter((f) => !same(values[f], defaults[f]));
    return { employee, base, values, defaults, net, changed };
  });

  const anyChanged = rows.some((r) => !r.base.blocking.length && r.changed.length);

  const setField = (employeeId, field, value) => setEdits((current) => ({ ...current, [employeeId]: { ...(current[employeeId] || {}), [field]: value } }));

  async function processAll() {
    if (!period) { setFeedback({ text: "Select a pay period first.", ok: false }); return; }
    if (!ready) { setFeedback({ text: data?.payroll_not_ready_message || "", ok: false }); return; }
    const eligible = rows.filter((r) => !r.base.blocking.length);
    const blockedCount = rows.length - eligible.length;
    if (!eligible.length) {
      setFeedback({ text: blockedCount ? "Every employee has unresolved attendance for this period." : "No employees to process.", ok: false });
      return;
    }
    if (eligible.some((r) => r.changed.length) && !reason.trim()) {
      setReasonError("Give a reason for the changed values.");
      setFeedback({ text: "Give a reason for the values changed from the computed defaults (highlighted).", ok: false });
      document.getElementById("pc-batch-reason")?.focus();
      return;
    }
    setReasonError("");
    const ok = await confirm({
      title: `Process payroll for ${eligible.length} employee${eligible.length === 1 ? "" : "s"}?`,
      description: `This will generate a payslip for each employee. Already-paid employees for this period will be skipped.${blockedCount ? ` ${blockedCount} employee${blockedCount === 1 ? "" : "s"} with unresolved attendance will wait.` : ""}`,
      confirmLabel: "Process payroll",
    });
    if (!ok) return;
    const entries = eligible.map((r) => ({
      employee_id: r.employee.id,
      basic_salary: r.base.basic,
      deductions: {
        sss: toAmount(r.values.sss),
        philhealth: toAmount(r.values.philhealth),
        pagibig: toAmount(r.values.pagibig),
        withholding_tax: toAmount(r.values.tax),
        // Absent / Late / Undertime / Half Day / incentives are computed on the server.
        leave_with_pay_days: r.base.lwp,
        leave_without_pay_days: toAmount(r.values.lwop),
      },
    }));
    setBusy(true);
    setFeedback({ text: "Processing payroll for all employees…", ok: true });
    try {
      const response = await apiFetch("/api/accountant/payroll", jsonBody("POST", { action: "batch_submit", pay_period: period, entries, override_reason: reason.trim() }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Failed to process batch payroll.");
      const processed = result.processed || [];
      const skipped = result.skipped || [];
      let message = `Processed ${processed.length} payslip${processed.length === 1 ? "" : "s"}.`;
      if (skipped.length) message += ` ${skipped.length} skipped — ${skipped.map((s) => `${s.employee_name || s.employee_id || "Unknown"}: ${s.reason || "skipped"}`).join(" · ")}`;
      setFeedback({ text: message, ok: true });
      setReason("");
      notify("Batch Payroll Processed", message, skipped.length && !processed.length ? "info" : "success");
      await load({ period });
      if (processed.length) openPayslip(processed[0].entry_id);
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function generate(employeeId, confirmIncomplete = false) {
    const employee = employees.find((e) => e.id === employeeId);
    setGenerating(employeeId);
    setFeedback({ text: `Generating ${employee?.full_name || "the"} payslip…`, ok: true });
    try {
      const response = await apiFetch("/api/accountant/payroll", jsonBody("PATCH", {
        action: "generate",
        employee_id: employeeId,
        pay_period: data?.active_period?.label || "",
        confirm_incomplete: confirmIncomplete,
      }));
      const result = await response.json().catch(() => ({}));
      if (response.status === 422 && result.code === "unresolved_attendance") {
        setFeedback({ text: "", ok: false });
        setGenerating("");
        const proceed = await confirm({
          title: "Generate without the unresolved days?",
          description: `${result.error} They will be listed on the payslip as not counted.`,
          confirmLabel: "Generate anyway",
        });
        if (proceed) await generate(employeeId, true);
        return;
      }
      if (!response.ok) throw new Error(result.error || "Unable to generate the payslip.");
      const final = result.status === "final";
      setFeedback({
        text: final
          ? `Final payslip ${result.entry?.payslip_no || ""} generated for ${employee?.full_name || "the employee"}. It is now locked.`
          : `Draft payslip generated for ${employee?.full_name || "the employee"} (attendance up to ${dateLabel(result.window?.attendance_through)}).`,
        ok: true,
      });
      notify(final ? "Final Payslip Generated" : "Draft Payslip Generated", final ? "The payslip is final and locked." : "You can regenerate it until the period ends.", "success");
      await load({ period: data?.active_period?.label });
      if (result.entry?.id) openPayslip(result.entry.id);
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    } finally {
      setGenerating("");
    }
  }

  const amountLine = (quantity, amount, sign = "-") => (
    <div>
      <span>{quantity}</span>
      {amount ? <p className={cn("text-xs", sign === "+" ? "text-success" : "text-destructive")}>{sign} {money(amount)}</p> : null}
    </div>
  );

  const numberInput = (row, field, step = "0.01") => (
    <Input
      type="number"
      min="0"
      step={step}
      inputMode={step === "1" ? "numeric" : "decimal"}
      aria-label={`${field.toUpperCase()} for ${row.employee.full_name}`}
      value={row.values[field]}
      disabled={Boolean(row.base.blocking.length) || row.base.half === "first"}
      onChange={(e) => setField(row.employee.id, field, e.target.value)}
      className={cn("h-8 w-24 px-2 text-right tabular-nums", !same(row.values[field], row.defaults[field]) && "border-warning ring-1 ring-warning/40")}
    />
  );

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>Batch process payroll</CardTitle>
        <CardDescription>Review every employee&apos;s computed values — auto-filled from attendance logs and approved leave — then process payroll for everyone in one go. Absent, Late, Undertime, Half Day and incentives come from the attendance logs and the rates in force on the period&apos;s first day; they cannot be typed in here.</CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          <Select value={period} onValueChange={setPeriod} disabled={!data?.period_options?.length}>
            <SelectTrigger size="sm" className="w-44" aria-label="Pay period"><SelectValue placeholder="Current period" /></SelectTrigger>
            <SelectContent>{(data?.period_options || []).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => load({ period })} disabled={loading}><RefreshCwIcon className={cn(loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-hidden rounded-lg border">
          <Table style={{ minWidth: 1500 }}>
            <TableHeader className="bg-muted/60">
              <TableRow className="hover:bg-transparent">
                {["Employee", "Basic salary", "SSS", "PhilHealth", "Pag-IBIG", "Tax", "Absent", "Late", "Undertime", "Half day", "Early bird / incentive", "Leave w/ pay", "Leave w/o pay", "Net pay", "Payslip"].map((h) => (
                  <TableHead key={h} className="text-xs font-semibold text-muted-foreground">{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data && loading ? Array.from({ length: 4 }, (_, i) => (
                <TableRow key={i}>{Array.from({ length: 15 }, (__, c) => <TableCell key={c}><Skeleton className="h-4 w-16" /></TableCell>)}</TableRow>
              )) : !rows.length ? (
                <TableRow className="hover:bg-transparent"><TableCell colSpan={15} className="p-0"><EmptyState title="No employees found" /></TableCell></TableRow>
              ) : rows.flatMap((row) => {
                const { employee, base } = row;
                const incentiveLabel = [
                  base.counts.early_bird_days ? `${base.counts.early_bird_days} day${base.counts.early_bird_days === 1 ? "" : "s"}` : "",
                  base.info.pay?.perfect_attendance && base.half !== "first" ? "Perfect" : "",
                  base.extras.other ? `Incentive/overload${base.extras.overloadHours ? ` (${base.extras.overloadHours} h)` : ""}` : "",
                ].filter(Boolean).join(" · ") || "0";
                const blocked = base.blocking.length > 0;
                const out = [
                  <TableRow key={employee.id} className={cn(blocked && "opacity-75")}>
                    <TableCell className="font-medium">{employee.full_name}</TableCell>
                    <TableCell className="tabular-nums">
                      {money(base.basic)}
                      {base.earnings ? <p className="text-xs text-success" title="Approved overtime and holiday pay">+ {money(base.earnings)} OT/holiday</p> : null}
                    </TableCell>
                    <TableCell>{numberInput(row, "sss")}</TableCell>
                    <TableCell>{numberInput(row, "philhealth")}</TableCell>
                    <TableCell>{numberInput(row, "pagibig")}</TableCell>
                    <TableCell>{numberInput(row, "tax")}</TableCell>
                    <TableCell className="tabular-nums">{amountLine(`${base.counts.absent_days || 0}`, base.amounts.absent)}</TableCell>
                    <TableCell className="tabular-nums">{amountLine(`${base.counts.late_days || 0}`, base.amounts.late)}</TableCell>
                    <TableCell className="tabular-nums">{amountLine(base.counts.undertime_minutes ? `${base.counts.undertime_minutes} min` : "0", base.amounts.undertime)}</TableCell>
                    <TableCell className="tabular-nums">{amountLine(`${base.counts.half_days || 0}`, base.amounts.half_day)}</TableCell>
                    <TableCell className="whitespace-normal tabular-nums">{amountLine(incentiveLabel, toAmount(base.incentives + base.extras.other), "+")}</TableCell>
                    <TableCell className="tabular-nums">{base.lwp}</TableCell>
                    <TableCell>{numberInput(row, "lwop", "1")}</TableCell>
                    <TableCell className="font-semibold tabular-nums">
                      {money(row.net)}
                      {base.half === "second" ? <p className="text-xs font-normal whitespace-normal text-muted-foreground" title="Monthly net less what the 1st half paid">less 1st half {money(base.extras.firstHalfPaid)}{base.extras.carryIn ? ` and carried ${money(base.extras.carryIn)}` : ""}</p> : null}
                      {base.cashAdvance ? <p className="text-xs font-normal whitespace-normal text-destructive">less cash advance {money(base.cashAdvance)}</p> : null}
                    </TableCell>
                    <TableCell><PayslipCell data={data} employee={employee} onGenerate={generate} onView={openPayslip} busy={generating === employee.id} /></TableCell>
                  </TableRow>,
                ];
                if (blocked) {
                  out.push(
                    <TableRow key={`${employee.id}-blocked`} className="bg-warning/8 hover:bg-warning/8">
                      <TableCell colSpan={15} className="whitespace-normal text-sm text-warning">
                        <AlertTriangleIcon className="mr-1 inline size-4" aria-hidden="true" />
                        {employee.full_name} will be skipped — unresolved attendance: {describeBlockingDays(base.blocking)}. HR or the branch Administrator must resolve {base.blocking.length === 1 ? "it" : "them"} first.{" "}
                        <Button variant="link" className="h-auto p-0 text-warning" onClick={() => openIncompleteQueue(onNavigate)}>View in attendance →</Button>
                      </TableCell>
                    </TableRow>,
                  );
                }
                return out;
              })}
            </TableBody>
          </Table>
        </div>

        {anyChanged ? (
          <div className="space-y-2">
            <Label htmlFor="pc-batch-reason">Reason for manual changes <span className="font-normal text-muted-foreground">(required — SSS, PhilHealth, Pag-IBIG, tax or Leave w/o Pay was changed from the computed value; logged with your name)</span></Label>
            <Input id="pc-batch-reason" maxLength={300} placeholder="e.g. Contribution table update for this employee" value={reason} onChange={(e) => { setReason(e.target.value); setReasonError(""); }} aria-invalid={Boolean(reasonError) || undefined} />
            {reasonError ? <p className="text-sm text-destructive">{reasonError}</p> : null}
          </div>
        ) : null}

        <Button className="w-full" size="lg" onClick={processAll} disabled={busy || !ready || !finalWindow} title={finalWindow ? "" : (win?.message || "")}>
          {busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Processing…</> : "Process payroll for all →"}
        </Button>
        {feedback.text ? <p role="status" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
      </CardContent>
      {confirmDialog}
    </Card>
  );
}

function SummaryRow({ label, value, tone, strong }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 text-sm", strong && "mt-1 border-t pt-2.5 font-semibold", tone === "plus" && "text-success", tone === "minus" && "text-destructive", tone === "warn" && "text-warning")}>
      <span>{label}</span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  );
}

function SingleEntry({ onNavigate }) {
  const { data, period, setPeriod, entryId, setEntryId, load, openPayslip } = useAccountant();
  const { notify } = usePortalSession();
  const employees = data?.employees || [];
  const [employeeId, setEmployeeId] = React.useState("");
  const [form, setForm] = React.useState(() => defaultForm(null, null));
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [reasonError, setReasonError] = React.useState("");
  const [processedBanner, setProcessedBanner] = React.useState(false);

  // After every load: the open draft fills the form, otherwise the selected
  // employee's computed defaults (populateFormFromDraft / syncFormForEmployee).
  React.useEffect(() => {
    if (!data) return;
    const draft = [...(data.records || []), ...(data.draft_entries || [])].find((row) => String(row.id) === String(entryId));
    if (draft) {
      setEmployeeId(draft.employee_id);
      setForm(formFromDraft(draft));
      return;
    }
    const id = employees.some((e) => e.id === employeeId) ? employeeId : employees[0]?.id || "";
    setEmployeeId(id);
    setForm(defaultForm(data, employees.find((e) => e.id === id)));
    // Re-fill only when new data arrives or another draft is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, entryId]);

  const employee = employees.find((e) => e.id === employeeId) || null;
  const summary = computeSummary(data, employee, form);
  const deviations = formDeviations(data, employee, form, summary.taxDefault);
  const info = employeePayInfo(data, employee?.id);
  const blocking = info.pay?.blocking || [];
  const ready = data?.payroll_ready !== false;
  const win = data?.generation_window || null;
  const finalWindow = !win || win.state === "final";
  const firstHalf = semiHalf(data) === "first";
  const leave = (data?.leave_summary || []).find((row) => row.employee_id === employee?.id);
  const peso = (v) => money(v).replace("₱ ", "₱");
  const unit = info.unit;
  const legal = usesLegalTables(info);
  const source = info.row?.defaults?.contribution_source || null;
  const sourceWords = { fixed: "fixed monthly amount", employee: "set for this employee" };
  const contributionHint = (type, pctLabel) => (legal
    ? (source && sourceWords[source[type]] ? `(${sourceWords[source[type]]}, editable)` : pctLabel)
    : `(default ${info.rates[`${type}_pct`]}% of Basic, editable)`);
  const lateRules = [
    unit.late_days_per_absent > 0 ? `${unit.late_days_per_absent} late = 1 absent (${peso(unit.absent)})` : "",
    unit.late_minute_pct > 0 ? `+ ${unit.late_minute_pct}% of hourly per minute` : "",
  ].filter(Boolean).join(" ") || "not charged";

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const shownTax = form.taxEdited ? form.tax : String(summary.taxDefault);
  const dates = (list) => (list || []).map((key) => {
    const d = new Date(`${key}T00:00:00+08:00`);
    return Number.isNaN(d.getTime()) ? key : new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" }).format(d);
  }).join(", ");

  async function submit(action) {
    if (!employee) { setFeedback({ text: "Select an employee first.", ok: false }); return; }
    if (!period) { setFeedback({ text: "Select a pay period first.", ok: false }); return; }
    setBusy(true);
    setReasonError("");
    setFeedback({ text: action === "submit" ? "Processing payroll…" : "Saving payroll draft…", ok: true });
    try {
      const payload = submissionPayload(action, { entryId, employee, period, form, tax: summary.tax, data });
      const response = await apiFetch("/api/accountant/payroll", jsonBody("POST", payload));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (result.code === "override_reason_required") setReasonError("Give a reason for the values changed from the computed defaults.");
        const err = new Error(result.error || "Failed to save payroll entry.");
        err.status = response.status;
        throw err;
      }
      const newId = String(result.entry?.id || entryId || "");
      setEntryId(newId);
      await load();
      if (result.db_synced === false) notify("Draft Saved", "Draft saved. Database sync pending — contact your administrator if this keeps occurring.", "info");
      if (action === "submit") {
        setFeedback({ text: "Payroll processed successfully. Payslip generated.", ok: true });
        notify("Payroll Processed", "Payroll has been processed and payslip generated.", "success");
        setProcessedBanner(true);
        setTimeout(() => setProcessedBanner(false), 5000);
        openPayslip(newId);
      } else {
        setFeedback({ text: "Payroll draft saved.", ok: true });
        notify("Draft Saved", "Payroll draft has been saved and can be edited before submission.", "info");
      }
    } catch (error) {
      if (action === "submit" && error.status === 409) {
        setFeedback({ text: "", ok: false });
        notify("Already Processed", "Payroll for this employee and period has already been processed.", "info");
      } else {
        setFeedback({ text: error.message, ok: false });
      }
    } finally {
      setBusy(false);
    }
  }

  const numberField = (id, label, key, { hint, step = "0.01", disabled = firstHalf, readOnly = false, children } = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex-wrap gap-x-1">{label}{hint ? <span className="font-normal text-muted-foreground">{hint}</span> : null}</Label>
      <Input
        id={id}
        type="number"
        min="0"
        step={step}
        inputMode={step === "1" ? "numeric" : "decimal"}
        value={key === "tax" ? shownTax : form[key]}
        onChange={key === "tax"
          ? (e) => setForm((c) => ({ ...c, tax: e.target.value, taxEdited: true }))
          // Basic salary keeps to 7 whole digits and the maximum.
          : key === "basic" ? (e) => setForm((c) => ({ ...c, basic: clampSalary(e.target.value) })) : set(key)}
        disabled={disabled}
        readOnly={readOnly}
        className={cn("tabular-nums", readOnly && "bg-muted text-muted-foreground")}
      />
      {children}
    </div>
  );

  return (
    <>
      {processedBanner ? (
        <Alert className="border-success/40 bg-success/8 text-success">
          <CheckCircle2Icon aria-hidden="true" />
          <AlertDescription className="text-success"><span><strong>Payroll processed:</strong> Payslip has been generated and recorded in Payroll Records.</span></AlertDescription>
        </Alert>
      ) : null}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">Payroll entry form {entryId ? <Badge variant="secondary">Editing saved entry</Badge> : null}</CardTitle>
            <CardDescription>Single entry, or edit a saved draft.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {blocking.length ? (
              <Alert className="border-warning/40 bg-warning/10 text-warning">
                <AlertTriangleIcon aria-hidden="true" />
                <AlertDescription className="text-warning">
                  <span>Unresolved attendance: {describeBlockingDays(blocking)}. This employee cannot be processed until HR or the branch Administrator resolves {blocking.length === 1 ? "it" : "them"}.{" "}
                    <Button variant="link" className="h-auto p-0 text-warning" onClick={() => openIncompleteQueue(onNavigate)}>View in attendance →</Button></span>
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="pc-employee">Select employee</Label>
                <Select value={employeeId} onValueChange={(id) => { setEmployeeId(id); setEntryId(""); setForm(defaultForm(data, employees.find((e) => e.id === id))); }} disabled={!employees.length}>
                  <SelectTrigger id="pc-employee" className="w-full"><SelectValue placeholder={employees.length ? "Select employee" : "No employees found"} /></SelectTrigger>
                  <SelectContent>{employees.map((e) => <SelectItem key={e.id} value={e.id}>{`${e.full_name} — ${e.employee_id} (${e.employee_type})`}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pc-period">Pay period</Label>
                <Select value={period} onValueChange={setPeriod} disabled={!data?.period_options?.length}>
                  <SelectTrigger id="pc-period" className="w-full"><SelectValue placeholder="Current period" /></SelectTrigger>
                  <SelectContent>{(data?.period_options || []).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {numberField("pc-basic", "Basic salary (₱)", "basic", { disabled: false })}
            </div>

            <Separator />
            <p className="text-xs font-semibold tracking-wide text-gold-text uppercase">Deductions</p>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              {numberField("pc-sss", "SSS", "sss", { hint: contributionHint("sss", `(legal table: ${info.rates.sss_pct}% of salary credit, editable)`) })}
              {numberField("pc-philhealth", "PhilHealth", "philhealth", { hint: contributionHint("philhealth", `(legal table: ${info.rates.philhealth_pct}% of monthly salary, editable)`) })}
              {numberField("pc-pagibig", "Pag-IBIG", "pagibig", { hint: contributionHint("pagibig", `(legal table: ${info.rates.pagibig_pct}% up to the cap, editable)`) })}
              {numberField("pc-tax", "Withholding tax (₱)", "tax")}
              <p className="text-xs text-muted-foreground sm:col-span-2">Absent, Late, Undertime, Half Day and incentives are filled in from the attendance logs. Changing one is an override: it needs a reason and is logged.</p>
              {numberField("pc-absences", "Absent (days)", "absences", { hint: `${peso(unit.absent)}/day`, step: "1" })}
              {numberField("pc-late", "Late (days)", "late", { hint: lateRules, step: "1" })}
              {numberField("pc-undertime", "Undertime (minutes)", "undertime", { hint: `${peso(unit.hourly)}/hour`, step: "1" })}
              {numberField("pc-half-days", "Half day (days)", "halfDays", { hint: `${peso(unit.half_day)}/day`, step: "1" })}
              {numberField("pc-leave-with-pay-days", "Leave with pay", "lwp", {
                hint: "(days, no deduction)", step: "1", readOnly: true,
                children: leave?.with_pay_dates?.length ? <p className="text-xs text-muted-foreground">{dates(leave.with_pay_dates)} · paid, no deduction</p> : null,
              })}
              {numberField("pc-leave-without-pay-days", "Leave without pay", "lwop", {
                hint: `(days, ${peso(unit.daily)}/day)`, step: "1",
                children: leave?.without_pay_dates?.length ? <p className="text-xs text-muted-foreground">{dates(leave.without_pay_dates)} · deducted at the daily rate</p> : null,
              })}
            </div>

            <Separator />
            <p className="text-xs font-semibold tracking-wide text-gold-text uppercase">Incentives</p>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              {numberField("pc-early-bird", "Early bird (days)", "earlyBird", { hint: `${peso(unit.early_bird)}/day`, step: "1" })}
              <div className="space-y-1.5">
                <Label htmlFor="pc-perfect" className="flex-wrap gap-x-1">Perfect attendance <span className="font-normal text-muted-foreground">{peso(unit.perfect_attendance)}/period</span></Label>
                <Select value={form.perfect ? "yes" : "no"} onValueChange={(v) => setForm((c) => ({ ...c, perfect: v === "yes" }))} disabled={firstHalf}>
                  <SelectTrigger id="pc-perfect" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="no">No</SelectItem><SelectItem value="yes">Yes</SelectItem></SelectContent>
                </Select>
              </div>
            </div>

            {deviations.length ? (
              <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/8 p-3">
                <Label htmlFor="pc-override-reason">Reason for override <span className="font-normal text-muted-foreground">(required to process; logged with your name)</span></Label>
                <Textarea id="pc-override-reason" rows={2} maxLength={300} placeholder="Why the computed value was changed" value={form.overrideReason} onChange={set("overrideReason")} aria-invalid={Boolean(reasonError) || undefined} />
                {reasonError ? <p className="text-sm text-destructive">{reasonError}</p> : null}
                <p className="text-xs text-warning">Changed from computed: {deviations.join(" · ")}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="shadow-xs">
            <CardHeader><CardTitle>Computation summary</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <SummaryRow label="Basic salary" value={money(summary.basic)} />
              <SummaryRow label="Overtime (approved)" value={`+ ${money(summary.earnings.overtime)}`} tone="plus" />
              <SummaryRow label="Holiday pay" value={`+ ${money(summary.earnings.holiday)}`} tone="plus" />
              <SummaryRow label="Gross pay" value={money(summary.gross)} strong />
              <SummaryRow label="SSS" value={`- ${money(summary.sss)}`} tone="minus" />
              <SummaryRow label="PhilHealth" value={`- ${money(summary.philhealth)}`} tone="minus" />
              <SummaryRow label="Pag-IBIG" value={`- ${money(summary.pagibig)}`} tone="minus" />
              <SummaryRow label="Withholding tax" value={`- ${money(summary.tax)}`} tone="minus" />
              <SummaryRow label="Absences" value={`- ${money(summary.amounts.absent)}`} tone="minus" />
              <SummaryRow label="Late" value={`- ${money(summary.amounts.late)}`} tone="minus" />
              <SummaryRow label="Undertime" value={`- ${money(summary.amounts.undertime)}`} tone="minus" />
              <SummaryRow label="Half day" value={`- ${money(summary.amounts.half_day)}`} tone="minus" />
              <SummaryRow label="Leave with pay" value={`${summary.lwpDays} day${summary.lwpDays === 1 ? "" : "s"}`} />
              <SummaryRow label="Leave without pay" value={`- ${money(summary.lwopDeduct)}`} tone="minus" />
              <SummaryRow label="Cash advance" value={`- ${money(summary.cashAdvance)}`} tone="minus" />
              <SummaryRow label="Early bird / attendance incentive" value={`+ ${money(summary.shownIncentives)}`} tone="plus" />
              {summary.settling ? (
                <>
                  <SummaryRow label="Incentives / overload pay" value={`+ ${money(summary.extras.other)}`} tone="plus" />
                  <SummaryRow label="Monthly net" value={money(summary.monthNet)} strong />
                  <SummaryRow label={summary.extras.firstHalfStatus === "final" ? "Paid in 1st half" : "Paid in 1st half (not processed)"} value={`- ${money(summary.extras.firstHalfPaid)}`} />
                  <SummaryRow label="Balance carried over" value={`- ${money(summary.extras.carryIn)}`} tone="minus" />
                  {summary.secondHalfNet < 0 ? <SummaryRow label="Carried to next month" value={money(Math.max(0, -summary.secondHalfNet))} tone="warn" /> : null}
                </>
              ) : null}
              <div className="mt-2 flex items-baseline justify-between gap-4 rounded-lg bg-primary/8 px-3 py-3">
                <span className="font-semibold">{semiHalf(data) === "second" ? "2nd half net pay" : semiHalf(data) === "first" ? "1st half net pay" : "Net pay"}</span>
                <span className="text-xl font-semibold text-primary tabular-nums">{money(summary.net)}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-xs">
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground"><strong className="text-foreground">Ready to process.</strong> Review all computed values before processing. Once confirmed, the payslip will be generated and stored in Payroll Records.</p>
              <Button className="w-full" size="lg" onClick={() => submit("submit")} disabled={busy || Boolean(blocking.length) || !ready || !finalWindow} title={finalWindow ? "" : (win?.message || "")}>
                {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Process payroll →
              </Button>
              <Button className="w-full" variant="outline" onClick={() => submit("save_draft")} disabled={busy}>Save as draft</Button>
              {feedback.text ? <p role="status" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

export function ProcessPage({ onNavigate }) {
  const { data } = useAccountant();
  return (
    <>
      <Banners data={data} />
      <BatchCard onNavigate={onNavigate} />
      <h2 className="mt-2 text-base font-semibold">Single entry / edit draft</h2>
      <SingleEntry onNavigate={onNavigate} />
    </>
  );
}
