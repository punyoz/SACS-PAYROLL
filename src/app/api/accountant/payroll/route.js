import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { floorNetPay } from "@/lib/payroll/net-pay";
import crypto from "node:crypto";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { readAllLeaveRequests } from "@/lib/leave-requests/store";
import { listUsersCached } from "@/lib/auth/users-cache";
import { collapseDailyTaps } from "@/lib/attendance/taps";
import { requirePermission } from "@/lib/rbac/guard";
import { SCOPE_ALL } from "@/lib/rbac/permissions";
import { formatDateKey, generationWindow, loadPayCalendar } from "@/lib/payroll/generation-window";
import { buildAttendanceSummary, buildDeductionBasis, money } from "@/lib/payroll/payslip-summary";
import { buildPayslipPdf } from "@/lib/payroll/payslip-pdf";
import {
  SEMI_MONTHLY_RULE,
  SEMI_MONTHLY_RULES_EFFECTIVE,
  computeFirstHalf,
  computeSecondHalf,
  halfOf,
  monthInfo,
  monthKeyOf,
  monthlyWindow,
  overloadPayFor,
  payrollMonthFor,
  resolveTaxTableRows,
  shiftMonth,
  taxTableFromRows,
  usesSemiMonthlyRules,
} from "@/lib/payroll/semi-monthly";
import { basicEarnedFromPayroll, compute13thMonthFromEntries } from "@/lib/payroll/thirteenth-month";
import {
  isUnresolvedStatus,
  normalizeAttendanceStatus as normalizeEngineStatus,
} from "@/lib/attendance/status";
import { computeAttendancePay, peso } from "@/lib/payroll/attendance-pay";
import { DEFAULT_RATES, loadRateConfigs, rateValues, resolveRate, resolveRates } from "@/lib/payroll/rates";
import { periodFromLabel, manilaDateKey } from "@/lib/payroll/periods";
import {
  SEMI_MONTHLY_TAX_TABLE,
  monthlyContributions,
  periodContributions,
  taxableCompensation,
  usesLegalRules,
  withholdingTax as computeWithholdingTax,
} from "@/lib/payroll/statutory";
import { roundPeso } from "@/lib/payroll/money";
import {
  contributionsForHalf,
  halfOfPeriod,
  monthlyContributionsFor,
  periodDaysFor,
  sheetFigures,
  sheetRowFromEntry,
  sheetTotals,
  usesPerHalfRule,
  workingDaysIn,
} from "@/lib/payroll/school-sheet";
import {
  CASH_ADVANCE_STATUSES,
  advanceBalance,
  repaidByAdvance,
  scheduleCashAdvances,
  validateCashAdvanceInput,
} from "@/lib/payroll/cash-advance";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { attendanceChangesAfterFinal } from "@/lib/payroll/final-payslips";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

const DUPLICATE_SUBMISSION_MESSAGE = "Payroll for this employee and period has already been processed.";

/**
 * Nobody processes, adjusts or adds to their own pay. Accountants are on the
 * payroll they run, so without this an Accountant could finalize their own
 * payslip with a raised basic salary, or file incentives and overload hours
 * for themselves. Another Accountant of the branch, or a Super Admin
 * (Generate / Override), handles an Accountant's own payroll.
 */
const OWN_PAYROLL_MESSAGE = "You cannot process or change your own payroll. Another Accountant of your branch or a Super Admin handles it.";

function isOwnPayroll(guard, employeeId) {
  return guard?.scope !== SCOPE_ALL && Boolean(guard?.userId) && String(employeeId || "") === String(guard.userId);
}

function refuseOwnPayroll(guard, employeeId) {
  if (!isOwnPayroll(guard, employeeId)) return null;
  return NextResponse.json({ error: OWN_PAYROLL_MESSAGE, code: "own_payroll" }, { status: 403 });
}

function parseEmployeeIdNumber(employeeId) {
  const match = /^SACS-(\d+)$/i.exec(String(employeeId || "").trim());
  if (!match) return null;
  return Number(match[1]);
}

// Today's calendar date in Asia/Manila, as a local-midnight Date so the
// getFullYear()/getMonth()/getDate() calls below read Manila's date whatever
// timezone the server runs in. new Date() alone is the server's clock — UTC on
// Vercel — so from midnight to 8 AM Manila on the 1st and the 16th, "today's"
// pay period (and the period dropdown's current month) was the previous one.
function manilaToday() {
  const [year, month, day] = manilaDateKey().split("-").map(Number);
  return new Date(year, month - 1, day);
}

// Payroll runs twice a month — cutoff on the 15th and on the last day of the
// month — so every date maps to one of two semi-monthly pay periods.
function getPayPeriodRange(dateInput = manilaToday()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const safeDate = Number.isNaN(date.getTime()) ? manilaToday() : date;

  const year = safeDate.getFullYear();
  const month = safeDate.getMonth();
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
  const isFirstHalf = safeDate.getDate() <= 15;

  const startDay = isFirstHalf ? 1 : 16;
  const endDay = isFirstHalf ? 15 : lastDayOfMonth;
  const pad = (n) => String(n).padStart(2, "0");

  const monthName = new Intl.DateTimeFormat("en-PH", { month: "long" }).format(safeDate);

  return {
    start_key: `${year}-${pad(month + 1)}-${pad(startDay)}`,
    end_key: `${year}-${pad(month + 1)}-${pad(endDay)}`,
    is_first_half: isFirstHalf,
    label: `${monthName} ${startDay}-${endDay}, ${year}`,
  };
}

function formatPeriodLabel(dateInput) {
  return getPayPeriodRange(dateInput).label;
}

function toAmount(value) {
  return roundPeso(value);
}

function normalizePositionForRole(positionInput, roleInput) {
  const role = String(roleInput || "").trim().toLowerCase();
  const position = normalizeText(positionInput).toLowerCase();

  if (role === "accountant" || position === "accountant" || position.includes("account")) {
    return "Accountant";
  }

  return "Employee";
}

function isDuplicateKeyError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return code === "23505" || message.includes("duplicate key");
}

function isInternalDbSchemaError(errorMessage) {
  const message = String(errorMessage || "").toLowerCase();
  return message.includes("has no field \"updated_at\"")
    || message.includes("relation")
    || message.includes("constraint")
    || message.includes("column");
}

function shapeEmployee(user, profile, index) {
  const metadata = user.user_metadata || {};
  const role = String(metadata.role || "employee").toLowerCase();

  return {
    id: user.id,
    role,
    full_name: normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email)),
    email: normalizeText(profile?.email, user.email),
    employee_id: normalizeText(metadata.employee_id, `SACS-${String(index + 1).padStart(3, "0")}`),
    employee_type: normalizeText(metadata.employee_type, "Teaching"),
    position: normalizePositionForRole(metadata.position, role),
    basic_salary: Number(metadata.basic_salary || 0),
    archived: Boolean(metadata.archived),
    // Printed on the payslip.
    position_title: normalizeText(metadata.position),
    // For position-scoped payroll rates (src/lib/payroll/rates.js):
    // profiles.position, which only the server writes. user_metadata.position
    // is editable by the account holder, who could otherwise take on another
    // position's rates.
    rate_position: normalizeText(profile?.position),
    branch_id: profile?.branch_id || metadata.branch_id || null,
  };
}

async function fetchEmployees(supabase, guard = null) {
  const usersResult = await listUsersCached(supabase);
  if (usersResult.error) {
    throw new Error(`Failed to list users: ${usersResult.error.message}`);
  }

  const employeeUsers = (usersResult.data.users || []).filter((user) => {
    const role = String(user.user_metadata?.role || "employee").toLowerCase();
    return role === "employee" || role === "accountant";
  });

  const userIds = employeeUsers.map((user) => user.id);
  const profileMap = new Map();

  if (userIds.length) {
    const profileResult = await supabase
      .from("profiles")
      .select("id,email,full_name,branch_id,position")
      .in("id", userIds);

    if (profileResult.error) {
      throw new Error(`Failed to fetch profiles: ${profileResult.error.message}`);
    }

    (profileResult.data || []).forEach((profile) => {
      profileMap.set(profile.id, profile);
    });
  }

  return employeeUsers
    .map((user, index) => shapeEmployee(user, profileMap.get(user.id), index))
    .filter((employee) => !employee.archived)
    .filter((employee) => {
      if (!guard || guard.branchExempt) return true;
      const branchId = profileMap.get(employee.id)?.branch_id || null;
      return String(branchId || "") === String(guard.branchId || "");
    })
    .sort((a, b) => {
      const idA = parseEmployeeIdNumber(a.employee_id) ?? Number.MAX_SAFE_INTEGER;
      const idB = parseEmployeeIdNumber(b.employee_id) ?? Number.MAX_SAFE_INTEGER;
      if (idA !== idB) return idA - idB;
      return a.full_name.localeCompare(b.full_name);
    });
}

function normalizePayrollEntry(row) {
  let payrollObj = row.payroll;
  if (typeof payrollObj === "string") {
    try { payrollObj = JSON.parse(payrollObj); } catch { payrollObj = null; }
  }

  return {
    id: normalizeText(row.id, crypto.randomUUID()),
    employee_id: normalizeText(row.employee_id),
    employee_name: normalizeText(row.employee_name, "Unknown Employee"),
    employee_code: normalizeText(row.employee_code),
    employee_type: normalizeText(row.employee_type, "Teaching"),
    position: normalizePositionForRole(row.position, row.role),
    pay_period: normalizeText(row.pay_period, formatPeriodLabel(manilaToday())),
    status: normalizeText(row.status, "draft").toLowerCase(),
    approval_id: normalizeText(row.approval_id),
    payslip_no: normalizeText(row.payslip_no) || null,
    submitted_at: row.submitted_at || null,
    created_at: row.created_at || new Date().toISOString(),
    updated_at: row.updated_at || row.created_at || new Date().toISOString(),
    payroll: {
      basic_salary: toAmount(payrollObj?.basic_salary ?? row.basic_salary),
      allowances: {
        transportation: 0,
        rice: 0,
        overtime: toAmount(payrollObj?.allowances?.overtime ?? 0),
        holiday_pay: toAmount(payrollObj?.allowances?.holiday_pay ?? 0),
        bonus: 0,
      },
      deductions: {
        sss: toAmount(payrollObj?.deductions?.sss ?? row.sss),
        philhealth: toAmount(payrollObj?.deductions?.philhealth ?? row.philhealth),
        pagibig: toAmount(payrollObj?.deductions?.pagibig ?? row.pagibig),
        withholding_tax: toAmount(payrollObj?.deductions?.withholding_tax ?? row.withholding_tax),
        absences_days: toAmount(payrollObj?.deductions?.absences_days ?? row.absences_days),
        late_days: toAmount(payrollObj?.deductions?.late_days ?? 0),
        late_minutes: toAmount(payrollObj?.deductions?.late_minutes ?? 0),
        undertime_minutes: toAmount(payrollObj?.deductions?.undertime_minutes ?? 0),
        half_days: toAmount(payrollObj?.deductions?.half_days ?? 0),
        leave_with_pay_days: toAmount(payrollObj?.deductions?.leave_with_pay_days),
        leave_without_pay_days: toAmount(payrollObj?.deductions?.leave_without_pay_days),
        cash_advance: toAmount(payrollObj?.deductions?.cash_advance ?? 0),
      },
      incentives: {
        early_bird_days: toAmount(payrollObj?.incentives?.early_bird_days ?? 0),
        perfect_attendance: payrollObj?.incentives?.perfect_attendance === true,
      },
      totals: {
        cash_advance_deduction: toAmount(payrollObj?.totals?.cash_advance_deduction ?? 0),
        absence_deduction: toAmount(payrollObj?.totals?.absence_deduction ?? row.absence_deduction),
        late_deduction: toAmount(payrollObj?.totals?.late_deduction ?? 0),
        undertime_deduction: toAmount(payrollObj?.totals?.undertime_deduction ?? 0),
        half_day_deduction: toAmount(payrollObj?.totals?.half_day_deduction ?? 0),
        leave_without_pay_deduction: toAmount(payrollObj?.totals?.leave_without_pay_deduction),
        early_bird_incentive: toAmount(payrollObj?.totals?.early_bird_incentive ?? 0),
        perfect_attendance_incentive: toAmount(payrollObj?.totals?.perfect_attendance_incentive ?? 0),
        other_incentive: toAmount(payrollObj?.totals?.other_incentive ?? 0),
        overload_pay: toAmount(payrollObj?.totals?.overload_pay ?? 0),
        carry_over_deduction: toAmount(payrollObj?.totals?.carry_over_deduction ?? 0),
        total_incentives: toAmount(payrollObj?.totals?.total_incentives ?? 0),
        overtime_pay: toAmount(payrollObj?.totals?.overtime_pay ?? 0),
        holiday_pay: toAmount(payrollObj?.totals?.holiday_pay ?? 0),
        gross_pay: toAmount(payrollObj?.totals?.gross_pay ?? row.gross_pay),
        total_deductions: toAmount(payrollObj?.totals?.total_deductions ?? row.total_deductions),
        net_pay: floorNetPay(payrollObj?.totals?.net_pay ?? row.net_pay),
      },
      // Rates, attendance lines and manual deviations behind this entry.
      audit: payrollObj?.audit && typeof payrollObj.audit === "object" ? payrollObj.audit : null,
      // Payslip generation (Generate / Regenerate): Draft or Final, attendance
      // counted up to, who and when, and the attendance snapshot used.
      generation: payrollObj?.generation && typeof payrollObj.generation === "object" ? payrollObj.generation : null,
      // Semi-monthly payroll (src/lib/payroll/semi-monthly.js): the month's
      // computation behind a 1st / 2nd half payslip, and the basic pay it
      // earned for the 13th month.
      monthly: payrollObj?.monthly && typeof payrollObj.monthly === "object" ? payrollObj.monthly : null,
      basic_earned: payrollObj?.basic_earned ?? null,
      // The school's payroll sheet (src/lib/payroll/school-sheet.js): the
      // sheet's columns for this payslip, and the cash advance installments
      // it repaid (src/lib/payroll/cash-advance.js reads these back).
      sheet: payrollObj?.sheet && typeof payrollObj.sheet === "object" ? payrollObj.sheet : null,
      cash_advances: Array.isArray(payrollObj?.cash_advances) ? payrollObj.cash_advances : [],
    },
  };
}

function computeTotals(payroll) {
  const basicSalary = toAmount(payroll.basic_salary);
  // The rate versions in force on the pay period's first day
  // (src/lib/payroll/rates.js); the defaults only apply when none were given.
  const rates = { ...DEFAULT_RATES, ...(payroll.rates || {}) };

  const sss = toAmount(payroll.deductions?.sss);
  const philhealth = toAmount(payroll.deductions?.philhealth);
  const pagibig = toAmount(payroll.deductions?.pagibig);
  const withholdingTax = toAmount(payroll.deductions?.withholding_tax);
  const absencesDays = Math.max(0, toAmount(payroll.deductions?.absences_days));
  const lateDays = Math.max(0, toAmount(payroll.deductions?.late_days));
  const lateMinutes = Math.max(0, toAmount(payroll.deductions?.late_minutes));
  const undertimeMinutes = Math.max(0, toAmount(payroll.deductions?.undertime_minutes));
  const halfDays = Math.max(0, toAmount(payroll.deductions?.half_days));
  const leaveWithPayDays = Math.max(0, toAmount(payroll.deductions?.leave_with_pay_days));
  const leaveWithoutPayDays = Math.max(0, toAmount(payroll.deductions?.leave_without_pay_days));
  const earlyBirdDays = Math.max(0, toAmount(payroll.incentives?.early_bird_days));
  const perfectAttendance = payroll.incentives?.perfect_attendance === true;

  // When the attendance lines were computed (buildEmployeePayroll), their
  // sums are used as they are, so a payslip's totals always equal the sum of
  // its traceable lines. Otherwise the quantities are priced here.
  const amounts = payroll.attendance_amounts || null;
  const daily = Number(rates.daily) || 0;
  const hourly = Number(rates.hourly) || 0;

  // Absent: absent_pct of the (branch's) daily rate. Late: see below.
  // Undertime: minutes ÷ 60 × hourly rate. Half Day: half_day_pct of the
  // daily rate.
  const absentDayAmount = peso(daily * (Number(rates.absent_pct) || 0) / 100);
  const absenceDeduction = amounts
    ? toAmount(amounts.absent)
    : toAmount(absencesDays * absentDayAmount);
  // Late: every late_days_per_absent days = 1 absence, plus the optional
  // per-minute charge (both Super Admin settings).
  const lateDaysPerAbsent = Math.max(0, Math.floor(Number(rates.late_days_per_absent) || 0));
  const lateDeduction = amounts
    ? toAmount(amounts.late)
    : toAmount(
      (lateDaysPerAbsent > 0 ? Math.floor(lateDays / lateDaysPerAbsent) * absentDayAmount : 0)
      + (lateMinutes / 60) * hourly * (Number(rates.late_minute_charge_pct) || 0) / 100,
    );
  const undertimeDeduction = amounts ? toAmount(amounts.undertime) : toAmount((undertimeMinutes / 60) * hourly);
  const halfDayDeduction = amounts
    ? toAmount(amounts.half_day)
    : toAmount(halfDays * peso(daily * (Number(rates.half_day_pct) || 0) / 100));
  // Leave Without Pay deducts one daily rate per day.
  const leaveWithoutPayDeduction = toAmount(leaveWithoutPayDays * daily);
  // Cash advance installments (src/lib/payroll/cash-advance.js).
  const cashAdvance = Math.max(0, toAmount(payroll.deductions?.cash_advance));

  const earlyBirdIncentive = amounts
    ? toAmount(amounts.early_bird)
    : toAmount(earlyBirdDays * (Number(rates.early_bird_bonus) || 0));
  const perfectAttendanceIncentive = amounts
    ? toAmount(amounts.perfect_attendance)
    : (perfectAttendance ? toAmount(rates.perfect_attendance_bonus) : 0);
  // Semi-monthly 2nd half: incentives and overload pay filed for the month
  // (payroll_monthly_incentives).
  const otherIncentive = Math.max(0, toAmount(payroll.extra?.incentive));
  const overloadPay = Math.max(0, toAmount(payroll.extra?.overload));

  // Gross Pay = Basic Salary + approved overtime + holiday pay.
  const overtimePay = Math.max(0, toAmount(payroll.earnings?.overtime));
  const holidayPay = Math.max(0, toAmount(payroll.earnings?.holiday_pay));
  const grossPay = toAmount(basicSalary + overtimePay + holidayPay);
  const totalDeductions = toAmount(
    sss + philhealth + pagibig + withholdingTax
    + absenceDeduction + lateDeduction + undertimeDeduction + halfDayDeduction
    + leaveWithoutPayDeduction + cashAdvance,
  );
  const totalIncentives = toAmount(earlyBirdIncentive + perfectAttendanceIncentive + otherIncentive + overloadPay);
  // Net Pay = Gross - SSS - PhilHealth - Pag-IBIG - Withholding Tax - Absences
  // - Late - Undertime - Half Day - Leave w/o Pay + Incentives.
  // Floored at zero: deductions can exceed the basic salary (absences, Leave
  // Without Pay), and a negative net pay is not a payment. total_deductions
  // stays truthful, so a clamped payslip shows gross - deductions != net by
  // design - see src/lib/payroll/net-pay.js.
  const netPay = floorNetPay(grossPay - totalDeductions + totalIncentives);

  return {
    basic_salary: basicSalary,
    allowances: {
      transportation: 0,
      rice: 0,
      overtime: overtimePay,
      holiday_pay: holidayPay,
      bonus: 0,
    },
    deductions: {
      sss,
      philhealth,
      pagibig,
      withholding_tax: withholdingTax,
      absences_days: absencesDays,
      late_days: lateDays,
      late_minutes: lateMinutes,
      undertime_minutes: undertimeMinutes,
      half_days: halfDays,
      leave_with_pay_days: leaveWithPayDays,
      leave_without_pay_days: leaveWithoutPayDays,
      cash_advance: cashAdvance,
    },
    incentives: {
      early_bird_days: earlyBirdDays,
      perfect_attendance: perfectAttendance,
    },
    totals: {
      cash_advance_deduction: cashAdvance,
      absence_deduction: absenceDeduction,
      late_deduction: lateDeduction,
      undertime_deduction: undertimeDeduction,
      half_day_deduction: halfDayDeduction,
      leave_without_pay_deduction: leaveWithoutPayDeduction,
      early_bird_incentive: earlyBirdIncentive,
      perfect_attendance_incentive: perfectAttendanceIncentive,
      other_incentive: otherIncentive,
      overload_pay: overloadPay,
      total_incentives: totalIncentives,
      overtime_pay: overtimePay,
      holiday_pay: holidayPay,
      gross_pay: grossPay,
      total_deductions: totalDeductions,
      net_pay: netPay,
    },
  };
}

async function readPayrollEntries(supabase) {
  // Every entry, paged: this list drives the duplicate-payment checks and the
  // period picker, and a .limit(2000) used to drop the oldest history
  // silently once the table outgrew it.
  const result = await fetchAllRows(() => supabase
    .from("payroll_entries")
    .select("*")
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true }));

  if (result.error) {
    throw new Error(result.error.message);
  }

  return { entries: Array.isArray(result.data) ? result.data.map(normalizePayrollEntry) : [] };
}

async function syncPayrollEntryToDb(supabase, entry) {
  if (!supabase || !entry?.id) {
    return { success: false, error: "Missing supabase client or entry id." };
  }

  const payload = {
    id: entry.id,
    employee_id: entry.employee_id,
    employee_name: entry.employee_name,
    employee_code: entry.employee_code || null,
    employee_type: entry.employee_type || null,
    position: entry.position || null,
    pay_period: entry.pay_period,
    status: entry.status,
    approval_id: entry.approval_id || null,
    payslip_no: entry.payslip_no || null,
    payroll: entry.payroll,
    submitted_at: entry.submitted_at || null,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };

  try {
    // A single atomic upsert keyed on the real UNIQUE(employee_id, pay_period)
    // constraint (see 20260917030000_payroll_entries_unique_period.sql). Two
    // concurrent submits for the same employee+period now serialize on this
    // one write instead of racing between a delete and an insert — the loser
    // updates the row the winner just created rather than creating a second
    // one. Callers are expected to have looked up any existing row for this
    // employee+period first and reused its id (see POST/handleBatchSubmit),
    // so this never tries to change an existing row's primary key.
    const result = await supabase
      .from("payroll_entries")
      .upsert(payload, { onConflict: "employee_id,pay_period" });

    if (result.error) {
      console.error("[payroll_entries] upsert failed:", result.error.message);
      return { success: false, error: result.error.message, code: result.error.code };
    }

    return { success: true };
  } catch (err) {
    const message = err?.message || String(err);
    console.error("[payroll_entries] sync threw:", message);
    return { success: false, error: message };
  }
}

async function deletePayrollEntryFromDb(supabase, entryId) {
  if (!supabase || !entryId) return;
  const result = await supabase.from("payroll_entries").delete().eq("id", entryId);
  if (result.error) {
    throw new Error(result.error.message);
  }
}

/** The payroll_records row for a processed entry (payslip_no is added by the database). */
function buildRecordPayload(entry) {
  return {
    employee_id: entry.employee_id,
    employee_name: entry.employee_name,
    employee_type: entry.employee_type,
    gross_pay: toAmount(entry.payroll.totals.gross_pay),
    total_deductions: toAmount(entry.payroll.totals.total_deductions),
    // Floored: payroll_records feeds the dashboards and branch reports.
    net_pay: floorNetPay(entry.payroll.totals.net_pay),
    period_label: entry.pay_period,
    processed_at: entry.submitted_at || new Date().toISOString(),
    ...recordAuditColumns(entry),
  };
}

/** The payroll_entries row for a processed entry (payslip_no is added by the database). */
function buildEntryPayload(entry) {
  return {
    id: entry.id,
    employee_id: entry.employee_id,
    employee_name: entry.employee_name,
    employee_code: entry.employee_code || null,
    employee_type: entry.employee_type || null,
    position: entry.position || null,
    pay_period: entry.pay_period,
    status: entry.status,
    approval_id: entry.approval_id || null,
    payroll: entry.payroll,
    submitted_at: entry.submitted_at || null,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

/**
 * Process payslips, all-or-nothing per employee.
 *
 * public.payroll_commit_entries (20260926090000_payroll_legal_rules_and_atomic_commit.sql)
 * writes each employee's payroll_records row, payslip number, payroll_entries
 * row and deduction / incentive lines in one transaction, and takes payslip
 * numbers under a lock. An employee whose write fails leaves nothing behind,
 * so processing them again is always safe; the others are unaffected.
 *
 * @returns {Promise<Array<{ employee_id: string, ok: boolean, record_id?: string,
 *   entry_id?: string, payslip_no?: string, code?: string, error?: string }>>}
 *   one result per entry, in order.
 */
async function commitPayrollEntries(supabase, entries) {
  const items = entries.map((entry) => {
    const lines = buildPayrollLineRows(entry);
    return {
      record: buildRecordPayload(entry),
      entry: buildEntryPayload(entry),
      deductions: lines.deductions,
      incentives: lines.incentives,
    };
  });

  const { data, error } = await supabase.rpc("payroll_commit_entries", { p_items: items });
  if (error) throw new Error(error.message);

  const results = Array.isArray(data) ? data : [];
  return entries.map((entry, index) => results[index] || {
    employee_id: entry.employee_id,
    ok: false,
    error: "The database returned no result for this employee.",
  });
}

/** A failed commit result as a message for the accountant. */
function describeCommitFailure(result) {
  if (String(result?.code || "") === "23505") return DUPLICATE_SUBMISSION_MESSAGE;
  return `Payroll was not saved: ${sanitizeError(result?.error, "the database refused the payslip.")}`;
}

function resolveEntryStatus(entry) {
  return entry.status || "draft";
}

// Buckets the engine's statuses (src/lib/attendance/status.js) for the
// present / late / absent day counts: every attended status is "present",
// Incomplete and Pending Correction are "unresolved" (neither worked nor
// unworked until someone resolves them). On Leave is "leave": the leave
// summary accounts for it, so it is neither present nor absent here.
function normalizeAttendanceStatus(value) {
  const status = normalizeEngineStatus(value, "Absent");
  if (status === "Late") return "late";
  if (status === "Absent") return "absent";
  if (status === "On Leave") return "leave";
  if (isUnresolvedStatus(status)) return "unresolved";
  return "present";
}

// Every calendar-day key (YYYY-MM-DD) an approved leave request covers,
// clamped to [periodStart, periodEnd]. Used to reconcile attendance against
// leave so an approved-leave day is never also counted as an unexplained
// absence — with-pay leave must not be deducted at all, and without-pay leave
// must be deducted exactly once (via leave_without_pay_days), not twice by
// also landing in the attendance "absent" bucket.
function expandDateRange(startKey, endKey) {
  const days = [];
  // Parsed and read back in UTC. Parsing as local midnight and then reading
  // toISOString() (UTC) shifted every key a day early on any server east of
  // UTC — a Manila machine turned "2026-09-01" into "2026-08-31".
  let cursor = new Date(`${startKey}T00:00:00Z`);
  const end = new Date(`${endKey}T00:00:00Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return days;
}

// Sums each employee's approved Leave With Pay / Without Pay days that fall in
// the given semi-monthly pay period, and separately indexes every individual
// day an approved leave covers so fetchAttendanceSummary() can reconcile
// against it. Days are clamped to the period window so a leave request
// spanning a cutoff only counts toward the half it actually falls in.
//
// Only working days count as leave days -- the same days that become On Leave
// in attendance (20260928010000_leave_attendance_sync.sql): Saturday, Sunday
// and holidays are skipped, so a Friday-to-Monday leave is 2 days, paid (With
// Pay) or deducted at the daily rate (Without Pay). The dates themselves are
// returned too, so the accountant sees which days each figure is.
function isLeaveWorkingDay(dayKey, holidays) {
  const weekday = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays?.has?.(dayKey);
}

// includeDay(day, request), when given, keeps only the leave days this payroll
// counts (semi-monthly: the lock day decides the month); a day it leaves out
// is still "covered", so it is never deducted as an absence either.
async function buildLeaveContext(employees, periodStart, periodEnd, holidays = new Map(), includeDay = null) {
  // Payroll only ever needs approved requests — filtering server-side avoids
  // transferring every leave request ever filed (pending, rejected, from
  // years ago) on every payroll page load.
  const approved = await readAllLeaveRequests({ status: "approved" });

  const summaries = [];
  const leaveDaysByEmployee = new Map();

  employees.forEach((employee) => {
    // leave_requests.employee_id holds either form: requests filed before the
    // 0904e12 self-scoping fix carry the SACS-XXX code the portal sent, and
    // every request since carries the auth user UUID the session pins it to.
    // Matching the code alone silently dropped all newer approved leave —
    // no With/Without Pay days auto-filled, and those days were deducted as
    // absences. The summary is keyed by employee.id (UUID) to match
    // attendance_rows' convention.
    const requestsForEmployee = approved.filter(
      (r) => r.employee_id === employee.id || r.employee_id === employee.employee_id,
    );

    const withPayDates = [];
    const withoutPayDates = [];
    const coveredDays = new Set();

    requestsForEmployee.forEach((request) => {
      const requestStart = String(request.start_date || "");
      const requestEnd = String(request.end_date || requestStart);
      if (!requestStart || !requestEnd) return;
      if (requestEnd < periodStart || requestStart > periodEnd) return;

      const overlapStart = requestStart > periodStart ? requestStart : periodStart;
      const overlapEnd = requestEnd < periodEnd ? requestEnd : periodEnd;
      if (overlapStart > overlapEnd) return;

      expandDateRange(overlapStart, overlapEnd).forEach((day) => {
        coveredDays.add(day);
        if (!isLeaveWorkingDay(day, holidays)) return;
        if (includeDay && !includeDay(day, request)) return;
        (request.pay_status === "without_pay" ? withoutPayDates : withPayDates).push(day);
      });
    });

    withPayDates.sort();
    withoutPayDates.sort();
    summaries.push({
      employee_id: employee.id,
      with_pay_days: withPayDates.length,
      without_pay_days: withoutPayDates.length,
      with_pay_dates: withPayDates,
      without_pay_dates: withoutPayDates,
    });
    leaveDaysByEmployee.set(employee.id, coveredDays);
  });

  return { summaries, leaveDaysByEmployee };
}

async function fetchAttendanceSummary(supabase, employees, periodStart, periodEnd, leaveDaysByEmployee, prefetchedRows = null) {
  // Filtering by log_date server-side (indexed — attendance_logs_log_date_idx)
  // means the query only ever transfers rows this period could possibly use,
  // instead of pulling the 5000 globally-most-recent rows and filtering them
  // out in JS below — which, once daily volume grew past that cap, could
  // silently return zero/partial rows for an older period being reviewed.
  const rows = prefetchedRows
    ?? (await readPeriodAttendance(supabase, periodStart, periodEnd)).rows;

  const activeEmployeeIds = new Set(employees.map((employee) => employee.id));
  const grouped = new Map();

  employees.forEach((employee) => {
    grouped.set(employee.id, {
      employee_id: employee.id,
      employee_name: employee.full_name,
      employee_type: employee.employee_type,
      present_days: 0,
      late_days: 0,
      absent_days: 0,
      deduction_days: 0,
      unresolved_days: 0,
    });
  });

  // One record per employee per day (the first tap decides the status), so a
  // repeated RFID tap never counts as an extra present, late or absent day.
  const dayKey = (row) => normalizeText(row.log_date, normalizeText(row.time_in, row.created_at)).slice(0, 10);
  collapseDailyTaps(rows || [], { dateKey: dayKey }).forEach((row) => {
    const employeeId = normalizeText(row.employee_id);
    if (!activeEmployeeIds.has(employeeId)) return;

    const key = dayKey(row);
    if (key < periodStart || key > periodEnd) return;

    const summary = grouped.get(employeeId);
    if (!summary) return;

    const status = normalizeAttendanceStatus(row.status);
    if (status === "present") summary.present_days += 1;
    if (status === "late") {
      summary.late_days += 1;
      summary.present_days += 1;
    }
    // Incomplete / Pending Correction: neither worked nor unworked until
    // resolved, so counted apart and never as present or absent.
    if (status === "unresolved") summary.unresolved_days += 1;
    if (status === "absent") {
      // An approved leave request (with or without pay) already accounts for
      // this day in leave_summary — counting it here too would let the
      // accountant double-deduct a Leave Without Pay day, or deduct a Leave
      // With Pay day that should cost the employee nothing.
      if (leaveDaysByEmployee?.get(employeeId)?.has(key)) return;
      summary.absent_days += 1;
      summary.deduction_days += 1;
    }
  });

  return Array.from(grouped.values()).sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

const ENGINE_ATTENDANCE_COLUMNS = "id,employee_id,status,log_date,time_in,time_out,created_at,late_minutes,undertime_minutes,is_half_day,is_early_bird";

/**
 * The period's attendance rows. Closes the period's finished days first
 * (public.attendance_close_days: Incomplete flags and Absent rows -- the same
 * idempotent step the nightly job runs), so the figures never depend on
 * whether the job ran.
 *
 * engineReady is false when the status-engine migration
 * (20260926010000_attendance_status_engine.sql) has not been applied; the
 * rows are then read the old way and payroll refuses to process.
 */
async function readPeriodAttendance(supabase, periodStart, periodEnd, employeeIds = null) {
  const closed = await supabase.rpc("attendance_close_days", { p_from: periodStart, p_to: periodEnd });

  // Paged: PostgREST returns at most max-rows (1000 by default) per request,
  // and a period for 200 employees is ~2,200 rows. A dropped row is an
  // absence or late day payroll never charges. id breaks created_at ties
  // (the nightly close writes many rows in one statement) so pages are stable.
  const buildQuery = () => {
    let query = supabase
      .from("attendance_logs")
      .select(ENGINE_ATTENDANCE_COLUMNS)
      .gte("log_date", periodStart)
      .lte("log_date", periodEnd)
      .eq("archived_duplicate", false);
    if (employeeIds && employeeIds.length && employeeIds.length <= 200) query = query.in("employee_id", employeeIds);
    return query.order("created_at", { ascending: false }).order("id", { ascending: true });
  };
  const engine = await fetchAllRows(buildQuery);

  if (!engine.error) return { rows: engine.data || [], engineReady: !closed?.error };

  const legacy = await supabase
    .from("attendance_logs")
    .select("employee_id,status,log_date,time_in,created_at")
    .gte("log_date", periodStart)
    .lte("log_date", periodEnd)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (legacy.error) {
    throw new Error(`Failed to fetch attendance summary: ${legacy.error.message}`);
  }
  return { rows: legacy.data || [], engineReady: false };
}

/**
 * Approved overtime minutes for the period, by attendance log id
 * (public.attendance_overtime_approvals). `available` is false when the table
 * does not exist yet -- payroll then refuses to process, like it does without
 * the attendance engine, rather than silently paying no overtime.
 */
async function readApprovedOvertime(supabase, periodStart, periodEnd) {
  // Paged for the same reason as readPeriodAttendance: a dropped row is
  // approved overtime that never gets paid.
  const result = await fetchAllRows(() => supabase
    .from("attendance_overtime_approvals")
    .select("log_id,approved_minutes,status")
    .gte("log_date", periodStart)
    .lte("log_date", periodEnd)
    .eq("status", "approved")
    .order("log_id", { ascending: true }));
  if (result.error) return { minutes: new Map(), available: false };
  return {
    minutes: new Map((result.data || []).map((row) => [String(row.log_id), Number(row.approved_minutes) || 0])),
    available: true,
  };
}

/** Holidays in the period: date key -> "holiday" (regular) | "special". */
async function readHolidays(supabase, periodStart, periodEnd) {
  const result = await supabase
    .from("attendance_holidays")
    .select("holiday_date,type")
    .gte("holiday_date", periodStart)
    .lte("holiday_date", periodEnd);
  if (result.error) return new Map();
  return new Map((result.data || []).map((row) => [String(row.holiday_date).slice(0, 10), row.type === "special" ? "special" : "holiday"]));
}

const PAYROLL_NOT_READY_MESSAGE = "Payroll cannot be processed yet: apply the attendance and payroll-rate database migrations (supabase/migrations/20260926010000_attendance_status_engine.sql, 20260926020000_payroll_rate_configs.sql, 20260926090000_payroll_legal_rules_and_atomic_commit.sql, 20261003010000_semi_monthly_payroll.sql and 20261006010000_school_payroll_sheet.sql) first.";

/** Zero amounts for a 1st half with no Final payslip. */
const NO_FIRST_HALF = Object.freeze({ gross_pay: 0, total_deductions: 0, total_incentives: 0, net_pay: 0, basic_earned: 0 });

/**
 * Semi-monthly payroll (src/lib/payroll/semi-monthly.js), for a period from
 * SEMI_MONTHLY_RULES_EFFECTIVE: which half it is and, for the 2nd half, the
 * month's attendance window (lock day), the monthly tax table, and per
 * employee what the month settles against: the 1st half already paid, a
 * balance carried from last month, incentives and overload hours filed for
 * the month, and fixed contribution amounts.
 *
 * `ready` is false when the 2nd half cannot be computed (migration not
 * applied, or no tax table); payroll then refuses to process.
 */
async function loadSemiMonthlyContext(supabase, employees, period, configs) {
  const half = halfOf(period.start_key);
  const month = monthInfo(monthKeyOf(period.start_key));
  const previous = monthInfo(shiftMonth(month.month_key, -1));
  // The lock day in force for a month's 2nd half.
  const lockDayFor = (monthKey) => Number(resolveRate(configs, "attendance_lock_day", {}, `${monthKey}-16`).value) || 0;
  // Off (the school): days after the lock day are never deducted, so the
  // month reads only its own 1st to the lock day.
  const carryOver = Number(resolveRate(configs, "carry_after_lock", {}, `${month.month_key}-16`).value) !== 0;
  const window = monthlyWindow(month.month_key, lockDayFor, { carryOver });
  const base = {
    half,
    month_key: month.month_key,
    month_label: month.label,
    first_half_label: month.first_half_label,
    second_half_label: month.second_half_label,
    window,
    lock_day: lockDayFor(month.month_key),
    carry_over: carryOver,
    lockDayFor,
  };

  const entriesResult = await supabase
    .from("payroll_entries")
    .select("id,employee_id,pay_period,status,payroll,payslip_no")
    .in("pay_period", [month.first_half_label, month.second_half_label, previous.second_half_label]);
  if (entriesResult.error) throw new Error(entriesResult.error.message);
  const entries = (entriesResult.data || []).map(normalizePayrollEntry);
  const find = (employeeId, label) => entries.find((entry) => entry.employee_id === employeeId && entry.pay_period === label) || null;

  const byEmployee = new Map();
  if (half === "first") {
    employees.forEach((employee) => {
      byEmployee.set(employee.id, { ...base, second_half_final: find(employee.id, month.second_half_label)?.status === "paid" });
    });
    return { ...base, ready: true, tax_table: [], byEmployee };
  }

  const [taxResult, contributionResult, itemResult, cash] = await Promise.all([
    supabase.from("payroll_tax_brackets")
      .select("id,version_id,effective_date,bracket_over,base_tax,rate_pct,created_at")
      .lte("effective_date", period.start_key),
    supabase.from("payroll_contribution_amounts")
      .select("employee_id,effective_date,sss,philhealth,pagibig,created_at")
      .lte("effective_date", period.start_key),
    fetchAllRows(() => supabase.from("payroll_monthly_incentives")
      .select("id,employee_id,item_date,kind,description,amount,hours,created_at")
      .eq("archived", false)
      .gte("item_date", SEMI_MONTHLY_RULES_EFFECTIVE)
      .lte("item_date", window.end_key)
      .order("item_date", { ascending: true })
      .order("id", { ascending: true })),
    // Cash advance installments: deducted on the 2nd half with everything else.
    loadCashAdvanceContext(supabase, employees.map((employee) => employee.id), period),
  ]);
  const failed = taxResult.error || contributionResult.error || itemResult.error || !cash.ready;
  const taxTable = failed ? [] : taxTableFromRows(resolveTaxTableRows(taxResult.data, period.start_key));
  if (failed || !taxTable.length) {
    return { ...base, ready: false, tax_table: [], byEmployee };
  }

  employees.forEach((employee) => {
    const first = find(employee.id, month.first_half_label);
    const firstPaid = first?.status === "paid";
    const totals = first?.payroll?.totals || {};
    const previousSecond = find(employee.id, previous.second_half_label);
    const carryIn = previousSecond?.status === "paid" ? toAmount(previousSecond.payroll?.monthly?.carry_over_out || 0) : 0;

    // Fixed amounts set for this employee (Super Admin → Contribution Amounts);
    // a blank one stays computed from the legal table.
    const fixed = (contributionResult.data || [])
      .filter((row) => row.employee_id === employee.id)
      .sort((a, b) => (String(b.effective_date).localeCompare(String(a.effective_date)) || String(b.created_at || "").localeCompare(String(a.created_at || ""))))[0] || null;
    const contributionAmounts = {};
    ["sss", "philhealth", "pagibig"].forEach((type) => {
      if (fixed && fixed[type] !== null && fixed[type] !== undefined) contributionAmounts[type] = toAmount(fixed[type]);
    });

    // Filed after the lock: counted next month.
    const items = (itemResult.data || []).filter((item) => item.employee_id === employee.id
      && payrollMonthFor(String(item.item_date).slice(0, 10), manilaDateKey(new Date(item.created_at || Date.now())), lockDayFor) === month.month_key);

    byEmployee.set(employee.id, {
      ...base,
      first_half: firstPaid
        ? {
          status: "final",
          payslip_no: first.payslip_no || null,
          gross_pay: toAmount(totals.gross_pay),
          total_deductions: toAmount(totals.total_deductions),
          total_incentives: toAmount(totals.total_incentives),
          net_pay: floorNetPay(totals.net_pay),
          basic_earned: basicEarnedFromPayroll(first.payroll),
        }
        : { status: first ? "draft" : "not_processed", payslip_no: null, ...NO_FIRST_HALF },
      carry_in: carryIn,
      carry_from: carryIn ? previous.label : null,
      contribution_amounts: contributionAmounts,
      items,
      tax_table: taxTable,
      advances: cash.advances.filter((row) => row.employee_id === employee.id),
      repaid: cash.repaid,
      working_days: workingDaysIn(period.start_key, period.end_key),
    });
  });

  return { ...base, ready: true, tax_table: taxTable, byEmployee };
}

/**
 * Each half paid on its own attendance (payroll_per_half, the school's payroll
 * sheet: src/lib/payroll/school-sheet.js). Per employee: the contribution
 * amounts set for them, the incentives and overload hours counted in the
 * month (paid on the 2nd half, by the lock day, as in the semi-monthly rule),
 * and their active cash advances with what Final payslips of other periods
 * already repaid.
 *
 * `ready` is false when a table it needs is missing (migrations
 * 20261003010000_semi_monthly_payroll.sql / 20261006010000_school_payroll_sheet.sql
 * not applied); payroll then refuses to process.
 */
async function loadPerHalfContext(supabase, employees, period, configs, holidays) {
  const half = halfOfPeriod(period.start_key);
  const month = monthInfo(monthKeyOf(period.start_key));
  const lockDayFor = (monthKey) => Number(resolveRate(configs, "attendance_lock_day", {}, `${monthKey}-16`).value) || 0;
  const employeeIds = employees.map((employee) => employee.id);
  const none = { data: [], error: null };

  const [contributionResult, itemResult, cash] = await Promise.all([
    supabase.from("payroll_contribution_amounts")
      .select("employee_id,effective_date,sss,philhealth,pagibig,created_at")
      .lte("effective_date", period.start_key),
    half === "second"
      ? fetchAllRows(() => supabase.from("payroll_monthly_incentives")
        .select("id,employee_id,item_date,kind,description,amount,hours,created_at")
        .eq("archived", false)
        .gte("item_date", SEMI_MONTHLY_RULES_EFFECTIVE)
        .lte("item_date", month.end_key)
        .order("item_date", { ascending: true })
        .order("id", { ascending: true }))
      : none,
    loadCashAdvanceContext(supabase, employeeIds, period),
  ]);
  const failed = contributionResult.error || itemResult.error || !cash.ready;
  const { advances, repaid } = cash;

  const workingDays = workingDaysIn(period.start_key, period.end_key, holidays);
  const byEmployee = new Map();
  employees.forEach((employee) => {
    const fixed = (contributionResult.data || [])
      .filter((row) => row.employee_id === employee.id)
      .sort((a, b) => (String(b.effective_date).localeCompare(String(a.effective_date)) || String(b.created_at || "").localeCompare(String(a.created_at || ""))))[0] || null;
    const contributionAmounts = {};
    ["sss", "philhealth", "pagibig"].forEach((type) => {
      if (fixed && fixed[type] !== null && fixed[type] !== undefined) contributionAmounts[type] = toAmount(fixed[type]);
    });
    const items = (itemResult.data || []).filter((item) => item.employee_id === employee.id
      && payrollMonthFor(String(item.item_date).slice(0, 10), manilaDateKey(new Date(item.created_at || Date.now())), lockDayFor) === month.month_key);
    byEmployee.set(employee.id, {
      half,
      month_key: month.month_key,
      working_days: workingDays,
      contribution_amounts: contributionAmounts,
      items,
      advances: advances.filter((row) => row.employee_id === employee.id),
      repaid,
    });
  });

  return { ready: !failed, half, working_days: workingDays, byEmployee };
}

/**
 * Active cash advances of these employees that a period may deduct, and what
 * Final payslips of OTHER periods already repaid (src/lib/payroll/cash-advance.js).
 * `ready` is false when the table is missing (20261006010000_school_payroll_sheet.sql).
 */
async function loadCashAdvanceContext(supabase, employeeIds, period) {
  const advanceResult = await fetchAllRows(() => supabase.from("payroll_cash_advances")
    .select("id,employee_id,date_granted,principal,installment_amount,deduct_on,start_date,status,description,created_at")
    .eq("status", "active")
    .lte("start_date", period.start_key)
    .order("date_granted", { ascending: true })
    .order("id", { ascending: true }));
  if (advanceResult.error) return { ready: false, advances: [], repaid: new Map() };

  const advances = (advanceResult.data || []).filter((row) => employeeIds.includes(row.employee_id));
  const borrowers = [...new Set(advances.map((row) => row.employee_id))];
  const paidResult = borrowers.length
    ? await fetchAllRows(() => supabase.from("payroll_entries")
      .select("id,employee_id,pay_period,status,payroll")
      .eq("status", "paid")
      .in("employee_id", borrowers)
      .order("id", { ascending: true }))
    : { data: [], error: null };
  return {
    ready: !paidResult.error,
    advances,
    repaid: repaidByAdvance(paidResult.data || [], { excludePeriod: period.label }),
  };
}

/**
 * Everything payroll needs for one period, per employee: the rate versions in
 * force on the period's first day, the attendance lines computed from the
 * logs, and the approved leave.
 *
 * `through` (a date inside the period) counts attendance and leave only up to
 * that day, for a payslip generated before the period ends: days that have
 * not happened yet are never absences or leave deductions.
 */
async function loadPeriodPayContext(supabase, employees, period, { through = null } = {}) {
  const employeeIds = employees.map((employee) => employee.id);
  const rateResult = await loadRateConfigs(supabase);
  // The school's payroll sheet: each half paid on its own attendance
  // (payroll_per_half), so neither half settles the month.
  const perHalf = usesPerHalfRule(rateResult.configs, period.start_key);
  // Semi-monthly payroll: the 2nd half counts the month's attendance window
  // (from the day after last month's lock day to this month's), and leave
  // filed after the lock is counted next month.
  const semi = usesSemiMonthlyRules(period.start_key) && !perHalf
    ? await loadSemiMonthlyContext(supabase, employees, period, rateResult.configs)
    : null;
  const settling = semi?.half === "second";
  const span = settling ? semi.window : period;
  const lastDay = through && through >= span.start_key && through < span.end_key ? through : span.end_key;
  // Without carry-over only leave days inside the window count; a leave day
  // after the lock day is never deducted, like an absence.
  const leaveFrom = settling && semi.carry_over ? SEMI_MONTHLY_RULES_EFFECTIVE : span.start_key;
  const includeLeaveDay = settling && semi.carry_over
    ? (day, request) => payrollMonthFor(day, manilaDateKey(new Date(request.submitted_at || Date.now())), semi.lockDayFor) === semi.month_key
    : null;
  // Holidays first: leave days are counted on working days only.
  const holidays = await readHolidays(supabase, leaveFrom < span.start_key ? leaveFrom : span.start_key, period.end_key);
  const [leaveContext, attendance, overtimeResult, school] = await Promise.all([
    buildLeaveContext(employees, leaveFrom, lastDay, holidays, includeLeaveDay),
    readPeriodAttendance(supabase, span.start_key, lastDay, employeeIds),
    readApprovedOvertime(supabase, span.start_key, lastDay),
    perHalf ? loadPerHalfContext(supabase, employees, period, rateResult.configs, holidays) : null,
  ]);
  const { summaries: leaveSummary, leaveDaysByEmployee } = leaveContext;

  const attendanceRows = await fetchAttendanceSummary(
    supabase,
    employees,
    span.start_key,
    lastDay,
    leaveDaysByEmployee,
    attendance.rows,
  );

  const dayKey = (row) => normalizeText(row.log_date, normalizeText(row.time_in, row.created_at)).slice(0, 10);
  const logsByEmployee = new Map();
  collapseDailyTaps(attendance.rows, { dateKey: dayKey }).forEach((row) => {
    const employeeId = normalizeText(row.employee_id);
    if (!logsByEmployee.has(employeeId)) logsByEmployee.set(employeeId, []);
    logsByEmployee.get(employeeId).push({ ...row, log_date: dayKey(row) });
  });

  const byEmployee = new Map();
  employees.forEach((employee) => {
    const resolved = resolveRates(
      rateResult.configs,
      {
        employeeId: employee.id,
        branchId: employee.branch_id,
        position: employee.rate_position,
        // From LEGAL_RULES_EFFECTIVE the daily rate is the employee's own salary.
        monthlySalary: employee.basic_salary,
      },
      period.start_key,
    );
    const auto = computeAttendancePay({
      logs: logsByEmployee.get(employee.id) || [],
      leaveDays: leaveDaysByEmployee.get(employee.id),
      rates: resolved,
      periodStart: span.start_key,
      periodEnd: lastDay,
      overtime: overtimeResult.minutes,
      holidays,
    });
    const leave = leaveSummary.find((row) => row.employee_id === employee.id) || null;
    byEmployee.set(employee.id, {
      resolved,
      auto,
      leave,
      semi: semi?.byEmployee.get(employee.id) || null,
      school: school?.byEmployee.get(employee.id) || null,
    });
  });

  // What the batch table and the Single Entry form show and pre-fill.
  const enrichedRows = attendanceRows.map((row) => {
    const context = byEmployee.get(row.employee_id);
    const employee = employees.find((e) => e.id === row.employee_id);
    if (!context || !employee) return row;
    const values = rateValues(context.resolved);
    const basic = toAmount(Number(employee.basic_salary || 0) / 2);
    // The very computation processing runs, with nothing overridden, so the
    // pre-filled defaults can never differ from what the server would use.
    const preview = buildEmployeePayroll({ employee, context, input: {}, period, actor: null });
    return {
      ...row,
      late_days: context.auto.counts.late_days,
      late_minutes: context.auto.counts.late_minutes,
      undertime_minutes: context.auto.counts.undertime_minutes,
      half_days: context.auto.counts.half_days,
      early_bird_days: context.auto.counts.early_bird_days,
      perfect_attendance: context.auto.perfect_attendance,
      pay: {
        counts: context.auto.counts,
        amounts: context.auto.amounts,
        unit_amounts: context.auto.unit_amounts,
        perfect_attendance: context.auto.perfect_attendance,
        blocking: context.auto.blocking,
      },
      rates: values,
      rate_versions: Object.fromEntries(Object.entries(context.resolved).map(([type, rate]) => [
        type,
        { effective_date: rate.effective_date, scope: rate.scope, source: rate.source },
      ])),
      defaults: {
        basic_salary: basic,
        ...preview.defaults,
      },
    };
  });

  return {
    period,
    through: lastDay,
    engineReady: attendance.engineReady && overtimeResult.available,
    ratesReady: rateResult.available && (!semi || semi.ready) && (!school || school.ready),
    semi,
    school,
    leaveSummary,
    attendanceRows: enrichedRows,
    byEmployee,
  };
}

const DEVIATION_TOLERANCE = 0.005;

function differs(a, b) {
  return Math.abs(toAmount(a) - toAmount(b)) > DEVIATION_TOLERANCE;
}

// Every override is a salary, contribution, tax, day count or minute count,
// none of which can be negative; a negative one would raise net pay (e.g. SSS
// -5,000 adds 5,000). The form has min="0" but the API is reachable directly,
// so the floor is enforced here too.
function pickAmount(value, fallback) {
  if (value === undefined || value === null || value === "") return Math.max(0, toAmount(fallback));
  return Math.max(0, toAmount(value));
}

function rateSnapshot(resolved) {
  return Object.fromEntries(Object.entries(resolved || {}).map(([type, rate]) => [type, {
    value: Number(rate.value) || 0,
    config_id: rate.config_id,
    effective_date: rate.effective_date,
    scope: rate.scope,
    scope_ref: rate.scope_ref,
    source: rate.source,
  }]));
}

/**
 * Semi-monthly 1st half: Monthly Salary / 2, no deductions at all.
 * Attendance, leave, incentives, contributions and tax are all settled in
 * the 2nd half. Basic salary may still be overridden, with a reason.
 */
function buildFirstHalfPayroll({ employee, context, input = {}, period, actor }) {
  const { resolved, auto } = context;
  const semi = context.semi;
  const rates = rateValues(resolved);
  const reason = normalizeText(input.override_reason);
  const defaultBasic = computeFirstHalf({ monthlySalary: employee.basic_salary }).semi_monthly_pay;
  const basic = pickAmount(input.basic_salary, defaultBasic);
  const deviations = differs(defaultBasic, basic)
    ? [{ field: "basic_salary", default: toAmount(defaultBasic), value: toAmount(basic) }]
    : [];

  const none = { absent: 0, late: 0, undertime: 0, half_day: 0, early_bird: 0, perfect_attendance: 0 };
  const payroll = computeTotals({ basic_salary: basic, rates, deductions: {}, incentives: {}, attendance_amounts: none, earnings: {} });
  payroll.basic_earned = toAmount(basic);
  payroll.monthly = {
    rule: SEMI_MONTHLY_RULE,
    half: "first",
    month_key: semi.month_key,
    month_label: semi.month_label,
    second_half_label: semi.second_half_label,
    monthly_salary: toAmount(employee.basic_salary),
    semi_monthly_pay: toAmount(basic),
    net_pay: payroll.totals.net_pay,
  };
  // The school's payroll sheet, 1-15: the full Rate, nothing deducted.
  payroll.sheet = {
    ...sheetFigures({
      basic,
      daily: rates.daily,
      hourly: rates.hourly,
      periodDays: periodDaysFor(rates.working_days_per_year, workingDaysIn(period.start_key, period.end_key)),
    }),
    half: "first",
  };

  const nowIso = new Date().toISOString();
  payroll.audit = {
    period: { label: period.label, start_key: period.start_key, end_key: period.end_key },
    rates: rateSnapshot(resolved),
    attendance: {
      counts: auto.counts,
      perfect_attendance: auto.perfect_attendance,
      source_log_ids: [],
      blocking: [],
    },
    lines: { deductions: [], incentives: [] },
    deviations: deviations.length
      ? { items: deviations, reason: reason || null, by: actor?.userId || null, by_name: actor?.name || null, at: nowIso }
      : null,
    computed_at: nowIso,
    computed_by: actor?.userId || null,
    computed_by_name: actor?.name || null,
  };

  return {
    payroll,
    deviations,
    reason,
    // Attendance is counted in the 2nd half, so nothing here waits on it.
    blocking: [],
    refusal: semi.second_half_final
      ? `${semi.second_half_label} is already Final and settled the whole month, so the 1st half can no longer be processed.`
      : null,
    defaults: {
      statutory_method: "semi_monthly_first",
      semi_monthly: "first",
      basic_salary: defaultBasic,
      sss: 0,
      philhealth: 0,
      pagibig: 0,
      withholding_tax: 0,
      overtime: 0,
      holiday_pay: 0,
    },
  };
}

/**
 * Semi-monthly 2nd half. computeTotals() priced the whole month; the payslip
 * pays the month less what the 1st half already paid and any balance carried
 * in. Its gross / incentives / deductions are what the month adds beyond the
 * 1st half, so the two payslips of a month add up to the month in records,
 * dashboards and reports. payroll.monthly keeps the month's figures for the
 * payslip.
 */
function applySecondHalfSettlement(payroll, { settlement, semi, rates }) {
  const month = { ...payroll.totals };
  const first = semi.first_half || NO_FIRST_HALF;
  const gross = toAmount(month.gross_pay - first.gross_pay);
  const incentives = toAmount(month.total_incentives - first.total_incentives);
  payroll.totals = {
    ...month,
    gross_pay: gross,
    total_incentives: incentives,
    total_deductions: toAmount(gross + incentives - settlement.second_half_net),
    carry_over_deduction: settlement.carry_in,
    net_pay: settlement.net_pay,
  };
  // 13th month: the month's basic less unpaid absences, less the 1st half's.
  const earnedThisMonth = Math.max(0, toAmount(payroll.basic_salary - month.absence_deduction - month.leave_without_pay_deduction));
  payroll.basic_earned = toAmount(earnedThisMonth - first.basic_earned);
  payroll.monthly = {
    rule: SEMI_MONTHLY_RULE,
    half: "second",
    month_key: semi.month_key,
    month_label: semi.month_label,
    window: semi.window,
    lock_day: semi.lock_day,
    divisor: Number(rates.working_days_per_year) || null,
    first_half_label: semi.first_half_label,
    first_half_status: first.status || "not_processed",
    first_half_payslip_no: first.payslip_no || null,
    carry_from: semi.carry_from || null,
    ...settlement,
    absent_deduction: toAmount(month.absence_deduction),
    leave_without_pay_deduction: toAmount(month.leave_without_pay_deduction),
    late_deduction: toAmount(month.late_deduction),
    undertime_deduction: toAmount(month.undertime_deduction),
    half_day_deduction: toAmount(month.half_day_deduction),
    attendance_incentives: toAmount(month.early_bird_incentive + month.perfect_attendance_incentive),
    other_incentive: toAmount(month.other_incentive),
    overtime_pay: toAmount(month.overtime_pay),
    holiday_pay: toAmount(month.holiday_pay),
    month_totals: { gross_pay: month.gross_pay, total_deductions: month.total_deductions, total_incentives: month.total_incentives, net_pay: month.net_pay },
  };
}

/**
 * One employee's payroll for one period, computed on the server.
 *
 * Attendance figures always come from the logs (context.auto). The Single
 * Entry form may override them (allowAttendanceOverrides), and anyone may
 * change basic salary, SSS, PhilHealth, Pag-IBIG or Leave Without Pay days
 * from their defaults -- every such change is a deviation, recorded with who
 * made it and why, and kept as its own is_override line next to the computed
 * lines rather than replacing them.
 */
function buildEmployeePayroll({ employee, context, input = {}, allowAttendanceOverrides = false, period, actor }) {
  const { resolved, auto, leave } = context;
  // Semi-monthly payroll (src/lib/payroll/semi-monthly.js): the 1st half is
  // half the salary with nothing deducted; the 2nd half settles the month.
  const semi = context.semi || null;
  if (semi?.half === "first") return buildFirstHalfPayroll({ employee, context, input, period, actor });
  const settling = semi?.half === "second";
  // The school's payroll sheet (payroll_per_half): this half on its own
  // attendance, with fixed / exempt contributions and cash advances.
  const school = context.school || null;
  const rates = rateValues(resolved);
  const deductionsIn = input.deductions || {};
  const incentivesIn = input.incentives || {};
  const reason = normalizeText(input.override_reason);
  const deviations = [];
  const note = (field, def, value) => {
    if (differs(def, value)) deviations.push({ field, default: toAmount(def), value: toAmount(value) });
  };

  // The 2nd half computes the whole month on the monthly salary.
  const defaultBasic = settling ? toAmount(employee.basic_salary) : toAmount(Number(employee.basic_salary || 0) / 2);
  const basic = pickAmount(input.basic_salary, defaultBasic);
  note("basic_salary", defaultBasic, basic);

  // From LEGAL_RULES_EFFECTIVE: SSS / PhilHealth / Pag-IBIG from the legal
  // base of the MONTHLY salary, half per payslip, and withholding tax from the
  // BIR table (src/lib/payroll/statutory.js). Before it: a flat % of the
  // period's basic and no default tax, exactly as payslips were computed then.
  const legal = usesLegalRules(period?.start_key);
  // The 2nd half deducts the whole month's share once, or the fixed amounts
  // set for the employee (Super Admin -> Contribution Amounts).
  // Per-half: the month's amounts (fixed, legal, or the employee's own; 0 =
  // exempt), deducted on the payslip contribution_half names.
  // Either way the month's amounts come from the legal tables, or the fixed
  // amounts when "Contributions as fixed amounts" is on (the school's sheet:
  // SSS ₱400, Pag-IBIG ₱200), and an employee's own amounts win (0 = exempt).
  const schoolMonthly = school || (legal && settling)
    ? monthlyContributionsFor(employee.basic_salary, rates, (school || semi).contribution_amounts)
    : null;
  const legalContributions = legal
    ? (settling
      ? { ...monthlyContributions(employee.basic_salary, rates), ...schoolMonthly }
      : school
        ? contributionsForHalf(schoolMonthly, school.half, rates.contribution_half)
        : periodContributions(employee.basic_salary, rates))
    : null;
  const contributionDefault = (type) => (legal
    ? legalContributions[type]
    : peso(basic * (rates[`${type}_pct`] || 0) / 100));
  const sss = pickAmount(deductionsIn.sss, contributionDefault("sss"));
  const philhealth = pickAmount(deductionsIn.philhealth, contributionDefault("philhealth"));
  const pagibig = pickAmount(deductionsIn.pagibig, contributionDefault("pagibig"));
  note("sss", contributionDefault("sss"), sss);
  note("philhealth", contributionDefault("philhealth"), philhealth);
  note("pagibig", contributionDefault("pagibig"), pagibig);

  // Leave comes from approved leave requests. With Pay is never editable.
  const leaveWithPayDays = toAmount(leave?.with_pay_days || 0);
  const defaultWithoutPay = toAmount(leave?.without_pay_days || 0);
  const leaveWithoutPayDays = pickAmount(deductionsIn.leave_without_pay_days, defaultWithoutPay);
  note("leave_without_pay_days", defaultWithoutPay, leaveWithoutPayDays);

  const computed = {
    absences_days: auto.counts.absent_days,
    late_days: auto.counts.late_days,
    undertime_minutes: auto.counts.undertime_minutes,
    half_days: auto.counts.half_days,
    early_bird_days: auto.counts.early_bird_days,
  };
  const used = { ...computed };
  let perfectAttendance = auto.perfect_attendance;

  if (allowAttendanceOverrides) {
    used.absences_days = pickAmount(deductionsIn.absences_days, computed.absences_days);
    used.late_days = pickAmount(deductionsIn.late_days, computed.late_days);
    used.undertime_minutes = pickAmount(deductionsIn.undertime_minutes, computed.undertime_minutes);
    used.half_days = pickAmount(deductionsIn.half_days, computed.half_days);
    used.early_bird_days = pickAmount(incentivesIn.early_bird_days, computed.early_bird_days);
    Object.keys(computed).forEach((field) => note(field, computed[field], used[field]));
    if (typeof incentivesIn.perfect_attendance === "boolean" && incentivesIn.perfect_attendance !== auto.perfect_attendance) {
      perfectAttendance = incentivesIn.perfect_attendance;
      deviations.push({ field: "perfect_attendance", default: auto.perfect_attendance, value: perfectAttendance });
    }
  }

  const unit = auto.unit_amounts;
  const finalAmounts = {
    absent: differs(used.absences_days, computed.absences_days) ? peso(used.absences_days * unit.absent) : auto.amounts.absent,
    // N late days = 1 absence; an overridden count reprices only that rule,
    // the per-minute part (if switched on) stays as computed from the logs.
    late: differs(used.late_days, computed.late_days)
      ? peso((unit.late_days_per_absent > 0 ? Math.floor(used.late_days / unit.late_days_per_absent) * unit.absent : 0)
        + (auto.amounts.late_minutes_charge || 0))
      : auto.amounts.late,
    undertime: differs(used.undertime_minutes, computed.undertime_minutes) ? peso((used.undertime_minutes / 60) * unit.hourly) : auto.amounts.undertime,
    half_day: differs(used.half_days, computed.half_days) ? peso(used.half_days * unit.half_day) : auto.amounts.half_day,
    early_bird: differs(used.early_bird_days, computed.early_bird_days) ? peso(used.early_bird_days * unit.early_bird) : auto.amounts.early_bird,
    perfect_attendance: perfectAttendance === auto.perfect_attendance
      ? auto.amounts.perfect_attendance
      : (perfectAttendance ? unit.perfect_attendance : 0),
  };

  // Approved overtime and holiday work (never editable here: overtime is
  // approved in Attendance, holidays come from the calendar).
  const overtimePay = toAmount(auto.amounts.overtime || 0);
  const holidayPay = toAmount(auto.amounts.holiday_premium || 0);

  // Semi-monthly 2nd half: incentives and overload hours filed for the month
  // (per-half: also on the 2nd half).
  const items = settling ? semi.items || [] : school?.items || [];
  const overloadRate = peso((Number(rates.hourly) || 0) * (1 + (Number(rates.overload_premium_pct) || 0) / 100));
  const itemAmount = (item) => (item.kind === "overload"
    ? overloadPayFor(rates.hourly, item.hours, rates.overload_premium_pct)
    : toAmount(item.amount));
  const sumItems = (kind, value) => toAmount(items.filter((item) => item.kind === kind).reduce((sum, item) => sum + value(item), 0));
  const otherIncentive = sumItems("incentive", itemAmount);
  const overloadHours = sumItems("overload", (item) => Number(item.hours) || 0);
  const overloadPay = sumItems("overload", itemAmount);

  // Withholding tax on this period's taxable compensation.
  const leaveWithoutPayAmount = toAmount(leaveWithoutPayDays * (Number(rates.daily) || 0));
  // 2nd half: once, on the month's taxable income, from the monthly table.
  const settle = (tax, cashAdvanceTotal = 0) => computeSecondHalf({
    monthlySalary: basic,
    dailyRate: rates.daily,
    absentDays: used.absences_days,
    leaveWithoutPayDays,
    leaveWithPayDays,
    absenceDeduction: finalAmounts.absent + leaveWithoutPayAmount,
    otherAttendanceDeductions: finalAmounts.late + finalAmounts.undertime + finalAmounts.half_day,
    incentives: finalAmounts.early_bird + finalAmounts.perfect_attendance + otherIncentive,
    overloadHours,
    overloadPay,
    otherEarnings: overtimePay + holidayPay,
    cashAdvance: cashAdvanceTotal,
    contributions: { sss, philhealth, pagibig },
    taxTable: semi?.tax_table || [],
    withholdingTax: tax,
    firstHalfPaid: semi?.first_half?.net_pay || 0,
    carryIn: semi?.carry_in || 0,
  });
  const taxDefault = settling
    ? settle(undefined).table_withholding_tax
    : legal
    ? computeWithholdingTax(taxableCompensation({
      basic,
      earnings: overtimePay + holidayPay,
      attendanceDeductions: finalAmounts.absent + finalAmounts.late + finalAmounts.undertime
        + finalAmounts.half_day + leaveWithoutPayAmount,
      contributions: sss + philhealth + pagibig,
    }))
    : 0;
  const withholdingTax = pickAmount(deductionsIn.withholding_tax, taxDefault);
  if (legal) note("withholding_tax", taxDefault, withholdingTax);
  // Cash advance installments, from what this payslip can still pay. The 2nd
  // half of a settled month deducts them with every other deduction; the 1st
  // half deducts nothing.
  const cashAdvance = settling
    ? scheduleCashAdvances({
      advances: semi.advances || [],
      repaid: semi.repaid || new Map(),
      period,
      available: settle(withholdingTax).second_half_net,
    })
    : school
    ? scheduleCashAdvances({
      advances: school.advances,
      repaid: school.repaid,
      period,
      available: toAmount(
        basic + overtimePay + holidayPay
        + finalAmounts.early_bird + finalAmounts.perfect_attendance + otherIncentive + overloadPay
        - (sss + philhealth + pagibig + withholdingTax
          + finalAmounts.absent + finalAmounts.late + finalAmounts.undertime + finalAmounts.half_day
          + leaveWithoutPayAmount),
      ),
    })
    : { lines: [], total: 0 };
  const settlement = settling ? settle(withholdingTax, cashAdvance.total) : null;
  const contributionPct = (type) => (schoolMonthly && schoolMonthly.source[type] !== "legal" ? null : rates[`${type}_pct`]);

  const adjustment = (type, finalAmount, autoAmount, quantity, unitName) => {
    const amount = peso(finalAmount - autoAmount);
    if (Math.abs(amount) < DEVIATION_TOLERANCE && !quantity) return null;
    return {
      type, quantity, unit: unitName, rate: null, rate_config_id: null, amount,
      source_log_id: null, is_override: true, note: reason || null, log_date: null,
    };
  };

  const statutory = (type, amount, pct, isOverride) => (amount > 0 ? {
    type, quantity: pct, unit: pct === null ? null : "percent", rate: basic,
    rate_config_id: pct === null ? null : resolved[`${type}_pct`]?.config_id || null,
    amount: toAmount(amount), source_log_id: null, is_override: isOverride, note: isOverride ? reason || null : null, log_date: null,
  } : null);

  const deductionLines = [
    ...auto.deductions,
    adjustment("absent", finalAmounts.absent, auto.amounts.absent, toAmount(used.absences_days - computed.absences_days), "day"),
    adjustment("late", finalAmounts.late, auto.amounts.late, toAmount(used.late_days - computed.late_days), "late day"),
    adjustment("undertime", finalAmounts.undertime, auto.amounts.undertime, toAmount(used.undertime_minutes - computed.undertime_minutes), "minute"),
    adjustment("half_day", finalAmounts.half_day, auto.amounts.half_day, toAmount(used.half_days - computed.half_days), "day"),
    statutory("sss", sss, contributionPct("sss"), differs(sss, contributionDefault("sss"))),
    statutory("philhealth", philhealth, contributionPct("philhealth"), differs(philhealth, contributionDefault("philhealth"))),
    statutory("pagibig", pagibig, contributionPct("pagibig"), differs(pagibig, contributionDefault("pagibig"))),
    statutory("withholding_tax", withholdingTax, null, legal && differs(withholdingTax, taxDefault)),
    leaveWithoutPayDays > 0 ? {
      type: "leave_without_pay", quantity: leaveWithoutPayDays, unit: "day", rate: rates.daily,
      rate_config_id: resolved.daily?.config_id || null, amount: toAmount(leaveWithoutPayDays * rates.daily),
      source_log_id: null, is_override: differs(leaveWithoutPayDays, defaultWithoutPay),
      note: differs(leaveWithoutPayDays, defaultWithoutPay) ? reason || null : null, log_date: null,
    } : null,
    // A negative 2nd half last month, recovered here.
    settlement?.carry_in > 0 ? {
      type: "carry_over", quantity: null, unit: null, rate: null, rate_config_id: null,
      amount: settlement.carry_in, source_log_id: null, is_override: false,
      note: `Balance carried over from ${semi.carry_from || "last month"}`, log_date: null,
    } : null,
    // Cash advance installments, one line per advance.
    ...cashAdvance.lines.filter((line) => line.amount > 0).map((line) => ({
      type: "cash_advance", quantity: 1, unit: "installment", rate: line.installment, rate_config_id: null,
      amount: line.amount, source_log_id: null, is_override: false,
      note: `${line.description ? `${line.description}: ` : ""}balance ${money(line.balance_before)} → ${money(line.balance_after)}`,
      log_date: null,
    })),
  ].filter(Boolean);

  const incentiveLines = [
    ...auto.incentives,
    // Earnings: stored with the incentives, each tied to its attendance log.
    ...(auto.earnings || []),
    adjustment("early_bird", finalAmounts.early_bird, auto.amounts.early_bird, toAmount(used.early_bird_days - computed.early_bird_days), "day"),
    adjustment("perfect_attendance", finalAmounts.perfect_attendance, auto.amounts.perfect_attendance, 0, "period"),
    // Incentives and overload hours filed for the month (payroll_monthly_incentives).
    ...items.map((item) => (item.kind === "overload"
      ? {
        type: "overload", quantity: toAmount(item.hours), unit: "hour", rate: overloadRate,
        rate_config_id: resolved.overload_premium_pct?.config_id || null, amount: itemAmount(item),
        source_log_id: null, is_override: false, note: item.description || null, log_date: String(item.item_date).slice(0, 10),
      }
      : {
        type: "incentive", quantity: 1, unit: "item", rate: itemAmount(item), rate_config_id: null,
        amount: itemAmount(item), source_log_id: null, is_override: false,
        note: item.description || null, log_date: String(item.item_date).slice(0, 10),
      })),
  ].filter(Boolean);

  const payroll = computeTotals({
    basic_salary: basic,
    rates,
    deductions: {
      sss,
      philhealth,
      pagibig,
      withholding_tax: withholdingTax,
      absences_days: used.absences_days,
      late_days: used.late_days,
      late_minutes: auto.counts.late_minutes,
      undertime_minutes: used.undertime_minutes,
      half_days: used.half_days,
      leave_with_pay_days: leaveWithPayDays,
      leave_without_pay_days: leaveWithoutPayDays,
      cash_advance: cashAdvance.total,
    },
    incentives: {
      early_bird_days: used.early_bird_days,
      perfect_attendance: perfectAttendance,
    },
    attendance_amounts: finalAmounts,
    earnings: { overtime: overtimePay, holiday_pay: holidayPay },
    extra: { incentive: otherIncentive, overload: overloadPay },
  });

  const nowIso = new Date().toISOString();
  payroll.audit = {
    period: { label: period.label, start_key: period.start_key, end_key: period.end_key },
    rates: rateSnapshot(resolved),
    attendance: {
      counts: auto.counts,
      perfect_attendance: auto.perfect_attendance,
      source_log_ids: auto.source_log_ids,
      blocking: auto.blocking,
    },
    lines: { deductions: deductionLines, incentives: incentiveLines },
    deviations: deviations.length
      ? { items: deviations, reason: reason || null, by: actor?.userId || null, by_name: actor?.name || null, at: nowIso }
      : null,
    computed_at: nowIso,
    computed_by: actor?.userId || null,
    computed_by_name: actor?.name || null,
  };
  if (settling) applySecondHalfSettlement(payroll, { settlement, semi, rates });
  if (settling) {
    const t = payroll.totals;
    // The school's payroll sheet, 16-end: Rate (monthly ÷ 2) less the missed
    // days, plus OT, less every deduction. Net Pay is what this payslip pays;
    // in the rare case the 1-15 payslip did not pay exactly Rate (or a balance
    // was carried in) the row says so in a note instead of an extra column.
    const sheet = sheetFigures({
      basic: toAmount(basic / 2),
      daily: rates.daily,
      hourly: rates.hourly,
      periodDays: periodDaysFor(rates.working_days_per_year, semi.working_days),
      absenceDeduction: t.absence_deduction,
      halfDayDeduction: t.half_day_deduction,
      leaveWithoutPayDeduction: t.leave_without_pay_deduction,
      lateDeduction: t.late_deduction,
      undertimeDeduction: t.undertime_deduction,
      overtimeMinutes: auto.counts.overtime_minutes,
      overtimePay: t.overtime_pay,
      overtimePremiumPct: rates.overtime_premium_pct,
      holidayPay: t.holiday_pay,
      incentives: payroll.monthly.month_totals.total_incentives,
      cashAdvance: cashAdvance.total,
      sss,
      philhealth,
      pagibig,
      withholdingTax,
    });
    const difference = toAmount(sheet.net_pay - settlement.second_half_net);
    payroll.sheet = {
      ...sheet,
      half: "second",
      net_pay: settlement.second_half_net,
      ...(Math.abs(difference) >= 0.01 ? {
        net_note: settlement.carry_in
          ? `Less ${money(settlement.carry_in)} carried over from last month`
          : `1-15 payslip paid ${money(semi.first_half?.net_pay || 0)} instead of ${money(sheet.rate)}`,
      } : {}),
    };
    payroll.cash_advances = cashAdvance.lines.filter((line) => line.amount > 0)
      .map((line) => ({ advance_id: line.advance_id, amount: line.amount, balance_after: line.balance_after, description: line.description }));
    payroll.audit.school_sheet = {
      rule: "semi_monthly",
      contribution_method: Number(rates.contribution_method) === 1 ? "fixed" : "legal",
      monthly_contributions: { sss: schoolMonthly.sss, philhealth: schoolMonthly.philhealth, pagibig: schoolMonthly.pagibig },
      contribution_source: schoolMonthly.source,
      cash_advances: cashAdvance.lines,
    };
  }
  if (school) {
    const t = payroll.totals;
    // The school's payroll sheet columns, from the amounts just charged.
    payroll.sheet = sheetFigures({
      basic,
      daily: rates.daily,
      hourly: rates.hourly,
      periodDays: periodDaysFor(rates.working_days_per_year, school.working_days),
      absenceDeduction: t.absence_deduction,
      halfDayDeduction: t.half_day_deduction,
      leaveWithoutPayDeduction: t.leave_without_pay_deduction,
      lateDeduction: t.late_deduction,
      undertimeDeduction: t.undertime_deduction,
      overtimeMinutes: auto.counts.overtime_minutes,
      overtimePay: t.overtime_pay,
      overtimePremiumPct: rates.overtime_premium_pct,
      holidayPay: t.holiday_pay,
      incentives: t.total_incentives,
      cashAdvance: t.cash_advance_deduction,
      sss,
      philhealth,
      pagibig,
      withholdingTax,
    });
    payroll.sheet.half = school.half;
    // Repaid by this payslip once it is Final (src/lib/payroll/cash-advance.js).
    payroll.cash_advances = cashAdvance.lines.filter((line) => line.amount > 0)
      .map((line) => ({ advance_id: line.advance_id, amount: line.amount, balance_after: line.balance_after, description: line.description }));
    // 13th month: basic pay less unpaid absences.
    payroll.basic_earned = Math.max(0, toAmount(basic - t.absence_deduction - t.leave_without_pay_deduction));
    payroll.audit.school_sheet = {
      rule: "per_half",
      half: school.half,
      working_days: school.working_days,
      contribution_half: Number(rates.contribution_half) || 3,
      contribution_method: Number(rates.contribution_method) === 1 ? "fixed" : "legal",
      monthly_contributions: { sss: schoolMonthly.sss, philhealth: schoolMonthly.philhealth, pagibig: schoolMonthly.pagibig },
      contribution_source: schoolMonthly.source,
      cash_advances: cashAdvance.lines,
    };
  }

  return {
    payroll,
    deviations,
    reason,
    blocking: auto.blocking,
    refusal: null,
    // What the form and the batch table pre-fill (GET).
    defaults: {
      statutory_method: legal ? "legal" : "flat",
      basic_salary: defaultBasic,
      ...(settling ? {
        semi_monthly: "second",
        other_incentive: otherIncentive,
        overload_hours: overloadHours,
        overload_pay: overloadPay,
        first_half_paid: semi.first_half.net_pay,
        first_half_status: semi.first_half.status,
        carry_in: semi.carry_in,
        monthly: payroll.monthly,
        sheet: payroll.sheet,
      } : {}),
      ...(school ? {
        per_half: school.half,
        other_incentive: otherIncentive,
        overload_hours: overloadHours,
        overload_pay: overloadPay,
        contribution_source: schoolMonthly.source,
        sheet: payroll.sheet,
      } : {}),
      // Where each contribution comes from: legal table, fixed amount, or
      // the employee's own (the form's hints).
      ...(schoolMonthly ? { contribution_source: schoolMonthly.source } : {}),
      // Cash advance installments this payslip deducts (not editable here:
      // put an advance On Hold in Cash Advances to skip it).
      cash_advance: cashAdvance.total,
      cash_advances: cashAdvance.lines,
      sss: contributionDefault("sss"),
      philhealth: contributionDefault("philhealth"),
      pagibig: contributionDefault("pagibig"),
      withholding_tax: taxDefault,
      overtime: overtimePay,
      holiday_pay: holidayPay,
    },
  };
}

const DEVIATION_LABELS = {
  basic_salary: "Basic Salary",
  sss: "SSS",
  philhealth: "PhilHealth",
  pagibig: "Pag-IBIG",
  withholding_tax: "Withholding Tax",
  leave_without_pay_days: "Leave Without Pay",
  absences_days: "Absent",
  late_days: "Late",
  undertime_minutes: "Undertime",
  half_days: "Half Day",
  early_bird_days: "Early Bird",
  perfect_attendance: "Perfect Attendance",
};

function describeBlocking(blocking) {
  const days = blocking
    .map((item) => `${item.log_date} (${item.status})`)
    .join(", ");
  return `Unresolved attendance: ${days}. Resolve these in Attendance before processing this employee.`;
}

function describeMissingReason(deviations) {
  const fields = [...new Set(deviations.map((d) => DEVIATION_LABELS[d.field] || d.field))].join(", ");
  return `Give a reason for changing ${fields} from the computed values.`;
}

/** Columns kept on the payslip row itself for auditability. */
function recordAuditColumns(entry) {
  const audit = entry.payroll?.audit || {};
  return {
    base_pay: toAmount(entry.payroll?.basic_salary),
    total_incentives: toAmount(entry.payroll?.totals?.total_incentives),
    period_start: audit.period?.start_key || null,
    period_end: audit.period?.end_key || null,
    rate_version_snapshot: audit.rates || null,
    attendance_snapshot: audit.attendance
      ? { ...audit.attendance, lines: audit.lines || null, generation: entry.payroll?.generation || null }
      : null,
    deviations: audit.deviations || null,
    processed_by: entry.processed_by || null,
    processed_by_name: entry.processed_by_name || null,
  };
}

/**
 * The payroll_deductions / payroll_incentives rows for an entry's lines,
 * written in the same transaction as the payslip (commitPayrollEntries).
 */
function buildPayrollLineRows(entry) {
  const audit = entry.payroll?.audit;
  if (!audit?.lines) return { deductions: [], incentives: [] };

  const shape = (line) => ({
    type: line.type,
    quantity: line.quantity ?? null,
    unit: line.unit || null,
    rate: line.rate ?? null,
    rate_config_id: line.rate_config_id || null,
    amount: toAmount(line.amount),
    source_log_id: line.source_log_id || null,
    source_log_ids: Array.isArray(line.source_log_ids) && line.source_log_ids.length ? line.source_log_ids : null,
    is_override: line.is_override === true,
    note: line.note || null,
  });

  return {
    deductions: (audit.lines.deductions || []).map(shape),
    incentives: (audit.lines.incentives || []).map(shape),
  };
}

function mapEntryToRecord(entry) {
  const grossPay = Number(entry.payroll?.totals?.gross_pay || 0);
  const totalDeductions = Number(entry.payroll?.totals?.total_deductions || 0);
  const netPay = floorNetPay(entry.payroll?.totals?.net_pay);

  return {
    id: entry.id,
    employee_id: entry.employee_id,
    employee_name: entry.employee_name,
    employee_code: entry.employee_code,
    employee_type: entry.employee_type,
    pay_period: entry.pay_period,
    payslip_no: entry.payslip_no || null,
    gross_pay: grossPay,
    total_deductions: totalDeductions,
    net_pay: netPay,
    status: entry.status,
    submitted_at: entry.submitted_at,
    updated_at: entry.updated_at,
    payroll: entry.payroll,
  };
}

function buildPayrollPanels(records) {
  const totals = records.reduce((acc, record) => {
    acc.gross += Number(record.gross_pay || 0);
    acc.deductions += Number(record.total_deductions || 0);
    acc.net += Number(record.net_pay || 0);
    return acc;
  }, { gross: 0, deductions: 0, net: 0 });

  return {
    total_gross: toAmount(totals.gross),
    total_deductions: toAmount(totals.deductions),
    total_net: toAmount(totals.net),
  };
}

function buildPayslipOptions(records, generatedDrafts = []) {
  return [
    ...generatedDrafts.map((entry) => ({
      id: entry.id,
      label: `${entry.employee_name} — ${entry.pay_period} (Draft)`,
    })),
    ...records
      .filter((record) => record.status !== "on_hold")
      .map((record) => ({
        id: record.id,
        label: `${record.employee_name} — ${record.pay_period}`,
      })),
  ];
}

/** "Oct 12, 2026, 09:30 AM" (Manila). */
function formatManilaDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || "");
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

/** The generation window for a period, from the Pay Calendar (Asia/Manila dates). */
async function periodWindow(supabase, period) {
  return generationWindow(period, { payCalendar: await loadPayCalendar(supabase) });
}

/**
 * Process Payroll / Process for All write Final payslips, so they are only
 * accepted once the period has ended and until its pay date. Before that,
 * Generate makes a Draft.
 */
function refuseOutsideFinalWindow(genWindow) {
  if (genWindow.state === "final") return null;
  const error = genWindow.state === "not_open"
    ? genWindow.message
    : genWindow.state === "draft"
      ? `This period ends on ${formatDateKey(genWindow.period_end)}: a payslip generated now is a Draft (use Generate). Final payslips are processed from ${formatDateKey(addDayKey(genWindow.period_end, 1))} to the pay date, ${formatDateKey(genWindow.pay_date)}.`
      : genWindow.message;
  return NextResponse.json({ error, code: "generation_window", genWindow }, { status: 403 });
}

function addDayKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The employee's payslip state for the period, for the Generate buttons. */
function payslipStateFor(entries, employeeId, periodLabel) {
  const entry = entries.find((row) => row.employee_id === employeeId && row.pay_period === periodLabel);
  if (!entry) return null;
  const generation = entry.payroll?.generation || null;
  return {
    entry_id: entry.id,
    status: entry.status === "draft" ? (generation ? "draft" : "form_draft") : "final",
    payslip_no: entry.payslip_no || null,
    attendance_through: generation?.attendance_through || null,
    generated_at: generation?.generated_at || null,
    generated_by_name: generation?.generated_by_name || null,
  };
}

function buildPayslipDetails(entry) {
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
      total_incentives: entry.payroll.totals.total_incentives ?? 0,
    },
    net_pay: entry.payroll.totals.net_pay,
    // Semi-monthly: the month's computation (2nd half) or the half-salary
    // 1st half; rendered instead of the per-period breakdown.
    monthly: entry.payroll.monthly || null,
  };
}

// Recovers the {start_key, end_key} a period label (e.g. "January 1-15, 2026")
// refers to, by regenerating labels for nearby months' first/second halves and
// matching. Falls back to null (caller uses "today"'s period) when the label
// doesn't match anything in that window — e.g. it's blank, or far outside the
// range anyone would realistically be preparing or reviewing.
function findPeriodRangeByLabel(label) {
  if (!label) return null;
  const now = manilaToday();
  for (let offset = -3; offset <= 3; offset += 1) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const firstHalf = getPayPeriodRange(new Date(monthDate.getFullYear(), monthDate.getMonth(), 1));
    if (firstHalf.label === label) return firstHalf;
    const secondHalf = getPayPeriodRange(new Date(monthDate.getFullYear(), monthDate.getMonth(), 16));
    if (secondHalf.label === label) return secondHalf;
  }
  return null;
}

function getPeriodOptions(entries) {
  const unique = new Set(entries.map((entry) => entry.pay_period).filter(Boolean));
  const periods = Array.from(unique.values());

  // Always offer both semi-monthly periods of the current month, regardless
  // of which half "today" falls in, so the second cutoff can be prepared
  // ahead of time and the first stays reachable after it closes.
  const now = manilaToday();
  const secondHalfLabel = getPayPeriodRange(new Date(now.getFullYear(), now.getMonth(), 16)).label;
  const firstHalfLabel = getPayPeriodRange(new Date(now.getFullYear(), now.getMonth(), 1)).label;

  [secondHalfLabel, firstHalfLabel].forEach((label) => {
    if (!periods.includes(label)) periods.unshift(label);
  });

  return periods;
}

/* ── 13th month pay (src/lib/payroll/thirteenth-month.js) ─────────────────── */

/** GET ?view=thirteenth_month&year=YYYY: every employee's 13th month from their Final payslips. */
async function handleThirteenthMonthView(supabase, employees, entries, url) {
  const today = manilaDateKey();
  const year = Number(url.searchParams.get("year")) || Number(today.slice(0, 4));
  const processed = await supabase
    .from("payroll_thirteenth_month")
    .select("employee_id,year,basic_earned,amount,processed_at,processed_by_name")
    .eq("year", year);
  const available = !processed.error;
  const done = new Map((processed.data || []).map((row) => [row.employee_id, row]));

  const rows = employees.map((employee) => {
    const computed = compute13thMonthFromEntries(entries.filter((entry) => entry.employee_id === employee.id), year);
    return {
      employee_id: employee.id,
      employee_name: employee.full_name,
      employee_code: employee.employee_id,
      employee_type: employee.employee_type,
      total_basic_earned: computed.total_basic_earned,
      amount: computed.amount,
      periods: computed.periods,
      processed: done.get(employee.id) || null,
    };
  });

  return NextResponse.json({
    year,
    available,
    error: available ? null : PAYROLL_NOT_READY_MESSAGE,
    process_opens: `${year}-12-01`,
    can_process: available && today >= `${year}-12-01`,
    rows,
    total_amount: toAmount(rows.reduce((sum, row) => sum + (row.processed ? Number(row.processed.amount) : row.amount), 0)),
  });
}

/** PATCH { action: "process_13th_month", year, employee_ids? }: record the December payout. */
async function handleProcessThirteenthMonth(supabase, body, guard) {
  const today = manilaDateKey();
  const year = Number(body.year) || Number(today.slice(0, 4));
  if (today < `${year}-12-01`) {
    return NextResponse.json({ error: `The ${year} 13th month pay is processed in December, from ${formatDateKey(`${year}-12-01`)}.`, code: "thirteenth_month_window" }, { status: 403 });
  }

  const [employees, { entries }] = await Promise.all([fetchEmployees(supabase, guard), readPayrollEntries(supabase)]);
  const wanted = Array.isArray(body.employee_ids) && body.employee_ids.length ? new Set(body.employee_ids.map(String)) : null;
  const existing = await supabase.from("payroll_thirteenth_month").select("employee_id").eq("year", year);
  if (existing.error) return NextResponse.json({ error: PAYROLL_NOT_READY_MESSAGE, code: "payroll_not_ready" }, { status: 503 });
  const already = new Set((existing.data || []).map((row) => row.employee_id));
  const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
  const nowIso = new Date().toISOString();

  const processed = [];
  const skipped = [];
  const rows = [];
  employees.filter((employee) => !wanted || wanted.has(employee.id)).forEach((employee) => {
    if (isOwnPayroll(guard, employee.id)) {
      skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason: OWN_PAYROLL_MESSAGE, code: "own_payroll" });
      return;
    }
    if (already.has(employee.id)) {
      skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason: "Already processed." });
      return;
    }
    const computed = compute13thMonthFromEntries(entries.filter((entry) => entry.employee_id === employee.id), year);
    if (!(computed.amount > 0)) {
      skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason: "No basic pay earned this year." });
      return;
    }
    rows.push({
      employee_id: employee.id,
      employee_name: employee.full_name,
      year,
      basic_earned: computed.total_basic_earned,
      amount: computed.amount,
      breakdown: { periods: computed.periods },
      processed_by: guard.userId || null,
      processed_by_name: actorName || null,
      processed_at: nowIso,
    });
    processed.push({ employee_id: employee.id, employee_name: employee.full_name, amount: computed.amount });
  });

  if (rows.length) {
    const result = await supabase.from("payroll_thirteenth_month").insert(rows);
    if (result.error) {
      const duplicate = isDuplicateKeyError(result.error);
      return NextResponse.json({
        error: duplicate ? "Another 13th month payout for this year was recorded at the same time. Refresh and try again." : sanitizeError(result.error),
      }, { status: duplicate ? 409 : 500 });
    }
  }

  await appendAuditLog({
    actor: guard,
    module: "payroll",
    action: "thirteenth_month_process",
    entity_type: "payroll_thirteenth_month",
    entity_id: String(year),
    description: `13th month pay ${year} processed for ${processed.length} employee(s)${skipped.length ? ` (${skipped.length} skipped)` : ""}.`,
    status: "success",
    source: "api",
    metadata: { year, processed, skipped },
  });

  return NextResponse.json({ success: true, year, processed, skipped });
}

/* ── Incentives and overload hours (payroll_monthly_incentives) ────────────── */

const MONTHLY_ITEM_KINDS = new Set(["incentive", "overload"]);

/** Lock days in force, from the rate versions (semi-monthly payroll). */
async function loadLockDayFor(supabase) {
  const { configs } = await loadRateConfigs(supabase);
  return (monthKey) => Number(resolveRate(configs, "attendance_lock_day", {}, `${monthKey}-16`).value) || 0;
}

function itemPayrollMonth(item, lockDayFor) {
  return payrollMonthFor(
    String(item.item_date).slice(0, 10),
    manilaDateKey(new Date(item.created_at || Date.now())),
    lockDayFor,
  );
}

/** GET ?view=monthly_items&month=YYYY-MM: the items dated in or counted for a month. */
async function handleMonthlyItemsView(supabase, employees, url) {
  const param = normalizeText(url.searchParams.get("month"));
  const monthKey = /^\d{4}-\d{2}$/.test(param) ? param : manilaDateKey().slice(0, 7);
  const month = monthInfo(monthKey);
  const lockDayFor = await loadLockDayFor(supabase);
  const names = new Map(employees.map((employee) => [employee.id, employee]));

  const result = await fetchAllRows(() => supabase
    .from("payroll_monthly_incentives")
    .select("id,employee_id,item_date,kind,description,amount,hours,created_at,created_by_name")
    .eq("archived", false)
    .gte("item_date", monthInfo(shiftMonth(monthKey, -1)).start_key)
    .lte("item_date", month.end_key)
    .order("item_date", { ascending: false })
    .order("id", { ascending: true }));
  if (result.error) {
    return NextResponse.json({ available: false, error: PAYROLL_NOT_READY_MESSAGE, month, items: [] });
  }

  const items = (result.data || [])
    .filter((item) => names.has(item.employee_id))
    .map((item) => {
      const payrollMonth = itemPayrollMonth(item, lockDayFor);
      return {
        ...item,
        item_date: String(item.item_date).slice(0, 10),
        employee_name: names.get(item.employee_id).full_name,
        employee_code: names.get(item.employee_id).employee_id,
        payroll_month: payrollMonth,
        payroll_month_label: monthInfo(payrollMonth).label,
        moved_to_next_month: payrollMonth !== monthKeyOf(item.item_date),
      };
    })
    .filter((item) => item.payroll_month === monthKey || monthKeyOf(item.item_date) === monthKey);

  const lockDay = lockDayFor(monthKey);
  return NextResponse.json({
    available: true,
    month,
    lock_day: lockDay,
    window: monthlyWindow(monthKey, lockDayFor, {
      carryOver: Number(resolveRate((await loadRateConfigs(supabase)).configs, "carry_after_lock", {}, `${monthKey}-16`).value) !== 0,
    }),
    items,
  });
}

/** POST { action: "add_monthly_item", employee_id, item_date, kind, description, amount | hours } */
async function handleAddMonthlyItem(supabase, body, guard) {
  const employees = await fetchEmployees(supabase, guard);
  const employee = employees.find((row) => row.id === normalizeText(body.employee_id));
  if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
  const own = refuseOwnPayroll(guard, employee.id);
  if (own) return own;

  const kind = normalizeText(body.kind).toLowerCase();
  const itemDate = normalizeText(body.item_date);
  const description = normalizeText(body.description).slice(0, 200);
  const amount = Number(body.amount);
  const hours = Number(body.hours);
  if (!MONTHLY_ITEM_KINDS.has(kind)) return NextResponse.json({ error: "Choose Incentive or Overload." }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(itemDate)) return NextResponse.json({ error: "Choose the date it is for." }, { status: 400 });
  if (itemDate < SEMI_MONTHLY_RULES_EFFECTIVE) {
    return NextResponse.json({ error: `Incentives and overload are paid by the semi-monthly payroll, from ${formatDateKey(SEMI_MONTHLY_RULES_EFFECTIVE)}.` }, { status: 400 });
  }
  if (!description) return NextResponse.json({ error: "Describe what it is for." }, { status: 400 });
  if (kind === "incentive" && !(Number.isFinite(amount) && amount > 0 && amount <= 9999999.99)) {
    return NextResponse.json({ error: "Enter an incentive amount greater than 0." }, { status: 400 });
  }
  if (kind === "overload" && !(Number.isFinite(hours) && hours > 0 && hours <= 744)) {
    return NextResponse.json({ error: "Enter overload hours greater than 0 (at most 744)." }, { status: 400 });
  }

  const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
  const row = {
    employee_id: employee.id,
    branch_id: employee.branch_id || null,
    item_date: itemDate,
    kind,
    description,
    amount: kind === "incentive" ? toAmount(amount) : null,
    hours: kind === "overload" ? toAmount(hours) : null,
    created_by: guard.userId || null,
    created_by_name: actorName || null,
    created_at: new Date().toISOString(),
  };
  const result = await supabase.from("payroll_monthly_incentives").insert(row);
  if (result.error) {
    return NextResponse.json({ error: isInternalDbSchemaError(result.error.message) ? PAYROLL_NOT_READY_MESSAGE : sanitizeError(result.error) }, { status: 500 });
  }

  const payrollMonth = itemPayrollMonth(row, await loadLockDayFor(supabase));
  await appendAuditLog({
    actor: guard,
    module: "payroll",
    action: "monthly_item_add",
    entity_type: "payroll_monthly_incentive",
    entity_id: employee.id,
    description: `${kind === "incentive" ? `Incentive ₱${money(row.amount)}` : `Overload ${row.hours} h`} for ${employee.full_name} (${description}), counted in ${monthInfo(payrollMonth).label} payroll.`,
    status: "success",
    source: "api",
    metadata: { ...row, payroll_month: payrollMonth },
  });

  return NextResponse.json({ success: true, payroll_month: payrollMonth, payroll_month_label: monthInfo(payrollMonth).label });
}

/** PATCH { action: "archive_monthly_item", item_id }: never once a Final payslip paid it. */
async function handleArchiveMonthlyItem(supabase, body, guard) {
  const itemId = normalizeText(body.item_id);
  if (!itemId) return NextResponse.json({ error: "item_id is required." }, { status: 400 });
  const found = await supabase.from("payroll_monthly_incentives").select("*").eq("id", itemId).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  const item = found.data;
  if (!item || item.archived) return NextResponse.json({ error: "Item not found." }, { status: 404 });

  const employees = await fetchEmployees(supabase, guard);
  const employee = employees.find((row) => row.id === item.employee_id);
  if (!employee) return NextResponse.json({ error: "That item belongs to another branch." }, { status: 403 });
  const own = refuseOwnPayroll(guard, employee.id);
  if (own) return own;

  const payrollMonth = itemPayrollMonth(item, await loadLockDayFor(supabase));
  const secondHalf = monthInfo(payrollMonth).second_half_label;
  const paid = await supabase
    .from("payroll_entries")
    .select("id,status")
    .eq("employee_id", item.employee_id)
    .eq("pay_period", secondHalf)
    .maybeSingle();
  if (paid.data?.status === "paid") {
    return NextResponse.json({ error: `Already paid on the Final ${secondHalf} payslip; it can no longer be removed.`, code: "payslip_locked" }, { status: 409 });
  }

  const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
  const result = await supabase
    .from("payroll_monthly_incentives")
    .update({ archived: true, archived_by: guard.userId || null, archived_by_name: actorName || null, archived_at: new Date().toISOString() })
    .eq("id", itemId);
  if (result.error) throw new Error(result.error.message);

  await appendAuditLog({
    actor: guard,
    module: "payroll",
    action: "monthly_item_archive",
    entity_type: "payroll_monthly_incentive",
    entity_id: itemId,
    description: `Removed ${item.kind} "${item.description}" for ${employee.full_name} from ${monthInfo(payrollMonth).label} payroll.`,
    status: "success",
    source: "api",
    metadata: { item_id: itemId, employee_id: item.employee_id, payroll_month: payrollMonth },
  });

  return NextResponse.json({ success: true });
}

/* ── The school's payroll sheet (src/lib/payroll/school-sheet.js) ─────────── */

const SHEET_CONFIG_KEYS = ["sheet_school_name", "sheet_approver_name", "sheet_approver_title"];

/** "Benitez, Jane Marinel D." from the name parts, or the full name. */
function sheetName(profile, fallback) {
  const last = normalizeText(profile?.last_name);
  const first = normalizeText(profile?.first_name);
  if (!last || !first) return normalizeText(fallback);
  const middle = normalizeText(profile?.middle_name);
  return `${last}, ${first}${middle ? ` ${middle.charAt(0)}.` : ""}`;
}

/**
 * GET ?view=payroll_sheet&period=<label>[&branch_id=<uuid>]: the period's
 * payslips laid out like the school's payroll sheet, one table per branch,
 * with totals, and the header / approval block from System Configuration.
 * Drafts are included and marked, so the sheet can be checked before the
 * payslips are Final.
 */
async function handlePayrollSheetView(supabase, employees, entries, url) {
  const label = normalizeText(url.searchParams.get("period"));
  const period = periodFromLabel(label) || findPeriodRangeByLabel(label);
  if (!period) return NextResponse.json({ error: "Choose a pay period." }, { status: 400 });
  const branchFilter = normalizeText(url.searchParams.get("branch_id"));

  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  const periodEntries = entries.filter((entry) => entry.pay_period === period.label && byId.has(entry.employee_id));
  const ids = periodEntries.map((entry) => entry.employee_id);

  const [branchResult, profileResult, configResult] = await Promise.all([
    supabase.from("branches").select("id,name"),
    ids.length
      ? supabase.from("profiles").select("id,first_name,middle_name,last_name").in("id", ids)
      : { data: [], error: null },
    supabase.from("system_config").select("key,value").eq("section", "payroll").in("key", SHEET_CONFIG_KEYS),
  ]);
  const branchNames = new Map((branchResult.data || []).map((row) => [row.id, row.name]));
  const profiles = new Map((profileResult.data || []).map((row) => [row.id, row]));
  const config = Object.fromEntries((configResult.data || []).map((row) => [row.key, row.value]));

  const groups = new Map();
  periodEntries.forEach((entry) => {
    const employee = byId.get(entry.employee_id);
    const branchId = employee.branch_id || "";
    if (branchFilter && branchFilter !== "all" && branchFilter !== branchId) return;
    if (!groups.has(branchId)) {
      groups.set(branchId, { branch_id: branchId || null, branch_name: branchNames.get(branchId) || "Unassigned", rows: [] });
    }
    groups.get(branchId).rows.push({
      entry_id: entry.id,
      employee_id: entry.employee_id,
      employee_code: entry.employee_code,
      name: sheetName(profiles.get(entry.employee_id), entry.employee_name).toUpperCase(),
      status: entry.status === "draft" ? "draft" : "final",
      payslip_no: entry.payslip_no || null,
      ...sheetRowFromEntry(entry),
    });
  });

  const branches = [...groups.values()]
    .map((group) => {
      const rows = group.rows.sort((a, b) => a.name.localeCompare(b.name));
      return { ...group, rows, totals: sheetTotals(rows) };
    })
    .sort((a, b) => a.branch_name.localeCompare(b.branch_name));
  const allRows = branches.flatMap((group) => group.rows);

  // A 16-end payslip deducts the attendance read up to the lock day (the 15th
  // for the school), not the 16-end days themselves; the sheet says which.
  const attendanceWindow = periodEntries.map((entry) => entry.payroll?.monthly?.window).find((w) => w?.start_key) || null;

  return NextResponse.json({
    period: { label: period.label, start_key: period.start_key, end_key: period.end_key },
    attendance_window: attendanceWindow,
    header: {
      school_name: config.sheet_school_name || "",
      approver_name: config.sheet_approver_name || "",
      approver_title: config.sheet_approver_title || "",
    },
    branches,
    grand_totals: sheetTotals(allRows),
    draft_count: allRows.filter((row) => row.status === "draft").length,
    missing: employees
      .filter((employee) => !periodEntries.some((entry) => entry.employee_id === employee.id))
      .filter((employee) => !branchFilter || branchFilter === "all" || (employee.branch_id || "") === branchFilter)
      .map((employee) => ({ employee_id: employee.id, employee_name: employee.full_name })),
    branch_options: [...branchNames.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  });
}

/* ── Cash advances (src/lib/payroll/cash-advance.js) ─────────────────────── */

const CASH_ADVANCE_NOT_READY = "Cash advances are not set up yet: apply supabase/migrations/20261006010000_school_payroll_sheet.sql first.";

/** GET ?view=cash_advances: every advance of the caller's employees, with its balance and repayments. */
async function handleCashAdvancesView(supabase, employees, entries) {
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  const result = await fetchAllRows(() => supabase
    .from("payroll_cash_advances")
    .select("*")
    .order("date_granted", { ascending: false })
    .order("id", { ascending: true }));
  if (result.error) return NextResponse.json({ available: false, error: CASH_ADVANCE_NOT_READY, advances: [] });

  const repaid = repaidByAdvance(entries);
  const paymentsFor = (advanceId) => entries
    .filter((entry) => entry.status === "paid")
    .flatMap((entry) => (entry.payroll?.cash_advances || [])
      .filter((line) => String(line.advance_id) === String(advanceId))
      .map((line) => ({ pay_period: entry.pay_period, payslip_no: entry.payslip_no || null, amount: toAmount(line.amount) })));

  const advances = (result.data || [])
    .filter((row) => byId.has(row.employee_id))
    .map((row) => {
      const balance = advanceBalance(row, repaid);
      return {
        ...row,
        principal: toAmount(row.principal),
        installment_amount: toAmount(row.installment_amount),
        employee_name: byId.get(row.employee_id).full_name,
        employee_code: byId.get(row.employee_id).employee_id,
        repaid: toAmount(repaid.get(String(row.id)) || 0),
        balance,
        fully_paid: balance <= 0,
        payments: paymentsFor(row.id),
      };
    });

  const open = advances.filter((row) => row.status !== "cancelled" && !row.fully_paid);
  return NextResponse.json({
    available: true,
    advances,
    summary: {
      open_count: open.length,
      outstanding: toAmount(open.reduce((sum, row) => sum + row.balance, 0)),
      repaid: toAmount(advances.reduce((sum, row) => sum + row.repaid, 0)),
    },
  });
}

/**
 * POST { action: "add_cash_advance", employee_id, principal, installment_amount,
 *        deduct_on, date_granted, start_date, description }
 */
async function handleAddCashAdvance(supabase, body, guard) {
  const employees = await fetchEmployees(supabase, guard);
  const employee = employees.find((row) => row.id === normalizeText(body.employee_id));
  if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
  const own = refuseOwnPayroll(guard, employee.id);
  if (own) return own;

  const input = {
    principal: body.principal,
    installment_amount: body.installment_amount,
    deduct_on: normalizeText(body.deduct_on, "both").toLowerCase(),
    date_granted: normalizeText(body.date_granted),
    start_date: normalizeText(body.start_date),
  };
  const invalid = validateCashAdvanceInput(input);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  // A period already Final for this employee cannot take a new deduction.
  const startPeriod = getPayPeriodRange(new Date(`${input.start_date}T00:00:00`));
  const finalExists = await supabase
    .from("payroll_entries")
    .select("id")
    .eq("employee_id", employee.id)
    .eq("pay_period", startPeriod.label)
    .eq("status", "paid")
    .maybeSingle();
  if (finalExists.data) {
    return NextResponse.json({ error: `${employee.full_name}'s ${startPeriod.label} payslip is already Final. Start the deduction on a later pay period.` }, { status: 409 });
  }

  const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
  const row = {
    employee_id: employee.id,
    branch_id: employee.branch_id || null,
    date_granted: input.date_granted,
    principal: toAmount(input.principal),
    installment_amount: toAmount(input.installment_amount),
    deduct_on: input.deduct_on,
    start_date: input.start_date,
    status: "active",
    description: normalizeText(body.description).slice(0, 200) || null,
    created_by: guard.userId || null,
    created_by_name: actorName || null,
    created_at: new Date().toISOString(),
  };
  const result = await supabase.from("payroll_cash_advances").insert(row).select("id").maybeSingle();
  if (result.error) {
    return NextResponse.json({ error: isInternalDbSchemaError(result.error.message) ? CASH_ADVANCE_NOT_READY : sanitizeError(result.error) }, { status: 500 });
  }

  await appendAuditLog({
    actor: guard,
    module: "payroll",
    action: "cash_advance_add",
    entity_type: "payroll_cash_advance",
    entity_id: result.data?.id || employee.id,
    description: `Cash advance ₱${money(row.principal)} for ${employee.full_name}, ₱${money(row.installment_amount)} per payslip from ${startPeriod.label}.`,
    status: "success",
    source: "api",
    metadata: row,
  });

  return NextResponse.json({ success: true, id: result.data?.id || null, start_period: startPeriod.label });
}

/** PATCH { action: "set_cash_advance_status", advance_id, status: active | on_hold | cancelled, reason } */
async function handleSetCashAdvanceStatus(supabase, body, guard) {
  const advanceId = normalizeText(body.advance_id);
  const status = normalizeText(body.status).toLowerCase();
  const reason = normalizeText(body.reason).slice(0, 300);
  if (!advanceId) return NextResponse.json({ error: "advance_id is required." }, { status: 400 });
  if (!CASH_ADVANCE_STATUSES.includes(status)) return NextResponse.json({ error: "Status must be active, on_hold or cancelled." }, { status: 400 });
  if (status === "cancelled" && reason.length < 5) return NextResponse.json({ error: "Give a reason for cancelling the advance." }, { status: 400 });

  const found = await supabase.from("payroll_cash_advances").select("*").eq("id", advanceId).maybeSingle();
  if (found.error) return NextResponse.json({ error: CASH_ADVANCE_NOT_READY }, { status: 503 });
  const advance = found.data;
  if (!advance) return NextResponse.json({ error: "Cash advance not found." }, { status: 404 });
  if (advance.status === "cancelled") return NextResponse.json({ error: "A cancelled advance cannot be changed." }, { status: 409 });

  const employees = await fetchEmployees(supabase, guard);
  const employee = employees.find((row) => row.id === advance.employee_id);
  if (!employee) return NextResponse.json({ error: "That cash advance belongs to another branch." }, { status: 403 });
  const own = refuseOwnPayroll(guard, employee.id);
  if (own) return own;

  const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
  const result = await supabase
    .from("payroll_cash_advances")
    .update({
      status,
      status_reason: reason || null,
      status_changed_by: guard.userId || null,
      status_changed_by_name: actorName || null,
      status_changed_at: new Date().toISOString(),
    })
    .eq("id", advanceId);
  if (result.error) throw new Error(result.error.message);

  const words = { active: "resumed", on_hold: "put on hold", cancelled: "cancelled" };
  await appendAuditLog({
    actor: guard,
    module: "payroll",
    action: "cash_advance_status",
    entity_type: "payroll_cash_advance",
    entity_id: advanceId,
    description: `Cash advance ₱${money(advance.principal)} for ${employee.full_name} ${words[status]}${reason ? `: ${reason}` : ""}.`,
    status: "success",
    source: "api",
    metadata: { advance_id: advanceId, from: advance.status, to: status, reason: reason || null },
  });

  return NextResponse.json({ success: true });
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "process_payroll", "read");
    if (guard.denied) return guard.denied;

    const url = new URL(request.url);
    const requestedEntryId = normalizeText(url.searchParams.get("entry_id"));
    const selectedPeriod = normalizeText(url.searchParams.get("period"));

    const supabase = getAdminClient();
    const [employees, entriesResult] = await Promise.all([
      fetchEmployees(supabase, guard),
      readPayrollEntries(supabase),
    ]);

    // ?view=thirteenth_month&year=… and ?view=monthly_items&month=YYYY-MM
    const view = normalizeText(url.searchParams.get("view")).toLowerCase();
    if (view === "thirteenth_month") return await handleThirteenthMonthView(supabase, employees, entriesResult.entries, url, guard);
    if (view === "monthly_items") return await handleMonthlyItemsView(supabase, employees, url);
    if (view === "payroll_sheet") return await handlePayrollSheetView(supabase, employees, entriesResult.entries, url);
    if (view === "cash_advances") return await handleCashAdvancesView(supabase, employees, entriesResult.entries);

    // ?format=pdf&entry_id=… : the payslip as a PDF download.
    if (normalizeText(url.searchParams.get("format")).toLowerCase() === "pdf") {
      const visible = new Set(employees.map((e) => e.id));
      const entry = entriesResult.entries.find((row) => row.id === requestedEntryId);
      if (!entry || (!guard.branchExempt && !visible.has(entry.employee_id))) {
        return NextResponse.json({ error: "Payslip not found." }, { status: 404 });
      }
      const details = buildPayslipDetails(entry);
      const pdf = buildPayslipPdf(details);
      const fileName = `payslip-${(entry.payslip_no || entry.employee_code || "draft").replace(/[^\w-]/g, "")}-${entry.pay_period.replace(/[^\w-]+/g, "-")}${details.status === "draft" ? "-DRAFT" : ""}.pdf`;
      return new NextResponse(pdf, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // Branch-scoped callers only ever see entries for employees in their own
    // branch — payroll_entries carries no branch_id of its own, but every
    // entry's employee_id ties back to an employee already filtered above.
    const visibleEmployeeIds = new Set(employees.map((e) => e.id));
    const branchEntries = guard.branchExempt
      ? entriesResult.entries
      : entriesResult.entries.filter((entry) => visibleEmployeeIds.has(entry.employee_id));

    const sortedEntries = branchEntries
      .map((entry) => ({
        ...entry,
        status: resolveEntryStatus(entry),
      }))
      .sort((a, b) => {
        const dateA = new Date(a.updated_at || a.created_at || 0).getTime();
        const dateB = new Date(b.updated_at || b.created_at || 0).getTime();
        return dateB - dateA;
      });

    const filteredByPeriod = selectedPeriod
      ? sortedEntries.filter((entry) => entry.pay_period === selectedPeriod)
      : sortedEntries;

    // Final payslips whose attendance was corrected after they were
    // finalized: they no longer match the records until a Super Admin
    // overrides them (src/lib/payroll/final-payslips.js).
    const finalEntries = filteredByPeriod.filter((entry) => entry.status !== "draft");
    const changedAfterFinal = await attendanceChangesAfterFinal(supabase, finalEntries);
    const payrollRecords = finalEntries.map((entry) => ({
      ...mapEntryToRecord(entry),
      attendance_changed: changedAfterFinal.get(entry.id) || null,
    }));

    const payslipSource = requestedEntryId
      ? sortedEntries.find((entry) => entry.id === requestedEntryId)
      : (payrollRecords[0]
          ? sortedEntries.find((entry) => entry.id === payrollRecords[0].id)
          : null);

    // Attendance and leave figures must reflect the period actually being
    // viewed/prepared, not always "today" — otherwise preparing the next
    // cutoff ahead of time (see getPeriodOptions()) shows the wrong half's
    // numbers.
    const activePeriod = periodFromLabel(selectedPeriod)
      || findPeriodRangeByLabel(selectedPeriod)
      || getPayPeriodRange(manilaToday());
    // When payslips for this period may be generated, and attendance counted
    // up to today while it is still open.
    const genWindow = await periodWindow(supabase, activePeriod);
    // Attendance lines, leave and the rate versions in force on the period's
    // first day, per employee (loadPeriodPayContext above).
    const payContext = await loadPeriodPayContext(supabase, employees, activePeriod, { through: genWindow.attendance_through });
    const leaveSummary = payContext.leaveSummary;
    const attendanceRows = payContext.attendanceRows.map((row) => ({
      ...row,
      payslip: payslipStateFor(sortedEntries, row.employee_id, activePeriod.label),
    }));
    const generatedDrafts = sortedEntries.filter((entry) => entry.status === "draft"
      && entry.payroll?.generation
      && (!selectedPeriod || entry.pay_period === selectedPeriod));

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      employees,
      period_options: getPeriodOptions(sortedEntries),
      records: payrollRecords,
      panels: buildPayrollPanels(payrollRecords),
      attendance_rows: attendanceRows,
      leave_summary: leaveSummary,
      active_period: { label: activePeriod.label, start_key: activePeriod.start_key, end_key: activePeriod.end_key },
      // false until the attendance / rate migrations are applied; processing
      // is refused meanwhile.
      payroll_ready: payContext.engineReady && payContext.ratesReady,
      payroll_not_ready_message: payContext.engineReady && payContext.ratesReady ? null : PAYROLL_NOT_READY_MESSAGE,
      draft_entries: sortedEntries.filter((entry) => entry.status === "draft").map(mapEntryToRecord),
      payslip_options: buildPayslipOptions(payrollRecords, generatedDrafts),
      payslip: buildPayslipDetails(payslipSource),
      generation_window: genWindow,
      // Super Admin only: change a Final payslip, with a reason.
      can_override: guard.scope === SCOPE_ALL,
      // From Oct 1, 2026: legal contribution tables and BIR withholding tax
      // (src/lib/payroll/statutory.js); the table lets the form preview the
      // tax exactly as the server computes it.
      legal_rules: usesLegalRules(activePeriod.start_key),
      // Semi-monthly payroll: the 2nd half uses the MONTHLY table (Super Admin
      // -> Withholding Tax Table); the 1st half deducts no tax.
      tax_table: payContext.semi
        ? payContext.semi.tax_table
        : SEMI_MONTHLY_TAX_TABLE,
      semi_monthly: payContext.semi
        ? {
          half: payContext.semi.half,
          month_label: payContext.semi.month_label,
          first_half_label: payContext.semi.first_half_label,
          second_half_label: payContext.semi.second_half_label,
          window: payContext.semi.window,
          lock_day: payContext.semi.lock_day,
        }
        : null,
      // The school's payroll sheet: each half paid on its own attendance.
      per_half: payContext.school
        ? { half: payContext.school.half, working_days: payContext.school.working_days }
        : null,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// Processes every employee in one request — used by the "Process Payroll for
// All" batch table. Builds every employee's payroll with the same
// buildEmployeePayroll() the single-entry path uses, then commits them all in
// one call to commitPayrollEntries().
async function handleBatchSubmit(supabase, body, guard) {
  const payPeriod = normalizeText(body.pay_period, formatPeriodLabel(manilaToday()));
  const requestedEntries = Array.isArray(body.entries) ? body.entries : [];

  if (!requestedEntries.length) {
    return NextResponse.json({ error: "At least one employee entry is required." }, { status: 400 });
  }

  // Independent reads — neither takes the other's output — so they go out
  // together, the same way GET() already issues this pair.
  const [employees, entriesResult] = await Promise.all([
    fetchEmployees(supabase, guard),
    readPayrollEntries(supabase),
  ]);
  const entries = entriesResult.entries;
  const nowIso = new Date().toISOString();

  // Attendance, leave and rates for the period, computed here -- never taken
  // from the browser. Attendance figures cannot be edited in the batch table.
  const period = periodFromLabel(payPeriod) || findPeriodRangeByLabel(payPeriod) || getPayPeriodRange(manilaToday());
  const refused = refuseOutsideFinalWindow(await periodWindow(supabase, period));
  if (refused) return refused;
  const payContext = await loadPeriodPayContext(supabase, employees, period);
  if (!payContext.engineReady || !payContext.ratesReady) {
    return NextResponse.json({ error: PAYROLL_NOT_READY_MESSAGE, code: "payroll_not_ready" }, { status: 503 });
  }
  const actor = { userId: guard.userId, name: normalizeText(guard.session?.full_name, guard.session?.email) };

  const processed = [];
  const skipped = [];
  const candidates = [];

  // Pure in-memory work — no DB calls here, so this loop costs nothing extra
  // regardless of how many employees are in the batch.
  for (const item of requestedEntries) {
    const employeeId = normalizeText(item.employee_id);
    const employee = employees.find((row) => row.id === employeeId);

    if (!employee) {
      skipped.push({ employee_id: employeeId, reason: "Employee not found." });
      continue;
    }

    if (isOwnPayroll(guard, employee.id)) {
      skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason: OWN_PAYROLL_MESSAGE, code: "own_payroll" });
      continue;
    }

    const existingForPeriod = entries.find(
      (entry) => entry.employee_id === employee.id && entry.pay_period === payPeriod,
    );

    if (existingForPeriod?.status === "paid") {
      skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason: DUPLICATE_SUBMISSION_MESSAGE });
      continue;
    }

    const built = buildEmployeePayroll({
      employee,
      context: payContext.byEmployee.get(employee.id),
      input: {
        basic_salary: item.basic_salary,
        deductions: {
          sss: item.deductions?.sss,
          philhealth: item.deductions?.philhealth,
          pagibig: item.deductions?.pagibig,
          withholding_tax: item.deductions?.withholding_tax,
          leave_without_pay_days: item.deductions?.leave_without_pay_days,
        },
        override_reason: item.override_reason ?? body.override_reason,
      },
      allowAttendanceOverrides: false,
      period,
      actor,
    });

    if (built.refusal) {
      skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason: built.refusal, code: "month_settled" });
      continue;
    }
    // Only this employee waits; everyone else in the batch is processed.
    if (built.blocking.length) {
      skipped.push({
        employee_id: employee.id,
        employee_name: employee.full_name,
        reason: describeBlocking(built.blocking),
        code: "unresolved_attendance",
        blocking: built.blocking,
      });
      continue;
    }
    if (built.deviations.length && !built.reason) {
      skipped.push({
        employee_id: employee.id,
        employee_name: employee.full_name,
        reason: describeMissingReason(built.deviations),
        code: "override_reason_required",
      });
      continue;
    }
    const computedPayroll = built.payroll;

    const baseEntry = {
      // Reuse an existing draft's id for this employee+period (there can be
      // at most one, per the UNIQUE(employee_id, pay_period) constraint) so
      // the upsert below updates that row instead of colliding with it
      // under a freshly-minted id.
      id: existingForPeriod?.id || crypto.randomUUID(),
      employee_id: employee.id,
      employee_name: employee.full_name,
      employee_code: employee.employee_id,
      employee_type: employee.employee_type,
      position: employee.position,
      pay_period: payPeriod,
      status: "paid",
      submitted_at: nowIso,
      created_at: existingForPeriod?.created_at || nowIso,
      updated_at: nowIso,
      payroll: computedPayroll,
      processed_by: guard.userId || null,
      processed_by_name: actor.name || null,
    };

    candidates.push({ employee, baseEntry });
  }

  if (candidates.length) {
    // One round trip for the whole batch. Each employee is committed in its
    // own transaction inside the database (commitPayrollEntries), so one bad
    // row never sinks the rest and never leaves half a payslip behind.
    let results;
    try {
      results = await commitPayrollEntries(supabase, candidates.map(({ baseEntry }) => baseEntry));
    } catch (error) {
      results = candidates.map(({ baseEntry }) => ({ employee_id: baseEntry.employee_id, ok: false, error: error.message }));
    }

    candidates.forEach(({ employee, baseEntry }, index) => {
      const result = results[index];
      if (!result?.ok) {
        skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason: describeCommitFailure(result) });
        return;
      }
      processed.push({
        employee_id: employee.id,
        employee_name: employee.full_name,
        entry_id: result.entry_id || baseEntry.id,
        payslip_no: result.payslip_no || null,
      });
    });
  }

  await appendAuditLog({
    actor: guard,
    module: "payroll",
    action: "batch_process",
    entity_type: "payroll_entry",
    entity_id: payPeriod,
    description: `Batch payroll processed for ${processed.length} employee(s), pay period ${payPeriod}${skipped.length ? ` (${skipped.length} skipped)` : ""}.`,
    status: "success",
    source: "api",
    metadata: { pay_period: payPeriod, processed_count: processed.length, skipped_count: skipped.length, skipped },
  });

  return NextResponse.json({ success: true, processed, skipped });
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "process_payroll", "create");
    if (guard.denied) return guard.denied;

    const body = await request.json();
    const action = normalizeText(body.action, "save_draft").toLowerCase();

    if (action === "add_monthly_item") return await handleAddMonthlyItem(getAdminClient(), body, guard);
    if (action === "add_cash_advance") return await handleAddCashAdvance(getAdminClient(), body, guard);

    if (action !== "save_draft" && action !== "submit" && action !== "batch_submit") {
      return NextResponse.json({ error: "Action must be save_draft, submit, or batch_submit." }, { status: 400 });
    }

    const supabase = getAdminClient();

    if (action === "batch_submit") {
      return await handleBatchSubmit(supabase, body, guard);
    }

    const employees = await fetchEmployees(supabase, guard);

    const employeeId = normalizeText(body.employee_id);
    const employee = employees.find((row) => row.id === employeeId);

    if (!employee) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }
    const own = refuseOwnPayroll(guard, employee.id);
    if (own) return own;

    const payPeriod = normalizeText(body.pay_period, formatPeriodLabel(manilaToday()));
    const period = periodFromLabel(payPeriod) || findPeriodRangeByLabel(payPeriod) || getPayPeriodRange(manilaToday());
    if (action === "submit") {
      const refused = refuseOutsideFinalWindow(await periodWindow(supabase, period));
      if (refused) return refused;
    }
    const payContext = await loadPeriodPayContext(supabase, [employee], period);
    if (action === "submit" && (!payContext.engineReady || !payContext.ratesReady)) {
      return NextResponse.json({ error: PAYROLL_NOT_READY_MESSAGE, code: "payroll_not_ready" }, { status: 503 });
    }
    const actor = { userId: guard.userId, name: normalizeText(guard.session?.full_name, guard.session?.email) };

    // Computed here from the attendance logs and the rate versions in force
    // on the period's first day. The form may override attendance figures and
    // defaults, but every override is a logged deviation that needs a reason.
    const built = buildEmployeePayroll({
      employee,
      context: payContext.byEmployee.get(employee.id),
      input: body,
      allowAttendanceOverrides: true,
      period,
      actor,
    });

    if (built.refusal) {
      return NextResponse.json({ error: built.refusal, code: "month_settled" }, { status: 422 });
    }
    if (action === "submit" && built.blocking.length) {
      // 422, not 409: the portal reads 409 as "already processed".
      return NextResponse.json(
        { error: describeBlocking(built.blocking), code: "unresolved_attendance", blocking: built.blocking },
        { status: 422 },
      );
    }
    if (action === "submit" && built.deviations.length && !built.reason) {
      return NextResponse.json(
        { error: describeMissingReason(built.deviations), code: "override_reason_required", deviations: built.deviations },
        { status: 400 },
      );
    }
    const computedPayroll = built.payroll;

    const nowIso = new Date().toISOString();
    const entriesResult = await readPayrollEntries(supabase);
    const entries = entriesResult.entries;
    const existingId = normalizeText(body.entry_id);
    // payroll_entries now carries a real UNIQUE(employee_id, pay_period)
    // constraint — reusing whatever id already holds that combination (rather
    // than minting a new one) is what lets syncPayrollEntryToDb()'s upsert
    // update that row instead of colliding with it under a different id.
    const existingIndex = existingId
      ? entries.findIndex((entry) => entry.id === existingId)
      : entries.findIndex((entry) => entry.employee_id === employee.id && entry.pay_period === payPeriod);
    const resolvedExistingId = existingIndex >= 0 ? entries[existingIndex].id : "";

    // The entry being written is itself already paid. The duplicate checks
    // below skip the entry's own id, so without this a second Process click on
    // the same form (the portal keeps the just-processed entry selected)
    // minted a second payroll_records row and payslip number for one pay
    // period, and Save Draft turned a paid entry back into a draft.
    if (existingIndex >= 0 && entries[existingIndex].status === "paid") {
      return NextResponse.json({ error: DUPLICATE_SUBMISSION_MESSAGE }, { status: 409 });
    }

    if (action === "submit") {
      const hasAlreadyPaid = entries.some((entry) => {
        if (entry.employee_id !== employee.id) return false;
        if (entry.pay_period !== payPeriod) return false;
        if (resolvedExistingId && entry.id === resolvedExistingId) return false;
        return entry.status === "paid";
      });

      if (hasAlreadyPaid) {
        return NextResponse.json({ error: DUPLICATE_SUBMISSION_MESSAGE }, { status: 409 });
      }
    }

    if (action === "save_draft") {
      const hasDraftDuplicate = entries.some((entry) => {
        if (entry.employee_id !== employee.id) return false;
        if (entry.pay_period !== payPeriod) return false;
        if (entry.status !== "draft") return false;
        if (resolvedExistingId && entry.id === resolvedExistingId) return false;
        return true;
      });

      if (hasDraftDuplicate) {
        return NextResponse.json(
          { error: "A draft for this employee and pay period already exists. Edit the existing draft from Pending Submissions instead." },
          { status: 409 },
        );
      }
    }

    const baseEntry = {
      id: existingIndex >= 0 ? entries[existingIndex].id : crypto.randomUUID(),
      employee_id: employee.id,
      employee_name: employee.full_name,
      employee_code: employee.employee_id,
      employee_type: employee.employee_type,
      position: employee.position,
      pay_period: payPeriod,
      status: action === "submit" ? "paid" : "draft",
      submitted_at: action === "submit" ? nowIso : (existingIndex >= 0 ? entries[existingIndex].submitted_at : null),
      created_at: existingIndex >= 0 ? entries[existingIndex].created_at : nowIso,
      updated_at: nowIso,
      payroll: computedPayroll,
      processed_by: action === "submit" ? guard.userId || null : null,
      processed_by_name: action === "submit" ? actor.name || null : null,
    };

    // Processing writes the payslip, its number, the entry and every line in
    // one transaction (commitPayrollEntries); a draft is only the entry.
    let dbSync;
    if (action === "submit") {
      const [result] = await commitPayrollEntries(supabase, [baseEntry]);
      dbSync = result?.ok ? { success: true } : { success: false, error: describeCommitFailure(result) };
      if (result?.ok) baseEntry.payslip_no = result.payslip_no || null;

      // Nothing was written, so the accountant can simply try again.
      if (!result?.ok) {
        await appendAuditLog({
          actor: guard,
          module: "payroll",
          action: "process",
          entity_type: "payroll_entry",
          entity_id: baseEntry.id,
          description: `Payroll entry for ${employee.full_name} failed to save: ${result?.error || "unknown error"}`,
          status: "failed",
          source: "api",
          metadata: { employee_id: employee.id, db_error: result?.error || null, db_code: result?.code || null },
        });

        const duplicate = String(result?.code || "") === "23505";
        return NextResponse.json(
          { error: dbSync.error },
          { status: duplicate ? 409 : 500 },
        );
      }
    } else {
      dbSync = await syncPayrollEntryToDb(supabase, baseEntry);

      // payroll_entries is the only place a draft lives. When that write
      // fails nothing was saved, so this used to answer success and the
      // portal said "Draft saved" over a draft that did not exist.
      if (!dbSync.success) {
        await appendAuditLog({
          actor: guard,
          module: "payroll",
          action: "draft",
          entity_type: "payroll_entry",
          entity_id: baseEntry.id,
          description: `Payroll draft for ${employee.full_name} failed to save: ${dbSync.error || "unknown error"}`,
          status: "failed",
          source: "api",
          metadata: { employee_id: employee.id, db_error: dbSync.error || null, db_code: dbSync.code || null },
        });
        const duplicate = String(dbSync.code || "") === "23505";
        return NextResponse.json(
          { error: duplicate ? DUPLICATE_SUBMISSION_MESSAGE : "The draft could not be saved. Please try again." },
          { status: duplicate ? 409 : 500 },
        );
      }
    }

    await appendAuditLog({
      actor: guard,
      module: "payroll",
      action: action === "submit" ? "process" : "draft",
      entity_type: "payroll_entry",
      entity_id: baseEntry.id,
      description: action === "submit"
        ? `Payroll entry for ${employee.full_name} processed. Payslip generated.`
        : `Payroll draft for ${employee.full_name} saved.`,
      status: "success",
      source: "api",
      metadata: {
        employee_id: employee.id,
        payslip_no: baseEntry.payslip_no || null,
        db_synced: dbSync.success,
        db_error: dbSync.success ? null : dbSync.error,
        deviations: built.deviations.length ? built.deviations : undefined,
        override_reason: built.deviations.length ? built.reason || null : undefined,
      },
    });

    return NextResponse.json({
      success: true,
      entry: mapEntryToRecord(baseEntry),
      db_synced: dbSync.success,
      db_error: dbSync.success ? null : dbSync.error,
    });
  } catch (error) {
    if (isDuplicateKeyError(error) || isInternalDbSchemaError(error?.message)) {
      return NextResponse.json({ error: DUPLICATE_SUBMISSION_MESSAGE }, { status: 409 });
    }

    return NextResponse.json({ error: "Unable to submit payroll right now. Please try again." }, { status: 500 });
  }
}

/**
 * PATCH { action: "generate", employee_id, pay_period, confirm_incomplete? }
 *   One employee's payslip, computed from the period's attendance records:
 *     - from 3 days before the period ends to its last day: a Draft counting
 *       attendance up to today (Regenerate recomputes it from the latest
 *       records and corrections);
 *     - after the period ends, up to the pay date: the Final payslip, written
 *       with its payslip number and locked.
 *   Unresolved Incomplete / Pending Correction days are never counted
 *   silently: the request is refused (422, code "unresolved_attendance")
 *   until it is repeated with confirm_incomplete: true, and the days are then
 *   recorded on the payslip as left out.
 *
 * PATCH { action: "override_final", employee_id, pay_period, reason, confirm_incomplete? }
 *   Super Admin only (every-branch scope): recompute a Final payslip after the
 *   period has ended, even past the pay date, with a reason. The previous
 *   payroll record is archived (kept, never deleted) and a new one is issued.
 *
 * Accountant and Super Admin reach this (process_payroll "update"); the
 * window is enforced here whatever the portal shows.
 */
async function handleGenerate(supabase, body, guard, { override = false } = {}) {
  const payPeriod = normalizeText(body.pay_period);
  const period = periodFromLabel(payPeriod);
  if (!period) return NextResponse.json({ error: "Choose a valid pay period." }, { status: 400 });

  const reason = normalizeText(body.reason).slice(0, 500);
  if (override) {
    if (guard.scope !== SCOPE_ALL) {
      return NextResponse.json({ error: "Only a Super Admin can override a Final payslip." }, { status: 403 });
    }
    if (reason.length < 10) {
      return NextResponse.json({ error: "Give a reason for the override (at least 10 characters).", code: "override_reason_required" }, { status: 400 });
    }
  }

  const employees = await fetchEmployees(supabase, guard);
  const employee = employees.find((row) => row.id === normalizeText(body.employee_id));
  if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
  const own = refuseOwnPayroll(guard, employee.id);
  if (own) return own;

  const genWindow = await periodWindow(supabase, period);
  if (override) {
    if (genWindow.state === "not_open" || genWindow.state === "draft") {
      return NextResponse.json({
        error: `An override changes a Final payslip, which exists only after the period ends (${formatDateKey(genWindow.period_end)}). Regenerate the Draft instead.`,
        code: "generation_window",
        window: genWindow,
      }, { status: 403 });
    }
  } else if (!genWindow.can_generate) {
    return NextResponse.json({ error: genWindow.message, code: "generation_window", window: genWindow }, { status: 403 });
  }

  const { entries } = await readPayrollEntries(supabase);
  const existing = entries.find((entry) => entry.employee_id === employee.id && entry.pay_period === period.label) || null;
  const existingFinal = existing && existing.status !== "draft";
  if (existingFinal && !override) {
    return NextResponse.json({
      error: "This payslip is Final and locked. Changing it needs a Super Admin override with a reason.",
      code: "payslip_locked",
    }, { status: 409 });
  }

  const through = genWindow.attendance_through;
  const payContext = await loadPeriodPayContext(supabase, [employee], period, { through });
  if (!payContext.engineReady || !payContext.ratesReady) {
    return NextResponse.json({ error: PAYROLL_NOT_READY_MESSAGE, code: "payroll_not_ready" }, { status: 503 });
  }
  const context = payContext.byEmployee.get(employee.id);
  const actor = { userId: guard.userId, name: normalizeText(guard.session?.full_name, guard.session?.email) };
  const built = buildEmployeePayroll({ employee, context, input: {}, allowAttendanceOverrides: false, period, actor });
  if (built.refusal) {
    return NextResponse.json({ error: built.refusal, code: "month_settled" }, { status: 422 });
  }

  if (built.blocking.length && body.confirm_incomplete !== true) {
    const days = built.blocking.map((item) => `${formatDateKey(item.log_date)} (${item.status})`).join(", ");
    return NextResponse.json({
      error: `${employee.full_name} has ${built.blocking.length} unresolved attendance record${built.blocking.length === 1 ? "" : "s"}: ${days}. Resolve ${built.blocking.length === 1 ? "it" : "them"} in Attendance first, or confirm to generate without counting ${built.blocking.length === 1 ? "it" : "them"}.`,
      code: "unresolved_attendance",
      blocking: built.blocking,
    }, { status: 422 });
  }

  const final = genWindow.state === "final" || genWindow.state === "closed";
  const nowIso = new Date().toISOString();
  const branch = employee.branch_id
    ? await supabase.from("branches").select("name").eq("id", employee.branch_id).maybeSingle()
    : { data: null };
  const previous = existing?.payroll?.generation || null;
  built.payroll.generation = {
    status: final ? "final" : "draft",
    attendance_through: through,
    attendance_through_label: formatDateKey(through),
    generated_at: nowIso,
    generated_by: guard.userId || null,
    generated_by_name: actor.name || null,
    regenerations: previous ? (Number(previous.regenerations) || 0) + 1 : 0,
    window: { opens_on: genWindow.opens_on, period_end: genWindow.period_end, pay_date: genWindow.pay_date },
    confirmed_incomplete: built.blocking,
    attendance_summary: buildAttendanceSummary({ auto: context.auto, leave: context.leave, through }),
    deduction_basis: buildDeductionBasis({
      payroll: built.payroll,
      auto: context.auto,
      rates: rateValues(context.resolved),
      legal: usesLegalRules(period.start_key),
      taxBasis: built.payroll.monthly?.half === "second"
        ? `BIR monthly withholding table on taxable income ${money(built.payroll.monthly.taxable_income)}`
        : undefined,
      contributionSource: built.payroll.audit?.school_sheet?.contribution_source,
    }),
    branch_name: branch?.data?.name || null,
    position_title: employee.position_title || employee.position,
    override: override
      ? { reason, by: guard.userId || null, by_name: actor.name || null, at: nowIso, replaced_payslip_no: existing?.payslip_no || null }
      : null,
  };

  const baseEntry = {
    id: existing?.id || crypto.randomUUID(),
    employee_id: employee.id,
    employee_name: employee.full_name,
    employee_code: employee.employee_id,
    employee_type: employee.employee_type,
    position: employee.position,
    pay_period: period.label,
    status: final ? "paid" : "draft",
    submitted_at: final ? nowIso : null,
    created_at: existing?.created_at || nowIso,
    updated_at: nowIso,
    payroll: built.payroll,
    processed_by: final ? guard.userId || null : null,
    processed_by_name: final ? actor.name || null : null,
  };

  if (final) {
    // An override replaces the live payroll record: the old one is archived
    // (kept for the audit trail) so the new one can take its place, and put
    // back if the new one cannot be written.
    let archivedIds = [];
    if (existingFinal) {
      const archived = await supabase
        .from("payroll_records")
        .update({ archived: true })
        .eq("employee_id", employee.id)
        .eq("period_label", period.label)
        .eq("archived", false)
        .select("id");
      if (archived.error) throw new Error(archived.error.message);
      archivedIds = (archived.data || []).map((row) => row.id);
    }
    const [result] = await commitPayrollEntries(supabase, [baseEntry]);
    if (!result?.ok) {
      if (archivedIds.length) await supabase.from("payroll_records").update({ archived: false }).in("id", archivedIds);
      return NextResponse.json({ error: describeCommitFailure(result) }, { status: String(result?.code || "") === "23505" ? 409 : 500 });
    }
    baseEntry.payslip_no = result.payslip_no || null;
  } else {
    const dbSync = await syncPayrollEntryToDb(supabase, baseEntry);
    if (!dbSync.success) {
      return NextResponse.json({ error: "The draft payslip could not be saved. Please try again." }, { status: 500 });
    }
  }

  const action = override ? "payslip_override" : final ? "payslip_finalize" : previous ? "payslip_regenerate" : "payslip_generate";
  await appendAuditLog({
    actor: guard,
    module: "payroll",
    action,
    entity_type: "payroll_entry",
    entity_id: baseEntry.id,
    description: override
      ? `Final payslip for ${employee.full_name}, ${period.label}, overridden by ${actor.name}: ${reason}`
      : `${final ? "Final" : "Draft"} payslip for ${employee.full_name}, ${period.label}, ${previous && !final ? "regenerated" : "generated"} (attendance up to ${formatDateKey(through)}).`,
    status: "success",
    source: "api",
    metadata: {
      employee_id: employee.id,
      pay_period: period.label,
      status: final ? "final" : "draft",
      payslip_no: baseEntry.payslip_no || null,
      replaced_payslip_no: override ? existing?.payslip_no || null : undefined,
      reason: override ? reason : undefined,
      attendance_through: through,
      attendance_summary: built.payroll.generation.attendance_summary,
      confirmed_incomplete: built.blocking.length ? built.blocking : undefined,
      totals: {
        gross_pay: built.payroll.totals.gross_pay,
        total_deductions: built.payroll.totals.total_deductions,
        net_pay: built.payroll.totals.net_pay,
      },
    },
  });

  return NextResponse.json({
    success: true,
    status: final ? "final" : "draft",
    entry: mapEntryToRecord(baseEntry),
    payslip: buildPayslipDetails(baseEntry),
    window: genWindow,
  });
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "process_payroll", "update");
    if (guard.denied) return guard.denied;

    const body = await request.json();
    const action = normalizeText(body.action).toLowerCase();

    if (action === "generate") return await handleGenerate(getAdminClient(), body, guard, { override: false });
    if (action === "override_final") return await handleGenerate(getAdminClient(), body, guard, { override: true });
    if (action === "archive_monthly_item") return await handleArchiveMonthlyItem(getAdminClient(), body, guard);
    if (action === "process_13th_month") return await handleProcessThirteenthMonth(getAdminClient(), body, guard);
    if (action === "set_cash_advance_status") return await handleSetCashAdvanceStatus(getAdminClient(), body, guard);

    if (action !== "cancel_draft") {
      return NextResponse.json({ error: "Action must be generate, override_final, archive_monthly_item, process_13th_month, set_cash_advance_status or cancel_draft." }, { status: 400 });
    }

    const entryId = normalizeText(body.entry_id);
    if (!entryId) {
      return NextResponse.json({ error: "entry_id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();

    const entriesResult = await readPayrollEntries(supabase);
    const entries = entriesResult.entries;
    const index = entries.findIndex((entry) => entry.id === entryId);

    if (index < 0) {
      return NextResponse.json({ error: "Payroll entry not found." }, { status: 404 });
    }

    const entry = entries[index];

    if (!guard.branchExempt) {
      const branchEmployees = await fetchEmployees(supabase, guard);
      if (!branchEmployees.some((e) => e.id === entry.employee_id)) {
        return NextResponse.json({ error: "That record belongs to another branch." }, { status: 403 });
      }
    }

    const own = refuseOwnPayroll(guard, entry.employee_id);
    if (own) return own;

    if (entry.status !== "draft") {
      return NextResponse.json({ error: "Only drafts can be cancelled." }, { status: 400 });
    }

    await deletePayrollEntryFromDb(supabase, entryId);

    await appendAuditLog({
      actor: guard,
      module: "payroll",
      action: "cancel_draft",
      entity_type: "payroll_entry",
      entity_id: entryId,
      description: `Accountant cancelled payroll draft for ${entry.employee_name}.`,
      status: "success",
      source: "api",
      metadata: { employee_id: entry.employee_id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
