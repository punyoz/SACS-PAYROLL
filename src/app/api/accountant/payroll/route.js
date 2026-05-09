import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { applyApprovalOverrides, readApprovalOverrides } from "@/lib/approvals/overrides";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const runtimeDir = path.join(os.tmpdir(), "bncs-payroll-runtime");
const payrollStorePath = path.join(runtimeDir, "accountant-payroll-entries.json");
const fallbackApprovalsPath = path.join(runtimeDir, "salary-approvals.json");
const DUPLICATE_SUBMISSION_MESSAGE = "This payroll entry has already been submitted and is awaiting admin approval.";

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
  const match = /^BNCS-(\d+)$/i.exec(String(employeeId || "").trim());
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
    employee_id: normalizeText(metadata.employee_id, `BNCS-${String(index + 1).padStart(3, "0")}`),
    employee_type: normalizeText(metadata.employee_type, "Teaching"),
    position: normalizePositionForRole(metadata.position, role),
    basic_salary: Number(metadata.basic_salary || 0),
    archived: Boolean(metadata.archived),
  };
}

async function fetchEmployees(supabase) {
  const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
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

async function readJsonStore(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

async function writeJsonStore(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function normalizePayrollEntry(row) {
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
    submitted_at: row.submitted_at || null,
    created_at: row.created_at || new Date().toISOString(),
    updated_at: row.updated_at || row.created_at || new Date().toISOString(),
    payroll: {
      basic_salary: toAmount(row.payroll?.basic_salary ?? row.basic_salary),
      allowances: {
        transportation: toAmount(row.payroll?.allowances?.transportation ?? row.transportation),
        rice: toAmount(row.payroll?.allowances?.rice ?? row.rice),
        overtime: toAmount(row.payroll?.allowances?.overtime ?? row.overtime),
        bonus: toAmount(row.payroll?.allowances?.bonus ?? row.bonus),
      },
      deductions: {
        sss: toAmount(row.payroll?.deductions?.sss ?? row.sss),
        philhealth: toAmount(row.payroll?.deductions?.philhealth ?? row.philhealth),
        pagibig: toAmount(row.payroll?.deductions?.pagibig ?? row.pagibig),
        withholding_tax: toAmount(row.payroll?.deductions?.withholding_tax ?? row.withholding_tax),
        absences_days: toAmount(row.payroll?.deductions?.absences_days ?? row.absences_days),
        cash_advance: toAmount(row.payroll?.deductions?.cash_advance ?? row.cash_advance),
      },
      totals: {
        absence_deduction: toAmount(row.payroll?.totals?.absence_deduction ?? row.absence_deduction),
        gross_pay: toAmount(row.payroll?.totals?.gross_pay ?? row.gross_pay),
        total_deductions: toAmount(row.payroll?.totals?.total_deductions ?? row.total_deductions),
        net_pay: toAmount(row.payroll?.totals?.net_pay ?? row.net_pay),
      },
    },
  };
}

function computeTotals(payroll) {
  const basicSalary = toAmount(payroll.basic_salary);

  const transportation = toAmount(payroll.allowances?.transportation);
  const rice = toAmount(payroll.allowances?.rice);
  const overtime = toAmount(payroll.allowances?.overtime);
  const bonus = toAmount(payroll.allowances?.bonus);

  const sss = toAmount(payroll.deductions?.sss);
  const philhealth = toAmount(payroll.deductions?.philhealth);
  const pagibig = toAmount(payroll.deductions?.pagibig);
  const withholdingTax = toAmount(payroll.deductions?.withholding_tax);
  const absencesDays = Math.max(0, toAmount(payroll.deductions?.absences_days));
  const cashAdvance = toAmount(payroll.deductions?.cash_advance);

  const dailyRate = basicSalary / 22;
  const absenceDeduction = toAmount(dailyRate * absencesDays);

  const grossPay = toAmount(basicSalary + transportation + rice + overtime + bonus);
  const totalDeductions = toAmount(sss + philhealth + pagibig + withholdingTax + absenceDeduction + cashAdvance);
  const netPay = toAmount(grossPay - totalDeductions);

  return {
    basic_salary: basicSalary,
    allowances: {
      transportation,
      rice,
      overtime,
      bonus,
    },
    deductions: {
      sss,
      philhealth,
      pagibig,
      withholding_tax: withholdingTax,
      absences_days: absencesDays,
      cash_advance: cashAdvance,
    },
    totals: {
      absence_deduction: absenceDeduction,
      gross_pay: grossPay,
      total_deductions: totalDeductions,
      net_pay: netPay,
    },
  };
}

async function readPayrollEntries() {
  const data = await readJsonStore(payrollStorePath, { entries: [] });
  const entries = Array.isArray(data.entries) ? data.entries.map(normalizePayrollEntry) : [];

  if (entries.length !== (Array.isArray(data.entries) ? data.entries.length : 0)) {
    await writeJsonStore(payrollStorePath, { entries });
  }

  return entries;
}

async function writePayrollEntries(entries) {
  await writeJsonStore(payrollStorePath, {
    entries: entries.map(normalizePayrollEntry),
  });
}

function normalizeApprovalRow(row) {
  return {
    id: String(row.id || ""),
    employee_id: normalizeText(row.employee_id),
    employee_name: normalizeText(row.employee_name, "Unknown Employee"),
    employee_code: normalizeText(row.employee_code),
    employee_type: normalizeText(row.employee_type, "Teaching"),
    position: normalizePositionForRole(row.position, row.role),
    current_salary: Number(row.current_salary || 0),
    proposed_salary: Number(row.proposed_salary || 0),
    reason: normalizeText(row.reason, "No reason provided."),
    submitted_by: normalizeText(row.submitted_by, "Accountant"),
    submitted_at: row.submitted_at || new Date().toISOString(),
    status: normalizeText(row.status, "pending").toLowerCase(),
    decided_at: row.decided_at || null,
  };
}

async function readFallbackApprovalStore() {
  const parsed = await readJsonStore(fallbackApprovalsPath, { pending: [], history: [] });
  return {
    pending: Array.isArray(parsed.pending) ? parsed.pending.map(normalizeApprovalRow) : [],
    history: Array.isArray(parsed.history) ? parsed.history.map(normalizeApprovalRow) : [],
  };
}

async function writeFallbackApprovalStore(store) {
  await writeJsonStore(fallbackApprovalsPath, {
    pending: Array.isArray(store.pending) ? store.pending : [],
    history: Array.isArray(store.history) ? store.history : [],
  });
}

async function fetchApprovals(supabase) {
  const overrides = await readApprovalOverrides();
  const result = await supabase
    .from("salary_approvals")
    .select("id,employee_id,employee_name,employee_code,employee_type,position,current_salary,proposed_salary,reason,submitted_by,submitted_at,status,decided_at")
    .order("submitted_at", { ascending: false })
    .limit(2000);

  if (result.error) {
    const message = String(result.error.message || "").toLowerCase();
    const isMissingTable = message.includes("does not exist") || message.includes("could not find the table");

    if (!isMissingTable) {
      throw new Error(`Failed to fetch salary approvals: ${result.error.message}`);
    }

    const fallback = await readFallbackApprovalStore();
    const allRows = [...fallback.pending, ...fallback.history].map(normalizeApprovalRow);

    return {
      can_persist: false,
      rows: allRows,
    };
  }

  return {
    can_persist: true,
    rows: applyApprovalOverrides((result.data || []).map(normalizeApprovalRow), overrides),
  };
}

async function createSalaryApprovalRequest(supabase, payload) {
  const insertPayload = {
    employee_id: payload.employee_id,
    employee_name: payload.employee_name,
    employee_code: payload.employee_code,
    employee_type: payload.employee_type,
    position: normalizePositionForRole(payload.position, payload.role),
    current_salary: toAmount(payload.current_salary),
    proposed_salary: toAmount(payload.proposed_salary),
    reason: normalizeText(payload.reason, "Submitted for payroll approval."),
    submitted_by: normalizeText(payload.submitted_by, "Accountant"),
    submitted_at: payload.submitted_at || new Date().toISOString(),
    status: "pending",
  };

  const insertResult = await supabase
    .from("salary_approvals")
    .insert(insertPayload)
    .select("id")
    .maybeSingle();

  if (insertResult.error) {
    const message = String(insertResult.error.message || "").toLowerCase();
    const isMissingTable = message.includes("does not exist") || message.includes("could not find the table");

    if (!isMissingTable) {
      if (!isDuplicateKeyError(insertResult.error)) {
        throw new Error(insertResult.error.message);
      }

      const existingPending = await supabase
        .from("salary_approvals")
        .select("id")
        .eq("employee_id", payload.employee_id)
        .eq("status", "pending")
        .order("submitted_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingPending.error || !existingPending.data?.id) {
        throw new Error(insertResult.error.message);
      }

      const updateResult = await supabase
        .from("salary_approvals")
        .update({
          ...insertPayload,
          status: "pending",
        })
        .eq("id", existingPending.data.id)
        .select("id")
        .maybeSingle();

      if (updateResult.error || !updateResult.data?.id) {
        throw new Error(updateResult.error?.message || "Failed to update existing pending approval.");
      }

      return {
        id: updateResult.data.id,
        persisted: true,
      };
    }

    const fallback = await readFallbackApprovalStore();
    const generatedId = `fallback-${crypto.randomUUID()}`;

    fallback.pending.unshift({
      ...insertPayload,
      id: generatedId,
      decided_at: null,
    });

    await writeFallbackApprovalStore(fallback);

    return { id: generatedId, persisted: false };
  }

  return {
    id: insertResult.data?.id || "",
    persisted: true,
  };
}

async function withdrawSalaryApprovalRequest(supabase, approvalId) {
  const normalizedId = normalizeText(approvalId);
  if (!normalizedId) {
    return { found: false, persisted: true };
  }

  const deleteResult = await supabase
    .from("salary_approvals")
    .delete()
    .eq("id", normalizedId)
    .select("id")
    .maybeSingle();

  if (!deleteResult.error) {
    return { found: Boolean(deleteResult.data), persisted: true };
  }

  const message = String(deleteResult.error.message || "").toLowerCase();
  const isMissingTable = message.includes("does not exist") || message.includes("could not find the table");

  if (!isMissingTable) {
    throw new Error(deleteResult.error.message);
  }

  const fallback = await readFallbackApprovalStore();
  const index = fallback.pending.findIndex((row) => String(row.id) === normalizedId);

  if (index < 0) {
    return { found: false, persisted: false };
  }

  fallback.pending.splice(index, 1);
  await writeFallbackApprovalStore(fallback);
  return { found: true, persisted: false };
}

async function generatePayslipNo(supabase, processedAt) {
  const date = processedAt ? new Date(processedAt) : new Date();
  const ym = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `PS-${ym}-`;

  try {
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
  } catch {
    // Fallback: timestamp-based unique ID
    return `${prefix}${Date.now().toString().slice(-4)}`;
  }
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
    const message = String(result.error.message || "").toLowerCase();
    const isMissingTable = message.includes("does not exist") || message.includes("could not find the table");

    if (!isMissingTable) {
      throw new Error(result.error.message);
    }

    return { persisted: false };
  }

  return { persisted: true, id: result.data?.id, payslip_no: result.data?.payslip_no };
}

function resolveEntryStatus(entry, approvalMap) {
  if (!entry.approval_id) {
    return entry.status === "draft" ? "draft" : "draft";
  }

  const approval = approvalMap.get(entry.approval_id);
  if (!approval) {
    return entry.status === "pending" ? "pending" : entry.status;
  }

  if (approval.status === "pending") return "pending";
  if (approval.status === "approved") return "paid";
  if (approval.status === "rejected") return "on_hold";

  return entry.status;
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

function buildAttendanceSummaryFallback(employees, payrollEntries) {
  const byEmployee = new Map();

  employees.forEach((employee) => {
    const entriesForEmployee = payrollEntries.filter((entry) => entry.employee_id === employee.id);
    const latest = entriesForEmployee[0];
    const deductionDays = Number(latest?.payroll?.deductions?.absences_days || 0);

    byEmployee.set(employee.id, {
      employee_id: employee.id,
      employee_name: employee.full_name,
      employee_type: employee.employee_type,
      present_days: Math.max(0, 22 - deductionDays),
      late_days: 0,
      absent_days: deductionDays,
      deduction_days: deductionDays,
    });
  });

  return Array.from(byEmployee.values());
}

async function fetchAttendanceSummary(supabase, employees, payrollEntries) {
  const result = await supabase
    .from("attendance_logs")
    .select("employee_id,status,log_date,time_in,created_at")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (result.error) {
    const message = String(result.error.message || "").toLowerCase();
    const isMissingTable = message.includes("does not exist") || message.includes("could not find the table");

    if (isMissingTable) {
      return buildAttendanceSummaryFallback(employees, payrollEntries);
    }

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
  return records.map((record) => ({
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
      transportation: entry.payroll.allowances.transportation,
      rice: entry.payroll.allowances.rice,
      overtime: entry.payroll.allowances.overtime,
      bonus: entry.payroll.allowances.bonus,
      gross_pay: entry.payroll.totals.gross_pay,
    },
    deductions: {
      sss: entry.payroll.deductions.sss,
      philhealth: entry.payroll.deductions.philhealth,
      pagibig: entry.payroll.deductions.pagibig,
      withholding_tax: entry.payroll.deductions.withholding_tax,
      absences_days: entry.payroll.deductions.absences_days,
      absence_deduction: entry.payroll.totals.absence_deduction,
      cash_advance: entry.payroll.deductions.cash_advance,
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
    const [employees, entries, approvalsData] = await Promise.all([
      fetchEmployees(supabase),
      readPayrollEntries(),
      fetchApprovals(supabase),
    ]);

    const approvalMap = new Map();
    approvalsData.rows.forEach((row) => {
      approvalMap.set(row.id, row);
    });

    const sortedEntries = entries
      .map((entry) => ({
        ...entry,
        status: resolveEntryStatus(entry, approvalMap),
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

    const pendingSubmissions = sortedEntries
      .filter((entry) => entry.status === "pending")
      .map(mapEntryToRecord);

    const payslipSource = requestedEntryId
      ? sortedEntries.find((entry) => entry.id === requestedEntryId)
      : (payrollRecords[0] ? sortedEntries.find((entry) => entry.id === payrollRecords[0].id) : null);

    const attendanceRows = await fetchAttendanceSummary(supabase, employees, sortedEntries);

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      can_persist_approvals: approvalsData.can_persist,
      employees,
      period_options: getPeriodOptions(sortedEntries),
      records: payrollRecords,
      panels: buildPayrollPanels(payrollRecords),
      pending_submissions: pendingSubmissions,
      attendance_rows: attendanceRows,
      draft_entries: sortedEntries.filter((entry) => entry.status === "draft").map(mapEntryToRecord),
      payslip_options: buildPayslipOptions(payrollRecords),
      payslip: buildPayslipDetails(payslipSource),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const action = normalizeText(body.action, "save_draft").toLowerCase();

    if (action !== "save_draft" && action !== "submit") {
      return NextResponse.json({ error: "Action must be save_draft or submit." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const employees = await fetchEmployees(supabase);

    const employeeId = normalizeText(body.employee_id);
    const employee = employees.find((row) => row.id === employeeId);

    if (!employee) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }

    const payPeriod = normalizeText(body.pay_period, formatPeriodLabel(new Date()));
    const computedPayroll = computeTotals({
      basic_salary: body.basic_salary,
      allowances: {
        transportation: body.allowances?.transportation,
        rice: body.allowances?.rice,
        overtime: body.allowances?.overtime,
        bonus: body.allowances?.bonus,
      },
      deductions: {
        sss: body.deductions?.sss,
        philhealth: body.deductions?.philhealth,
        pagibig: body.deductions?.pagibig,
        withholding_tax: body.deductions?.withholding_tax,
        absences_days: body.deductions?.absences_days,
        cash_advance: body.deductions?.cash_advance,
      },
    });

    const nowIso = new Date().toISOString();
    const entries = await readPayrollEntries();
    const existingId = normalizeText(body.entry_id);
    const existingIndex = existingId
      ? entries.findIndex((entry) => entry.id === existingId)
      : -1;

    if (action === "submit") {
      const hasPendingDuplicate = entries.some((entry) => {
        if (entry.employee_id !== employee.id) return false;
        if (entry.pay_period !== payPeriod) return false;
        if (entry.status !== "pending") return false;
        if (existingId && entry.id === existingId) return true;
        return true;
      });

      if (hasPendingDuplicate) {
        return NextResponse.json({ error: DUPLICATE_SUBMISSION_MESSAGE }, { status: 409 });
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
      status: action === "submit" ? "pending" : "draft",
      approval_id: existingIndex >= 0 ? normalizeText(entries[existingIndex].approval_id) : "",
      submitted_at: action === "submit" ? nowIso : (existingIndex >= 0 ? entries[existingIndex].submitted_at : null),
      created_at: existingIndex >= 0 ? entries[existingIndex].created_at : nowIso,
      updated_at: nowIso,
      payroll: computedPayroll,
    };

    let approvalPersisted = null;

    if (action === "submit") {
      if (baseEntry.approval_id) {
        const withdrawn = await withdrawSalaryApprovalRequest(supabase, baseEntry.approval_id);
        if (!withdrawn.found) {
          baseEntry.approval_id = "";
        }
      }

      const approvalResult = await createSalaryApprovalRequest(supabase, {
        employee_id: employee.id,
        employee_name: employee.full_name,
        employee_code: employee.employee_id,
        employee_type: employee.employee_type,
        position: employee.position,
        role: employee.role,
        current_salary: Number(employee.basic_salary || 0),
        proposed_salary: Number(baseEntry.payroll.basic_salary || 0),
        reason: normalizeText(body.reason, "Submitted via Process Payroll page."),
        submitted_by: "Accountant",
        submitted_at: nowIso,
      });

      baseEntry.approval_id = approvalResult.id;
      baseEntry.submitted_at = nowIso;
      approvalPersisted = approvalResult.persisted;

      const recordResult = await appendPayrollRecord(supabase, baseEntry);
      if (recordResult.payslip_no) {
        baseEntry.payslip_no = recordResult.payslip_no;
      }
    }

    if (existingIndex >= 0) {
      entries[existingIndex] = baseEntry;
    } else {
      entries.unshift(baseEntry);
    }

    await writePayrollEntries(entries);

    await appendAuditLog({
      module: "salary_approvals",
      action: action === "submit" ? "submit" : "draft",
      entity_type: "payroll_entry",
      entity_id: baseEntry.id,
      description: action === "submit"
        ? `Payroll entry for ${employee.full_name} submitted for admin approval.`
        : `Payroll draft for ${employee.full_name} saved.`,
      status: "success",
      source: "api",
      metadata: {
        employee_id: employee.id,
        approval_id: baseEntry.approval_id,
        approval_persisted: approvalPersisted,
      },
    });

    return NextResponse.json({
      success: true,
      entry: mapEntryToRecord(baseEntry),
      approval_persisted: approvalPersisted,
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

    if (action !== "withdraw") {
      return NextResponse.json({ error: "Action must be withdraw." }, { status: 400 });
    }

    const entryId = normalizeText(body.entry_id);
    if (!entryId) {
      return NextResponse.json({ error: "entry_id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const entries = await readPayrollEntries();
    const index = entries.findIndex((entry) => entry.id === entryId);

    if (index < 0) {
      return NextResponse.json({ error: "Payroll entry not found." }, { status: 404 });
    }

    const entry = entries[index];
    if (entry.status !== "pending") {
      return NextResponse.json({ error: "Only pending submissions can be withdrawn." }, { status: 400 });
    }

    if (entry.approval_id) {
      const withdrawn = await withdrawSalaryApprovalRequest(supabase, entry.approval_id);
      if (!withdrawn.found) {
        return NextResponse.json({ error: "Linked approval request was not found." }, { status: 404 });
      }
    }

    const updatedEntry = {
      ...entry,
      status: "draft",
      approval_id: "",
      submitted_at: null,
      updated_at: new Date().toISOString(),
    };

    entries[index] = updatedEntry;
    await writePayrollEntries(entries);

    await appendAuditLog({
      module: "salary_approvals",
      action: "withdraw",
      entity_type: "payroll_entry",
      entity_id: entryId,
      description: `Accountant withdrew pending payroll submission for ${entry.employee_name}.`,
      status: "success",
      source: "api",
      metadata: {
        employee_id: entry.employee_id,
      },
    });

    return NextResponse.json({ success: true, entry: mapEntryToRecord(updatedEntry) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
