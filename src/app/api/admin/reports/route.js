import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function buildEmployeeId(currentCount = 0) {
  const next = currentCount + 1;
  return `BNCS-${String(next).padStart(3, "0")}`;
}

function formatMonthYearLabel(dateInput) {
  return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(dateInput);
}

function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function shapeEmployee(user, profile, index) {
  const metadata = user.user_metadata || {};

  return {
    id: user.id,
    email: normalizeText(profile?.email, user.email),
    full_name: normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email)),
    employee_id: normalizeText(metadata.employee_id, buildEmployeeId(index)),
    employee_type: normalizeText(metadata.employee_type, "Teaching"),
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
    .sort((a, b) => {
      const idA = parseEmployeeIdNumber(a.employee_id) ?? Number.MAX_SAFE_INTEGER;
      const idB = parseEmployeeIdNumber(b.employee_id) ?? Number.MAX_SAFE_INTEGER;
      if (idA !== idB) return idA - idB;
      return a.full_name.localeCompare(b.full_name);
    });
}

function buildFallbackPayrollRecords(activeEmployees) {
  const periodLabel = formatMonthYearLabel(new Date());
  const now = new Date().toISOString();

  return activeEmployees.map((employee) => {
    const grossPay = Number(employee.basic_salary || 0);
    const totalDeductions = roundCurrency(grossPay * 0.1);
    const netPay = roundCurrency(grossPay - totalDeductions);

    return {
      id: `fallback-${employee.id}`,
      employee_id: employee.id,
      employee_name: employee.full_name,
      employee_type: employee.employee_type,
      gross_pay: grossPay,
      total_deductions: totalDeductions,
      net_pay: netPay,
      period_label: periodLabel,
      processed_at: now,
    };
  });
}

function mapPayrollRecord(row) {
  const grossPay = Number(
    row.gross_pay
      ?? row.total_gross
      ?? row.basic_salary
      ?? 0,
  );

  const totalDeductions = Number(
    row.total_deductions
      ?? row.deductions
      ?? row.deduction_amount
      ?? 0,
  );

  const netPay = Number(
    row.net_pay
      ?? row.total_net_pay
      ?? (grossPay - totalDeductions),
  );

  return {
    id: String(row.id || row.record_id || crypto.randomUUID()),
    employee_id: normalizeText(row.employee_id || row.user_id || row.profile_id),
    employee_name: normalizeText(row.employee_name),
    employee_type: normalizeText(row.employee_type),
    gross_pay: grossPay,
    total_deductions: totalDeductions,
    net_pay: netPay,
    period_label: normalizeText(row.period_label),
    processed_at: row.processed_at || row.created_at || new Date().toISOString(),
  };
}

async function fetchPayrollRecords(supabase, activeEmployees) {
  const result = await supabase
    .from("payroll_records")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (result.error) {
    const message = String(result.error.message || "").toLowerCase();
    const isMissingTable = message.includes("does not exist") || message.includes("could not find the table");

    if (isMissingTable) {
      return {
        source_mode: "fallback",
        records: buildFallbackPayrollRecords(activeEmployees),
      };
    }

    throw new Error(`Failed to fetch payroll records: ${result.error.message}`);
  }

  return {
    source_mode: "table",
    records: (result.data || []).map(mapPayrollRecord),
  };
}

function buildSummaryPayload(activeEmployees, payrollData) {
  const employeeMap = new Map();
  activeEmployees.forEach((employee) => {
    employeeMap.set(employee.id, employee);
  });

  const grouped = new Map();
  let totalGross = 0;
  let totalDeductions = 0;
  let totalNetPay = 0;
  let mostRecentDate = null;

  payrollData.records.forEach((record, index) => {
    const employee = employeeMap.get(record.employee_id);
    const key = record.employee_id || `unknown-${index}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        employee_id: record.employee_id || "",
        employee_name: normalizeText(
          record.employee_name,
          normalizeText(employee?.full_name, "Unknown Employee"),
        ),
        employee_type: normalizeText(
          record.employee_type,
          normalizeText(employee?.employee_type, "Teaching"),
        ),
        total_records: 0,
        total_gross: 0,
        total_deductions: 0,
        total_net_pay: 0,
      });
    }

    const row = grouped.get(key);
    row.total_records += 1;
    row.total_gross += Number(record.gross_pay || 0);
    row.total_deductions += Number(record.total_deductions || 0);
    row.total_net_pay += Number(record.net_pay || 0);

    totalGross += Number(record.gross_pay || 0);
    totalDeductions += Number(record.total_deductions || 0);
    totalNetPay += Number(record.net_pay || 0);

    const recordDate = new Date(record.processed_at || Date.now());
    if (!Number.isNaN(recordDate.getTime())) {
      if (!mostRecentDate || recordDate > mostRecentDate) {
        mostRecentDate = recordDate;
      }
    }
  });

  const payrollByEmployee = Array.from(grouped.values())
    .map((row) => ({
      ...row,
      total_gross: roundCurrency(row.total_gross),
      total_deductions: roundCurrency(row.total_deductions),
      total_net_pay: roundCurrency(row.total_net_pay),
    }))
    .sort((a, b) => {
      const idA = parseEmployeeIdNumber(a.employee_id) ?? Number.MAX_SAFE_INTEGER;
      const idB = parseEmployeeIdNumber(b.employee_id) ?? Number.MAX_SAFE_INTEGER;
      if (idA !== idB) return idA - idB;
      return a.employee_name.localeCompare(b.employee_name);
    });

  return {
    generated_at: new Date().toISOString(),
    source_mode: payrollData.source_mode,
    period_label: formatMonthYearLabel(mostRecentDate || new Date()),
    panels: {
      total_records: payrollData.records.length,
      total_gross: roundCurrency(totalGross),
      total_deductions: roundCurrency(totalDeductions),
      total_net_pay: roundCurrency(totalNetPay),
    },
    payroll_by_employee: payrollByEmployee,
  };
}

export async function GET() {
  try {
    const supabase = getAdminClient();
    const employees = await fetchEmployees(supabase);
    const activeEmployees = employees.filter((employee) => !employee.archived);
    const payrollData = await fetchPayrollRecords(supabase, activeEmployees);

    const payload = buildSummaryPayload(activeEmployees, payrollData);

    await appendAuditLog({
      module: "reports",
      action: "view_summary",
      entity_type: "summary_reports",
      entity_id: payload.period_label,
      description: `Summary reports generated for ${payload.period_label}.`,
      status: "success",
      source: "api",
      metadata: {
        total_records: payload.panels.total_records,
        source_mode: payload.source_mode,
      },
    });

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
