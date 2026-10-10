"use client";

import * as React from "react";
import { EyeIcon, ReceiptTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/portal/data-table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { formatIssued, formatPeso, formatPesoShort, holidayLineLabel } from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/*
 * The payslip breakdown, row for row as public/legacy/js/employee.js
 * renderPayslipCard() / semiMonthlyPayslipRows() builds it. Each row is
 * { label, value, kind } where kind is plus | minus | total | note | sub.
 */

function holidayRows(lines) {
  return (lines || []).map((line) => ({ label: holidayLineLabel(line), value: `+ ${formatPeso(line.amount)}`, kind: "sub" }));
}

function semiMonthlyRows(m, holidayLines = []) {
  const rows = [];
  const row = (label, value, kind) => rows.push({ label, value, kind });
  const minus = (label, amount) => { if (Number(amount) > 0) row(label, `- ${formatPeso(amount)}`, "minus"); };
  const plus = (label, amount) => { if (Number(amount) > 0) row(label, `+ ${formatPeso(amount)}`, "plus"); };
  const days = (n) => `${n}d`;

  if (m.half === "first") {
    row("Monthly Salary", formatPeso(m.monthly_salary));
    row(m.new_hire ? `Paid from Hire Date (${days(m.new_hire.days)} × ${formatPeso(m.new_hire.daily_rate)})` : "1st Half Pay (÷ 2)", formatPeso(m.semi_monthly_pay), "total");
    row("Deductions", "None this half", "note");
    row(`Absences, leave, incentives, contributions and tax for ${m.month_label || "the month"} are settled on the ${m.second_half_label || "2nd half"} payslip.`, "", "note");
    return rows;
  }

  row(m.new_hire ? `Paid from Hire Date (${days(m.new_hire.days)} × ${formatPeso(m.new_hire.daily_rate)})` : `Monthly Salary — ${m.month_label || ""}`, formatPeso(m.monthly_salary));
  minus(`Absences without pay (${days(m.absent_days || 0)})`, m.absent_deduction);
  minus(`Leave Without Pay (${days(m.leave_without_pay_days || 0)})`, m.leave_without_pay_deduction);
  minus("Late", m.late_deduction);
  minus("Undertime", m.undertime_deduction);
  minus("Half Day", m.half_day_deduction);
  if (Number(m.leave_with_pay_days) > 0) row(`Leave With Pay (${days(m.leave_with_pay_days)})`, "No deduction");
  plus("Incentives", Number(m.other_incentive || 0) + Number(m.attendance_incentives || 0));
  plus(`Overload Pay (${m.overload_hours} h)`, m.overload_pay);
  plus("Overtime", m.overtime_pay);
  plus("Holiday Pay", m.holiday_pay);
  if (Number(m.holiday_pay) > 0) rows.push(...holidayRows(holidayLines));
  plus("Licensed Teacher Subsidy", m.subsidy_pay);
  row("Monthly Gross", formatPeso(m.monthly_gross), "total");
  minus("SSS", m.sss);
  minus("PhilHealth", m.philhealth);
  minus("Pag-IBIG", m.pagibig);
  minus("Withholding Tax (monthly)", m.withholding_tax);
  minus("Loans and Cash Advances", m.cash_advance);
  (m.subsidy_memos || []).forEach((memo) => row(memo, "", "note"));
  row("Monthly Net", formatPeso(m.monthly_net), "total");
  row("Paid in 1st Half", `- ${formatPeso(m.first_half_paid)}`);
  minus(`Balance carried from ${m.carry_from || "last month"}`, m.carry_in);
  if (Number(m.carry_over_out) > 0) row("Carried to next month", formatPeso(m.carry_over_out), "carry");
  return rows;
}

function payslipRows(p) {
  if (p.monthly) return semiMonthlyRows(p.monthly, p.holiday_lines);
  const rows = [];
  const add = (cond, label, value, kind) => { if (cond) rows.push({ label, value, kind }); };
  if (p.has_breakdown) {
    add(true, "Basic Salary", formatPeso(p.basic_salary));
    add(p.transportation, "Transportation", formatPeso(p.transportation));
    add(p.rice, "Rice Allowance", formatPeso(p.rice));
    add(p.overtime, "Overtime", formatPeso(p.overtime));
    if (p.holiday_pay) {
      rows.push({ label: "Holiday Pay", value: formatPeso(p.holiday_pay) });
      rows.push(...holidayRows(p.holiday_lines));
    }
    add(p.bonus, "Bonus", formatPeso(p.bonus));
    add(true, "Gross Pay", formatPeso(p.gross_pay), "total");
    add(p.sss, "SSS", `- ${formatPeso(p.sss)}`, "minus");
    add(p.philhealth, "PhilHealth", `- ${formatPeso(p.philhealth)}`, "minus");
    add(p.pagibig, "Pag-IBIG", `- ${formatPeso(p.pagibig)}`, "minus");
    add(p.withholding_tax, "Withholding Tax", `- ${formatPeso(p.withholding_tax)}`, "minus");
    add(p.absence_deduction, `Absences (${p.absences_days}d)`, `- ${formatPeso(p.absence_deduction)}`, "minus");
    add(p.late_deduction, `Late (${p.late_days}d)`, `- ${formatPeso(p.late_deduction)}`, "minus");
    add(p.undertime_deduction, `Undertime (${p.undertime_minutes} min)`, `- ${formatPeso(p.undertime_deduction)}`, "minus");
    add(p.half_day_deduction, `Half Day (${p.half_days}d)`, `- ${formatPeso(p.half_day_deduction)}`, "minus");
    add(p.early_bird_incentive, `Early Bird (${p.early_bird_days}d)`, `+ ${formatPeso(p.early_bird_incentive)}`, "plus");
    add(p.perfect_attendance_incentive, "Perfect Attendance", `+ ${formatPeso(p.perfect_attendance_incentive)}`, "plus");
    add(p.leave_with_pay_days, `Leave With Pay (${p.leave_with_pay_days}d)`, "—");
    add(p.leave_without_pay_deduction, `Leave Without Pay (${p.leave_without_pay_days}d)`, `- ${formatPeso(p.leave_without_pay_deduction)}`, "minus");
    add(p.cash_advance, "Cash Advance", `- ${formatPeso(p.cash_advance)}`, "minus");
    return rows;
  }
  rows.push({ label: "Gross Pay", value: formatPeso(p.gross_pay), kind: "total" });
  rows.push({ label: "Total Deductions", value: `- ${formatPeso(p.total_deductions)}`, kind: "minus" });
  return rows;
}

const KIND_CLASS = {
  plus: "text-success",
  minus: "text-destructive",
  total: "border-t border-dashed pt-2.5 font-semibold",
  note: "text-muted-foreground text-xs",
  sub: "pl-4 text-xs text-muted-foreground",
  carry: "text-warning",
};

function PayslipCard({ payslip }) {
  if (!payslip) {
    return (
      <Card className="shadow-xs">
        <CardContent>
          <EmptyState icon={ReceiptTextIcon} title="No payslip available" description="Your payslip will appear here once payroll is processed." />
        </CardContent>
      </Card>
    );
  }
  const issued = formatIssued(payslip.processed_at);
  const m = payslip.monthly || null;
  const netName = m ? (m.half === "first" ? "1st Half Net Pay" : "2nd Half Net Pay") : "Net Pay";

  return (
    <Card className="gap-0 overflow-hidden py-0 shadow-xs">
      <div className="flex items-center gap-3 border-b-2 border-brand-gold bg-gradient-to-br from-brand-green to-brand-green-dark px-5 py-4 text-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo-160.png" alt="" width={40} height={40} className="size-10 shrink-0 rounded-full bg-white/95 p-0.5" />
        <div className="min-w-0">
          <h3 className="truncate font-semibold">Shepherd Angels Christian School</h3>
          <p className="truncate text-sm text-white/80">{issued ? `${payslip.period_label} · Issued ${issued}` : payslip.period_label}</p>
        </div>
        {payslip.payslip_no ? <span className="ml-auto hidden shrink-0 font-mono text-xs text-brand-gold-light sm:block">{payslip.payslip_no}</span> : null}
      </div>
      <CardContent className="px-5 py-4">
        <dl className="space-y-2.5 text-sm">
          {payslipRows(payslip).map((row, index) => (
            <div key={`${row.label}-${index}`} className={cn("flex items-start justify-between gap-4", KIND_CLASS[row.kind])}>
              <dt className="min-w-0">{row.label}</dt>
              {row.value ? <dd className="shrink-0 tabular-nums">{row.value}</dd> : null}
            </div>
          ))}
        </dl>
      </CardContent>
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-2 bg-primary/8 px-5 py-4">
        <span className="text-sm font-medium">{netName} — {payslip.period_label}</span>
        <span className="text-2xl font-semibold text-primary tabular-nums">{formatPeso(payslip.net_pay)}</span>
      </div>
    </Card>
  );
}

export function PayslipsPage({ payslips }) {
  const [selected, setSelected] = React.useState(0);
  const list = payslips.list;
  const current = list[selected] || list[0] || null;

  const columns = React.useMemo(() => [
    { key: "period_label", header: "Pay period", className: "font-medium", searchValue: (p) => p.period_label },
    { key: "payslip_no", header: "Payslip no.", className: "font-mono text-xs", cell: (p) => p.payslip_no || "—", searchValue: (p) => p.payslip_no },
    { key: "processed_at", header: "Issued", sortValue: (p) => p.processed_at || "", cell: (p) => formatIssued(p.processed_at, "short") || "—" },
    { key: "net_pay", header: "Net pay", align: "right", sortValue: (p) => Number(p.net_pay || 0), className: "tabular-nums", cell: (p) => formatPesoShort(p.net_pay) },
    {
      key: "view",
      header: <span className="sr-only">View</span>,
      align: "right",
      cell: (p) => {
        const index = list.indexOf(p);
        const isOpen = list[selected] === p;
        return (
          <Button variant={isOpen ? "secondary" : "outline"} size="sm" onClick={() => setSelected(index)} aria-pressed={isOpen}>
            <EyeIcon aria-hidden="true" />{isOpen ? "Showing" : "View"}
          </Button>
        );
      },
    },
  ], [list, selected]);

  if (payslips.loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-96 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }
  if (payslips.error && !list.length) {
    return <Card className="shadow-xs"><CardContent><ErrorState message={payslips.error} onRetry={payslips.reload} /></CardContent></Card>;
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section aria-label={selected === 0 ? "Latest payslip" : "Selected payslip"} className="min-w-0 space-y-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{selected === 0 ? "My latest payslip" : "Selected payslip"}</p>
        <PayslipCard payslip={current} />
      </section>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>All payslips</CardTitle>
          <CardDescription>Choose View to open an earlier payslip.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={list}
            rowKey={(p, i) => p.id || `${p.period_label}-${i}`}
            rowClassName={(p) => (list[selected] === p ? "bg-primary/5" : undefined)}
            searchPlaceholder="Search payslips…"
            empty={{ title: "No payslips yet", icon: ReceiptTextIcon }}
            caption="Payslips"
            minWidth={560}
          />
        </CardContent>
      </Card>
    </div>
  );
}
