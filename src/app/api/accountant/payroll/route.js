import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { floorNetPay } from "@/lib/payroll/net-pay";
import crypto from "node:crypto";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { readAllLeaveRequests, countLeaveDays } from "@/lib/leave-requests/store";
import { listUsersCached } from "@/lib/auth/users-cache";
import { collapseDailyTaps } from "@/lib/attendance/taps";
import { requirePermission } from "@/lib/rbac/guard";
import {
  isUnresolvedStatus,
  normalizeAttendanceStatus as normalizeEngineStatus,
} from "@/lib/attendance/status";
import { computeAttendancePay, peso } from "@/lib/payroll/attendance-pay";
import { DEFAULT_RATES, loadRateConfigs, rateValues, resolveRates } from "@/lib/payroll/rates";
import { periodFromLabel } from "@/lib/payroll/periods";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DUPLICATE_SUBMISSION_MESSAGE = "Payroll for this employee and period has already been processed.";

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  return createClient(projectUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
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
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()).split("-").map(Number);
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
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
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
    // For position- and branch-scoped payroll rates (src/lib/payroll/rates.js).
    position_title: normalizeText(metadata.position),
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
      .select("id,email,full_name,branch_id")
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
        overtime: 0,
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
      },
      incentives: {
        early_bird_days: toAmount(payrollObj?.incentives?.early_bird_days ?? 0),
        perfect_attendance: payrollObj?.incentives?.perfect_attendance === true,
      },
      totals: {
        absence_deduction: toAmount(payrollObj?.totals?.absence_deduction ?? row.absence_deduction),
        late_deduction: toAmount(payrollObj?.totals?.late_deduction ?? 0),
        undertime_deduction: toAmount(payrollObj?.totals?.undertime_deduction ?? 0),
        half_day_deduction: toAmount(payrollObj?.totals?.half_day_deduction ?? 0),
        leave_without_pay_deduction: toAmount(payrollObj?.totals?.leave_without_pay_deduction),
        early_bird_incentive: toAmount(payrollObj?.totals?.early_bird_incentive ?? 0),
        perfect_attendance_incentive: toAmount(payrollObj?.totals?.perfect_attendance_incentive ?? 0),
        total_incentives: toAmount(payrollObj?.totals?.total_incentives ?? 0),
        gross_pay: toAmount(payrollObj?.totals?.gross_pay ?? row.gross_pay),
        total_deductions: toAmount(payrollObj?.totals?.total_deductions ?? row.total_deductions),
        net_pay: floorNetPay(payrollObj?.totals?.net_pay ?? row.net_pay),
      },
      // Rates, attendance lines and manual deviations behind this entry.
      audit: payrollObj?.audit && typeof payrollObj.audit === "object" ? payrollObj.audit : null,
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

  const earlyBirdIncentive = amounts
    ? toAmount(amounts.early_bird)
    : toAmount(earlyBirdDays * (Number(rates.early_bird_bonus) || 0));
  const perfectAttendanceIncentive = amounts
    ? toAmount(amounts.perfect_attendance)
    : (perfectAttendance ? toAmount(rates.perfect_attendance_bonus) : 0);

  const grossPay = basicSalary; // No allowances; Gross Pay = Basic Salary
  const totalDeductions = toAmount(
    sss + philhealth + pagibig + withholdingTax
    + absenceDeduction + lateDeduction + undertimeDeduction + halfDayDeduction
    + leaveWithoutPayDeduction,
  );
  const totalIncentives = toAmount(earlyBirdIncentive + perfectAttendanceIncentive);
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
      overtime: 0,
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
    },
    incentives: {
      early_bird_days: earlyBirdDays,
      perfect_attendance: perfectAttendance,
    },
    totals: {
      absence_deduction: absenceDeduction,
      late_deduction: lateDeduction,
      undertime_deduction: undertimeDeduction,
      half_day_deduction: halfDayDeduction,
      leave_without_pay_deduction: leaveWithoutPayDeduction,
      early_bird_incentive: earlyBirdIncentive,
      perfect_attendance_incentive: perfectAttendanceIncentive,
      total_incentives: totalIncentives,
      gross_pay: grossPay,
      total_deductions: totalDeductions,
      net_pay: netPay,
    },
  };
}

async function readPayrollEntries(supabase) {
  const result = await supabase
    .from("payroll_entries")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(2000);

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

async function nextPayslipSeqPrefix(supabase, processedAt) {
  const date = processedAt ? new Date(processedAt) : new Date();
  // The month the payslip was issued in Manila, not on the server's clock.
  const ym = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
  }).format(date).replace("-", "");
  const prefix = `PS-${ym}-`;

  const { data } = await supabase
    .from("payroll_records")
    .select("payslip_no")
    .like("payslip_no", `${prefix}%`)
    .order("payslip_no", { ascending: false })
    .limit(1);

  let seq = 1;
  if (data?.length && data[0].payslip_no) {
    const last = data[0].payslip_no.split("-").pop();
    seq = (Number(last) || 0) + 1;
  }

  return { prefix, seq };
}

async function generatePayslipNo(supabase, processedAt) {
  const { prefix, seq } = await nextPayslipSeqPrefix(supabase, processedAt);
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

// One query instead of one-per-employee: reads the current sequence once and
// assigns `count` consecutive numbers in memory. Safe within this batch (every
// number here is guaranteed distinct); a collision with a payslip_no minted by
// a submission outside this batch still surfaces as a 23505 on insert, which
// handleBatchSubmit's caller falls back to the slower per-employee path for.
async function generatePayslipNumbers(supabase, processedAt, count) {
  const { prefix, seq } = await nextPayslipSeqPrefix(supabase, processedAt);
  return Array.from({ length: count }, (_, i) => `${prefix}${String(seq + i).padStart(4, "0")}`);
}

// payroll_records.payslip_no carries a UNIQUE constraint (20260509010000_add_payslip_no.sql),
// so a collision from generatePayslipNo()'s read-then-increment race surfaces
// here as a 23505 error rather than a silently duplicated payslip number.
// Retrying with a freshly-read next sequence number resolves it without
// treating it as the unrelated "already processed" duplicate this function's
// caller otherwise reports for a 23505 on employee_id/pay_period.
async function appendPayrollRecord(supabase, entry, attemptsLeft = 5) {
  const processedAt = entry.submitted_at || new Date().toISOString();
  const payslipNo = await generatePayslipNo(supabase, processedAt);

  const insertPayload = {
    employee_id: entry.employee_id,
    employee_name: entry.employee_name,
    employee_type: entry.employee_type,
    gross_pay: toAmount(entry.payroll.totals.gross_pay),
    total_deductions: toAmount(entry.payroll.totals.total_deductions),
    net_pay: floorNetPay(entry.payroll.totals.net_pay),
    period_label: entry.pay_period,
    processed_at: processedAt,
    payslip_no: payslipNo,
    ...recordAuditColumns(entry),
  };

  const result = await supabase
    .from("payroll_records")
    .insert(insertPayload)
    .select("id, payslip_no")
    .maybeSingle();

  if (result.error) {
    const isPayslipNoCollision = isDuplicateKeyError(result.error)
      && String(result.error.message || "").toLowerCase().includes("payslip_no");
    if (isPayslipNoCollision && attemptsLeft > 1) {
      return appendPayrollRecord(supabase, entry, attemptsLeft - 1);
    }
    throw new Error(result.error.message);
  }

  await writePayrollLines(supabase, result.data?.id, entry);

  return { persisted: true, id: result.data?.id, payslip_no: result.data?.payslip_no };
}

function resolveEntryStatus(entry) {
  return entry.status || "draft";
}

// Buckets the engine's statuses (src/lib/attendance/status.js) for the
// present / late / absent day counts: every attended status is "present",
// Incomplete and Pending Correction are "unresolved" (neither worked nor
// unworked until someone resolves them).
function normalizeAttendanceStatus(value) {
  const status = normalizeEngineStatus(value, "Absent");
  if (status === "Late") return "late";
  if (status === "Absent") return "absent";
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
async function buildLeaveContext(employees, periodStart, periodEnd) {
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

    let withPayDays = 0;
    let withoutPayDays = 0;
    const coveredDays = new Set();

    requestsForEmployee.forEach((request) => {
      const requestStart = String(request.start_date || "");
      const requestEnd = String(request.end_date || requestStart);
      if (!requestStart || !requestEnd) return;
      if (requestEnd < periodStart || requestStart > periodEnd) return;

      const overlapStart = requestStart > periodStart ? requestStart : periodStart;
      const overlapEnd = requestEnd < periodEnd ? requestEnd : periodEnd;
      const days = countLeaveDays(overlapStart, overlapEnd);
      if (request.pay_status === "without_pay") withoutPayDays += days;
      else withPayDays += days;

      expandDateRange(overlapStart, overlapEnd).forEach((day) => coveredDays.add(day));
    });

    summaries.push({ employee_id: employee.id, with_pay_days: withPayDays, without_pay_days: withoutPayDays });
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

  let query = supabase
    .from("attendance_logs")
    .select(ENGINE_ATTENDANCE_COLUMNS)
    .gte("log_date", periodStart)
    .lte("log_date", periodEnd)
    .eq("archived_duplicate", false);
  if (employeeIds && employeeIds.length && employeeIds.length <= 200) query = query.in("employee_id", employeeIds);
  const engine = await query.order("created_at", { ascending: false }).limit(20000);

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

const PAYROLL_NOT_READY_MESSAGE = "Payroll cannot be processed yet: apply the attendance and payroll-rate database migrations (supabase/migrations/20260926010000_attendance_status_engine.sql and 20260926020000_payroll_rate_configs.sql) first.";

/**
 * Everything payroll needs for one period, per employee: the rate versions in
 * force on the period's first day, the attendance lines computed from the
 * logs, and the approved leave.
 */
async function loadPeriodPayContext(supabase, employees, period) {
  const employeeIds = employees.map((employee) => employee.id);
  const [leaveContext, attendance, rateResult] = await Promise.all([
    buildLeaveContext(employees, period.start_key, period.end_key),
    readPeriodAttendance(supabase, period.start_key, period.end_key, employeeIds),
    loadRateConfigs(supabase),
  ]);
  const { summaries: leaveSummary, leaveDaysByEmployee } = leaveContext;

  const attendanceRows = await fetchAttendanceSummary(
    supabase,
    employees,
    period.start_key,
    period.end_key,
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
      { employeeId: employee.id, branchId: employee.branch_id, position: employee.position_title },
      period.start_key,
    );
    const auto = computeAttendancePay({
      logs: logsByEmployee.get(employee.id) || [],
      leaveDays: leaveDaysByEmployee.get(employee.id),
      rates: resolved,
      periodStart: period.start_key,
      periodEnd: period.end_key,
    });
    const leave = leaveSummary.find((row) => row.employee_id === employee.id) || null;
    byEmployee.set(employee.id, { resolved, auto, leave });
  });

  // What the batch table and the Single Entry form show and pre-fill.
  const enrichedRows = attendanceRows.map((row) => {
    const context = byEmployee.get(row.employee_id);
    const employee = employees.find((e) => e.id === row.employee_id);
    if (!context || !employee) return row;
    const values = rateValues(context.resolved);
    const basic = toAmount(Number(employee.basic_salary || 0) / 2);
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
        sss: peso(basic * values.sss_pct / 100),
        philhealth: peso(basic * values.philhealth_pct / 100),
        pagibig: peso(basic * values.pagibig_pct / 100),
      },
    };
  });

  return {
    period,
    engineReady: attendance.engineReady,
    ratesReady: rateResult.available,
    leaveSummary,
    attendanceRows: enrichedRows,
    byEmployee,
  };
}

const DEVIATION_TOLERANCE = 0.005;

function differs(a, b) {
  return Math.abs(toAmount(a) - toAmount(b)) > DEVIATION_TOLERANCE;
}

function pickAmount(value, fallback) {
  if (value === undefined || value === null || value === "") return toAmount(fallback);
  return toAmount(value);
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
  const rates = rateValues(resolved);
  const deductionsIn = input.deductions || {};
  const incentivesIn = input.incentives || {};
  const reason = normalizeText(input.override_reason);
  const deviations = [];
  const note = (field, def, value) => {
    if (differs(def, value)) deviations.push({ field, default: toAmount(def), value: toAmount(value) });
  };

  const defaultBasic = toAmount(Number(employee.basic_salary || 0) / 2);
  const basic = pickAmount(input.basic_salary, defaultBasic);
  note("basic_salary", defaultBasic, basic);

  const contributionDefault = (type) => peso(basic * (rates[`${type}_pct`] || 0) / 100);
  const sss = pickAmount(deductionsIn.sss, contributionDefault("sss"));
  const philhealth = pickAmount(deductionsIn.philhealth, contributionDefault("philhealth"));
  const pagibig = pickAmount(deductionsIn.pagibig, contributionDefault("pagibig"));
  note("sss", contributionDefault("sss"), sss);
  note("philhealth", contributionDefault("philhealth"), philhealth);
  note("pagibig", contributionDefault("pagibig"), pagibig);
  const withholdingTax = pickAmount(deductionsIn.withholding_tax, 0);

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
    statutory("sss", sss, rates.sss_pct, differs(sss, contributionDefault("sss"))),
    statutory("philhealth", philhealth, rates.philhealth_pct, differs(philhealth, contributionDefault("philhealth"))),
    statutory("pagibig", pagibig, rates.pagibig_pct, differs(pagibig, contributionDefault("pagibig"))),
    statutory("withholding_tax", withholdingTax, null, false),
    leaveWithoutPayDays > 0 ? {
      type: "leave_without_pay", quantity: leaveWithoutPayDays, unit: "day", rate: rates.daily,
      rate_config_id: resolved.daily?.config_id || null, amount: toAmount(leaveWithoutPayDays * rates.daily),
      source_log_id: null, is_override: differs(leaveWithoutPayDays, defaultWithoutPay),
      note: differs(leaveWithoutPayDays, defaultWithoutPay) ? reason || null : null, log_date: null,
    } : null,
  ].filter(Boolean);

  const incentiveLines = [
    ...auto.incentives,
    adjustment("early_bird", finalAmounts.early_bird, auto.amounts.early_bird, toAmount(used.early_bird_days - computed.early_bird_days), "day"),
    adjustment("perfect_attendance", finalAmounts.perfect_attendance, auto.amounts.perfect_attendance, 0, "period"),
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
    },
    incentives: {
      early_bird_days: used.early_bird_days,
      perfect_attendance: perfectAttendance,
    },
    attendance_amounts: finalAmounts,
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

  return { payroll, deviations, reason, blocking: auto.blocking };
}

const DEVIATION_LABELS = {
  basic_salary: "Basic Salary",
  sss: "SSS",
  philhealth: "PhilHealth",
  pagibig: "Pag-IBIG",
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
    attendance_snapshot: audit.attendance ? { ...audit.attendance, lines: audit.lines || null } : null,
    deviations: audit.deviations || null,
    processed_by: entry.processed_by || null,
    processed_by_name: entry.processed_by_name || null,
  };
}

/**
 * One row per deduction / incentive line in payroll_deductions /
 * payroll_incentives. The same lines are already stored atomically on the
 * payslip row (attendance_snapshot.lines), so a failure here is reported and
 * audited but never loses the trace.
 */
async function writePayrollLines(supabase, recordId, entry) {
  const audit = entry.payroll?.audit;
  if (!recordId || !audit?.lines) return { success: true };

  const base = {
    payroll_record_id: recordId,
    payroll_entry_id: entry.id,
    employee_id: entry.employee_id,
    pay_period: entry.pay_period,
    period_start: audit.period?.start_key || null,
    period_end: audit.period?.end_key || null,
  };
  const shape = (line) => ({
    ...base,
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

  try {
    const deductions = (audit.lines.deductions || []).map(shape);
    const incentives = (audit.lines.incentives || []).map(shape);
    if (deductions.length) {
      const result = await supabase.from("payroll_deductions").insert(deductions);
      if (result.error) throw new Error(result.error.message);
    }
    if (incentives.length) {
      const result = await supabase.from("payroll_incentives").insert(incentives);
      if (result.error) throw new Error(result.error.message);
    }
    return { success: true };
  } catch (error) {
    await appendAuditLog({
      module: "payroll",
      action: "line_items",
      entity_type: "payroll_record",
      entity_id: recordId,
      description: `Deduction/incentive lines for ${entry.employee_name} were not written: ${error.message}. The payslip keeps them in attendance_snapshot.`,
      status: "failed",
      source: "api",
      metadata: { employee_id: entry.employee_id, pay_period: entry.pay_period },
    });
    return { success: false, error: error.message };
  }
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

function buildPayslipOptions(records) {
  return records
    .filter((record) => record.status !== "on_hold")
    .map((record) => ({
      id: record.id,
      label: `${record.employee_name} — ${record.pay_period}`,
    }));
}

function buildPayslipDetails(entry) {
  if (!entry) return null;

  return {
    entry_id: entry.id,
    payslip_no: entry.payslip_no || null,
    pay_period: entry.pay_period,
    issued_at: entry.submitted_at || entry.updated_at || entry.created_at,
    employee: {
      id: entry.employee_code,
      name: entry.employee_name,
      type: entry.employee_type,
      position: entry.position,
    },
    earnings: {
      basic_salary: entry.payroll.basic_salary,
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
      total_deductions: entry.payroll.totals.total_deductions,
    },
    incentives: {
      early_bird_days: entry.payroll.incentives?.early_bird_days ?? 0,
      early_bird_incentive: entry.payroll.totals.early_bird_incentive ?? 0,
      perfect_attendance: entry.payroll.incentives?.perfect_attendance === true,
      perfect_attendance_incentive: entry.payroll.totals.perfect_attendance_incentive ?? 0,
      total_incentives: entry.payroll.totals.total_incentives ?? 0,
    },
    net_pay: entry.payroll.totals.net_pay,
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

    const payrollRecords = filteredByPeriod
      .filter((entry) => entry.status !== "draft")
      .map(mapEntryToRecord);

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
    // Attendance lines, leave and the rate versions in force on the period's
    // first day, per employee (loadPeriodPayContext above).
    const payContext = await loadPeriodPayContext(supabase, employees, activePeriod);
    const leaveSummary = payContext.leaveSummary;
    const attendanceRows = payContext.attendanceRows;

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
      payslip_options: buildPayslipOptions(payrollRecords),
      payslip: buildPayslipDetails(payslipSource),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// Processes every employee in one request — used by the "Process Payroll for
// All" batch table. Does not touch the existing single-employee save_draft/
// submit path below; reuses the same computeTotals()/appendPayrollRecord()/
// syncPayrollEntryToDb() building blocks that path already relies on.
// Processes one employee the slow-but-fully-isolated way: a failure here
// (e.g. a genuine duplicate-key conflict from stale data an earlier check
// couldn't see) affects only this employee, never the rest of the batch.
// This is handleBatchSubmit's fallback path, kept byte-for-byte equivalent to
// how every employee used to be processed before batching was added below.
async function submitOneBatchEntry(supabase, employee, baseEntry, processed, skipped) {
  try {
    const recordResult = await appendPayrollRecord(supabase, baseEntry);
    if (recordResult.payslip_no) {
      baseEntry.payslip_no = recordResult.payslip_no;
    }

    const dbSync = await syncPayrollEntryToDb(supabase, baseEntry);
    if (!dbSync.success) {
      skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason: `Payroll was not saved: ${dbSync.error}` });
      return;
    }

    processed.push({
      employee_id: employee.id,
      employee_name: employee.full_name,
      entry_id: baseEntry.id,
      payslip_no: baseEntry.payslip_no || null,
    });
  } catch (error) {
    const reason = isDuplicateKeyError(error)
      ? DUPLICATE_SUBMISSION_MESSAGE
      : (error?.message || "Failed to process this employee.");
    skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason });
  }
}

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
    // Fast path: one payslip-number query, one bulk insert into
    // payroll_records, one bulk upsert into payroll_entries — 3 round trips
    // total instead of 3 per employee (a 150-employee batch used to mean
    // 450+ sequential awaited Supabase calls). "Process Payroll for All" is
    // expected to succeed for every row every time it's run, so this is the
    // common case; if the bulk writes fail for any reason (most likely a
    // payslip_no collision with a submission from outside this batch), fall
    // through to submitOneBatchEntry()'s slower but fully isolated path so
    // one bad row can never sink the whole batch.
    try {
      const payslipNumbers = await generatePayslipNumbers(supabase, nowIso, candidates.length);

      const recordsPayload = candidates.map(({ baseEntry }, index) => ({
        employee_id: baseEntry.employee_id,
        employee_name: baseEntry.employee_name,
        employee_type: baseEntry.employee_type,
        gross_pay: toAmount(baseEntry.payroll.totals.gross_pay),
        total_deductions: toAmount(baseEntry.payroll.totals.total_deductions),
        // Bulk "process payroll for everyone" writes payroll_records directly,
        // and those rows feed the dashboards and branch reports — so the floor
        // has to hold here too, not just on the single-entry path.
        net_pay: floorNetPay(baseEntry.payroll.totals.net_pay),
        period_label: baseEntry.pay_period,
        processed_at: baseEntry.submitted_at,
        payslip_no: payslipNumbers[index],
        ...recordAuditColumns(baseEntry),
      }));

      let recordsInserted = false;
      let payslipByEmployee = new Map();

      try {
        const recordsResult = await supabase
          .from("payroll_records")
          .insert(recordsPayload)
          .select("id, employee_id, payslip_no");

        if (recordsResult.error) throw new Error(recordsResult.error.message);
        recordsInserted = true;

        payslipByEmployee = new Map(
          (recordsResult.data || []).map((row) => [row.employee_id, row.payslip_no]),
        );

        const recordIdByEmployee = new Map(
          (recordsResult.data || []).map((row) => [row.employee_id, row.id]),
        );
        for (const { baseEntry } of candidates) {
          await writePayrollLines(supabase, recordIdByEmployee.get(baseEntry.employee_id), baseEntry);
        }

        const entriesPayload = candidates.map(({ baseEntry }) => ({
          id: baseEntry.id,
          employee_id: baseEntry.employee_id,
          employee_name: baseEntry.employee_name,
          employee_code: baseEntry.employee_code || null,
          employee_type: baseEntry.employee_type || null,
          position: baseEntry.position || null,
          pay_period: baseEntry.pay_period,
          status: baseEntry.status,
          approval_id: baseEntry.approval_id || null,
          payslip_no: payslipByEmployee.get(baseEntry.employee_id) || null,
          payroll: baseEntry.payroll,
          submitted_at: baseEntry.submitted_at,
          created_at: baseEntry.created_at,
          updated_at: baseEntry.updated_at,
        }));

        const upsertResult = await supabase
          .from("payroll_entries")
          .upsert(entriesPayload, { onConflict: "employee_id,pay_period" });

        if (upsertResult.error) throw new Error(upsertResult.error.message);

        candidates.forEach(({ employee, baseEntry }) => {
          processed.push({
            employee_id: employee.id,
            employee_name: employee.full_name,
            entry_id: baseEntry.id,
            payslip_no: payslipByEmployee.get(baseEntry.employee_id) || null,
          });
        });
      } catch (bulkError) {
        if (!recordsInserted) {
          // Nothing was written yet — safe to fall back to the fully
          // isolated per-employee path (which mints its own payroll_records
          // row per employee) without risking a duplicate.
          for (const { employee, baseEntry } of candidates) {
            await submitOneBatchEntry(supabase, employee, baseEntry, processed, skipped);
          }
        } else {
          // payroll_records already got its row for every candidate — only
          // payroll_entries failed to sync. Retrying via appendPayrollRecord()
          // here would mint a second payroll_records row per employee, so
          // this only retries the payroll_entries sync, one row at a time.
          for (const { employee, baseEntry } of candidates) {
            baseEntry.payslip_no = payslipByEmployee.get(baseEntry.employee_id) || baseEntry.payslip_no;
            const dbSync = await syncPayrollEntryToDb(supabase, baseEntry);
            if (!dbSync.success) {
              skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason: `Payroll was not saved: ${dbSync.error}` });
              continue;
            }
            processed.push({
              employee_id: employee.id,
              employee_name: employee.full_name,
              entry_id: baseEntry.id,
              payslip_no: baseEntry.payslip_no || null,
            });
          }
        }
      }
    } catch {
      // generatePayslipNumbers() itself failed — nothing was written for
      // any candidate, so the fully isolated per-employee path is safe.
      for (const { employee, baseEntry } of candidates) {
        await submitOneBatchEntry(supabase, employee, baseEntry, processed, skipped);
      }
    }
  }

  await appendAuditLog({
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

    const payPeriod = normalizeText(body.pay_period, formatPeriodLabel(manilaToday()));
    const period = periodFromLabel(payPeriod) || findPeriodRangeByLabel(payPeriod) || getPayPeriodRange(manilaToday());
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

    if (action === "submit") {
      const recordResult = await appendPayrollRecord(supabase, baseEntry);
      if (recordResult.payslip_no) {
        baseEntry.payslip_no = recordResult.payslip_no;
      }
    }

    const dbSync = await syncPayrollEntryToDb(supabase, baseEntry);

    // payroll_entries is the only place Payslips/Payroll Records/Payroll
    // Monitoring read a processed entry from — a submit whose entries-sync
    // fails has produced no visible or printable result anywhere, so it must
    // be reported as a failure rather than the misleading "processed
    // successfully" response this used to return.
    if (action === "submit" && !dbSync.success) {
      await appendAuditLog({
        module: "payroll",
        action: "process",
        entity_type: "payroll_entry",
        entity_id: baseEntry.id,
        description: `Payroll entry for ${employee.full_name} failed to save: ${dbSync.error}`,
        status: "failed",
        source: "api",
        metadata: { employee_id: employee.id, db_error: dbSync.error },
      });

      return NextResponse.json(
        { error: `Payroll was not saved: ${dbSync.error}` },
        { status: 500 },
      );
    }

    await appendAuditLog({
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

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "process_payroll", "update");
    if (guard.denied) return guard.denied;

    const body = await request.json();
    const action = normalizeText(body.action).toLowerCase();

    if (action !== "cancel_draft") {
      return NextResponse.json({ error: "Action must be cancel_draft." }, { status: 400 });
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

    if (entry.status !== "draft") {
      return NextResponse.json({ error: "Only drafts can be cancelled." }, { status: 400 });
    }

    await deletePayrollEntryFromDb(supabase, entryId);

    await appendAuditLog({
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
