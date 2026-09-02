import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import crypto from "node:crypto";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { readAllLeaveRequests, countLeaveDays } from "@/lib/leave-requests/store";
import { listUsersCached } from "@/lib/auth/users-cache";

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

function formatPeriodLabel(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(new Date());
  }

  return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(date);
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
  };
}

async function fetchEmployees(supabase) {
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
      .select("id,email,full_name")
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
    pay_period: normalizeText(row.pay_period, formatPeriodLabel(new Date())),
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
        leave_with_pay_days: toAmount(payrollObj?.deductions?.leave_with_pay_days),
        leave_without_pay_days: toAmount(payrollObj?.deductions?.leave_without_pay_days),
      },
      totals: {
        absence_deduction: toAmount(payrollObj?.totals?.absence_deduction ?? row.absence_deduction),
        leave_without_pay_deduction: toAmount(payrollObj?.totals?.leave_without_pay_deduction),
        gross_pay: toAmount(payrollObj?.totals?.gross_pay ?? row.gross_pay),
        total_deductions: toAmount(payrollObj?.totals?.total_deductions ?? row.total_deductions),
        net_pay: toAmount(payrollObj?.totals?.net_pay ?? row.net_pay),
      },
    },
  };
}

function computeTotals(payroll) {
  const basicSalary = toAmount(payroll.basic_salary);

  const sss = toAmount(payroll.deductions?.sss);
  const philhealth = toAmount(payroll.deductions?.philhealth);
  const pagibig = toAmount(payroll.deductions?.pagibig);
  const withholdingTax = toAmount(payroll.deductions?.withholding_tax);
  const absencesDays = Math.max(0, toAmount(payroll.deductions?.absences_days));
  const lateDays = Math.max(0, toAmount(payroll.deductions?.late_days));
  const leaveWithPayDays = Math.max(0, toAmount(payroll.deductions?.leave_with_pay_days));
  const leaveWithoutPayDays = Math.max(0, toAmount(payroll.deductions?.leave_without_pay_days));

  // 1 absent = ₱550, 3 late = 1 absent = ₱550
  const absenceDeduction = toAmount((absencesDays + Math.floor(lateDays / 3)) * 550);
  // Leave Without Pay deducts at the same ₱550/day rate as an absence.
  const leaveWithoutPayDeduction = toAmount(leaveWithoutPayDays * 550);

  const grossPay = basicSalary; // No allowances; Gross Pay = Basic Salary
  const totalDeductions = toAmount(sss + philhealth + pagibig + withholdingTax + absenceDeduction + leaveWithoutPayDeduction);
  const netPay = toAmount(grossPay - totalDeductions);

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
      leave_with_pay_days: leaveWithPayDays,
      leave_without_pay_days: leaveWithoutPayDays,
    },
    totals: {
      absence_deduction: absenceDeduction,
      leave_without_pay_deduction: leaveWithoutPayDeduction,
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
    // Step 1: Delete any rows that could conflict.
    // The legacy payroll_entries table may have UNIQUE constraints on
    // (employee_id, pay_period) in addition to the primary key, so a plain
    // upsert with onConflict:"id" fails when another row already holds that
    // employee+period combination. Deleting first makes the insert clean.
    await supabase.from("payroll_entries").delete().eq("id", entry.id);

    if (entry.employee_id && entry.pay_period) {
      await supabase
        .from("payroll_entries")
        .delete()
        .eq("employee_id", entry.employee_id)
        .eq("pay_period", entry.pay_period);
    }

    // Step 2: Insert fresh — no conflicts possible after the deletes above.
    const result = await supabase.from("payroll_entries").insert(payload);

    if (result.error) {
      console.error("[payroll_entries] insert failed:", result.error.message);
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

async function generatePayslipNo(supabase, processedAt) {
  const date = processedAt ? new Date(processedAt) : new Date();
  const ym = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
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

  return `${prefix}${String(seq).padStart(4, "0")}`;
}

async function appendPayrollRecord(supabase, entry) {
  const processedAt = entry.submitted_at || new Date().toISOString();
  const payslipNo = await generatePayslipNo(supabase, processedAt);

  const insertPayload = {
    employee_id: entry.employee_id,
    employee_name: entry.employee_name,
    employee_type: entry.employee_type,
    gross_pay: toAmount(entry.payroll.totals.gross_pay),
    total_deductions: toAmount(entry.payroll.totals.total_deductions),
    net_pay: toAmount(entry.payroll.totals.net_pay),
    period_label: entry.pay_period,
    processed_at: processedAt,
    payslip_no: payslipNo,
  };

  const result = await supabase
    .from("payroll_records")
    .insert(insertPayload)
    .select("id, payslip_no")
    .maybeSingle();

  if (result.error) {
    throw new Error(result.error.message);
  }

  return { persisted: true, id: result.data?.id, payslip_no: result.data?.payslip_no };
}

function resolveEntryStatus(entry) {
  return entry.status || "draft";
}

function getCurrentMonthPrefix() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function normalizeAttendanceStatus(value) {
  const status = normalizeText(value, "Absent").toLowerCase();
  if (status === "present") return "present";
  if (status === "late") return "late";
  return "absent";
}

async function fetchAttendanceSummary(supabase, employees) {
  const result = await supabase
    .from("attendance_logs")
    .select("employee_id,status,log_date,time_in,created_at")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (result.error) {
    throw new Error(`Failed to fetch attendance summary: ${result.error.message}`);
  }

  const activeEmployeeIds = new Set(employees.map((employee) => employee.id));
  const monthPrefix = getCurrentMonthPrefix();
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
    });
  });

  (result.data || []).forEach((row) => {
    const employeeId = normalizeText(row.employee_id);
    if (!activeEmployeeIds.has(employeeId)) return;

    const key = normalizeText(row.log_date, normalizeText(row.time_in, row.created_at)).slice(0, 10);
    if (!key.startsWith(monthPrefix)) return;

    const summary = grouped.get(employeeId);
    if (!summary) return;

    const status = normalizeAttendanceStatus(row.status);
    if (status === "present") summary.present_days += 1;
    if (status === "late") {
      summary.late_days += 1;
      summary.present_days += 1;
    }
    if (status === "absent") {
      summary.absent_days += 1;
      summary.deduction_days += 1;
    }
  });

  return Array.from(grouped.values()).sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

// Sums each employee's approved Leave With Pay / Without Pay days that fall in
// the current calendar month, matching fetchAttendanceSummary()'s same
// current-month scoping (pay periods aren't otherwise date-ranged in this app).
async function computeLeaveSummary(employees) {
  const monthPrefix = getCurrentMonthPrefix();
  const allLeaveRequests = await readAllLeaveRequests();
  const approved = allLeaveRequests.filter((r) => r.status === "approved");

  return employees.map((employee) => {
    // leave_requests.employee_id stores the human-readable SACS-XXX code
    // (see submitLeaveRequest() in employee.js), not the auth user UUID that
    // `employee.id` is — match on employee.employee_id, but key the returned
    // summary by employee.id (UUID) to match attendance_rows' convention.
    const requestsForEmployee = approved.filter((r) => r.employee_id === employee.employee_id);

    let withPayDays = 0;
    let withoutPayDays = 0;

    requestsForEmployee.forEach((request) => {
      if (!String(request.start_date || "").startsWith(monthPrefix) && !String(request.end_date || "").startsWith(monthPrefix)) {
        return;
      }
      const days = countLeaveDays(request.start_date, request.end_date);
      if (request.pay_status === "without_pay") withoutPayDays += days;
      else withPayDays += days;
    });

    return {
      employee_id: employee.id,
      with_pay_days: withPayDays,
      without_pay_days: withoutPayDays,
    };
  });
}

function mapEntryToRecord(entry) {
  const grossPay = Number(entry.payroll?.totals?.gross_pay || 0);
  const totalDeductions = Number(entry.payroll?.totals?.total_deductions || 0);
  const netPay = Number(entry.payroll?.totals?.net_pay || 0);

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
      total_deductions: entry.payroll.totals.total_deductions,
    },
    net_pay: entry.payroll.totals.net_pay,
  };
}

function getPeriodOptions(entries) {
  const unique = new Set(entries.map((entry) => entry.pay_period).filter(Boolean));
  const periods = Array.from(unique.values());
  const current = formatPeriodLabel(new Date());

  if (!periods.includes(current)) {
    periods.unshift(current);
  }

  return periods;
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const requestedEntryId = normalizeText(url.searchParams.get("entry_id"));
    const selectedPeriod = normalizeText(url.searchParams.get("period"));

    const supabase = getAdminClient();
    const [employees, entriesResult] = await Promise.all([
      fetchEmployees(supabase),
      readPayrollEntries(supabase),
    ]);

    const entries = entriesResult.entries;

    const sortedEntries = entries
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

    const attendanceRows = await fetchAttendanceSummary(supabase, employees);
    const leaveSummary = await computeLeaveSummary(employees);

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      employees,
      period_options: getPeriodOptions(sortedEntries),
      records: payrollRecords,
      panels: buildPayrollPanels(payrollRecords),
      attendance_rows: attendanceRows,
      leave_summary: leaveSummary,
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
async function handleBatchSubmit(supabase, body) {
  const payPeriod = normalizeText(body.pay_period, formatPeriodLabel(new Date()));
  const requestedEntries = Array.isArray(body.entries) ? body.entries : [];

  if (!requestedEntries.length) {
    return NextResponse.json({ error: "At least one employee entry is required." }, { status: 400 });
  }

  const employees = await fetchEmployees(supabase);
  const entriesResult = await readPayrollEntries(supabase);
  const entries = entriesResult.entries;
  const nowIso = new Date().toISOString();

  const processed = [];
  const skipped = [];

  for (const item of requestedEntries) {
    const employeeId = normalizeText(item.employee_id);
    const employee = employees.find((row) => row.id === employeeId);

    if (!employee) {
      skipped.push({ employee_id: employeeId, reason: "Employee not found." });
      continue;
    }

    const hasAlreadyPaid = entries.some(
      (entry) => entry.employee_id === employee.id && entry.pay_period === payPeriod && entry.status === "paid",
    );

    if (hasAlreadyPaid) {
      skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason: DUPLICATE_SUBMISSION_MESSAGE });
      continue;
    }

    // Each employee's write is isolated: a failure here (e.g. a genuine
    // duplicate-key conflict from stale data the in-memory check above
    // couldn't see) must not abort the rest of the batch or get reported
    // as a blanket "already processed" for employees who were never
    // actually touched.
    try {
      const computedPayroll = computeTotals({
        basic_salary: item.basic_salary,
        deductions: {
          sss: item.deductions?.sss,
          philhealth: item.deductions?.philhealth,
          pagibig: item.deductions?.pagibig,
          withholding_tax: item.deductions?.withholding_tax,
          absences_days: item.deductions?.absences_days,
          late_days: item.deductions?.late_days,
          leave_with_pay_days: item.deductions?.leave_with_pay_days,
          leave_without_pay_days: item.deductions?.leave_without_pay_days,
        },
      });

      const baseEntry = {
        id: crypto.randomUUID(),
        employee_id: employee.id,
        employee_name: employee.full_name,
        employee_code: employee.employee_id,
        employee_type: employee.employee_type,
        position: employee.position,
        pay_period: payPeriod,
        status: "paid",
        submitted_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
        payroll: computedPayroll,
      };

      const recordResult = await appendPayrollRecord(supabase, baseEntry);
      if (recordResult.payslip_no) {
        baseEntry.payslip_no = recordResult.payslip_no;
      }

      // payroll_entries is the only place Payslips/Payroll Records/Payroll
      // Monitoring read a processed entry from — a sync failure here must
      // count as a skip, not a silent success with nothing to show for it.
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
    } catch (error) {
      const reason = isDuplicateKeyError(error)
        ? DUPLICATE_SUBMISSION_MESSAGE
        : (error?.message || "Failed to process this employee.");
      skipped.push({ employee_id: employee.id, employee_name: employee.full_name, reason });
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
    const body = await request.json();
    const action = normalizeText(body.action, "save_draft").toLowerCase();

    if (action !== "save_draft" && action !== "submit" && action !== "batch_submit") {
      return NextResponse.json({ error: "Action must be save_draft, submit, or batch_submit." }, { status: 400 });
    }

    const supabase = getAdminClient();

    if (action === "batch_submit") {
      return await handleBatchSubmit(supabase, body);
    }

    const employees = await fetchEmployees(supabase);

    const employeeId = normalizeText(body.employee_id);
    const employee = employees.find((row) => row.id === employeeId);

    if (!employee) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }

    const payPeriod = normalizeText(body.pay_period, formatPeriodLabel(new Date()));
    const computedPayroll = computeTotals({
      basic_salary: body.basic_salary,
      deductions: {
        sss: body.deductions?.sss,
        philhealth: body.deductions?.philhealth,
        pagibig: body.deductions?.pagibig,
        withholding_tax: body.deductions?.withholding_tax,
        absences_days: body.deductions?.absences_days,
        late_days: body.deductions?.late_days,
        leave_with_pay_days: body.deductions?.leave_with_pay_days,
        leave_without_pay_days: body.deductions?.leave_without_pay_days,
      },
    });

    const nowIso = new Date().toISOString();
    const entriesResult = await readPayrollEntries(supabase);
    const entries = entriesResult.entries;
    const existingId = normalizeText(body.entry_id);
    const existingIndex = existingId
      ? entries.findIndex((entry) => entry.id === existingId)
      : -1;

    if (action === "submit") {
      const hasAlreadyPaid = entries.some((entry) => {
        if (entry.employee_id !== employee.id) return false;
        if (entry.pay_period !== payPeriod) return false;
        if (existingId && entry.id === existingId) return false;
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
        if (existingId && entry.id === existingId) return false;
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
