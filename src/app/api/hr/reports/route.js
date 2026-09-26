import { listUsersCached } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { collapseDailyTaps } from "@/lib/attendance/taps";
import { attendanceBucket } from "@/lib/attendance/status";
import { requirePermission } from "@/lib/rbac/guard";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "hr_reports", "read");
    if (guard.denied) return guard.denied;

    const supabase = getAdminClient();
    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "attendance";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to") || getDateKey();

    // Branch names so both reports can be grouped per branch.
    const { data: branchRows } = await supabase.from("branches").select("id,name");
    const branchNames = new Map((branchRows || []).map((b) => [String(b.id), b.name]));
    const branchName = (id) => (id ? branchNames.get(String(id)) || "Unknown branch" : "Unassigned");

    if (type === "attendance") {
      let query = supabase
        .from("attendance_logs")
        .select("employee_id, employee_name, employee_type, branch_id, log_date, time_in, time_out, status, total_hours")
        .order("log_date", { ascending: false })
        .limit(1000);

      if (!guard.branchExempt) query = query.eq("branch_id", guard.branchId);
      if (from) query = query.gte("log_date", from);
      if (to) query = query.lte("log_date", to);

      const { data, error } = await query;
      if (error) throw new Error(error.message);

      // One record per employee per day (first tap in, last tap out), so a
      // repeated tap never counts as an extra day or extra hours.
      const logs = collapseDailyTaps(data || []);

      // Aggregate per employee
      const byEmployee = new Map();
      logs.forEach((row) => {
        const key = row.employee_id;
        if (!byEmployee.has(key)) {
          byEmployee.set(key, {
            employee_id: row.employee_id,
            employee_name: normalizeText(row.employee_name, "Unknown"),
            employee_type: normalizeText(row.employee_type, "Teaching"),
            // Logs are newest first, so this is the employee's latest branch.
            branch_id: row.branch_id || null,
            branch_name: branchName(row.branch_id),
            present: 0,
            late: 0,
            absent: 0,
            total_hours: 0,
          });
        }
        const rec = byEmployee.get(key);
        const s = attendanceBucket(row.status);
        if (s === "present") rec.present++;
        else if (s === "late") { rec.present++; rec.late++; }
        else if (s === "absent") rec.absent++;
        rec.total_hours += Number(row.total_hours || 0);
      });

      return NextResponse.json({
        type: "attendance",
        records: Array.from(byEmployee.values()),
        total_logs: logs.length,
        date_range: { from: from || null, to },
        generated_at: new Date().toISOString(),
      });
    }

    if (type === "employees") {
      const usersResult = await listUsersCached(supabase);
      if (usersResult.error) throw new Error(usersResult.error.message);

      const branchMap = new Map();
      const candidateIds = (usersResult.data.users || []).map((u) => u.id);
      if (candidateIds.length) {
        const { data: profileRows } = await supabase
          .from("profiles")
          .select("id,branch_id")
          .in("id", candidateIds);
        (profileRows || []).forEach((row) => branchMap.set(row.id, row.branch_id));
      }

      const employees = (usersResult.data.users || [])
        .filter((u) => {
          const role = String(u.user_metadata?.role || "employee").toLowerCase();
          if (role !== "employee" && role !== "accountant") return false;
          if (guard.branchExempt) return true;
          const branchId = branchMap.get(u.id) || u.user_metadata?.branch_id || "";
          return String(branchId) === String(guard.branchId || "");
        })
        .map((u) => {
          const meta = u.user_metadata || {};
          const branchId = branchMap.get(u.id) || meta.branch_id || null;
          return {
            employee_id: normalizeText(meta.employee_id),
            full_name: normalizeText(meta.full_name, u.email),
            email: normalizeText(u.email),
            role: normalizeText(meta.role, "employee"),
            employee_type: normalizeText(meta.employee_type, "Teaching"),
            position: normalizeText(meta.position, "Employee"),
            employee_status: normalizeText(meta.employee_status, "Active"),
            archived: Boolean(meta.archived),
            branch_id: branchId,
            branch_name: branchName(branchId),
            created_at: u.created_at,
          };
        });

      return NextResponse.json({
        type: "employees",
        records: employees,
        total: employees.length,
        active: employees.filter((e) => !e.archived).length,
        archived: employees.filter((e) => e.archived).length,
        generated_at: new Date().toISOString(),
      });
    }

    return NextResponse.json({ error: "type must be attendance or employees." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
