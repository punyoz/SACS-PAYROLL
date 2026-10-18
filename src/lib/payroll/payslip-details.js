/**
 * A processed payslip as the screens and the PDF show it, built from a
 * payroll_entries row. Shared by the Accountant's Pay Record
 * (/api/accountant/payroll) and HR's read-only Payroll Records
 * (/api/hr/payroll-records), so both show the same payslip.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { holidayPayLines } from "@/lib/payroll/holiday-lines";

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

/** "Oct 12, 2026, 09:30 AM" (Manila). */
function formatManilaDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || "");
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export function buildPayslipDetails(entry) {
  if (!entry) return null;
  const generation = entry.payroll?.generation || null;

  return {
    entry_id: entry.id,
    payslip_no: entry.payslip_no || null,
    pay_period: entry.pay_period,
    issued_at: entry.submitted_at || entry.updated_at || entry.created_at,
    // Draft while the period is open; Final (locked) once processed.
    status: entry.status === "draft" ? "draft" : "final",
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
      type: entry.employee_type,
      position: generation?.position_title || entry.position,
      branch: generation?.branch_name || null,
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
  };
}
