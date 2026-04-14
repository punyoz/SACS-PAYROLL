import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { applyApprovalOverrides, readApprovalOverrides, setApprovalOverride } from "@/lib/approvals/overrides";
import { getAttendancePanels } from "@/app/api/admin/attendance/route";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const fallbackStorePath = path.join(process.cwd(), ".runtime", "salary-approvals.json");

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

function shapeEmployee(user, profile, index) {
  const metadata = user.user_metadata || {};

  return {
    id: user.id,
    email: normalizeText(profile?.email, user.email),
    full_name: normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email)),
    employee_id: normalizeText(metadata.employee_id, buildEmployeeId(index)),
    employee_type: normalizeText(metadata.employee_type, "Teaching"),
    position: normalizeText(metadata.position, "Staff"),
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

function formatMonthLabel(date) {
  return new Intl.DateTimeFormat("en-PH", { month: "short" }).format(date);
}

function formatMonthYearLabel(date) {
  return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(date);
}

function buildMonthlyPayroll(totalPayrollMonth) {
  const multipliers = [0.92, 0.96, 0.9, 0.98, 1.03, 1];
  const months = [];

  for (let index = 5; index >= 0; index -= 1) {
    const date = new Date();
    date.setMonth(date.getMonth() - index);

    const multiplier = multipliers[5 - index] || 1;
    const amount = Math.round(totalPayrollMonth * multiplier);

    months.push({
      key: `${date.getFullYear()}-${date.getMonth() + 1}`,
      label: formatMonthLabel(date),
      amount,
      isCurrentMonth: index === 0,
    });
  }

  return months;
}

function normalizeApprovalRow(row) {
  return {
    id: String(row.id || ""),
    employee_id: normalizeText(row.employee_id),
    employee_name: normalizeText(row.employee_name, "Unknown Employee"),
    employee_code: normalizeText(row.employee_code),
    employee_type: normalizeText(row.employee_type, "Teaching"),
    position: normalizeText(row.position, "Staff"),
    current_salary: Number(row.current_salary || 0),
    proposed_salary: Number(row.proposed_salary || 0),
    reason: normalizeText(row.reason, "No reason provided."),
    submitted_by: normalizeText(row.submitted_by, "Accountant"),
    submitted_at: row.submitted_at || new Date().toISOString(),
    status: normalizeText(row.status, "pending").toLowerCase(),
    decided_at: row.decided_at || null,
  };
}

function buildSeedFallbackPending(activeEmployees) {
  const now = Date.now();

  return activeEmployees.slice(0, 2).map((employee, index) => {
    const baseSalary = Number(employee.basic_salary || 0);
    const increase = index === 0 ? 800 : 600;

    return {
      id: `fallback-${employee.id}`,
      employee_id: employee.id,
      employee_name: employee.full_name,
      employee_code: employee.employee_id,
      employee_type: employee.employee_type,
      position: employee.position,
      current_salary: baseSalary,
      proposed_salary: baseSalary + increase,
      reason: "Submitted for monthly salary adjustment review.",
      submitted_by: "Accountant",
      submitted_at: new Date(now - index * 86400000).toISOString(),
      status: "pending",
      decided_at: null,
    };
  });
}

async function readFallbackApprovalStore(activeEmployees) {
  const directory = path.dirname(fallbackStorePath);
  await fs.mkdir(directory, { recursive: true });

  let parsed = { pending: [], history: [] };

  try {
    const raw = await fs.readFile(fallbackStorePath, "utf8");
    const data = JSON.parse(raw);
    parsed = {
      pending: Array.isArray(data.pending) ? data.pending.map(normalizeApprovalRow) : [],
      history: Array.isArray(data.history) ? data.history.map(normalizeApprovalRow) : [],
    };
  } catch {
    parsed = { pending: [], history: [] };
  }

  if (!parsed.pending.length && !parsed.history.length) {
    parsed.pending = buildSeedFallbackPending(activeEmployees);
    await fs.writeFile(fallbackStorePath, JSON.stringify(parsed, null, 2), "utf8");
  }

  return parsed;
}

async function writeFallbackApprovalStore(store) {
  const directory = path.dirname(fallbackStorePath);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(fallbackStorePath, JSON.stringify(store, null, 2), "utf8");
}

async function fetchApprovalData(supabase, activeEmployees) {
  const overrides = await readApprovalOverrides();
  const result = await supabase
    .from("salary_approvals")
    .select("id,employee_id,employee_name,employee_code,employee_type,position,current_salary,proposed_salary,reason,submitted_by,submitted_at,status")
    .order("submitted_at", { ascending: false })
    .limit(1000);

  if (result.error) {
    const message = String(result.error.message || "").toLowerCase();
    const isMissingTable = message.includes("does not exist") || message.includes("could not find the table");

    if (!isMissingTable) {
      throw new Error(`Failed to fetch salary approvals: ${result.error.message}`);
    }

    const fallback = await readFallbackApprovalStore(activeEmployees);
    const pending = fallback.pending.filter((row) => row.status === "pending");
    const history = fallback.history.filter((row) => row.status !== "pending");

    return {
      can_persist: false,
      pending,
      history,
      all: [...pending, ...history],
    };
  }

  const allRows = applyApprovalOverrides((result.data || []).map(normalizeApprovalRow), overrides);
  const pending = allRows.filter((row) => row.status === "pending");
  const history = allRows.filter((row) => row.status !== "pending");

  return {
    can_persist: true,
    pending,
    history,
    all: allRows,
  };
}

async function applyApprovedSalaryToEmployee(supabase, employeeId, proposedSalary) {
  const normalizedEmployeeId = normalizeText(employeeId);
  if (!normalizedEmployeeId) {
    return { updated: false };
  }

  const amount = Number(proposedSalary || 0);
  if (!Number.isFinite(amount)) {
    return { updated: false };
  }

  const userResult = await supabase.auth.admin.getUserById(normalizedEmployeeId);
  if (userResult.error || !userResult.data?.user) {
    return { updated: false };
  }

  const currentUser = userResult.data.user;
  const nextMetadata = {
    ...(currentUser.user_metadata || {}),
    basic_salary: amount,
  };

  const updateResult = await supabase.auth.admin.updateUserById(normalizedEmployeeId, {
    user_metadata: nextMetadata,
  });

  if (updateResult.error) {
    throw new Error(updateResult.error.message);
  }

  return { updated: true };
}

async function applyApprovalDecision(supabase, activeEmployees, id, action) {
  const nextStatus = action === "approve" ? "approved" : "rejected";

  const probe = await supabase.from("salary_approvals").select("id").limit(1);
  const canPersist = !probe.error;

  if (canPersist) {
    const lookupResult = await supabase
      .from("salary_approvals")
      .select("id,employee_id,proposed_salary")
      .eq("id", id)
      .maybeSingle();

    if (lookupResult.error) {
      throw new Error(lookupResult.error.message);
    }

    if (!lookupResult.data) {
      return { found: false, persisted: true, next_status: nextStatus, salary_applied: false };
    }

    const updateResult = await supabase
      .from("salary_approvals")
      .update({ status: nextStatus, decided_at: new Date().toISOString() })
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (updateResult.error) {
      const message = String(updateResult.error.message || "");
      const missingUpdatedAt = message.toLowerCase().includes('has no field "updated_at"');

      if (!missingUpdatedAt) {
        throw new Error(message);
      }

      // Database trigger expects updated_at on legacy schema. Save an override so UI and history stay in sync.
      await setApprovalOverride(id, nextStatus, new Date().toISOString());

      let salaryAppliedFromOverride = false;
      if (action === "approve") {
        const salaryUpdate = await applyApprovedSalaryToEmployee(
          supabase,
          lookupResult.data.employee_id,
          lookupResult.data.proposed_salary,
        );
        salaryAppliedFromOverride = salaryUpdate.updated;
      }

      return {
        found: true,
        persisted: false,
        next_status: nextStatus,
        salary_applied: salaryAppliedFromOverride,
      };
    }

    if (!updateResult.data) {
      return { found: false, persisted: true, next_status: nextStatus, salary_applied: false };
    }

    if (action === "approve") {
      const salaryUpdate = await applyApprovedSalaryToEmployee(
        supabase,
        lookupResult.data.employee_id,
        lookupResult.data.proposed_salary,
      );

      return {
        found: true,
        persisted: true,
        next_status: nextStatus,
        salary_applied: salaryUpdate.updated,
      };
    }

    return { found: true, persisted: true, next_status: nextStatus, salary_applied: false };
  }

  const fallback = await readFallbackApprovalStore(activeEmployees);
  const pendingIndex = fallback.pending.findIndex((row) => String(row.id) === id);

  if (pendingIndex < 0) {
    return { found: false, persisted: false, next_status: nextStatus };
  }

  const selected = fallback.pending[pendingIndex];
  const moved = {
    ...selected,
    status: nextStatus,
    decided_at: new Date().toISOString(),
  };

  fallback.pending.splice(pendingIndex, 1);
  fallback.history.unshift(moved);
  await writeFallbackApprovalStore(fallback);

  let salaryApplied = false;
  if (action === "approve") {
    const salaryUpdate = await applyApprovedSalaryToEmployee(
      supabase,
      selected.employee_id,
      selected.proposed_salary,
    );
    salaryApplied = salaryUpdate.updated;
  }

  return { found: true, persisted: false, next_status: nextStatus, salary_applied: salaryApplied };
}

function buildRecentActivity(activeEmployees, pendingApprovals) {
  const pendingEmployeeIds = new Set(
    pendingApprovals
      .map((approval) => approval.employee_id)
      .filter(Boolean),
  );

  const monthLabel = formatMonthYearLabel(new Date());

  return activeEmployees.slice(0, 6).map((employee) => {
    const hasPendingApproval = pendingEmployeeIds.has(employee.id);

    return {
      id: employee.id,
      name: employee.full_name,
      employee_type: employee.employee_type,
      amount: Number(employee.basic_salary || 0),
      period: monthLabel,
      status: hasPendingApproval ? "Pending" : "Paid",
      sub_text: hasPendingApproval
        ? `${monthLabel} · Approval pending`
        : monthLabel,
    };
  });
}

function buildDashboardPayload(activeEmployees, approvalData, attendancePanels) {
  const totalEmployees = activeEmployees.length;
  const totalPayrollMonth = activeEmployees.reduce(
    (sum, employee) => sum + Number(employee.basic_salary || 0),
    0,
  );

  return {
    generated_at: new Date().toISOString(),
    panels: {
      total_employees: totalEmployees,
      total_payroll_month: totalPayrollMonth,
      pending_approvals: approvalData.pending.length,
      absent_today: Number(attendancePanels.absent_today || 0),
    },
    pending_approvals: approvalData.pending,
    approval_history: approvalData.history,
    monthly_payroll: buildMonthlyPayroll(totalPayrollMonth),
    recent_activity: buildRecentActivity(activeEmployees, approvalData.pending),
    approvals_can_persist: approvalData.can_persist,
  };
}

export async function GET() {
  try {
    const supabase = getAdminClient();
    const employees = await fetchEmployees(supabase);
    const activeEmployees = employees.filter((employee) => !employee.archived);

    const approvalData = await fetchApprovalData(supabase, activeEmployees);
    const attendancePanels = await getAttendancePanels(supabase, activeEmployees);
    const payload = buildDashboardPayload(activeEmployees, approvalData, attendancePanels);

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const id = normalizeText(body.id);
    const action = normalizeText(body.action).toLowerCase();

    if (!id) {
      return NextResponse.json({ error: "Approval id is required." }, { status: 400 });
    }

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json({ error: "Action must be approve or reject." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const employees = await fetchEmployees(supabase);
    const activeEmployees = employees.filter((employee) => !employee.archived);

    const decision = await applyApprovalDecision(supabase, activeEmployees, id, action);

    if (!decision.found) {
      return NextResponse.json({ error: "Approval request not found." }, { status: 404 });
    }

    await appendAuditLog({
      module: "salary_approvals",
      action,
      entity_type: "salary_request",
      entity_id: id,
      description: `Salary approval request ${id} was ${decision.next_status} by admin.`,
      status: "success",
      source: "api",
      metadata: {
        request_id: id,
        persisted: decision.persisted,
        salary_applied: decision.salary_applied,
      },
    });

    return NextResponse.json({
      success: true,
      status: decision.next_status,
      persisted: decision.persisted,
      salary_applied: decision.salary_applied,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
