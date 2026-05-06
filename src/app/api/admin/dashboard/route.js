import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { readAllSalaryApprovals, updateSalaryApprovalStatus } from "@/lib/salary-approvals/store";
import { getAttendancePanels } from "@/app/api/admin/attendance/route";

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

function normalizePositionForRole(positionInput, roleInput) {
  const role = String(roleInput || "").toLowerCase();
  const position = normalizeText(positionInput).toLowerCase();

  if (role === "accountant" || position === "accountant" || position.includes("account")) {
    return "Accountant";
  }

  return "Employee";
}

function shapeEmployee(user, profile, index) {
  const metadata = user.user_metadata || {};

  return {
    id: user.id,
    email: normalizeText(profile?.email, user.email),
    full_name: normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email)),
    employee_id: normalizeText(metadata.employee_id, buildEmployeeId(index)),
    employee_type: normalizeText(metadata.employee_type, "Teaching"),
    position: normalizePositionForRole(metadata.position, metadata.role),
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

async function fetchApprovalData() {
  const allRows = await readAllSalaryApprovals();
  const pending = allRows.filter((row) => row.status === "pending");
  const history = allRows.filter((row) => row.status !== "pending");
  return { can_persist: true, pending, history, all: allRows };
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

    const approvalData = await fetchApprovalData();
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

    const nextStatus = action === "approve" ? "approved" : "rejected";

    // Verify the record is still pending before acting.
    const allApprovals = await readAllSalaryApprovals();
    const current = allApprovals.find((row) => row.id === id);

    if (!current) {
      return NextResponse.json({ error: "Approval request not found." }, { status: 404 });
    }

    if (current.status !== "pending") {
      return NextResponse.json(
        { error: `Cannot ${action} a request with status: ${current.status}.` },
        { status: 400 },
      );
    }

    // Persist the status change (DB → Storage → /tmp, same as leave approvals).
    const result = await updateSalaryApprovalStatus(id, nextStatus);

    if (!result.found) {
      return NextResponse.json({ error: "Approval request not found." }, { status: 404 });
    }

    // If approved, apply the new salary to the employee's metadata.
    let salaryApplied = false;
    if (action === "approve") {
      try {
        const supabase = getAdminClient();
        const salaryUpdate = await applyApprovedSalaryToEmployee(
          supabase,
          current.employee_id,
          current.proposed_salary,
        );
        salaryApplied = salaryUpdate.updated;
      } catch {
        // Salary update is best-effort; approval itself is already saved.
      }
    }

    await appendAuditLog({
      module: "salary_approvals",
      action,
      entity_type: "salary_request",
      entity_id: id,
      description: `Salary approval request ${id} was ${nextStatus} by admin.`,
      status: "success",
      source: "api",
      metadata: { request_id: id, salary_applied: salaryApplied },
    });

    return NextResponse.json({ success: true, status: nextStatus, salary_applied: salaryApplied });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
