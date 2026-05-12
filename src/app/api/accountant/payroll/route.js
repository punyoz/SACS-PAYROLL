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

// Supabase Storage — schema-free draft persistence that survives Lambda cold starts.
const DRAFT_BUCKET = "bncs-payroll-runtime";
const DRAFT_STORAGE_KEY = "accountant-draft-entries.json";

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
        cash_advance: toAmount(payrollObj?.deductions?.cash_advance ?? row.cash_advance),
      },
      totals: {
        absence_deduction: toAmount(payrollObj?.totals?.absence_deduction ?? row.absence_deduction),
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
  const cashAdvance = toAmount(payroll.deductions?.cash_advance);

  // 1 absent = ₱550, 3 late = 1 absent = ₱550
  const absenceDeduction = toAmount((absencesDays + Math.floor(lateDays / 3)) * 550);

  const grossPay = basicSalary; // No allowances; Gross Pay = Basic Salary
  const totalDeductions = toAmount(sss + philhealth + pagibig + withholdingTax + absenceDeduction + cashAdvance);
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

async function readPayrollEntriesFromDb(supabase) {
  try {
    const result = await supabase
      .from("payroll_entries")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(2000);

    if (result.error) {
      const message = String(result.error.message || "").toLowerCase();
      const isMissingTable = message.includes("does not exist") || message.includes("could not find the table");
      if (isMissingTable) return { rows: null, error: result.error.message, missingTable: true };
      console.error("[payroll_entries] read failed:", result.error.message);
      return { rows: null, error: result.error.message, missingTable: false };
    }

    const rows = Array.isArray(result.data) ? result.data.map(normalizePayrollEntry) : [];
    return { rows, error: null, missingTable: false };
  } catch (error) {
    const message = error?.message || String(error);
    console.error("[payroll_entries] read threw:", message);
    return { rows: null, error: message, missingTable: false };
  }
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
    payroll: entry.payroll,
    submitted_at: entry.submitted_at || null,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await supabase
        .from("payroll_entries")
        .upsert(payload, { onConflict: "id" });

      if (!result.error) return { success: true };

      lastError = result.error;
      const errMsg = result.error.message || "";
      const errCode = String(result.error.code || "");

      console.error(`[payroll_entries] upsert attempt ${attempt} failed (${errCode}):`, errMsg);

      // Auto-fix: if a NOT NULL constraint blocks us, drop it via the helper
      // function and retry so future saves succeed without manual migration.
      if (errCode === "23502" || errMsg.toLowerCase().includes("violates not-null")) {
        const colMatch = /null value in column "([^"]+)"/.exec(errMsg);
        if (colMatch) {
          const col = colMatch[1];
          console.warn(`[payroll_entries] auto-fixing NOT NULL on column "${col}"…`);
          try {
            await supabase.rpc("drop_column_not_null", { tbl: "payroll_entries", col });
            console.log(`[payroll_entries] NOT NULL dropped on "${col}", retrying upsert`);
          } catch (fixErr) {
            console.error("[payroll_entries] auto-fix RPC failed:", fixErr?.message || fixErr);
          }
        }
      }

      if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
    } catch (err) {
      lastError = err;
      console.error(`[payroll_entries] upsert attempt ${attempt} threw:`, err?.message || err);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  const errMsg = lastError?.message || String(lastError) || "Unknown DB error";
  console.error("[payroll_entries] all 3 upsert attempts failed:", errMsg);
  return { success: false, error: errMsg, code: lastError?.code };
}

async function deletePayrollEntryFromDb(supabase, entryId) {
  if (!supabase || !entryId) return;
  try {
    await supabase.from("payroll_entries").delete().eq("id", entryId);
  } catch {
    // best-effort — table may not exist
  }
}

async function readDraftEntriesFromStorage(supabase) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.storage
      .from(DRAFT_BUCKET)
      .download(DRAFT_STORAGE_KEY);
    if (error || !data) return [];
    const text = await data.text();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(normalizePayrollEntry) : [];
  } catch {
    return [];
  }
}

async function writeDraftEntriesToStorage(supabase, draftEntries) {
  if (!supabase) return false;
  try {
    await supabase.storage.createBucket(DRAFT_BUCKET, { public: false });
  } catch {
    // Bucket already exists — continue
  }
  try {
    const content = Buffer.from(JSON.stringify(draftEntries, null, 2), "utf-8");
    const { error } = await supabase.storage
      .from(DRAFT_BUCKET)
      .upload(DRAFT_STORAGE_KEY, content, { upsert: true, contentType: "application/json" });
    if (error) {
      console.error("[storage] write drafts failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[storage] write drafts threw:", err?.message || err);
    return false;
  }
}

async function readPayrollEntries(supabase) {
  // Three sources, merged by id:
  // 1. Supabase Storage — reliable draft persistence across all Lambda instances
  // 2. payroll_entries DB — submitted/pending entries (schema may vary)
  // 3. /tmp — same-instance fallback for very recent writes
  const [storageDrafts, dbResult, tmpData] = await Promise.all([
    readDraftEntriesFromStorage(supabase),
    supabase ? readPayrollEntriesFromDb(supabase) : Promise.resolve(null),
    readJsonStore(payrollStorePath, { entries: [] }),
  ]);

  const tmpEntries = Array.isArray(tmpData.entries)
    ? tmpData.entries.map(normalizePayrollEntry)
    : [];

  const byId = new Map();

  // DB rows first (authoritative for submitted/pending entries)
  for (const row of (dbResult?.rows ?? [])) byId.set(row.id, row);

  // Storage drafts override DB rows for draft status
  for (const entry of storageDrafts) {
    if (!byId.has(entry.id) || entry.status === "draft") byId.set(entry.id, entry);
  }

  // /tmp as same-instance fallback
  for (const entry of tmpEntries) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  const merged = Array.from(byId.values()).sort((a, b) => {
    const aT = new Date(a.updated_at || a.created_at || 0).getTime();
    const bT = new Date(b.updated_at || b.created_at || 0).getTime();
    return bT - aT;
  });

  return {
    entries: merged,
    diag: {
      db_rows: (dbResult?.rows ?? []).length,
      storage_drafts: storageDrafts.length,
      tmp_rows: tmpEntries.length,
      db_error: dbResult?.error || null,
      db_missing_table: dbResult?.missingTable || false,
    },
  };
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
    const [employees, entriesResult, approvalsData] = await Promise.all([
      fetchEmployees(supabase),
      readPayrollEntries(supabase),
      fetchApprovals(supabase),
    ]);

    const entries = entriesResult.entries;

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

    // Primary pending entries (from payroll_entries or storage)
    const entryPendingFromEntries = sortedEntries
      .filter((entry) => entry.status === "pending")
      .map(mapEntryToRecord);

    // Synthesise pending entries from salary_approvals rows that have no
    // matching payroll entry — this covers the case where payroll_entries
    // DB write failed but salary_approvals insert succeeded (common with
    // pre-existing schema constraints on the payroll_entries table).
    const coveredApprovalIds = new Set(
      sortedEntries.map((e) => e.approval_id).filter(Boolean),
    );
    const orphanPendingMapped = approvalsData.rows
      .filter((row) => row.status === "pending" && !coveredApprovalIds.has(row.id))
      .map((row) => mapEntryToRecord({
        id: `synth-${row.id}`,
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        employee_code: row.employee_code || "",
        employee_type: row.employee_type || "Teaching",
        position: row.position || "Employee",
        pay_period: formatPeriodLabel(new Date(row.submitted_at || Date.now())),
        status: "pending",
        approval_id: row.id,
        submitted_at: row.submitted_at,
        updated_at: row.submitted_at,
        created_at: row.submitted_at,
        payroll: {
          basic_salary: toAmount(row.proposed_salary),
          allowances: { transportation: 0, rice: 0, overtime: 0, bonus: 0 },
          deductions: { sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0, absences_days: 0, late_days: 0, cash_advance: 0 },
          totals: {
            absence_deduction: 0,
            gross_pay: toAmount(row.proposed_salary),
            total_deductions: 0,
            net_pay: toAmount(row.proposed_salary),
          },
        },
      }));

    const pendingSubmissions = [...entryPendingFromEntries, ...orphanPendingMapped];

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
      diag: entriesResult.diag,
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
      deductions: {
        sss: body.deductions?.sss,
        philhealth: body.deductions?.philhealth,
        pagibig: body.deductions?.pagibig,
        withholding_tax: body.deductions?.withholding_tax,
        absences_days: body.deductions?.absences_days,
        late_days: body.deductions?.late_days,
        cash_advance: body.deductions?.cash_advance,
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

    // Persist current draft list to Supabase Storage (cross-instance reliability).
    // For submit: the entry moves to pending so remove it from the draft snapshot.
    // For save_draft: include it in the snapshot.
    const currentDrafts = entries.filter((e) => e.status === "draft");
    await writeDraftEntriesToStorage(supabase, currentDrafts);

    const dbSync = await syncPayrollEntryToDb(supabase, baseEntry);

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
        db_synced: dbSync.success,
        db_error: dbSync.success ? null : dbSync.error,
      },
    });

    return NextResponse.json({
      success: true,
      entry: mapEntryToRecord(baseEntry),
      approval_persisted: approvalPersisted,
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

    if (action !== "withdraw" && action !== "cancel_draft") {
      return NextResponse.json({ error: "Action must be withdraw or cancel_draft." }, { status: 400 });
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

    if (action === "cancel_draft") {
      if (entry.status !== "draft") {
        return NextResponse.json({ error: "Only drafts can be cancelled." }, { status: 400 });
      }

      const remaining = entries.filter((_, i) => i !== index);
      await writePayrollEntries(remaining);
      await deletePayrollEntryFromDb(supabase, entryId);
      await writeDraftEntriesToStorage(supabase, remaining.filter((e) => e.status === "draft"));

      await appendAuditLog({
        module: "salary_approvals",
        action: "cancel_draft",
        entity_type: "payroll_entry",
        entity_id: entryId,
        description: `Accountant withdrew payroll draft for ${entry.employee_name}.`,
        status: "success",
        source: "api",
        metadata: { employee_id: entry.employee_id },
      });

      return NextResponse.json({ success: true });
    }

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
    await syncPayrollEntryToDb(supabase, updatedEntry);
    await writeDraftEntriesToStorage(supabase, entries.filter((e) => e.status === "draft"));

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
