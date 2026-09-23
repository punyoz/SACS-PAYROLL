import { listUsersCached } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { getAttendancePanels } from "@/app/api/admin/attendance/route";
import { requirePermission } from "@/lib/rbac/guard";
import { SCOPE_SELF } from "@/lib/rbac/permissions";

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
  const match = /^SACS-(\d+)$/i.exec(String(employeeId || "").trim());
  if (!match) return null;
  return Number(match[1]);
}

function buildEmployeeId(currentCount = 0) {
  const next = currentCount + 1;
  return `SACS-${String(next).padStart(3, "0")}`;
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
    branch_id: profile?.branch_id || metadata.branch_id || null,
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
    .sort((a, b) => {
      const idA = parseEmployeeIdNumber(a.employee_id) ?? Number.MAX_SAFE_INTEGER;
      const idB = parseEmployeeIdNumber(b.employee_id) ?? Number.MAX_SAFE_INTEGER;
      if (idA !== idB) return idA - idB;
      return a.full_name.localeCompare(b.full_name);
    });
}

function formatMonthYearLabel(date) {
  return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(date);
}

async function buildRecentActivity(supabase, activeEmployees, guard) {
  const employeeById = new Map(activeEmployees.map((employee) => [employee.id, employee]));

  try {
    let query = supabase
      .from("payroll_records")
      .select("id, employee_id, employee_name, employee_type, net_pay, period_label, processed_at, payslip_no, branch_id")
      .order("processed_at", { ascending: false })
      .limit(guard.branchExempt ? 5 : 50);

    if (!guard.branchExempt) {
      query = query.eq("branch_id", guard.branchId);
    }

    const { data: rawData, error } = await query;
    const data = guard.branchExempt ? rawData : (rawData || []).slice(0, 5);

    if (!error && Array.isArray(data) && data.length) {
      return data.map((record) => {
        const employee = employeeById.get(record.employee_id);
        return {
          id: record.id,
          name: record.employee_name || employee?.full_name || "Unknown",
          employee_type: record.employee_type || employee?.employee_type || "",
          amount: Number(record.net_pay || 0),
          period: record.period_label || "",
          status: "paid",
          sub_text: record.payslip_no
            ? `${record.period_label || ""} · ${record.payslip_no}`
            : record.period_label || "",
        };
      });
    }
  } catch {
    // payroll_records table may not exist yet — fall through to unpaid state
  }

  const monthLabel = formatMonthYearLabel(new Date());
  return activeEmployees.slice(0, 5).map((employee) => ({
    id: employee.id,
    name: employee.full_name,
    employee_type: employee.employee_type,
    amount: Number(employee.basic_salary || 0),
    period: monthLabel,
    status: "not_paid",
    sub_text: `${monthLabel} · No payroll processed yet`,
  }));
}

function buildDashboardPayload(activeEmployees, attendancePanels, recentActivity) {
  const totalEmployees = activeEmployees.length;
  const totalPayrollMonth = activeEmployees.reduce(
    (sum, employee) => sum + Number(employee.basic_salary || 0),
    0,
  );

  const teachingCount = activeEmployees.filter((e) => e.employee_type === "Teaching").length;
  const nonTeachingCount = activeEmployees.filter((e) => e.employee_type === "Non-Teaching").length;

  return {
    generated_at: new Date().toISOString(),
    panels: {
      total_employees: totalEmployees,
      total_payroll_month: totalPayrollMonth,
      absent_today: Number(attendancePanels.absent_today || 0),
      present_today: Number(attendancePanels.present_today || 0),
      late_today: Number(attendancePanels.late_today || 0),
      teaching_count: teachingCount,
      non_teaching_count: nonTeachingCount,
    },
    recent_activity: recentActivity,
  };
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "dashboard", "read");
    if (guard.denied) return guard.denied;

    // This endpoint returns company/branch-wide aggregates (headcount,
    // total payroll, pending approvals, attendance and payroll activity
    // across every employee) — not a single person's own records. A
    // SCOPE_SELF caller (Employee) has "dashboard read" for their own
    // employee-portal stats endpoint (/api/employee/stats), but that grant
    // does not extend to this admin-facing aggregate view.
    if (guard.scope === SCOPE_SELF) {
      return NextResponse.json({ error: "You do not have permission to perform this action." }, { status: 403 });
    }

    const supabase = getAdminClient();
    const employees = await fetchEmployees(supabase);
    const branchEmployees = guard.branchExempt
      ? employees
      : employees.filter((employee) => String(employee.branch_id || "") === String(guard.branchId || ""));
    const activeEmployees = branchEmployees.filter((employee) => !employee.archived);

    // These two don't depend on each other's result — running them
    // sequentially was pure added latency on every dashboard load. Recent
    // activity's own query used to be the slowest part once payroll_records
    // grew (see 20260915010000_payroll_records_processed_at_idx.sql), so it's
    // worth overlapping with the rest rather than tacking it on after.
    const [attendancePanels, recentActivity] = await Promise.all([
      getAttendancePanels(supabase, activeEmployees),
      buildRecentActivity(supabase, activeEmployees, guard),
    ]);
    const payload = buildDashboardPayload(activeEmployees, attendancePanels, recentActivity);

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
