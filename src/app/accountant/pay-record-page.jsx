"use client";

import * as React from "react";
import { DownloadIcon, Loader2Icon, PrinterIcon, ReceiptTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession, useSystemName } from "@/components/portal/session";
import { apiFetch } from "@/lib/portal/api";
import { holidayLineLabel } from "@/lib/portal/format";
import { dateLabel, dateTime, money, shortDate, toAmount } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { contributionLabel, withholdingTaxLabel } from "@/lib/payroll/statutory";
import { useAccountant } from "./accountant-data";
import { PayslipTables } from "@/components/portal/payslip-tables";
import { payslipTables } from "@/lib/payroll/payslip-tables";
import { printPdf } from "@/lib/portal/print-pdf";
import { NeedsCorrectionNote } from "@/components/portal/payroll-corrections";

/*
 * Pay Record (renderPayslipDetails / renderPayslipGeneration /
 * renderSemiMonthlyPayslip / downloadPayslipPdf, accountant.js). The
 * payslip is the one GET /api/accountant/payroll?entry_id= returns; the PDF
 * is built on the server (?format=pdf).
 */

/** Accountant / Employee from position and role (normalizePortalPosition). */
function portalPosition(position, role) {
  const r = String(role || "").trim().toLowerCase();
  const p = String(position || "").trim().toLowerCase();
  if (!r && !p) return "N/A";
  return r === "accountant" || p === "accountant" || p.includes("account") ? "Accountant" : "Employee";
}

/**
 * One payslip line as a table row (alpha test A8). Deductions show below zero
 * the same way as the PDF and Excel: "-₱ 1,000.00"; additions just "₱ …".
 */
function signedValue(value) {
  if (typeof value !== "string") return value;
  return value.replace(/^-\s+/, "-").replace(/^\+\s+/, "");
}

function Row({ label, value, tone, strong, muted, indent }) {
  return (
    <div role="row" className={cn("flex items-baseline justify-between gap-4 px-3 py-1.5 text-sm print:py-0.5", strong && "bg-muted/40 font-semibold", muted && "text-muted-foreground", indent && "py-1 pl-6 text-xs")}>
      <span role="cell" className="min-w-0 break-words">{label}</span>
      <span role="cell" className={cn("shrink-0 text-right tabular-nums", tone === "plus" && "text-success", tone === "minus" && "text-destructive", tone === "gold" && "text-gold-text", tone === "warn" && "text-warning")}>{signedValue(value)}</span>
    </div>
  );
}

/** A payslip section as a table: its title and "Amount" over the rows. */
function Section({ title, children }) {
  return (
    <div role="table" aria-label={title} className="overflow-hidden rounded-md border print:break-inside-avoid">
      <div role="row" className="flex items-baseline justify-between gap-4 bg-muted/60 px-3 py-1.5 text-xs font-semibold">
        <span role="columnheader" className="tracking-wide text-gold-text uppercase">{title}</span>
        <span role="columnheader" className="text-muted-foreground">Amount</span>
      </div>
      <div role="rowgroup" className="divide-y">{children}</div>
    </div>
  );
}

const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? "" : "s"}`;

function HolidayLines({ lines }) {
  return (lines || []).map((line, i) => <Row key={`${line.date}-${i}`} indent muted label={holidayLineLabel(line)} value={`+ ${money(line.amount)}`} />);
}

function SemiMonthly({ payslip }) {
  const m = payslip.monthly;
  if (m.half === "first") {
    return (
      <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2 print:gap-6">
        <Section title="Earnings — 1st half">
          <Row label="Monthly salary" value={money(m.monthly_salary)} />
          <Row label={m.new_hire ? `Paid from hire date (${plural(m.new_hire.days, "day")} × ${money(m.new_hire.daily_rate)})` : "Semi-monthly pay (÷ 2)"} value={money(m.semi_monthly_pay)} strong tone="gold" />
        </Section>
        <Section title="Deductions">
          <Row label="None this half" value={money(0)} />
          <p className="pt-1 text-xs text-muted-foreground">Absences, leave, incentives, contributions and withholding tax for {m.month_label || "the month"} are settled on the {m.second_half_label || "2nd half"} payslip.</p>
        </Section>
      </div>
    );
  }
  const attendance = [["Late", m.late_deduction], ["Undertime", m.undertime_deduction], ["Half day", m.half_day_deduction]].filter(([, a]) => Number(a) > 0);
  return (
    <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2 print:gap-6">
      <Section title={`Month of ${m.month_label || ""}`}>
        {m.window ? <Row muted label={`Attendance ${shortDate(m.window.start_key)} – ${shortDate(m.window.end_key)}`} value={`Daily ${money(m.daily_rate)}`} /> : null}
        <Row label={m.new_hire ? `Paid from hire date (${plural(m.new_hire.days, "day")} × ${money(m.new_hire.daily_rate)})` : "Monthly salary"} value={money(m.monthly_salary)} />
        <Row label={`Absences without pay (${plural(m.absent_days || 0, "day")})`} value={`- ${money(m.absent_deduction)}`} tone="minus" />
        <Row label={`Leave without pay (${plural(m.leave_without_pay_days || 0, "day")})`} value={`- ${money(m.leave_without_pay_deduction)}`} tone="minus" />
        {attendance.map(([label, amount]) => <Row key={label} label={label} value={`- ${money(amount)}`} tone="minus" />)}
        <Row label={`Leave with pay (${plural(m.leave_with_pay_days || 0, "day")})`} value="No deduction" />
        <Row label="Incentives" value={`+ ${money(toAmount(Number(m.other_incentive || 0) + Number(m.attendance_incentives || 0)))}`} tone="plus" />
        {Number(m.overload_pay) > 0 ? <Row label={`Overload pay (${m.overload_hours} h)`} value={`+ ${money(m.overload_pay)}`} tone="plus" /> : null}
        {Number(m.overtime_pay) > 0 ? <Row label="Overtime" value={`+ ${money(m.overtime_pay)}`} tone="plus" /> : null}
        {Number(m.holiday_pay) > 0 ? <><Row label="Holiday pay" value={`+ ${money(m.holiday_pay)}`} tone="plus" /><HolidayLines lines={payslip.holiday_lines} /></> : null}
        <Row label="Monthly gross" value={money(m.monthly_gross)} strong tone="gold" />
      </Section>
      <Section title="Contributions & tax">
        <Row label={contributionLabel("SSS", m.contribution_basis?.sss)} value={`- ${money(m.sss)}`} />
        <Row label={contributionLabel("PhilHealth", m.contribution_basis?.philhealth)} value={`- ${money(m.philhealth)}`} />
        <Row label={contributionLabel("Pag-IBIG", m.contribution_basis?.pagibig)} value={`- ${money(m.pagibig)}`} />
        <Row muted label="Taxable income" value={money(m.taxable_income)} />
        <Row label={withholdingTaxLabel("Withholding tax (monthly)", m.tax_bracket)} value={`- ${money(m.withholding_tax)}`} />
        <Row label="Monthly net" value={money(m.monthly_net)} strong />
        <Row label={m.first_half_status === "final" ? "Paid in 1st half" : "Paid in 1st half (not processed)"} value={`- ${money(m.first_half_paid)}`} />
        {Number(m.carry_in) > 0 ? <Row label={`Balance carried from ${m.carry_from || "last month"}`} value={`- ${money(m.carry_in)}`} tone="minus" /> : null}
        {Number(m.year_end_tax?.amount) > 0 ? <Row label={m.year_end_tax.label} value={`${m.year_end_tax.kind === "refund" ? "+" : "-"} ${money(m.year_end_tax.amount)}`} tone={m.year_end_tax.kind === "refund" ? "plus" : "minus"} /> : null}
        {Number(m.carry_over_out) > 0 ? <Row label="Carried to next month" value={money(m.carry_over_out)} tone="warn" /> : null}
      </Section>
    </div>
  );
}

/** The monthly tax computation of a 2nd half (employeePayslipView tax_box): what the withholding tax was computed on. */
function TaxBox({ box }) {
  if (!box) return null;
  const sign = (s) => (s === "-" ? "− " : s === "+" ? "+ " : "");
  return (
    <section className="space-y-1 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2 text-xs print:break-inside-avoid" data-testid="tax-box">
      <p className="font-semibold tracking-wide text-gold-text uppercase">Monthly tax computation</p>
      {box.rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-3"><span className="min-w-0">{r.label}</span><span className="shrink-0 tabular-nums">{sign(r.sign)}{money(r.amount)}</span></div>
      ))}
      <div className="flex items-baseline justify-between gap-3 border-t border-dashed pt-1 font-semibold"><span>Taxable income</span><span className="tabular-nums">{money(box.taxable)}</span></div>
      {box.bracket ? <p className="text-muted-foreground">Bracket: {box.bracket}{box.formula ? <span className="block font-mono text-[11px] break-words">{box.formula}</span> : null}</p> : null}
      <div className="flex items-baseline justify-between gap-3 font-semibold"><span>Withholding tax</span><span className="tabular-nums">{money(box.tax)}</span></div>
      {box.reason ? <p className="text-muted-foreground">{box.reason}</p> : null}
    </section>
  );
}

/**
 * The payslip itself; also shown read-only on HR → Payroll Records and, with
 * the employee's own notes as children, on My Payslips (2026-11-18).
 */
export function PayslipDocument({ payslip, children, netLabel }) {
  // Grouped and tagged lines (2026-11-03) when the stored payslip supports them.
  const groups = payslip.line_groups || null;
  const systemTitle = useSystemName();
  const draft = payslip.status === "draft";
  const g = payslip.generation || null;
  const notes = [];
  if (draft && g?.attendance_through) notes.push(`Includes attendance up to ${dateLabel(g.attendance_through)}.`);
  if (g?.confirmed_incomplete?.length) notes.push(`Not counted (unresolved when generated): ${g.confirmed_incomplete.map((i) => `${dateLabel(i.log_date)} (${i.status})`).join(", ")}.`);
  if (g?.override) notes.push(`Overridden by ${g.override.by_name || "Super Admin"}: ${g.override.reason}`);
  const summary = payslip.attendance_summary;
  const basis = Array.isArray(payslip.deduction_basis) ? payslip.deduction_basis : [];
  const m = payslip.monthly || null;
  const tables = payslipTables(payslip);

  return (
    <Card data-print-area className="gap-0 overflow-hidden border-brand-gold/60 py-0 shadow-sm print:break-inside-avoid">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-brand-gold bg-gradient-to-br from-brand-green to-brand-green-dark px-6 py-5 text-white print:py-3">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-160.png" alt="Shepherd Angels Christian School seal" width={52} height={52} className="size-13 shrink-0 rounded-full bg-white/95 p-0.5" />
          <div>
            <p className="font-semibold">Shepherd Angels Christian School</p>
            <p className="text-sm text-white/80">{systemTitle} Management System</p>
            <p className="mt-1.5 inline-flex items-center gap-2 rounded-md bg-white/10 px-2 py-0.5 text-xs"><span className="font-semibold tracking-wide text-brand-gold-light uppercase">Payslip no.</span><span className="font-mono">{payslip.payslip_no || "—"}</span></p>
          </div>
        </div>
        <div className="text-right text-sm">
          <p className="text-white/80">Pay period</p>
          <p className="font-semibold">{payslip.pay_period || "N/A"}</p>
          {/* Pay date = the day HR approved the run; the status in the employee's words (2026-11-19), as on the PDF. */}
          <p className="text-xs text-white/70">Issued: {dateTime(payslip.issued_at)}</p>
          {payslip.status_label ? <p className="text-xs text-white/70">{payslip.final_pay ? "Release date" : "Pay date"}: {payslip.pay_date_label || (payslip.status_label === "Paid" || draft ? "—" : "After HR approval")}</p> : null}
          <div className="mt-1.5"><StatusBadge tone={draft ? "gold" : payslip.status_label && !/^(Paid|Released)/.test(payslip.status_label) ? "warning" : "success"} className="bg-white/90">{payslip.status_label || (draft ? "Draft" : "Final")}</StatusBadge></div>
        </div>
      </div>
      <CardContent className="space-y-5 px-6 py-5 print:space-y-3 print:py-3">
        <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5 print:grid-cols-5 print:gap-3">
          {[
            ["Employee name", payslip.employee?.name || "N/A"],
            ["ID", payslip.employee?.id || "N/A"],
            ["Position", portalPosition(payslip.employee?.position, payslip.employee?.role)],
            ["Type", payslip.employee?.type || "N/A"],
            ["Branch", payslip.employee?.branch || "—"],
            ...(payslip.employee?.branch_days?.length ? [["Days by branch", payslip.employee.branch_days.map((b) => `${b.branch_name} ${b.days}`).join(" · ")]] : []),
          ].map(([label, value]) => (
            <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>
          ))}
        </dl>
        {notes.length ? <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/8 p-3 text-sm text-warning">{notes.map((n) => <p key={n}>{n}</p>)}</div> : null}
        {summary ? (
          <Section title="Attendance summary">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 print:grid-cols-6">
              {[["Days present", summary.days_present], ["Days absent", summary.days_absent], ["Half days", summary.half_days], ["Late minutes", summary.late_minutes], ["Undertime minutes", summary.undertime_minutes], ["Leave days", summary.leave_days]].map(([label, value]) => (
                <div key={label} className="rounded-lg border bg-muted/40 px-3 py-2"><p className="text-xs text-muted-foreground">{label}</p><p className="font-semibold tabular-nums">{String(value ?? 0)}</p></div>
              ))}
            </div>
          </Section>
        ) : null}
        <Separator />
        {/* One layout for every payslip (2026-11-18); an older semi-monthly one keeps its own. */}
        {tables ? <PayslipTables tables={tables} /> : <SemiMonthly payslip={payslip} />}
        {/* A 2nd half: the monthly tax computation, for every role (on My Payslips only before 2026-11-19). */}
        <TaxBox box={groups?.tax_box || payslip.tax_box} />
        {children}
        {basis.length && !groups && !payslip.final_pay ? (
          <Section title="How deductions were computed">
            <ul className="space-y-1 text-sm text-muted-foreground">{basis.map((line, i) => <li key={i}>{line.basis}</li>)}</ul>
          </Section>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-primary/8 px-4 py-4 print:break-inside-avoid print:py-2">
          <span className="font-semibold">{netLabel || (m && !payslip.final_pay ? (m.half === "first" ? "1st half net pay" : "2nd half net pay") : "Net pay")}</span>
          <span className="text-2xl font-semibold text-primary tabular-nums">{money(payslip.net_pay)}</span>
        </div>
        {(groups?.month_total || payslip.month_total) ? <p className="text-xs font-medium text-muted-foreground" data-testid="month-total">{(groups?.month_total || payslip.month_total).label}</p> : null}
        {/* A final pay: who approved it and when (20261120010000). */}
        {payslip.approval_line ? <p className="text-xs text-muted-foreground" data-testid="final-pay-approval">{payslip.approval_line}.</p> : null}
        {g?.generated_by_name ? (
          <p className="text-xs text-muted-foreground">Generated by {g.generated_by_name} on {g.generated_at_label || dateTime(g.generated_at)}{g.regenerations ? ` · regenerated ${g.regenerations} time${g.regenerations === 1 ? "" : "s"}` : ""}.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PayRecordPage() {
  const { data, loading, error, load } = useAccountant();
  const { notify } = usePortalSession();
  const options = React.useMemo(() => data?.payslip_options || [], [data]);
  const payslip = data?.payslip || null;
  const [selected, setSelected] = React.useState("");
  const [downloading, setDownloading] = React.useState(false);

  React.useEffect(() => {
    if (payslip?.entry_id) setSelected(String(payslip.entry_id));
    else if (!selected && options[0]) setSelected(String(options[0].id));
  }, [payslip, options, selected]);

  async function downloadPdf() {
    const entryId = payslip?.entry_id;
    if (!entryId) return;
    setDownloading(true);
    try {
      const response = await apiFetch(`/api/accountant/payroll?format=pdf&entry_id=${encodeURIComponent(entryId)}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Unable to download the payslip.");
      }
      const blob = await response.blob();
      const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = match ? match[1] : "payslip.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      notify("Download Failed", error.message, "error");
    } finally {
      setDownloading(false);
    }
  }

  // A failed first load showed an empty payslip picker and no reason (E2E 2026-10-22).
  if (error && !data) return <Card className="shadow-xs"><CardContent><ErrorState message={error} onRetry={() => load()} /></CardContent></Card>;

  return (
    <>
      <Card className="shadow-xs">
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="space-y-1.5 sm:w-[26rem]">
            <Label htmlFor="ac-payslip-select">Payslip</Label>
            <Select value={selected} onValueChange={(id) => { setSelected(id); load({ entryId: id }); }} disabled={!options.length}>
              <SelectTrigger id="ac-payslip-select" className="w-full"><SelectValue placeholder={options.length ? "Select a payslip" : "No payslips available"} /></SelectTrigger>
              <SelectContent>{options.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => selected && load({ entryId: selected })} disabled={!selected || loading}>{loading ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Generate</Button>
            <Button variant="outline" onClick={() => printPdf(`/api/accountant/payroll?format=pdf&entry_id=${encodeURIComponent(payslip?.entry_id || selected)}`).catch((e) => notify("Not printed", e.message, "error"))} disabled={!payslip?.entry_id}><PrinterIcon aria-hidden="true" />Print</Button>
            <Button variant="outline" onClick={downloadPdf} disabled={!payslip?.entry_id || downloading}>{downloading ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}Download PDF</Button>
          </div>
        </CardContent>
      </Card>
      {payslip ? <NeedsCorrectionNote role="accountant" entryId={payslip.entry_id}
        info={(data?.history_records || data?.records || []).find((r) => String(r.id) === String(payslip.entry_id))?.needs_correction} /> : null}
      {loading && !payslip ? <Skeleton className="h-[480px] w-full rounded-xl" /> : payslip ? <PayslipDocument payslip={payslip} /> : (
        <Card className="shadow-xs"><CardContent><EmptyState icon={ReceiptTextIcon} title="No payslip selected" description="Process payroll or pick a payslip above." /></CardContent></Card>
      )}
    </>
  );
}
