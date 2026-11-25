/**
 * A processed payslip as the screens and the PDF show it, built from a
 * payroll_entries row. Shared by the Accountant's Pay Record
 * (/api/accountant/payroll) and HR's read-only Payroll Records
 * (/api/hr/payroll-records), so both show the same payslip.
 */

import { dateTimeText } from "@/lib/payroll/final-pay-text";
import { readFileSync } from "node:fs";
import path from "node:path";
import { holidayPayLines } from "@/lib/payroll/holiday-lines";
import { employeePayslipView, payrollLineGroups } from "@/lib/payroll/line-tags";
import { resolveTaxTableRows, taxTableFromRows } from "@/lib/payroll/semi-monthly";
import { classificationLabel } from "@/lib/employees/classification";
import { periodFromLabel } from "@/lib/payroll/periods";
import { paidLeaveDailyRate, payslipTables } from "@/lib/payroll/payslip-tables";
import { fetchAllIn } from "@/lib/supabase/fetch-all";

/**
 * payroll_tax_brackets rows (every version), for the withholding tax line's
 * bracket range on a payslip; [] when they cannot be read.
 */
export async function loadTaxBracketRows(supabase) {
  try {
    const result = await supabase.from("payroll_tax_brackets").select("version_id,effective_date,bracket_over,base_tax,rate_pct,created_at");
    return result.error ? [] : result.data || [];
  } catch {
    return [];
  }
}

/** The tax table version in force on the payslip's period (the one the engine used). */
function taxTableForPayroll(taxRows, payroll) {
  const start = payroll?.audit?.period?.start_key;
  if (!start || !Array.isArray(taxRows) || !taxRows.length) return [];
  return taxTableFromRows(resolveTaxTableRows(taxRows, start));
}

/**
 * The school seal printed on payslip PDFs. Replace the file to change it
 * (JPEG, square, about 300 x 300 px); shipped with this route by
 * next.config.mjs outputFileTracingIncludes. Missing -> no seal.
 */
const SEAL_FILE = path.join(process.cwd(), "public", "brand", "seal-payslip.jpg");
let sealCache;
export function payslipSeal() {
  if (sealCache === undefined) {
    try {
      sealCache = readFileSync(SEAL_FILE);
    } catch {
      sealCache = null;
    }
  }
  return sealCache;
}

/**
 * A payslip that did not record its branch (a final pay): the employee's
 * branch now, so the payslip's Branch is not "—". The entry otherwise as is.
 */
export async function withBranchName(supabase, entry) {
  if (!entry?.payroll || entry.payroll.generation?.branch_name || entry.payroll.payslip_meta?.branch_name) return entry;
  try {
    const profile = await supabase.from("profiles").select("branch_id").eq("id", entry.employee_id).maybeSingle();
    const branchId = profile.data?.branch_id;
    const branch = branchId ? await supabase.from("branches").select("name").eq("id", branchId).maybeSingle() : null;
    if (!branch?.data?.name) return entry;
    return { ...entry, payroll: { ...entry.payroll, payslip_meta: { ...(entry.payroll.payslip_meta || {}), branch_name: branch.data.name } } };
  } catch {
    return entry;
  }
}

/** "Oct 12, 2026, 09:30 AM" (Manila). */
function formatManilaDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || "");
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

/** "Nov 19, 2026" (Manila): a payslip's pay date. */
export function formatManilaDate(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" }).format(date);
}

/**
 * What the payslip is, in the employee's words (2026-11-19): Draft while the
 * period is open; Paid once HR approved its run (approved_at; a payslip with
 * no run -- a final pay -- has its own approval); else Pending HR approval,
 * or Returned by HR when the run was sent back. A label only: the status
 * rules themselves are unchanged.
 */
export function payslipStatus(entry, runStatus = null) {
  if (entry?.status === "draft") return { label: "Draft", pay_date_label: null };
  // A final pay (20261120010000): written only when HR approves it; older ones were released before that rule.
  const finalPay = entry?.payroll?.final_pay;
  if (finalPay && entry?.status === "paid") {
    const approval = finalPay.approval || null;
    return {
      label: approval ? "Paid" : "Released before HR approval was required",
      pay_date_label: formatManilaDate(finalPay.release_on ? `${finalPay.release_on}T12:00:00+08:00` : null),
      approval_line: approval
        ? `Approved by ${approval.approved_by_name}${approval.approved_by_role === "super_admin" ? " (Super Admin, stand-in for HR)" : " (HR)"} on ${dateTimeText(approval.approved_at)}`
        : "Released before HR approval was required",
    };
  }
  if (entry?.approved_at || !entry?.run_id) return { label: "Paid", pay_date_label: formatManilaDate(entry?.approved_at) };
  if (runStatus === "rejected") return { label: "Returned by HR", pay_date_label: null };
  return { label: "Pending HR approval", pay_date_label: null };
}

export function buildPayslipDetails(entry, { taxRows = [], runStatus = null } = {}) {
  if (!entry) return null;
  const generation = entry.payroll?.generation || null;
  const taxTable = taxTableForPayroll(taxRows, entry.payroll);
  // The employee's view of the same stored figures: on a 2nd half, the monthly tax computation and the month total.
  const view = employeePayslipView(entry.payroll, { taxTable });
  const state = payslipStatus(entry, runStatus);

  return {
    entry_id: entry.id,
    payslip_no: entry.payslip_no || null,
    pay_period: entry.pay_period,
    // The daily rate the payslip already uses: the peso amount of its paid leave days (display only).
    leave_daily_rate: paidLeaveDailyRate(entry.payroll),
    issued_at: entry.submitted_at || entry.updated_at || entry.created_at,
    // Draft while the period is open; Final (locked) once processed.
    status: entry.status === "draft" ? "draft" : "final",
    status_label: state.label,
    pay_date_label: state.pay_date_label,
    approval_line: state.approval_line || null,
    tax_box: view?.tax_box || null,
    month_total: view?.month_total || null,
    generation: generation
      ? {
        attendance_through: generation.attendance_through || null,
        attendance_through_label: generation.attendance_through_label || null,
        generated_at: generation.generated_at || null,
        generated_at_label: generation.generated_at ? formatManilaDateTime(generation.generated_at) : null,
        generated_by_name: generation.generated_by_name || null,
        regenerations: generation.regenerations || 0,
        confirmed_incomplete: generation.confirmed_incomplete || [],
        override: generation.override || null,
      }
      : null,
    attendance_summary: generation?.attendance_summary || null,
    deduction_basis: generation?.deduction_basis || [],
    employee: {
      id: entry.employee_code,
      name: entry.employee_name,
      // "Teaching · Regular · Full-time" when the payslip kept it (from 20261121010000).
      type: classificationLabel(entry.payroll?.payslip_meta?.classification || {}) || entry.employee_type,
      position: generation?.position_title || entry.payroll?.payslip_meta?.position_title || entry.position,
      branch: generation?.branch_name || entry.payroll?.payslip_meta?.branch_name || null,
      // Days worked in each branch when there was more than one (a transfer).
      branch_days: generation?.branch_days || entry.payroll?.payslip_meta?.branch_days || null,
    },
    earnings: {
      basic_salary: entry.payroll.basic_salary,
      overtime: entry.payroll.totals.overtime_pay ?? 0,
      holiday_pay: entry.payroll.totals.holiday_pay ?? 0,
      gross_pay: entry.payroll.totals.gross_pay,
    },
    // Each holiday worked: name, day, hours and premium (src/lib/payroll/holiday-lines.js).
    holiday_lines: holidayPayLines(entry.payroll),
    deductions: {
      sss: entry.payroll.deductions.sss,
      philhealth: entry.payroll.deductions.philhealth,
      pagibig: entry.payroll.deductions.pagibig,
      withholding_tax: entry.payroll.deductions.withholding_tax,
      absences_days: entry.payroll.deductions.absences_days,
      late_days: entry.payroll.deductions.late_days ?? 0,
      absence_deduction: entry.payroll.totals.absence_deduction,
      leave_with_pay_days: entry.payroll.deductions.leave_with_pay_days ?? 0,
      leave_without_pay_days: entry.payroll.deductions.leave_without_pay_days ?? 0,
      leave_without_pay_deduction: entry.payroll.totals.leave_without_pay_deduction ?? 0,
      late_minutes: entry.payroll.deductions.late_minutes ?? 0,
      late_deduction: entry.payroll.totals.late_deduction ?? 0,
      undertime_minutes: entry.payroll.deductions.undertime_minutes ?? 0,
      undertime_deduction: entry.payroll.totals.undertime_deduction ?? 0,
      half_days: entry.payroll.deductions.half_days ?? 0,
      half_day_deduction: entry.payroll.totals.half_day_deduction ?? 0,
      cash_advance: entry.payroll.deductions.cash_advance ?? 0,
      total_deductions: entry.payroll.totals.total_deductions,
    },
    // The school's payroll sheet columns and the cash advances repaid.
    sheet: entry.payroll.sheet || null,
    cash_advances: entry.payroll.cash_advances || [],
    incentives: {
      early_bird_days: entry.payroll.incentives?.early_bird_days ?? 0,
      early_bird_incentive: entry.payroll.totals.early_bird_incentive ?? 0,
      perfect_attendance: entry.payroll.incentives?.perfect_attendance === true,
      perfect_attendance_incentive: entry.payroll.totals.perfect_attendance_incentive ?? 0,
      // The period's Early Bird winner (only on the winner's payslip).
      early_bird_winner_incentive: entry.payroll.totals.early_bird_winner_incentive ?? 0,
      early_bird_winner: entry.payroll.early_bird || null,
      total_incentives: entry.payroll.totals.total_incentives ?? 0,
    },
    net_pay: entry.payroll.totals.net_pay,
    // Semi-monthly: the month's computation (2nd half) or the half-salary
    // 1st half; rendered instead of the per-period breakdown.
    monthly: entry.payroll.monthly || null,
    // Every line grouped and tagged (2026-11-03, src/lib/payroll/line-tags.js),
    // from the payslip's own stored figures; null when they do not support it.
    // A final pay's stored breakdown (13th month, subsidy, leave conversion, loans): src/lib/payroll/payslip-tables.js.
    final_pay: entry.payroll.final_pay?.breakdown || null,
    final_pay_overpayment: entry.payroll.final_pay?.overpayment_to_recover || 0,
    // A hire on the 16th (one whole-month 2nd half) has no grouped lines: the employee's view of it.
    line_groups: payrollLineGroups(entry.payroll, { taxTable }) || view,
  };
}

/* ── Year to date (2026-11-22) ── */

const cents = (value) => Math.round((Number(value) || 0) * 100);
const sumKeys = (rows, keys) => rows.filter((r) => keys.includes(r.key) && !r.text).reduce((t, r) => t + (r.credit ? -1 : 1) * Math.abs(cents(r.amount)), 0);

/**
 * Year-to-date figures from payslips as they are shown (buildPayslipDetails +
 * payslipTables, the stored figures only): gross pay, taxable income (the
 * 2nd-half monthly computation), withholding tax and the employee's SSS,
 * PhilHealth and Pag-IBIG.
 */
export function payslipYtd(detailsList) {
  const total = { gross: 0, taxable: 0, tax: 0, sss: 0, philhealth: 0, pagibig: 0 };
  for (const d of detailsList.filter(Boolean)) {
    const t = payslipTables(d);
    total.gross += cents(t ? t.gross : d.earnings?.gross_pay);
    const taxable = d.tax_box?.taxable ?? (d.monthly?.half === "second" ? d.monthly.taxable_income : d.final_pay?.taxable_income);
    total.taxable += cents(taxable);
    const rows = t?.deductions || [];
    total.tax += t ? sumKeys(rows, ["withholding_tax", "year_end_tax", "year_end_refund"]) : cents(d.deductions?.withholding_tax);
    total.sss += t ? sumKeys(rows, ["sss"]) : cents(d.deductions?.sss);
    total.philhealth += t ? sumKeys(rows, ["philhealth"]) : cents(d.deductions?.philhealth);
    total.pagibig += t ? sumKeys(rows, ["pagibig"]) : cents(d.deductions?.pagibig);
  }
  return Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v / 100]));
}

function asEntry(row) {
  let payroll = row.payroll;
  if (typeof payroll === "string") {
    try { payroll = JSON.parse(payroll); } catch { payroll = null; }
  }
  payroll = payroll && typeof payroll === "object" ? payroll : {};
  return { ...row, status: String(row.status || "").toLowerCase(), payroll: { ...payroll, totals: payroll.totals || {}, deductions: payroll.deductions || {}, incentives: payroll.incentives || {} } };
}

/**
 * This payslip's year to date: its own figures plus the employee's released
 * payslips earlier in the same calendar year (a pay period counts once its
 * run is approved). A final pay counts every released period of its year.
 * null when the history cannot be read (the PDF then leaves the box out).
 */
export async function loadPayslipYtd(supabase, entry, details) {
  if (!supabase || !entry?.employee_id || !details) return null;
  const own = periodFromLabel(entry.pay_period || "");
  const year = own?.start_key?.slice(0, 4) || String(entry.approved_at || entry.submitted_at || entry.created_at || "").slice(0, 4);
  if (!/^\d{4}$/.test(year)) return null;
  try {
    const found = await supabase.from("payroll_entries").select("id,employee_id,pay_period,status,run_id,payroll").eq("employee_id", entry.employee_id).neq("status", "draft").like("pay_period", `%${year}%`);
    if (found.error) return null;
    const earlier = (found.data || []).filter((row) => {
      if (String(row.id) === String(entry.id)) return false;
      const p = periodFromLabel(row.pay_period || "");
      return Boolean(p && row.run_id && p.start_key.startsWith(year) && (!own || p.start_key < own.start_key));
    });
    const runIds = [...new Set(earlier.map((row) => row.run_id))];
    const runs = runIds.length ? await fetchAllIn(() => supabase.from("payroll_runs").select("id").eq("status", "approved"), "id", runIds) : { data: [] };
    if (runs.error) return null;
    const approved = new Set((runs.data || []).map((r) => String(r.id)));
    const priorRows = earlier.filter((row) => approved.has(String(row.run_id)));
    const prior = priorRows.map((row) => buildPayslipDetails(asEntry(row)));
    // 13th month accrued to date (2026-11-24): basic pay earned this year ÷ 12; paid in December, not before.
    const basicOf = (row) => Math.round((Number(asEntry(row).payroll.basic_earned) || 0) * 100);
    const basic = ([...priorRows, entry].reduce((sum, row) => sum + basicOf(row), 0)) / 100;
    return { year, ...payslipYtd([...prior, details]), basic, thirteenth_accrued: Math.round((basic / 12) * 100) / 100, payslips: prior.length + 1 };
  } catch {
    return null;
  }
}

/**
 * A 13th month payout (payroll_thirteenth_month row) as payslip details, for
 * the same PDF layout as a final pay (2026-11-22): one line, basic pay earned
 * in the year ÷ 12, no deductions; the stored amount only.
 */
export function thirteenthMonthDetails(row, employee = {}) {
  if (!row) return null;
  const amount = Math.round((Number(row.amount) || 0) * 100) / 100;
  const basic = Math.round((Number(row.basic_earned) || 0) * 100) / 100;
  const peso = (n) => `₱${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const periods = Array.isArray(row.breakdown?.periods) ? row.breakdown.periods.length : 0;
  return {
    entry_id: row.id,
    payslip_no: row.payslip_no || `13M-${row.year}-${String(employee.id || row.employee_id || "").slice(-6)}`,
    pay_period: `13th month pay ${row.year}`,
    pay_type: "13th month",
    status: "final",
    status_label: "Paid",
    pay_date_label: row.processed_at ? formatManilaDate(row.processed_at) : "—",
    employee: { id: employee.id || null, name: employee.name || row.employee_name, type: employee.type || null, position: employee.position || null, branch: employee.branch || null },
    final_pay: {
      earnings: [{ kind: "thirteenth_month", label: "13th month pay", amount, note: `Basic pay earned ${peso(basic)} ÷ 12${periods ? ` (${periods} payslips)` : ""}` }],
      deductions: [],
      gross: amount,
      total_deductions: 0,
    },
    net_pay: amount,
  };
}
