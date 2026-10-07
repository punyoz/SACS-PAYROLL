"use client";

import * as React from "react";
import { DownloadIcon, FileTextIcon, Loader2Icon, PrinterIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataTable } from "@/components/portal/data-table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson } from "@/lib/portal/api";
import { dateLabel, money, moneyCompact, statusMeta, toAmount } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";
import { useAccountant } from "./accountant-data";

/*
 * Payroll Reports (generateReport / generatePayrollSheet /
 * generateHolidayWorkReport and their CSV exports, accountant.js). Summary
 * and Deductions come from the loaded records; the Payroll Sheet (?view=
 * payroll_sheet) and Holiday Work (?view=holiday_work) are built on the
 * server.
 */

/** Quoted, formula-safe CSV, as the legacy exports wrote it. */
function downloadQuotedCsv(filename, headers, rows) {
  const text = (v) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s; };
  const csv = [headers, ...rows].map((row) => row.map((v) => `"${text(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const sheetMoney = (v) => { const n = toAmount(v); return n ? n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-"; };
const sheetNumber = (v) => { const n = Number(v) || 0; return n ? n.toLocaleString("en-PH", { maximumFractionDigits: 2 }) : "-"; };

const SHEET_HEAD = ["Employees", "Days", "Reg. hrs.", "Rate", "Amount", "OT", "Rate", "Amount", "Other pay", "Total amount", "Cash advance", "SSS", "PhilHealth", "Pag-IBIG", "Tax", "Late / undertime", "Total deduction", "Net pay", "Signature"];

function PayrollSheet({ data }) {
  const header = data.header || {};
  const school = header.school_name || "Shepherd Angels Christian School";
  if (!(data.branches || []).length) {
    return <EmptyState icon={FileTextIcon} title="No payslips for this period yet" description="Generate or process payroll first." />;
  }
  return (
    <div className="space-y-6">
      {data.branches.map((branch) => (
        <div key={branch.branch_name} className="space-y-3 break-inside-avoid">
          <div className="text-center font-semibold underline">
            <p>{school}</p>
            <p>PAYROLL — {String(branch.branch_name).toUpperCase()}</p>
          </div>
          <p className="text-xs text-muted-foreground">
            FOR THE PERIOD OF <strong className="text-destructive">{String(data.period?.label || "").toUpperCase()}</strong>, WE HEREBY ACKNOWLEDGE TO HAVE RECEIVED FROM {school} the sum specified opposite our respective names, as full compensation for services rendered.
          </p>
          {data.attendance_window ? <p className="text-xs text-muted-foreground">Days, absences and deductions are from attendance {dateLabel(data.attendance_window.start_key)} – {dateLabel(data.attendance_window.end_key)}.</p> : null}
          <div className="overflow-x-auto rounded-lg border">
            <Table className="text-xs" style={{ minWidth: 1500 }}>
              <TableHeader className="bg-muted/60">
                <TableRow className="hover:bg-transparent">{SHEET_HEAD.map((h, i) => <TableHead key={`${h}-${i}`} className="h-9 text-xs font-semibold text-muted-foreground">{h}</TableHead>)}</TableRow>
              </TableHeader>
              <TableBody>
                {branch.rows.map((r, i) => (
                  <TableRow key={`${r.name}-${i}`}>
                    <TableCell className="font-medium">{r.name}{r.status === "draft" ? <StatusBadge tone="info" className="ml-1.5">Draft</StatusBadge> : null}</TableCell>
                    {[sheetNumber(r.days), sheetNumber(r.regular_hours), sheetMoney(r.rate), sheetMoney(r.amount), sheetNumber(r.ot_hours), sheetMoney(r.ot_rate), sheetMoney(r.ot_amount), sheetMoney(r.other_pay), sheetMoney(r.total_amount), sheetMoney(r.cash_advance), sheetMoney(r.sss), sheetMoney(r.philhealth), sheetMoney(r.pagibig), sheetMoney(r.withholding_tax), sheetMoney(r.late_undertime), sheetMoney(r.total_deduction)]
                      .map((v, c) => <TableCell key={c} className="text-right tabular-nums">{v}</TableCell>)}
                    <TableCell className="text-right font-semibold tabular-nums">{sheetMoney(r.net_pay)}{r.net_note ? <p className="text-[10px] font-normal whitespace-normal text-muted-foreground">{r.net_note}</p> : null}</TableCell>
                    <TableCell className="min-w-28" />
                  </TableRow>
                ))}
                <TableRow className="bg-muted/60 font-semibold hover:bg-muted/60">
                  <TableCell>TOTAL NET PAY</TableCell><TableCell /><TableCell />
                  <TableCell className="text-right tabular-nums">{sheetMoney(branch.totals.rate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{sheetMoney(branch.totals.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{sheetNumber(branch.totals.ot_hours)}</TableCell><TableCell />
                  {["ot_amount", "other_pay", "total_amount", "cash_advance", "sss", "philhealth", "pagibig", "withholding_tax", "late_undertime", "total_deduction", "net_pay"].map((f) => <TableCell key={f} className="text-right tabular-nums">{sheetMoney(branch.totals[f])}</TableCell>)}
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <div className="text-xs">
            <p className="font-semibold">APPROVED FOR PAYMENT</p>
            <p className="mt-6 font-semibold">{header.approver_name || "______________________________"}</p>
            <p>{header.approver_title || ""}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ReportsPage() {
  const { data } = useAccountant();
  const { notify } = usePortalSession();
  const [period, setPeriod] = React.useState("all");
  const [type, setType] = React.useState("summary");
  const [branch, setBranch] = React.useState("all");
  const [branchOptions, setBranchOptions] = React.useState([]);
  const [report, setReport] = React.useState(null); // { type, period, rows | sheet | holiday }
  const [state, setState] = React.useState({ loading: false, error: null });

  const periods = data?.period_options || [];
  const all = [...(data?.records || []), ...(data?.draft_entries || [])];

  async function generate() {
    setState({ loading: false, error: null });
    if (type === "summary" || type === "deductions") {
      setReport({ type, period, rows: period === "all" ? all : all.filter((r) => r.pay_period === period) });
      return;
    }
    if (type === "sheet" && period === "all") {
      notify("Choose a Period", "The payroll sheet is for one pay period. Choose it under Pay Period.", "info");
      return;
    }
    setState({ loading: true, error: null });
    try {
      if (type === "sheet") {
        const sheet = await fetchJson(`/api/accountant/payroll?view=payroll_sheet&period=${encodeURIComponent(period)}&branch_id=${encodeURIComponent(branch)}`);
        setBranchOptions(sheet.branch_options || []);
        setReport({ type, period, sheet });
      } else {
        const holiday = await fetchJson(`/api/accountant/payroll?view=holiday_work&period=${encodeURIComponent(period)}`);
        setReport({ type, period, holiday });
      }
      setState({ loading: false, error: null });
    } catch (error) {
      setReport(null);
      setState({ loading: false, error: error.message || "Unable to load the report." });
    }
  }

  function exportCsv() {
    if (!report) { notify("No Data", "Generate a report first before exporting.", "info"); return; }
    if (report.type === "sheet") {
      const sheet = report.sheet;
      if (!sheet?.branches?.length) { notify("No Data", "Generate the payroll sheet first before exporting.", "info"); return; }
      const fields = ["days", "regular_hours", "rate", "amount", "ot_hours", "ot_rate", "ot_amount", "other_pay", "total_amount", "cash_advance", "sss", "philhealth", "pagibig", "withholding_tax", "late_undertime", "total_deduction", "net_pay"];
      const rows = [];
      sheet.branches.forEach((b) => {
        b.rows.forEach((r) => rows.push([b.branch_name, r.name, r.status, ...fields.map((f) => String(Number(r[f]) || 0)), ""]));
        rows.push([b.branch_name, "TOTAL NET PAY", "", "", "", ...["rate", "amount", "ot_hours"].map((f) => String(Number(b.totals[f]) || 0)), "",
          ...["ot_amount", "other_pay", "total_amount", "cash_advance", "sss", "philhealth", "pagibig", "withholding_tax", "late_undertime", "total_deduction", "net_pay"].map((f) => String(Number(b.totals[f]) || 0)), ""]);
      });
      downloadQuotedCsv(`payroll-sheet-${String(sheet.period?.label || "period").replace(/[^\w-]+/g, "-")}.csv`,
        ["Branch", "Employee", "Status", "Days", "Reg. Hrs.", "Rate", "Amount", "OT Hours", "OT Rate", "OT Amount", "Other Pay", "Total Amount", "Cash Advance", "SSS", "PhilHealth", "Pag-IBIG", "Tax", "Late/Undertime", "Total Deduction", "Net Pay", "Signature"], rows);
      return;
    }
    if (report.type === "holidays") {
      const rows = report.holiday?.rows || [];
      if (!rows.length) { notify("No Data", "Generate the Holiday Work report first before exporting.", "info"); return; }
      downloadQuotedCsv(`holiday-work-${report.holiday.period || "all"}.csv`,
        ["Date", "Holiday", "Type", "Employee", "Employee ID", "Pay Period", "Hours", "Premium", "Payslip No.", "Status"],
        rows.map((r) => [r.date || "", r.holiday || "", r.type === "special" ? "Special day" : "Regular holiday", r.employee_name || "", r.employee_code || "", r.pay_period || "", r.hours ?? "", String(toAmount(r.amount)), r.payslip_no || "", r.status || ""]));
      return;
    }
    if (!report.rows.length) { notify("No Data", "Generate a report first before exporting.", "info"); return; }
    downloadQuotedCsv(`payroll-report-${report.period}.csv`, ["Employee", "Pay Period", "Gross Pay", "Total Deductions", "Net Pay", "Status"],
      report.rows.map((r) => [r.employee_name || "", r.pay_period || "", String(toAmount(r.gross_pay)), String(toAmount(r.total_deductions)), String(toAmount(r.net_pay)), r.status || ""]));
  }

  // Report summary (the right-hand box).
  let summary = null;
  if (report?.type === "summary" || report?.type === "deductions") {
    const sum = (k) => report.rows.reduce((s, r) => s + Number(r[k] || 0), 0);
    summary = [["Records", String(report.rows.length)], ["Total gross pay", money(sum("gross_pay"))], ["Total deductions", `- ${money(sum("total_deductions"))}`, "minus"], ["Total net pay", money(sum("net_pay")), "total"]];
  } else if (report?.type === "sheet") {
    const t = report.sheet.grand_totals || {};
    summary = [
      ["Payslips", `${(report.sheet.branches || []).reduce((n, b) => n + b.rows.length, 0)}${report.sheet.draft_count ? ` (${report.sheet.draft_count} draft)` : ""}`],
      ["Total amount", money(t.total_amount || 0)], ["Total deduction", `- ${money(t.total_deduction || 0)}`, "minus"], ["Total net pay", money(t.net_pay || 0), "total"],
      ...(report.sheet.missing?.length ? [["No payslip yet", `${report.sheet.missing.length} employee${report.sheet.missing.length === 1 ? "" : "s"}`, "warn"]] : []),
    ];
  } else if (report?.type === "holidays") {
    const t = report.holiday.totals || {};
    summary = [["Employees", String(Number(t.employees || 0))], ["Holiday days worked", String(Number(t.days || 0))], ["Hours", String(Number(t.hours || 0))], ["Total holiday premium", money(t.amount || 0), "total"]];
  }

  const recordColumns = report?.type === "deductions" ? [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium" },
    { key: "pay_period", header: "Period" },
    ...[["sss", "SSS"], ["philhealth", "PhilHealth"], ["pagibig", "Pag-IBIG"], ["withholding_tax", "Tax"]].map(([k, h]) => ({ key: k, header: h, align: "right", className: "tabular-nums", cell: (r) => moneyCompact(r.payroll?.deductions?.[k] || 0) })),
    { key: "absence", header: "Absence ded.", align: "right", className: "tabular-nums", cell: (r) => moneyCompact(r.payroll?.totals?.absence_deduction || 0) },
    { key: "net_pay", header: "Net pay", align: "right", className: "tabular-nums font-medium", cell: (r) => moneyCompact(r.net_pay) },
  ] : [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium" },
    { key: "pay_period", header: "Period", sortable: true },
    { key: "gross_pay", header: "Gross pay", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.gross_pay || 0), cell: (r) => moneyCompact(r.gross_pay) },
    { key: "total_deductions", header: "Deductions", align: "right", className: "tabular-nums", cell: (r) => moneyCompact(r.total_deductions) },
    { key: "net_pay", header: "Net pay", align: "right", className: "tabular-nums font-medium", sortValue: (r) => Number(r.net_pay || 0), cell: (r) => moneyCompact(r.net_pay) },
    { key: "status", header: "Status", cell: (r) => { const s = statusMeta(r.status); return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>; } },
  ];

  const holidayColumns = [
    { key: "date", header: "Date", sortable: true, className: "whitespace-nowrap tabular-nums", cell: (r) => dateLabel(r.date) },
    { key: "holiday", header: "Holiday", cell: (r) => <div><p>{r.holiday}</p><p className="text-xs text-muted-foreground">{r.type === "special" ? "Special day" : "Regular holiday"}</p></div> },
    { key: "employee_name", header: "Employee", sortable: true, cell: (r) => <div><p className="font-medium">{r.employee_name}</p><p className="text-xs text-muted-foreground">{r.employee_code || ""}</p></div> },
    { key: "hours", header: "Hours", align: "right", className: "tabular-nums", cell: (r) => (r.hours === null || r.hours === undefined ? "—" : String(r.hours)) },
    { key: "amount", header: "Premium", align: "right", className: "tabular-nums", cell: (r) => money(r.amount) },
    { key: "payslip_no", header: "Payslip", cell: (r) => <div><p>{r.payslip_no || "—"}</p>{r.status === "draft" ? <p className="text-xs text-warning">Draft</p> : null}</div> },
  ];

  const title = report ? `${report.type === "holidays" ? "Holiday work" : report.type === "sheet" ? "Payroll sheet" : "Payroll report"} — ${report.period === "all" ? "All periods" : report.period}` : "Report";

  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card className="shadow-xs">
          <CardHeader><CardTitle>Report settings</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rpt-period">Pay period</Label>
                <Select value={period} onValueChange={setPeriod}>
                  <SelectTrigger id="rpt-period" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">All periods</SelectItem>{periods.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rpt-type">Report type</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger id="rpt-type" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="summary">Payroll summary</SelectItem>
                    <SelectItem value="deductions">Deductions report</SelectItem>
                    <SelectItem value="sheet">Payroll sheet (school format)</SelectItem>
                    <SelectItem value="holidays">Holiday work</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {type === "sheet" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="rpt-branch">Branch</Label>
                  <Select value={branch} onValueChange={setBranch}>
                    <SelectTrigger id="rpt-branch" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="all">All branches</SelectItem>{branchOptions.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={generate} disabled={state.loading}>{state.loading ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Generate report</Button>
              <Button variant="outline" onClick={exportCsv}><DownloadIcon aria-hidden="true" />Export CSV</Button>
              <Button variant="outline" onClick={() => window.print()} disabled={!report}><PrinterIcon aria-hidden="true" />Print</Button>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-xs">
          <CardHeader><CardTitle>Report summary</CardTitle></CardHeader>
          <CardContent>
            {summary ? (
              <dl className="space-y-2">
                {summary.map(([label, value, tone]) => (
                  <div key={label} className={cn("flex items-baseline justify-between gap-4 text-sm", tone === "minus" && "text-destructive", tone === "warn" && "text-warning", tone === "total" && "border-t pt-2 font-semibold")}>
                    <dt>{label}</dt><dd className={cn("tabular-nums", tone === "total" && "text-primary")}>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : <p className="text-sm text-muted-foreground">Select a period and choose Generate report.</p>}
          </CardContent>
        </Card>
      </div>

      <Card data-print-area className="min-w-0 shadow-xs">
        <div className="hidden items-center gap-3 px-6 print:flex">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/legacy/assets/logo.png" alt="" width={56} height={56} className="size-14" />
          <div>
            <p className="font-semibold">Shepherd Angels Christian School</p>
            <p className="text-sm">SACS Payroll Management System — Payroll report</p>
            <p className="text-xs">{report?.period === "all" ? "All periods" : report?.period} · Generated {new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}</p>
          </div>
        </div>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {report?.type === "sheet" ? <CardDescription>One table per branch, with signatures and approval.</CardDescription> : null}
        </CardHeader>
        <CardContent>
          {state.error ? <ErrorState message={state.error} onRetry={generate} />
            : !report && !state.loading ? <EmptyState icon={FileTextIcon} title="No report generated yet" description="Select a period and choose Generate report." />
              : report?.type === "sheet" ? <PayrollSheet data={report.sheet} />
                : report?.type === "holidays" ? (
                  <DataTable columns={holidayColumns} rows={report.holiday?.rows || []} rowKey={(r, i) => `${r.date}-${r.employee_code}-${i}`} searchable={false} pageSize={25} empty={{ title: "No holiday work paid in this period" }} caption={title} minWidth={760} />
                ) : (
                  <DataTable columns={recordColumns} rows={report?.rows || []} loading={state.loading} searchPlaceholder="Search employee…" pageSize={25} empty={{ title: "No records for selected period" }} caption={title} minWidth={760} />
                )}
        </CardContent>
      </Card>
    </>
  );
}
