"use client";

import * as React from "react";
import { AlertTriangleIcon, CheckCircle2Icon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, FlagIcon, InfoIcon, Loader2Icon, LockIcon, MoreHorizontalIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
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
  earlyBirdWinnerPay,
  employeePayInfo,
  formDeviations,
  formFromDraft,
  governmentLocked,
  money,
  perCutoffFirst,
  same,
  semiHalf,
  shortDate,
  submissionPayload,
  toAmount,
  usesLegalTables,
} from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { useAccountant } from "./accountant-data";
import { RunApprovalPanel } from "./run-approval-panel";
import { DeferredIncentivesNotice } from "./incentives-page";
import { CONTRIBUTION_MAX, DAYS_MAX, PERIOD_MINUTES_MAX, PESO_MAX, REASON_MAX } from "@/lib/input-limits";
import { attendanceOverrideState } from "@/lib/payroll/override-window";
import { TestingModeBanner } from "@/components/portal/testing-mode-banner";
import { pesoText } from "@/lib/payroll/line-tags";
import { compactLineGroups, previewLineGroups } from "@/lib/portal/payroll-line-preview";
import { InfoTip } from "@/components/portal/info-tip";
import { useIsMobile } from "@/hooks/use-mobile";
import { LineTag, LineTagLegend, PayrollLineGroups } from "@/components/portal/payroll-lines";
import { SearchableSelect } from "@/components/portal/searchable-select";

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

// The most each number box takes (the route's attendanceInputError):
// days in a period, undertime minutes in a 31-day period, otherwise pesos.
const NUMBER_MAX = {
  absences: DAYS_MAX, late: DAYS_MAX, halfDays: DAYS_MAX, lwop: DAYS_MAX, lwp: DAYS_MAX, undertime: PERIOD_MINUTES_MAX,
  sss: CONTRIBUTION_MAX, philhealth: CONTRIBUTION_MAX, pagibig: CONTRIBUTION_MAX, basic: SALARY_MAX,
};

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
      {/* Super Admin testing switch OFF (window-enforcement.js). */}
      <TestingModeBanner enforcement={win?.window_enforcement} compact />
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
            {win.scheduled ? (
              <p className="text-xs">{win.banner}. Pay date {dateLabel(win.pay_date)}{win.pay_date_scheduled ? " (from the Pay Calendar)" : ""}.</p>
            ) : (
              <p className="text-xs">Window {dateLabel(win.opens_on)} – {dateLabel(win.pay_date)}{win.pay_date_scheduled ? " (pay date from the Pay Calendar)" : ""}.</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {(data?.employees || []).some((e) => e.payroll_hold) ? (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertDescription>
            <p><strong className="text-foreground">Pay on hold:</strong> {(data.employees || []).filter((e) => e.payroll_hold).map((e) => e.full_name).join(", ")}. Their payslips are not generated: an AWOL case must be closed first (HR), and a separated employee is paid through Final Pay.</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {semi ? (
        <Alert className="border-info/40 bg-info/8">
          <InfoIcon aria-hidden="true" />
          <AlertDescription>
            {semi.per_cutoff && semi.half === "first" ? (
              <p><strong className="text-foreground">1st cutoff:</strong> the semi-monthly salary (monthly salary ÷ 2) less this cutoff&apos;s attendance only — late, undertime and absences from {shortDate(semi.attendance_window?.start_key)} to {dateLabel(semi.attendance_window?.end_key)}. No withholding tax, SSS, PhilHealth, Pag-IBIG, loans or other deductions: those are on the {semi.second_half_label} payslip.</p>
            ) : semi.per_cutoff ? (
              <p><strong className="text-foreground">2nd cutoff:</strong> attendance from {shortDate(semi.attendance_window?.start_key)} to {dateLabel(semi.attendance_window?.end_key)} only, plus SSS, PhilHealth, Pag-IBIG, loans and other deductions. Withholding tax and contributions are computed on the whole of {semi.month_label}&apos;s earnings; each deduction is its own line on the payslip.</p>
            ) : semi.half === "first" ? (
              <p><strong className="text-foreground">1st half:</strong> the full semi-monthly salary (monthly salary ÷ 2) with no deductions. Absences, leave, incentives, contributions and withholding tax for {semi.month_label} are settled on the {semi.second_half_label} payslip.</p>
            ) : (
              <p><strong className="text-foreground">2nd half settles {semi.month_label}:</strong> attendance {shortDate(semi.window?.start_key)} – {dateLabel(semi.window?.end_key)}{semi.lock_day ? ` (locked on day ${semi.lock_day}; later items go to next month)` : ""}, approved leave, incentives and overload, the month&apos;s SSS / PhilHealth / Pag-IBIG and withholding tax from the monthly table. Net pay is the month&apos;s net less what the 1st half paid.</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      <EarlyBirdBanner earlyBird={data?.early_bird} />
    </>
  );
}

/** The period's one Early Bird winner (src/lib/payroll/early-bird.js). */
function EarlyBirdBanner({ earlyBird }) {
  if (!earlyBird || (!earlyBird.enabled && !earlyBird.winner)) return null;
  const winner = earlyBird.winner;
  const range = earlyBird.window ? `${shortDate(earlyBird.window.start_key)} – ${dateLabel(earlyBird.window.end_key)}` : "this period";
  return (
    <Alert className="border-success/40 bg-success/8">
      <InfoIcon aria-hidden="true" />
      <AlertDescription>
        {earlyBird.error ? (
          <p><strong className="text-foreground">Early Bird Incentive:</strong> the winner could not be worked out ({earlyBird.error}); no incentive is added until it can.</p>
        ) : winner?.employee_name ? (
          <p>
            <strong className="text-foreground">Early Bird Incentive — {winner.employee_name}:</strong>{" "}
            {winner.early_count} early time-in{winner.early_count === 1 ? "" : "s"} ({range}, at least {earlyBird.threshold_minutes} min before their own start).{" "}
            {money(winner.amount)} is added to {winner.other_branch ? "their" : "this employee's"} payslip as its own earnings line.
            {winner.finalized ? " Locked: payroll for this period is finalized." : " Recomputed until the first payslip of the period is Final."}
            {winner.tie_broken_by ? " A full tie was broken by employee ID." : ""}
          </p>
        ) : (
          <p><strong className="text-foreground">Early Bird Incentive:</strong> no eligible employee yet for {range}. Each needs at least one time-in {earlyBird.threshold_minutes} minutes or more before their own start{earlyBird.amount ? `; the winner receives ${money(earlyBird.amount)}` : ""}.</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** "₱1,234.56"; ₱0 is "—" in the batch table (cleanup 2026-11-14). */
const cellPeso = (value) => (toAmount(value) ? pesoText(value) : "—");

const BATCH_STATUS = {
  ready: { label: "Ready", tone: "info" },
  draft: { label: "Draft", tone: "gold" },
  final: { label: "Final", tone: "success" },
  blocked: { label: "Blocked", tone: "warning" },
  first_half: { label: "1st half not Final", tone: "warning" },
};

/**
 * One batch row's payslip state (was acctPayslipCell): status, what can be
 * generated or reprocessed, and why a row is blocked. Display only: the
 * server checks every one of these again.
 */
function batchRowState(data, employee, base) {
  const win = data?.generation_window;
  const slip = (data?.attendance_rows || []).find((r) => r.employee_id === employee.id)?.payslip || null;
  // The branch's payroll run (Payroll Approval): Pending / Approved locks it;
  // Draft / Rejected lets a Final payslip be reprocessed.
  const run = data?.payroll_runs?.[String(employee.branch_id || "")] || null;
  // A Final payslip follows the run it is in (a period can also have a
  // supplemental run); a new one waits only while the latest run is with HR.
  const final = slip?.status === "final";
  const ownStatus = final ? (slip.run_status || (run?.status === "approved" ? null : run?.status)) : run?.status;
  const runLocked = final ? ownStatus === "pending" || ownStatus === "approved" : run?.status === "pending";
  const canReprocess = final && !runLocked && (win?.state === "final" || (win?.state === "closed" && run?.status === "rejected"));
  // After the window closes: still generated (marked late for HR) while the run is open.
  const canGenerate = Boolean(win?.can_generate) || win?.state === "closed";
  const finalNext = win?.state === "final";
  const firstHalfBlock = base.info.row?.defaults?.first_half_block || null;
  const reasons = [];
  let status;
  if (final) status = "final";
  else if (base.blocking.length) { status = "blocked"; reasons.push(...base.blocking.map((b) => ({ kind: "attendance", text: `${b.status} record, ${shortDate(b.log_date)}` }))); }
  else if (firstHalfBlock) { status = "first_half"; reasons.push({ kind: "first_half", text: firstHalfBlock }); }
  else if (employee.payroll_hold) { status = "blocked"; reasons.push({ kind: "hold", text: "Pay on hold: an AWOL case must be closed first (HR), and a separated employee is paid through Final Pay." }); }
  else if (runLocked) { status = "blocked"; reasons.push({ kind: "run", text: "Run waiting for HR approval: locked" }); }
  else status = slip?.status === "draft" ? "draft" : "ready";
  const sub = final
    ? `${slip.payslip_no || ""} · ${runLocked ? (ownStatus === "pending" ? "waiting for HR" : "approved, locked") : "processed"}`
    : status === "draft" ? `Up to ${dateLabel(slip.attendance_through)}`
      : status === "ready" && !canGenerate && win?.state === "not_open" ? `Opens ${dateLabel(win.opens_on)}`
        : status === "ready" && win?.state === "closed" ? "Window closed: marked late for HR" : "";
  const generateTitle = canGenerate
    ? (finalNext ? "Creates the Final payslip (locked once saved)" : `Draft with attendance up to ${dateLabel(win.attendance_through)}`)
    : (win?.message || "");
  return { status, slip, reasons, sub, canReprocess, canGenerate, finalNext, generateTitle, processable: status === "ready" || status === "draft" };
}

/** The status pill; a blocked row's pill opens the reason (tap / Enter). */
function BatchStatus({ row, onResolve }) {
  const meta = BATCH_STATUS[row.state.status];
  const pill = <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>;
  // A Final payslip made with unresolved days ("Generate anyway") keeps its warning.
  const warn = row.state.status === "final" && row.base.blocking.length;
  return (
    <div className="space-y-0.5" data-testid="batch-status" data-status={row.state.status}>
      <div className="flex items-center gap-1">
        {row.state.reasons.length || warn ? (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex cursor-pointer items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={`${meta.label}: why`}>
                {pill}{warn ? <AlertTriangleIcon className="size-3.5 text-warning" aria-hidden="true" /> : null}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 space-y-1.5 text-xs" data-testid="batch-blocked-reason">
              {(warn ? row.base.blocking.map((b) => ({ kind: "attendance", text: `${b.status} record, ${shortDate(b.log_date)} (not counted on this payslip)` })) : row.state.reasons).map((r, i) => <p key={i}>{r.text}</p>)}
              {row.base.blocking.length ? (
                <Button variant="link" className="h-auto p-0 text-xs" onClick={onResolve}>Open in Attendance →</Button>
              ) : null}
            </PopoverContent>
          </Popover>
        ) : pill}
      </div>
      {row.state.sub ? <p className="text-[11px] whitespace-nowrap text-muted-foreground">{row.state.sub}</p> : null}
    </div>
  );
}

/** View / Generate / Resolve, and a ⋯ menu with Reprocess, Edit, Generate anyway. */
function BatchActions({ row, busy, onGenerate, onView, onEdit, onResolve }) {
  const { state, employee } = row;
  const generateLabel = state.finalNext && state.canGenerate ? "Generate final" : state.status === "draft" ? "Regenerate" : "Generate";
  const attendanceBlocked = state.reasons.some((r) => r.kind === "attendance");
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {state.processable ? (
        <Button size="sm" className="h-7" variant={state.finalNext && state.canGenerate ? "default" : "outline"} title={state.generateTitle} disabled={!state.canGenerate || busy} onClick={() => onGenerate(employee.id)}>
          {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{generateLabel}
        </Button>
      ) : null}
      {state.slip?.entry_id && (state.status === "final" || state.status === "draft") ? (
        <Button variant="outline" size="sm" className="h-7" onClick={() => onView(state.slip.entry_id)}>View</Button>
      ) : null}
      {attendanceBlocked ? <Button variant="link" size="sm" className="h-7 px-1 text-warning" onClick={onResolve}>Resolve</Button> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label={`More actions for ${employee.full_name}`} disabled={busy}>
            {busy && !state.processable ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <MoreHorizontalIcon aria-hidden="true" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {state.canReprocess ? (
            <DropdownMenuItem onSelect={() => onGenerate(employee.id, false, true)} title="Recompute this Final payslip from the latest records (the run is not yet submitted, or HR sent it back)">Reprocess</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => onEdit(employee.id)}>Edit in the form</DropdownMenuItem>
          {attendanceBlocked && state.canGenerate ? (
            <DropdownMenuItem onSelect={() => onGenerate(employee.id)}>Generate without the unresolved days…</DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The expanded breakdown: every attendance item, incentive and adjustment with its amount. */
function BatchBreakdown({ row }) {
  const { base } = row;
  const c = base.counts;
  const a = base.amounts;
  const unit = base.info.unit || {};
  const incentiveLabel = [
    earlyBirdWinnerPay(base.info) ? "Early Bird Incentive" : "",
    base.info.pay?.perfect_attendance && base.half !== "first" ? "Perfect" : "",
    base.extras.other ? `Incentive/overload${base.extras.overloadHours ? ` (${base.extras.overloadHours} h)` : ""}` : "",
  ].filter(Boolean).join(" · ");
  const items = [
    ["Absent", c.absent_days ? `${c.absent_days} day${c.absent_days === 1 ? "" : "s"}` : "—", -toAmount(a.absent)],
    ["Late", c.late_days ? `${c.late_days} day${c.late_days === 1 ? "" : "s"}${c.late_minutes ? `, ${c.late_minutes} min` : ""}` : "—", -toAmount(a.late)],
    ["Undertime", c.undertime_minutes ? `${c.undertime_minutes} min` : "—", -toAmount(a.undertime)],
    ["Half day", c.half_days ? `${c.half_days} day${c.half_days === 1 ? "" : "s"}` : "—", -toAmount(a.half_day)],
    ["Leave with pay", base.lwp ? `${base.lwp} day${base.lwp === 1 ? "" : "s"} · no deduction` : "—", 0],
    ["Leave without pay", base.lwop ? `${base.lwop} day${base.lwop === 1 ? "" : "s"}` : "—", -toAmount(base.lwop * (unit.daily || 0))],
    ["Incentives", incentiveLabel || "—", toAmount(base.incentives + base.extras.other)],
    ...(base.earnings ? [["Overtime / holiday", "approved", base.earnings]] : []),
    ...(row.firstHalf ? [] : [
      ["SSS", "", -toAmount(row.values.sss)],
      ["PhilHealth", "", -toAmount(row.values.philhealth)],
      ["Pag-IBIG", "", -toAmount(row.values.pagibig)],
      ["Withholding tax", "", -toAmount(row.values.tax)],
    ]),
    ...(base.half === "second" ? [["Paid in 1st half", "", -toAmount(base.extras.firstHalfPaid)]] : []),
    ...(base.extras.carryIn ? [["Carried from last month", "", -base.extras.carryIn]] : []),
    ...(base.cashAdvance ? [["Loans / cash advance", "", -base.cashAdvance]] : []),
    ...(base.yearEndTax ? [[base.yearEndTax > 0 ? "Year-end tax adjustment" : "Year-end tax refund", "", -base.yearEndTax]] : []),
  ];
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 gap-y-1 text-xs sm:max-w-xl" data-testid="batch-breakdown">
      {items.map(([label, qty, amount]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right text-muted-foreground tabular-nums">{qty}</dd>
          <dd className={cn("text-right tabular-nums", amount < 0 && "text-destructive/80", amount > 0 && "text-success")}>{amount ? `${amount < 0 ? "−" : "+"}${pesoText(Math.abs(amount))}` : "—"}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** "9 absent · 1 late": the non-zero attendance items, short. */
function attendanceSummary(base) {
  const c = base.counts;
  return [
    c.absent_days ? `${c.absent_days} absent` : "",
    c.late_days ? `${c.late_days} late` : "",
    c.undertime_minutes ? `${c.undertime_minutes} min undertime` : "",
    c.half_days ? `${c.half_days} half day` : "",
    base.lwop ? `${base.lwop} LWOP` : "",
  ].filter(Boolean).join(" · ");
}

function BatchCard({ onNavigate, onEdit }) {
  const { data, loading, period, setPeriod, load, openPayslip } = useAccountant();
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const isMobile = useIsMobile();
  // The employee table in pages (alpha test B4; 10 rows by default, cleanup
  // 2026-11-14). Process still covers every page.
  const [tablePage, setTablePage] = React.useState(1);
  const [tableSize, setTableSize] = React.useState(10);
  const [filter, setFilter] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [selected, setSelected] = React.useState(() => new Set());
  const [expanded, setExpanded] = React.useState(() => new Set());
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);
  const [generating, setGenerating] = React.useState("");

  // New data: the selection starts again.
  React.useEffect(() => { setSelected(new Set()); }, [data]);
  // A new period or filter starts on page 1 (the page size stays).
  React.useEffect(() => { setTablePage(1); }, [period, filter, query, typeFilter]);

  const employees = data?.employees || [];
  const ready = data?.payroll_ready !== false;
  const win = data?.generation_window || null;
  const firstHalf = semiHalf(data) === "first";
  const secondHalf = semiHalf(data) === "second";
  // Closed: the Accountant still processes what is missing (marked late)
  // while the run is not submitted; a submitted run stays locked.
  const finalWindow = !win || win.state === "final" || win.state === "closed";
  // Every visible branch's run is Pending / Approved: nothing left to process.
  const branchIds = [...new Set(employees.map((e) => String(e.branch_id || "")))];
  // Approved: locked once everyone has a Final payslip (anyone left out is
  // processed into a supplemental run).
  const finalFor = (id) => (data?.attendance_rows || []).find((r) => r.employee_id === id)?.payslip?.status === "final";
  const allRunsLocked = branchIds.length > 0 && branchIds.every((id) => {
    const status = data?.payroll_runs?.[id]?.status;
    return status === "pending" || (status === "approved" && employees.filter((e) => String(e.branch_id || "") === id).every((e) => finalFor(e.id)));
  });

  // Read-only rows (cleanup 2026-11-14): every value is the computed default;
  // a change goes through the single-entry form, where the reason is asked.
  const rows = employees.map((employee) => {
    const base = batchRowBase(data, employee);
    const locked = governmentLocked(base.info);
    const { sss, philhealth, pagibig } = base.contributions;
    const tax = batchTaxDefault(data, base, { sss, philhealth, pagibig, lwop: base.lwop });
    const net = batchRowNet({
      basic_salary: base.basic, sss, philhealth, pagibig, tax,
      leave_without_pay_days: base.lwop, daily_rate: base.info.unit.daily, attendance_deductions: base.attendanceDeductions,
      incentives: base.incentives, earnings: base.earnings, other_incentives: base.extras.other + (base.extras.subsidy || 0),
      first_half_paid: base.extras.firstHalfPaid, carry_in: base.extras.carryIn, cash_advance: base.cashAdvance,
      prior_attendance: base.extras.priorAttendance || 0, prior_earnings: base.extras.priorEarnings || 0,
      year_end_tax: base.yearEndTax,
    });
    const attendance = toAmount(base.attendanceDeductions + base.lwop * base.info.unit.daily);
    // This payslip's own gross in a 2nd half (as HR and the employee see it).
    const gross = secondHalf ? toAmount(base.info.row?.defaults?.cutoff_gross ?? (base.basic + base.earnings + base.incentives + base.extras.other)) : base.basic;
    return {
      employee, base, locked, net, attendance, gross, firstHalf,
      values: { sss, philhealth, pagibig, tax, lwop: base.lwop },
      contributions: toAmount(sss + philhealth + pagibig),
      state: batchRowState(data, employee, base),
    };
  });

  const counts = { all: rows.length, ready: 0, draft: 0, final: 0, blocked: 0 };
  rows.forEach((r) => { counts[r.state.status === "first_half" ? "blocked" : r.state.status] += 1; });
  const totalNet = toAmount(rows.reduce((sum, r) => sum + r.net, 0));
  const types = [...new Set(employees.map((e) => e.employee_type).filter(Boolean))];
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => (filter === "all" || r.state.status === filter || (filter === "blocked" && r.state.status === "first_half"))
    && (typeFilter === "all" || r.employee.employee_type === typeFilter)
    && (!q || `${r.employee.full_name} ${r.employee.employee_id || ""}`.toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(shown.length / tableSize));
  const at = Math.min(tablePage, pages);
  const pageRows = shown.slice((at - 1) * tableSize, at * tableSize);
  const processable = rows.filter((r) => r.state.processable);
  const selectedRows = processable.filter((r) => selected.has(r.employee.id));
  const blockedBy = (kind) => rows.filter((r) => r.state.status !== "final" && r.state.reasons.some((x) => x.kind === kind)).length;
  const attendanceBlocked = blockedBy("attendance");
  const otherBlocked = [
    [blockedBy("first_half"), "waiting for a Final 1st half"],
    [blockedBy("hold"), "on pay hold"],
    [blockedBy("run"), "in a run with HR"],
  ].filter(([n]) => n).map(([n, why]) => `${n} ${why}`).join(", ");
  const canProcess = ready && finalWindow && !allRunsLocked;
  const processTitle = allRunsLocked ? "This period's payroll run is with HR or approved: it cannot be processed again." : finalWindow ? "" : (win?.message || "");

  const resolve = () => openIncompleteQueue(onNavigate);
  const toggle = (set, id) => set((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const pageProcessable = pageRows.filter((r) => r.state.processable);
  const pageAllSelected = pageProcessable.length > 0 && pageProcessable.every((r) => selected.has(r.employee.id));

  async function processRows(onlySelected) {
    if (!period) { setFeedback({ text: "Select a pay period first.", ok: false }); return; }
    if (!ready) { setFeedback({ text: data?.payroll_not_ready_message || "", ok: false }); return; }
    const eligible = onlySelected ? selectedRows : processable;
    if (!eligible.length) {
      setFeedback({ text: counts.blocked ? "Every employee left is blocked for this period." : "No employees to process.", ok: false });
      return;
    }
    const sum = toAmount(eligible.reduce((s, r) => s + r.net, 0));
    const ok = await confirm({
      title: `Process ${eligible.length} payslip${eligible.length === 1 ? "" : "s"}?`,
      description: onlySelected
        ? `Only the ${eligible.length} selected employee${eligible.length === 1 ? "" : "s"}. Total net pay ${pesoText(sum)}.`
        : `${counts.blocked ? `${counts.blocked} blocked will be skipped, ` : ""}${counts.final ? `${counts.final} already Final are unchanged. ` : ""}Total net pay ${pesoText(sum)}. This covers every page of the table, not only the one shown.`,
      confirmLabel: "Process payroll",
    });
    if (!ok) return;
    const entries = eligible.map((r) => ({
      employee_id: r.employee.id,
      deductions: {
        // Computed on the server when locked: not sent (a different value is refused).
        ...(r.locked ? {} : {
          sss: toAmount(r.values.sss),
          philhealth: toAmount(r.values.philhealth),
          pagibig: toAmount(r.values.pagibig),
          withholding_tax: toAmount(r.values.tax),
        }),
        // Absent / Late / Undertime / Half Day / incentives are computed on the server.
        leave_with_pay_days: r.base.lwp,
        leave_without_pay_days: toAmount(r.values.lwop),
      },
    }));
    setBusy(true);
    setFeedback({ text: "Processing payroll…", ok: true });
    try {
      const response = await apiFetch("/api/accountant/payroll", jsonBody("POST", { action: "batch_submit", pay_period: period, entries, override_reason: "" }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Failed to process batch payroll.");
      const processed = result.processed || [];
      const skipped = result.skipped || [];
      let message = `Processed ${processed.length} payslip${processed.length === 1 ? "" : "s"}.`;
      if (skipped.length) message += ` ${skipped.length} skipped — ${skipped.map((s) => `${s.employee_name || s.employee_id || "Unknown"}: ${s.reason || "skipped"}`).join(" · ")}`;
      setFeedback({ text: message, ok: true });
      // One summary toast per action (alpha test B4): green when all went
      // through, amber when some were skipped (the names are in the note
      // under the button), never one toast per employee.
      notify(
        processed.length ? `Payroll processed for ${processed.length} employee${processed.length === 1 ? "" : "s"}` : "No payslips processed",
        skipped.length ? `${skipped.length} skipped. See the note under Process payroll for who and why.` : null,
        skipped.length ? "warning" : "success",
      );
      await load({ period });
      if (processed.length) openPayslip(processed[0].entry_id);
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
      notify("Payroll not processed", error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function generate(employeeId, confirmIncomplete = false, reprocess = false) {
    const employee = employees.find((e) => e.id === employeeId);
    if (reprocess) {
      const ok = await confirm({
        title: `Reprocess ${employee?.full_name || "this"} payslip?`,
        description: "The Final payslip is recomputed from the latest attendance, leave and settings and replaces the current one (the old record is kept, archived). Submit the run for HR approval again afterwards.",
        confirmLabel: "Reprocess",
      });
      if (!ok) return;
    }
    setGenerating(employeeId);
    setFeedback({ text: `Generating ${employee?.full_name || "the"} payslip…`, ok: true });
    try {
      const response = await apiFetch("/api/accountant/payroll", jsonBody("PATCH", {
        action: "generate",
        employee_id: employeeId,
        pay_period: data?.active_period?.label || "",
        confirm_incomplete: confirmIncomplete,
        reprocess,
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
        if (proceed) await generate(employeeId, true, reprocess);
        return;
      }
      if (!response.ok) throw new Error(result.error || "Unable to generate the payslip.");
      const final = result.status === "final";
      setFeedback({
        text: final
          ? `Final payslip ${result.entry?.payslip_no || ""} ${reprocess ? "reprocessed" : "generated"} for ${employee?.full_name || "the employee"}. Submit the branch's run for HR approval when every employee is done.`
          : `Draft payslip generated for ${employee?.full_name || "the employee"} (attendance up to ${dateLabel(result.window?.attendance_through)}).`,
        ok: true,
      });
      notify(final ? "Final Payslip Generated" : "Draft Payslip Generated", final ? "It locks when the run is submitted for HR approval." : "You can regenerate it until the period ends.", "success");
      await load({ period: data?.active_period?.label });
      if (result.entry?.id) openPayslip(result.entry.id);
    } catch (error) {
      setFeedback({ text: error.message, ok: false });
    } finally {
      setGenerating("");
    }
  }

  const actions = (row) => <BatchActions row={row} busy={generating === row.employee.id} onGenerate={generate} onView={openPayslip} onEdit={onEdit} onResolve={resolve} />;
  const select = (row) => (row.state.processable ? (
    <Checkbox checked={selected.has(row.employee.id)} onCheckedChange={() => toggle(setSelected, row.employee.id)} aria-label={`Select ${row.employee.full_name}`} />
  ) : null);
  const who = (row) => (
    <div className="min-w-0">
      <p className="truncate font-medium">{row.employee.full_name}</p>
      <p className="truncate text-[11px] text-muted-foreground">{[row.employee.employee_id, row.employee.employee_type].filter(Boolean).join(" · ")}</p>
    </div>
  );
  const attendanceCell = (row) => (
    <div className="text-right">
      <p className={cn("tabular-nums", row.attendance ? "text-destructive/80" : "text-muted-foreground")}>{row.attendance ? `−${pesoText(row.attendance)}` : "—"}</p>
      {attendanceSummary(row.base) ? <p className="text-[11px] text-muted-foreground">{attendanceSummary(row.base)}</p> : null}
    </div>
  );
  const expandButton = (row) => (
    <Button variant="ghost" size="icon" className="size-7" aria-expanded={expanded.has(row.employee.id)} aria-label={`${expanded.has(row.employee.id) ? "Hide" : "Show"} breakdown for ${row.employee.full_name}`}
      onClick={() => toggle(setExpanded, row.employee.id)}>
      <ChevronDownIcon className={cn("transition-transform", expanded.has(row.employee.id) && "rotate-180")} aria-hidden="true" />
    </Button>
  );
  // A row click expands it, except on its own buttons, links and checkbox.
  const rowClick = (row) => (event) => { if (!event.target.closest("button, a, input, [role=checkbox], [role=menuitem]")) toggle(setExpanded, row.employee.id); };
  const headers = [
    "", "Employee", secondHalf ? "Gross (this payslip)" : firstHalf ? "Basic pay" : "Gross", "Attendance deductions",
    ...(firstHalf ? [] : ["Contributions", "Tax"]), "Net pay", "Status", "",
  ];
  const statFilter = (key, label, value) => (
    <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(filter === key && key !== "all" ? "all" : key)} data-testid={`batch-count-${key}`}
      className={cn("flex min-w-0 cursor-pointer flex-col items-start rounded-md border px-3 py-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50", filter === key && "border-primary bg-primary/8")}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </button>
  );

  return (
    <Card className="min-w-0 shadow-xs" data-testid="batch-card">
      <CardHeader>
        <CardTitle>Batch process payroll</CardTitle>
        <CardDescription className="flex items-center gap-1">
          Values come from attendance logs and approved leave.
          <InfoTip label="About batch processing">Absent, Late, Undertime, Half day and incentives come from the attendance logs and the rates in force on the period&apos;s first day; they cannot be typed in here. To change a value, choose Edit in the form from a row&apos;s ⋯ menu: the form asks for a reason and logs it.</InfoTip>
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          <Select value={period} onValueChange={setPeriod} disabled={!data?.period_options?.length}>
            <SelectTrigger size="sm" className="w-44" aria-label="Pay period"><SelectValue placeholder="Current period" /></SelectTrigger>
            <SelectContent>{(data?.period_options || []).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => load({ period })} disabled={loading}><RefreshCwIcon className={cn(loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Whole period, every page (cleanup 2026-11-14); each count filters the table. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="batch-summary">
          {statFilter("all", "Employees", counts.all)}
          {statFilter("ready", "Ready", counts.ready)}
          {counts.draft ? statFilter("draft", "Draft", counts.draft) : null}
          {statFilter("final", "Final", counts.final)}
          {statFilter("blocked", "Blocked", counts.blocked)}
          <div className="col-span-2 flex flex-col items-start rounded-md border border-dashed px-3 py-1.5 sm:col-span-1">
            <span className="text-[11px] text-muted-foreground">Total net pay</span>
            <span className="font-semibold tabular-nums" data-testid="batch-total-net">{pesoText(totalNet)}</span>
          </div>
        </div>

        {counts.blocked ? (
          <Alert className="border-warning/40 bg-warning/10" data-testid="batch-blocked-banner">
            <AlertTriangleIcon className="text-warning" aria-hidden="true" />
            <AlertDescription className="text-warning">
              <p>
                {attendanceBlocked ? <>{attendanceBlocked} employee{attendanceBlocked === 1 ? " is" : "s are"} blocked: unresolved attendance (HR or the branch Administrator resolves it).{" "}
                  <Button variant="link" className="h-auto p-0 text-warning" onClick={resolve}>Resolve in Attendance →</Button>{" "}</> : null}
                {otherBlocked ? `${attendanceBlocked ? "Also blocked" : "Blocked"}: ${otherBlocked}. Tap a row's pill for why.` : null}
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative sm:max-w-xs sm:flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or ID" aria-label="Search employees" className="h-8 pl-8" />
          </div>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger size="sm" className="w-full sm:w-36" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {["ready", "draft", "final", "blocked"].map((k) => <SelectItem key={k} value={k}>{BATCH_STATUS[k].label}</SelectItem>)}
            </SelectContent>
          </Select>
          {types.length > 1 ? (
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Employee type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {types.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
        </div>

        {isMobile ? (
          // Phone: one card per employee; tap to expand the breakdown.
          <ul className="space-y-2" data-testid="batch-cards">
            {!data && loading ? Array.from({ length: 3 }, (_, i) => <li key={i}><Skeleton className="h-20 w-full" /></li>)
              : !pageRows.length ? <li><EmptyState title="No employees found" /></li>
                : pageRows.map((row) => (
                  <li key={row.employee.id} className="space-y-2 rounded-lg border p-3" data-testid="batch-row">
                    <div className="flex items-start gap-2">
                      <div className="pt-0.5">{select(row)}</div>
                      <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => toggle(setExpanded, row.employee.id)} aria-expanded={expanded.has(row.employee.id)}>
                        {who(row)}
                      </button>
                      <div className="text-right">
                        <p className="font-semibold tabular-nums">{cellPeso(row.net)}</p>
                        {row.attendance ? <p className="text-[11px] text-destructive/80 tabular-nums">−{pesoText(row.attendance)}</p> : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <BatchStatus row={row} onResolve={resolve} />
                      {actions(row)}
                    </div>
                    {expanded.has(row.employee.id) ? (
                      <div className="space-y-2 border-t pt-2">
                        <p className="flex justify-between text-xs"><span className="text-muted-foreground">{headers[2]}</span><span className="tabular-nums">{cellPeso(row.gross)}</span></p>
                        <BatchBreakdown row={row} />
                      </div>
                    ) : null}
                  </li>
                ))}
          </ul>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/60">
                <TableRow className="hover:bg-transparent">
                  {headers.map((h, i) => (
                    <TableHead key={i} className={cn("text-xs font-semibold text-muted-foreground", i >= 2 && i < headers.length - 2 && "text-right")}>
                      {i === 0 ? (
                        <Checkbox checked={pageAllSelected} disabled={!pageProcessable.length} aria-label="Select every ready employee on this page"
                          onCheckedChange={(v) => setSelected((current) => { const next = new Set(current); pageProcessable.forEach((r) => (v ? next.add(r.employee.id) : next.delete(r.employee.id))); return next; })} />
                      ) : h || <span className="sr-only">Actions</span>}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {!data && loading ? Array.from({ length: 4 }, (_, i) => (
                  <TableRow key={i}>{headers.map((_h, c) => <TableCell key={c}><Skeleton className="h-4 w-16" /></TableCell>)}</TableRow>
                )) : !pageRows.length ? (
                  <TableRow className="hover:bg-transparent"><TableCell colSpan={headers.length} className="p-0"><EmptyState title="No employees found" /></TableCell></TableRow>
                ) : pageRows.flatMap((row) => {
                  const open = expanded.has(row.employee.id);
                  return [
                    <TableRow key={row.employee.id} data-testid="batch-row" className="cursor-pointer" onClick={rowClick(row)}>
                      <TableCell className="w-8">{select(row)}</TableCell>
                      <TableCell className="max-w-56">{who(row)}</TableCell>
                      <TableCell className="text-right tabular-nums">{cellPeso(row.gross)}</TableCell>
                      <TableCell><div className="flex items-start justify-end gap-1">{attendanceCell(row)}{expandButton(row)}</div></TableCell>
                      {firstHalf ? null : <>
                        <TableCell className={cn("text-right tabular-nums", row.contributions && "text-destructive/80")}>{row.contributions ? `−${pesoText(row.contributions)}` : "—"}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", row.values.tax && "text-destructive/80")}>{row.values.tax ? `−${pesoText(row.values.tax)}` : "—"}</TableCell>
                      </>}
                      <TableCell className="text-right font-semibold tabular-nums">{cellPeso(row.net)}</TableCell>
                      <TableCell><BatchStatus row={row} onResolve={resolve} /></TableCell>
                      <TableCell>{actions(row)}</TableCell>
                    </TableRow>,
                    ...(open ? [
                      <TableRow key={`${row.employee.id}-breakdown`} className="bg-muted/30 hover:bg-muted/30">
                        <TableCell />
                        <TableCell colSpan={headers.length - 1} className="whitespace-normal"><BatchBreakdown row={row} /></TableCell>
                      </TableRow>,
                    ] : []),
                  ];
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {rows.length ? (
          <div className="flex flex-col-reverse gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between" data-testid="process-pager">
            <p aria-live="polite">{shown.length ? `Showing ${(at - 1) * tableSize + 1}–${Math.min(at * tableSize, shown.length)} of ${shown.length}` : "Showing 0 of 0"}</p>
            <div className="flex items-center gap-2">
              <Select value={String(tableSize)} onValueChange={(v) => { setTableSize(Number(v)); setTablePage(1); }}>
                <SelectTrigger size="sm" className="w-18" aria-label="Rows per page"><SelectValue /></SelectTrigger>
                <SelectContent>{[10, 25, 50].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
              </Select>
              <span className="tabular-nums">Page {at} of {pages}</span>
              <Button variant="outline" size="icon" className="size-8" onClick={() => setTablePage(at - 1)} disabled={at <= 1} aria-label="Previous page"><ChevronLeftIcon /></Button>
              <Button variant="outline" size="icon" className="size-8" onClick={() => setTablePage(at + 1)} disabled={at >= pages} aria-label="Next page"><ChevronRightIcon /></Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          {selectedRows.length ? (
            <Button variant="outline" size="lg" className="w-full sm:w-auto" onClick={() => processRows(true)} disabled={busy || !canProcess} title={processTitle} data-testid="process-selected">
              Process selected ({selectedRows.length})
            </Button>
          ) : null}
          <Button size="lg" className="w-full sm:w-auto" onClick={() => processRows(false)} disabled={busy || !canProcess || !processable.length} title={processTitle} data-testid="process-all">
            {busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Processing…</> : `Process all ready (${processable.length})`}
          </Button>
        </div>
        {feedback.text ? <p role="status" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
      </CardContent>
      {confirmDialog}
    </Card>
  );
}


/*
 * Flag for review: the Accountant questions a computed government deduction
 * without changing it. HR and the Super Admin are notified; the flag is in the
 * audit log (POST /api/accountant/payroll, action "flag_deduction").
 */
function FlagDeductionDialog({ flag, employee, period, onClose }) {
  const { notify } = usePortalSession();
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (flag) { setNote(""); setError(""); } }, [flag]);

  async function send(event) {
    event.preventDefault();
    if (note.trim().length < 10) { setError("Say what looks wrong (at least 10 characters)."); return; }
    setBusy(true);
    try {
      const response = await apiFetch("/api/accountant/payroll", jsonBody("POST", {
        action: "flag_deduction", employee_id: employee?.id, pay_period: period, field: flag.field, amount: flag.amount, note: note.trim(),
      }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The flag was not sent.");
      notify("Flagged for Review", "HR and the Super Admin were notified. The computed figure stays as it is.", "success");
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(flag)} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {flag ? (
          <form onSubmit={send} className="contents">
            <DialogHeader>
              <DialogTitle>Flag {flag.name} for review</DialogTitle>
              <DialogDescription>{employee?.full_name} · {period} · computed {money(flag.amount)}. The figure is not changed: HR and the Super Admin are asked to check it.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="pc-flag-note">What looks wrong</Label>
              <Textarea id="pc-flag-note" rows={3} maxLength={500} value={note} onChange={(e) => { setNote(e.target.value); setError(""); }} autoFocus aria-invalid={Boolean(error) || undefined} />
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            </div>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <FlagIcon aria-hidden="true" />}Send for review</Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
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

function SingleEntry({ onNavigate, editRequest }) {
  const { data, period, setPeriod, entryId, setEntryId, load, openPayslip } = useAccountant();
  const { notify } = usePortalSession();
  const employees = data?.employees || [];
  const [employeeId, setEmployeeId] = React.useState("");
  const [form, setForm] = React.useState(() => defaultForm(null, null));
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [reasonError, setReasonError] = React.useState("");
  const [processedBanner, setProcessedBanner] = React.useState(false);
  const [flag, setFlag] = React.useState(null); // { field, name, amount }: Flag for review

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

  // "Edit in the form" from a batch row: that employee's computed values, then scroll here.
  React.useEffect(() => {
    if (!editRequest) return;
    setEmployeeId(editRequest.id);
    setEntryId("");
    setForm(defaultForm(data, employees.find((e) => e.id === editRequest.id)));
    document.getElementById("pc-entry")?.scrollIntoView({ behavior: "smooth", block: "start" });
    // Only a new request re-fills the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest]);

  const employee = employees.find((e) => e.id === employeeId) || null;
  const win = data?.generation_window || null;
  // Attendance overrides (Absent, Late, Undertime, Half day, Perfect
  // attendance): only inside the processing window on a payroll still open,
  // or a run HR rejected (src/lib/payroll/override-window.js; the API checks
  // the same). Locked: the computed values are shown and used.
  const branchRun = data?.payroll_runs?.[String(employee?.branch_id || "")] || null;
  const slip = (data?.attendance_rows || []).find((r) => r.employee_id === employee?.id)?.payslip || null;
  const slipFinal = slip?.status === "final";
  const latestRunStatus = branchRun?.status === "approved" ? null : branchRun?.status || null;
  const overrideRunStatus = slipFinal ? slip.run_status || latestRunStatus : latestRunStatus;
  const overrideGate = attendanceOverrideState({ window: win, runStatus: overrideRunStatus, payslipStatus: slipFinal ? "final" : null });
  const overrideLocked = Boolean(employee) && !overrideGate.allowed;
  const computedForm = defaultForm(data, employee);
  const shownForm = overrideLocked
    ? { ...form, absences: computedForm.absences, late: computedForm.late, undertime: computedForm.undertime, halfDays: computedForm.halfDays, lwop: computedForm.lwop, perfect: computedForm.perfect }
    : form;
  // A saved draft's override values are not used while overrides are locked.
  const droppedOverrides = overrideLocked
    && (["absences", "late", "undertime", "halfDays", "lwop"].some((key) => !same(form[key], computedForm[key])) || form.perfect !== computedForm.perfect);
  const summary = computeSummary(data, employee, shownForm);
  const deviations = formDeviations(data, employee, shownForm, summary.taxDefault);
  // Every line grouped and tagged from the same figures (2026-11-03).
  const lineGroups = previewLineGroups(data, employee, shownForm, summary, computedForm);
  const groupOf = (key) => lineGroups?.groups.find((g) => g.key === key) || null;
  const lineOf = (group, key) => groupOf(group)?.lines.find((l) => l.key === key) || null;
  const info = employeePayInfo(data, employee?.id);
  const blocking = info.pay?.blocking || [];
  const ready = data?.payroll_ready !== false;
  // Closed: the Accountant still processes what is missing (marked late)
  // while the run is not submitted; a submitted run stays locked.
  const finalWindow = !win || win.state === "final" || win.state === "closed";
  const firstHalf = semiHalf(data) === "first";
  // Per-cutoff 1st half: its own attendance is editable; contributions and
  // tax are not (they are all on the 2nd half).
  const attendanceLocked = firstHalf && !perCutoffFirst(data);
  const winnerPay = earlyBirdWinnerPay(info);
  const leave = (data?.leave_summary || []).find((row) => row.employee_id === employee?.id);
  const peso = (v) => money(v).replace("₱ ", "₱");
  const unit = info.unit;
  const legal = usesLegalTables(info);
  const source = info.row?.defaults?.contribution_source || null;
  const sourceWords = { fixed: "fixed monthly amount", employee: "set for this employee" };
  const contributionHint = (type, pctLabel) => (legal
    ? (source && sourceWords[source[type]] ? `(${sourceWords[source[type]]}, editable)` : pctLabel)
    : `(default ${info.rates[`${type}_pct`]}% of Basic, editable)`);
  // Computed government deductions (2026-10-26): read-only. Labels are the
  // name only (cleanup 2026-11-14); each formula is in the Computation summary.
  const locked = governmentLocked(info);
  const computedField = (id, label, field, name, amount, tagged = null) => (
    <div className="space-y-1.5">
      <p id={id} className="flex min-h-5 flex-wrap items-center gap-1.5 text-sm leading-none font-medium">{label}{tagged ? <LineTag tag={tagged.tag} /> : null}</p>
      <div aria-labelledby={id} className="flex min-h-9 items-center justify-between gap-2 rounded-md border bg-muted px-3 py-1.5 text-sm tabular-nums">
        <span>{money(amount)}</span>
        {employee ? (
          <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => setFlag({ field, name, amount })} aria-label={`Flag ${name} for review`}>
            <FlagIcon className="size-3.5" aria-hidden="true" />Flag for review
          </Button>
        ) : null}
      </div>
    </div>
  );
  const unitDays = (n, rate) => `${toAmount(n)} day${toAmount(n) === 1 ? "" : "s"} × ${peso(rate)}/day`;
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
      const payload = submissionPayload(action, { entryId, employee, period, form: shownForm, tax: summary.tax, data });
      // HR rejected the run: its Final payslip is reprocessed, with any
      // attendance override (reopened for that run only).
      const reopenedFinal = action === "submit" && slipFinal && overrideGate.reopened;
      const response = reopenedFinal
        ? await apiFetch("/api/accountant/payroll", jsonBody("PATCH", {
          action: "generate", reprocess: true, employee_id: employee.id, pay_period: period,
          deductions: payload.deductions, incentives: payload.incentives, override_reason: payload.override_reason,
        }))
        : await apiFetch("/api/accountant/payroll", jsonBody("POST", payload));
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
      // One toast per save (alpha test B4): the sync warning and the
      // reprocessed note join the main message instead of stacking.
      const extra = [
        reopenedFinal ? "The Final payslip was recomputed: submit the run for HR approval again." : "",
        result.db_synced === false ? "Database sync pending: contact your administrator if this keeps occurring." : "",
      ].filter(Boolean).join(" ");
      if (action === "submit") {
        setFeedback({ text: "Payroll processed successfully. Payslip generated.", ok: true });
        notify(reopenedFinal ? "Payslip Reprocessed" : "Payroll Processed", extra || "Payroll has been processed and payslip generated.", result.db_synced === false ? "warning" : "success");
        setProcessedBanner(true);
        setTimeout(() => setProcessedBanner(false), 5000);
        openPayslip(newId);
      } else {
        setFeedback({ text: "Payroll draft saved.", ok: true });
        notify("Draft Saved", extra || "Payroll draft has been saved and can be edited before submission.", result.db_synced === false ? "warning" : "success");
      }
    } catch (error) {
      if (action === "submit" && error.status === 409) {
        setFeedback({ text: "", ok: false });
        notify("Already Processed", "Payroll for this employee and period has already been processed.", "warning");
      } else {
        setFeedback({ text: error.message, ok: false });
        notify("Not saved", error.message, "error");
      }
    } finally {
      setBusy(false);
    }
  }

  // Short label; the rate as small muted text; units / ₱ inside the field; longer notes behind ⓘ (cleanup 2026-11-14).
  const numberField = (id, label, key, { hint, tip, suffix, prefix, step = "0.01", disabled = attendanceLocked, readOnly = false, locked: lockedField = false, children } = {}) => (
    <div className="space-y-1.5">
      <div className="flex min-h-5 flex-wrap items-center gap-x-1">
        <Label htmlFor={id} className="flex-wrap items-baseline gap-x-1.5">{lockedField ? <LockIcon className="size-3.5 self-center text-muted-foreground" aria-hidden="true" /> : null}{label}{hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}</Label>
        {tip ? <InfoTip label={`About ${label}`}>{tip}</InfoTip> : null}
      </div>
      <div className="relative">
      {prefix ? <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground" aria-hidden="true">{prefix}</span> : null}
      <Input
        id={id}
        type="number"
        min="0"
        max={NUMBER_MAX[key] || PESO_MAX}
        step={step}
        inputMode={step === "1" ? "numeric" : "decimal"}
        // Basic salary (2026-11-14): the contract's fixed monthly pay from the
        // employee's record, the same in both halves; each half's Basic pay
        // (computed from it) is in the summary.
        value={key === "tax" ? shownTax : key === "basic" && employee ? String(toAmount(employee.basic_salary)) : shownForm[key]}
        onChange={key === "tax"
          ? (e) => setForm((c) => ({ ...c, tax: e.target.value, taxEdited: true }))
          // Basic salary keeps to 7 whole digits and the maximum.
          : key === "basic" ? (e) => setForm((c) => ({ ...c, basic: clampSalary(e.target.value) })) : set(key)}
        disabled={disabled || lockedField}
        readOnly={readOnly}
        title={lockedField ? overrideGate.message : undefined}
        className={cn("tabular-nums", (readOnly || lockedField) && "bg-muted text-muted-foreground", lockedField && "border-dashed", prefix && "pl-7", suffix && "pr-12")}
      />
      {suffix ? <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground" aria-hidden="true">{suffix}</span> : null}
      </div>
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
        <Card className="min-w-0 shadow-xs" id="pc-entry">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">Payroll entry form {entryId ? <Badge variant="secondary">Editing saved entry</Badge> : null}</CardTitle>
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
            {summary.info.row?.defaults?.first_half_block ? (
              <Alert className="border-warning/40 bg-warning/10 text-warning" data-testid="first-half-not-final">
                <AlertTriangleIcon aria-hidden="true" />
                <AlertDescription className="text-warning">Preview only: {summary.info.row.defaults.first_half_block}</AlertDescription>
              </Alert>
            ) : null}
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="pc-employee" className="min-h-5">Select employee</Label>
                <SearchableSelect id="pc-employee" label="Employee" value={employeeId} disabled={!employees.length}
                  onValueChange={(id) => { setEmployeeId(id); setEntryId(""); setForm(defaultForm(data, employees.find((e) => e.id === id))); }}
                  placeholder={employees.length ? "Select employee" : "No employees found"} searchPlaceholder="Search name or employee ID…"
                  options={employees.map((e) => ({ value: e.id, label: `${e.full_name} — ${e.employee_id} (${e.employee_type})` }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pc-period" className="min-h-5">Pay period</Label>
                <Select value={period} onValueChange={setPeriod} disabled={!data?.period_options?.length}>
                  <SelectTrigger id="pc-period" className="w-full"><SelectValue placeholder="Current period" /></SelectTrigger>
                  <SelectContent>{(data?.period_options || []).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {/* From the employee's record: HR changes a salary (2026-10-26), never payroll processing. */}
              <div className="space-y-1.5">
                <div className="flex min-h-5 items-center gap-1">
                  <Label htmlFor="pc-basic">Basic salary (monthly)</Label>
                  <InfoTip label="About Basic salary">Set by HR in the employee&apos;s record.</InfoTip>
                </div>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground" aria-hidden="true">₱</span>
                  <Input id="pc-basic" readOnly value={employee ? toAmount(employee.basic_salary).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""}
                    className="bg-muted pr-9 pl-7 text-muted-foreground tabular-nums" />
                  <LockIcon className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                </div>
              </div>
            </div>

            <Separator />
            <p className="text-xs font-semibold tracking-wide text-gold-text uppercase">Deductions</p>
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
              {firstHalf ? (
                // One note instead of "Deducted on the 2nd half" on every box (cleanup 2026-11-14).
                <p data-testid="deferred-note" className="flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground sm:col-span-2">
                  <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />Government contributions and withholding tax are deducted on the 2nd-half payslip.
                </p>
              ) : locked ? (
                <>
                  {/* Social insurance, the employee's share (2026-11-03). */}
                  <p className="flex items-center gap-1 text-xs font-semibold tracking-wide text-gold-text sm:col-span-2" data-testid="group-contributions">
                    Government contributions
                    <InfoTip label="About government contributions">SSS, PhilHealth, Pag-IBIG and withholding tax are computed from the government rate tables (Government Rates) and cannot be changed here. If one looks wrong, flag it for review: HR and the Super Admin are notified.</InfoTip>
                  </p>
                  {computedField("pc-sss", "SSS", "sss", "SSS", summary.sss, lineOf("contributions", "sss"))}
                  {computedField("pc-philhealth", "PhilHealth", "philhealth", "PhilHealth", summary.philhealth, lineOf("contributions", "philhealth"))}
                  {computedField("pc-pagibig", "Pag-IBIG", "pagibig", "Pag-IBIG", summary.pagibig, lineOf("contributions", "pagibig"))}
                  <div className="flex items-baseline justify-between gap-3 self-end border-t border-dashed pt-1 text-sm font-semibold">
                    <span>Subtotal: contributions</span>
                    <span className="text-destructive/80 tabular-nums">− {pesoText(toAmount(summary.sss + summary.philhealth + summary.pagibig))}</span>
                  </div>
                  {lineGroups?.taxable ? (
                    <div className="flex items-baseline justify-between gap-3 rounded-md border border-dashed border-primary/30 bg-primary/5 px-3 py-2 text-sm sm:col-span-2" data-testid="form-taxable-income">
                      <span className="flex min-w-0 items-center gap-1 font-medium">Taxable income
                        <InfoTip label="About taxable income">Gross less the contributions above (and non-taxable items). The withholding tax is computed on this.</InfoTip>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">{pesoText(lineGroups.taxable.amount)}</span>
                    </div>
                  ) : null}
                  {/* Income tax (TRAIN law), withheld for the BIR. */}
                  <p className="text-xs font-semibold tracking-wide text-gold-text sm:col-span-2" data-testid="group-tax">Income tax</p>
                  {computedField("pc-tax", "Withholding tax", "withholding_tax", "withholding tax", summary.tax, lineOf("tax", "withholding_tax"))}
                  <div className="flex items-baseline justify-between gap-3 self-end border-t border-dashed pt-1 text-sm font-semibold">
                    <span>Subtotal: withholding tax</span>
                    <span className="text-destructive/80 tabular-nums">− {pesoText(summary.tax)}</span>
                  </div>
                </>
              ) : (
                <>
                  {numberField("pc-sss", "SSS", "sss", { disabled: false, hint: contributionHint("sss", `(legal table: ${info.rates.sss_pct}% of salary credit, editable)`) })}
                  {numberField("pc-philhealth", "PhilHealth", "philhealth", { disabled: false, hint: contributionHint("philhealth", `(legal table: ${info.rates.philhealth_pct}% of monthly salary, editable)`) })}
                  {numberField("pc-pagibig", "Pag-IBIG", "pagibig", { disabled: false, hint: contributionHint("pagibig", `(legal table: ${info.rates.pagibig_pct}% up to the cap, editable)`) })}
                  {numberField("pc-tax", "Withholding tax", "tax", { disabled: false, prefix: "₱" })}
                </>
              )}
              <p className="flex items-center gap-1 text-xs font-semibold tracking-wide text-gold-text sm:col-span-2" data-testid="group-attendance">
                Attendance
                <InfoTip label="About attendance">Absent, Late, Undertime, Half day, Leave without pay and incentives are filled in from the attendance logs and approved leave. Changing one is an override: only in the processing window, it needs a reason and is logged.</InfoTip>
              </p>
              {employee && !attendanceLocked ? (
                overrideLocked ? (
                  <div role="status" data-testid="override-locked" className="flex items-start gap-2 rounded-lg border border-dashed border-muted-foreground/40 bg-muted/60 px-3 py-2 text-sm text-muted-foreground sm:col-span-2">
                    <LockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span><strong className="text-foreground">Overrides locked.</strong> {overrideGate.message} The values below come from the RFID attendance logs and are used as they are.{droppedOverrides ? " This draft's earlier override values are not used." : ""}</span>
                  </div>
                ) : (
                  <p role="status" data-testid="override-open" className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/8 px-3 py-2 text-xs text-success sm:col-span-2">
                    <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{overrideGate.message}
                  </p>
                )
              ) : null}
              {/* field-grid: a label that wraps (narrow screens) keeps its box level with its neighbour. */}
              <div className="field-grid grid grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-2">
              {numberField("pc-absences", "Absent (days)", "absences", { hint: `${peso(unit.absent)}/day`, step: "1", locked: overrideLocked })}
              {numberField("pc-late", "Late", "late", { hint: lateRules, suffix: "days", step: "1", locked: overrideLocked })}
              {numberField("pc-undertime", "Undertime (min)", "undertime", { hint: `${peso(unit.hourly)}/hour`, step: "1", locked: overrideLocked })}
              {numberField("pc-half-days", "Half day (days)", "halfDays", { hint: `${peso(unit.half_day)}/day`, step: "1", locked: overrideLocked })}
              {numberField("pc-leave-with-pay-days", "Leave with pay (days)", "lwp", {
                tip: "No deduction.", step: "1", readOnly: true,
                children: leave?.with_pay_dates?.length ? <p className="text-xs text-muted-foreground">{dates(leave.with_pay_dates)}</p> : null,
              })}
              {numberField("pc-leave-without-pay-days", "Leave without pay (days)", "lwop", {
                hint: `${peso(unit.daily)}/day`, step: "1", locked: overrideLocked,
                children: leave?.without_pay_dates?.length ? <p className="text-xs text-muted-foreground">{dates(leave.without_pay_dates)}</p> : null,
              })}
              </div>
              {/* The override rule next to the fields it is about (cleanup 2026-11-14). */}
              {deviations.length ? (
                <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/8 p-3 sm:col-span-2">
                  <Label htmlFor="pc-override-reason">Reason for override <span className="font-normal text-muted-foreground">(required to process; logged with your name)</span></Label>
                  <Textarea id="pc-override-reason" rows={2} maxLength={REASON_MAX} placeholder="Why the computed value was changed" value={form.overrideReason} onChange={set("overrideReason")} aria-invalid={Boolean(reasonError) || undefined} />
                  {reasonError ? <p className="text-sm text-destructive">{reasonError}</p> : null}
                  <p className="text-xs text-warning">Changed from computed: {deviations.join(" · ")}</p>
                </div>
              ) : null}
            </div>

            <Separator />
            <p className="text-xs font-semibold tracking-wide text-gold-text uppercase">Incentives</p>
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <p className="flex min-h-5 items-center text-sm leading-none font-medium">Early Bird Incentive</p>
                <p className="flex h-9 items-center rounded-md border bg-muted px-3 text-sm text-muted-foreground tabular-nums">
                  {winnerPay ? `${money(winnerPay)} — this period's winner` : "Not this period's winner"}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pc-perfect" className="min-h-5 flex-wrap gap-x-1">{overrideLocked ? <LockIcon className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}Perfect attendance <span className="font-normal text-muted-foreground">{peso(unit.perfect_attendance)}/period</span></Label>
                <Select value={shownForm.perfect ? "yes" : "no"} onValueChange={(v) => setForm((c) => ({ ...c, perfect: v === "yes" }))} disabled={attendanceLocked || overrideLocked}>
                  <SelectTrigger id="pc-perfect" className={cn("w-full", overrideLocked && "border-dashed bg-muted text-muted-foreground")} title={overrideLocked ? overrideGate.message : undefined}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="no">No</SelectItem><SelectItem value="yes">Yes</SelectItem></SelectContent>
                </Select>
              </div>
            </div>

          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="shadow-xs">
            <CardHeader><CardTitle>Computation summary</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {/* Every line tagged and grouped (src/lib/payroll/line-tags.js);
                  the same figures as before, from computeSummary(). */}
              {lineGroups ? (
                <PayrollLineGroups
                  result={compactLineGroups(lineGroups, { employee, form: shownForm, summary })}
                  net={summary.net}
                  netLabel={semiHalf(data) === "second" ? "2nd half net pay" : semiHalf(data) === "first" ? "1st half net pay" : "Net pay"}
                >
                  {/* Totals for reference (2nd half: the month is computed once; the
                      payslip's own gross is what HR and the employee see, 2026-10-29). */}
                  <div className="space-y-1.5 border-t pt-2">
                    <SummaryRow label={summary.settling ? "Monthly gross (less attendance)" : "Gross pay"} value={money(summary.settling ? summary.monthGross : summary.gross)} />
                    {summary.settling ? <SummaryRow label="Monthly net (before what the 1st half paid)" value={money(summary.monthNet)} strong /> : null}
                    {summary.settling && summary.secondHalfNet < 0 ? <SummaryRow label="Carried to next month" value={money(Math.max(0, -summary.secondHalfNet))} tone="warn" /> : null}
                    {summary.settling && summary.info.row?.defaults?.cutoff_gross !== undefined ? <SummaryRow label="Gross pay (this payslip, 2nd cutoff)" value={money(summary.info.row.defaults.cutoff_gross)} /> : null}
                  </div>
                  {lineGroups.monthly_tax ? (
                    <div data-testid="monthly-tax-box" className="space-y-1.5 rounded-lg border bg-muted/40 p-3">
                      <p className="flex items-center gap-1 text-xs font-semibold tracking-wide text-gold-text uppercase">Monthly tax computation
                        <InfoTip label="About the monthly tax">The 2nd half computes the whole month, then takes off what the 1st half paid.</InfoTip>
                      </p>
                      <SummaryRow label="Monthly basic salary" value={money(lineGroups.monthly_tax.basic)} />
                      {lineGroups.monthly_tax.earnings ? <SummaryRow label="+ Taxable earnings (overload, incentives)" value={money(lineGroups.monthly_tax.earnings)} /> : null}
                      <SummaryRow label="− Attendance, whole month (both halves)" value={money(lineGroups.monthly_tax.attendance)} />
                      <SummaryRow label="− SSS, PhilHealth, Pag-IBIG" value={money(lineGroups.monthly_tax.contributions)} />
                      <SummaryRow label="= Taxable income (monthly table)" value={money(lineGroups.monthly_tax.taxable)} strong />
                      <SummaryRow label="Withholding tax" value={money(lineGroups.monthly_tax.tax)} />
                    </div>
                  ) : null}
                  {lineGroups.reconciliation ? (
                    <div data-testid="reconciliation" className="space-y-1">
                      <SummaryRow
                        label={`Reconciliation: 1st half ${money(lineGroups.reconciliation.first_half_net)} + 2nd half ${money(lineGroups.reconciliation.second_half_net)}`}
                        value={money(lineGroups.reconciliation.total)}
                        tone={lineGroups.reconciliation.total === lineGroups.reconciliation.monthly_net ? undefined : "warn"}
                      />
                      <p className="text-xs text-muted-foreground">
                        = monthly net {money(lineGroups.reconciliation.monthly_net)}
                        {lineGroups.reconciliation.estimate ? " · estimate, 1st half not Final" : ""}
                      </p>
                    </div>
                  ) : null}
                  {summary.lwpDays ? <SummaryRow label="Leave with pay (no deduction)" value={`${summary.lwpDays} day${summary.lwpDays === 1 ? "" : "s"}`} /> : null}
                </PayrollLineGroups>
              ) : (
                <div className="flex items-baseline justify-between gap-4 rounded-lg bg-primary/8 px-3 py-3">
                  <span className="font-semibold">Net pay</span>
                  <span className="text-xl font-semibold text-primary tabular-nums">{money(summary.net)}</span>
                </div>
              )}
              <LineTagLegend />
            </CardContent>
          </Card>
          <Card className="shadow-xs">
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">Review the computation before processing. The payslip is saved to Payroll Records.</p>
              <Button className="w-full" size="lg" onClick={() => submit("submit")} disabled={busy || Boolean(blocking.length) || !ready || !finalWindow || Boolean(summary.info.row?.defaults?.first_half_block)} title={finalWindow ? "" : (win?.message || "")}>
                {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Process payroll →
              </Button>
              <Button className="w-full" variant="outline" onClick={() => submit("save_draft")} disabled={busy}>Save as draft</Button>
              {feedback.text ? <p role="status" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
            </CardContent>
          </Card>
        </div>
      </div>
      <FlagDeductionDialog flag={flag} employee={employee} period={period} onClose={() => setFlag(null)} />
    </>
  );
}

export function ProcessPage({ onNavigate }) {
  const { data, error, load } = useAccountant();
  const [editRequest, setEditRequest] = React.useState(null);
  // A failed first load said "No employees found" with Process enabled (E2E 2026-10-22).
  if (error && !data) return <Card className="shadow-xs"><CardContent><ErrorState message={error} onRetry={() => load()} /></CardContent></Card>;
  return (
    <>
      <Banners data={data} />
      {/* Incentives filed after the 15th are paid next month (intended). */}
      <DeferredIncentivesNotice monthKey={String(data?.active_period?.start_key || "").slice(0, 7)} />
      <RunApprovalPanel />
      <BatchCard onNavigate={onNavigate} onEdit={(id) => setEditRequest({ id, at: Date.now() })} />
      <h2 className="mt-2 text-base font-semibold">Single entry / edit draft</h2>
      <SingleEntry onNavigate={onNavigate} editRequest={editRequest} />
    </>
  );
}
