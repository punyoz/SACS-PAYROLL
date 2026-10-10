"use client";

import * as React from "react";
import { DownloadIcon, Loader2Icon, PrinterIcon, ReceiptTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/portal/empty-state";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch } from "@/lib/portal/api";
import { holidayLineLabel } from "@/lib/portal/format";
import { dateLabel, dateTime, money, shortDate, toAmount } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { useAccountant } from "./accountant-data";

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

function Row({ label, value, tone, strong, muted, indent }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-1 text-sm print:py-0.5", strong && "mt-1 border-t pt-2 font-semibold print:pt-1", muted && "text-muted-foreground", indent && "pl-3 text-xs")}>
      <span className="min-w-0">{label}</span>
      <span className={cn("shrink-0 tabular-nums", tone === "plus" && "text-success", tone === "minus" && "text-destructive", tone === "gold" && "text-gold-text", tone === "warn" && "text-warning")}>{value}</span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold tracking-wide text-gold-text uppercase">{title}</p>
      {children}
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
          <Row label="Semi-monthly pay (÷ 2)" value={money(m.semi_monthly_pay)} strong tone="gold" />
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
        <Row label="Monthly salary" value={money(m.monthly_salary)} />
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
        <Row label="SSS" value={`- ${money(m.sss)}`} />
        <Row label="PhilHealth" value={`- ${money(m.philhealth)}`} />
        <Row label="Pag-IBIG" value={`- ${money(m.pagibig)}`} />
        <Row muted label="Taxable income" value={money(m.taxable_income)} />
        <Row label="Withholding tax (monthly)" value={`- ${money(m.withholding_tax)}`} />
        <Row label="Monthly net" value={money(m.monthly_net)} strong />
        <Row label={m.first_half_status === "final" ? "Paid in 1st half" : "Paid in 1st half (not processed)"} value={`- ${money(m.first_half_paid)}`} />
        {Number(m.carry_in) > 0 ? <Row label={`Balance carried from ${m.carry_from || "last month"}`} value={`- ${money(m.carry_in)}`} tone="minus" /> : null}
        {Number(m.carry_over_out) > 0 ? <Row label="Carried to next month" value={money(m.carry_over_out)} tone="warn" /> : null}
      </Section>
    </div>
  );
}

function Classic({ payslip }) {
  const e = payslip.earnings || {};
  const d = payslip.deductions || {};
  const inc = payslip.incentives || {};
  const late = d.late_days || 0;
  const under = d.undertime_minutes || 0;
  const half = d.half_days || 0;
  const eb = inc.early_bird_days || 0;
  const lwp = d.leave_with_pay_days || 0;
  return (
    <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2 print:gap-6">
      <div className="space-y-4 print:space-y-2">
        <Section title="Earnings">
          <Row label="Basic salary" value={money(e.basic_salary)} />
          <Row label="Overtime" value={money(e.overtime)} />
          <Row label="Holiday pay" value={money(e.holiday_pay)} />
          <HolidayLines lines={payslip.holiday_lines} />
          <Row label="Gross pay" value={money(e.gross_pay)} strong tone="gold" />
        </Section>
        <Section title="Incentives">
          <Row label={eb ? `Early bird (${plural(eb, "day")})` : "Early bird"} value={money(inc.early_bird_incentive)} tone="plus" />
          <Row label="Perfect attendance" value={money(inc.perfect_attendance_incentive)} tone="plus" />
        </Section>
      </div>
      <Section title="Deductions">
        <Row label="SSS" value={money(d.sss)} />
        <Row label="PhilHealth" value={money(d.philhealth)} />
        <Row label="Pag-IBIG" value={money(d.pagibig)} />
        <Row label="Withholding tax" value={money(d.withholding_tax)} />
        <Row label="Absences" value={money(d.absence_deduction)} />
        <Row label={late ? `Late (${plural(late, "day")})` : "Late"} value={money(d.late_deduction)} />
        <Row label={under ? `Undertime (${under} min)` : "Undertime"} value={money(d.undertime_deduction)} />
        <Row label={half ? `Half day (${plural(half, "day")})` : "Half day"} value={money(d.half_day_deduction)} />
        <Row label="Leave with pay" value={plural(lwp, "day")} />
        <Row label="Leave without pay" value={money(d.leave_without_pay_deduction)} />
        <Row label="Cash advance" value={money(d.cash_advance)} />
        <Row label="Total deductions" value={money(d.total_deductions)} strong tone="minus" />
      </Section>
    </div>
  );
}

function PayslipDocument({ payslip }) {
  const draft = payslip.status === "draft";
  const g = payslip.generation || null;
  const notes = [];
  if (draft && g?.attendance_through) notes.push(`Includes attendance up to ${dateLabel(g.attendance_through)}.`);
  if (g?.confirmed_incomplete?.length) notes.push(`Not counted (unresolved when generated): ${g.confirmed_incomplete.map((i) => `${dateLabel(i.log_date)} (${i.status})`).join(", ")}.`);
  if (g?.override) notes.push(`Overridden by ${g.override.by_name || "Super Admin"}: ${g.override.reason}`);
  const summary = payslip.attendance_summary;
  const basis = Array.isArray(payslip.deduction_basis) ? payslip.deduction_basis : [];
  const m = payslip.monthly || null;

  return (
    <Card data-print-area className="gap-0 overflow-hidden border-brand-gold/60 py-0 shadow-sm print:break-inside-avoid">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-brand-gold bg-gradient-to-br from-brand-green to-brand-green-dark px-6 py-5 text-white print:py-3">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-160.png" alt="Shepherd Angels Christian School seal" width={52} height={52} className="size-13 shrink-0 rounded-full bg-white/95 p-0.5" />
          <div>
            <p className="font-semibold">Shepherd Angels Christian School</p>
            <p className="text-sm text-white/80">SACS Payroll Management System</p>
            <p className="mt-1.5 inline-flex items-center gap-2 rounded-md bg-white/10 px-2 py-0.5 text-xs"><span className="font-semibold tracking-wide text-brand-gold-light uppercase">Payslip no.</span><span className="font-mono">{payslip.payslip_no || "—"}</span></p>
          </div>
        </div>
        <div className="text-right text-sm">
          <p className="text-white/80">Pay period</p>
          <p className="font-semibold">{payslip.pay_period || "N/A"}</p>
          <p className="text-xs text-white/70">Issued: {dateTime(payslip.issued_at)}</p>
          <div className="mt-1.5">{draft ? <StatusBadge tone="gold" className="bg-white/90">Draft</StatusBadge> : <StatusBadge tone="success" className="bg-white/90">Final</StatusBadge>}</div>
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
        {m ? <SemiMonthly payslip={payslip} /> : <Classic payslip={payslip} />}
        {basis.length ? (
          <Section title="How deductions were computed">
            <ul className="space-y-1 text-sm text-muted-foreground">{basis.map((line, i) => <li key={i}>{line.basis}</li>)}</ul>
          </Section>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-primary/8 px-4 py-4 print:break-inside-avoid print:py-2">
          <span className="font-semibold">{m ? (m.half === "first" ? "1st half net pay" : "2nd half net pay") : "Net pay"}</span>
          <span className="text-2xl font-semibold text-primary tabular-nums">{money(payslip.net_pay)}</span>
        </div>
        {g?.generated_by_name ? (
          <p className="text-xs text-muted-foreground">Generated by {g.generated_by_name} on {g.generated_at_label || dateTime(g.generated_at)}{g.regenerations ? ` · regenerated ${g.regenerations} time${g.regenerations === 1 ? "" : "s"}` : ""}.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PayRecordPage() {
  const { data, loading, load } = useAccountant();
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

  return (
    <>
      <Card className="shadow-xs">
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="space-y-1.5 sm:w-80">
            <Label htmlFor="ac-payslip-select">Payslip</Label>
            <Select value={selected} onValueChange={(id) => { setSelected(id); load({ entryId: id }); }} disabled={!options.length}>
              <SelectTrigger id="ac-payslip-select" className="w-full"><SelectValue placeholder={options.length ? "Select a payslip" : "No payslips available"} /></SelectTrigger>
              <SelectContent>{options.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => selected && load({ entryId: selected })} disabled={!selected || loading}>{loading ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Generate</Button>
            <Button variant="outline" onClick={() => window.print()} disabled={!payslip}><PrinterIcon aria-hidden="true" />Print</Button>
            <Button variant="outline" onClick={downloadPdf} disabled={!payslip?.entry_id || downloading}>{downloading ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}Download PDF</Button>
          </div>
        </CardContent>
      </Card>
      {loading && !payslip ? <Skeleton className="h-[480px] w-full rounded-xl" /> : payslip ? <PayslipDocument payslip={payslip} /> : (
        <Card className="shadow-xs"><CardContent><EmptyState icon={ReceiptTextIcon} title="No payslip selected" description="Process payroll or pick a payslip above." /></CardContent></Card>
      )}
    </>
  );
}
