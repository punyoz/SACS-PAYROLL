/**
 * The Accountant's Payroll Records table and its Excel / PDF export use these
 * same search fields, sortable columns and status words (2026-11-19).
 */
import { recordStatusMeta } from "@/lib/portal/payroll-preview";

export const recordSearchFields = (r) => [r.employee_name, r.pay_period];

export const RECORD_SORTS = {
  employee_name: { label: "Employee", value: (r) => r.employee_name },
  pay_period: { label: "Period", value: (r) => r.pay_period },
  gross_pay: { label: "Gross pay", value: (r) => Number(r.gross_pay || 0) },
  total_deductions: { label: "Deductions", value: (r) => Number(r.total_deductions || 0) },
  net_pay: { label: "Net pay", value: (r) => Number(r.net_pay || 0) },
  status: { label: "Status", value: (r) => recordStatusMeta(r).label },
};

export const recordStatusLabel = (r) => recordStatusMeta(r).label;
