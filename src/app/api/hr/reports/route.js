import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeText } from "@/lib/auth/normalize";

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
    const supabase = getAdminClient();
    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "attendance";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to") || getDateKey();

    if (type === "attendance") {
      let query = supabase
        .from("attendance_logs")
        .select("employee_id, employee_name, employee_type, date, time_in, time_out, status, hours_worked")
        .order("date", { ascending: false })
        .limit(1000);

      if (from) query = query.gte("date", from);
      if (to) query = query.lte("date", to);

      const { data, error } = await query;
      if (error) throw new Error(error.message);

      const logs = data || [];

      // Aggregate per employee
      const byEmployee = new Map();
      logs.forEach((row) => {
        const key = row.employee_id;
        if (!byEmployee.has(key)) {
          byEmployee.set(key, {
            employee_id: row.employee_id,
            employee_name: normalizeText(row.employee_name, "Unknown"),
            employee_type: normalizeText(row.employee_type, "Teaching"),
            present: 0,
            late: 0,
            absent: 0,
            total_hours: 0,
          });
        }
        const rec = byEmployee.get(key);
        const s = String(row.status || "").toLowerCase();
        if (s === "present") rec.present++;
        else if (s === "late") { rec.present++; rec.late++; }
        else if (s === "absent") rec.absent++;
        rec.total_hours += Number(row.hours_worked || 0);
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
      const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (usersResult.error) throw new Error(usersResult.error.message);

      const employees = (usersResult.data.users || [])
        .filter((u) => {
          const role = String(u.user_metadata?.role || "employee").toLowerCase();
          return role === "employee" || role === "accountant";
        })
        .map((u) => {
          const meta = u.user_metadata || {};
          return {
            employee_id: normalizeText(meta.employee_id),
            full_name: normalizeText(meta.full_name, u.email),
            email: normalizeText(u.email),
            role: normalizeText(meta.role, "employee"),
            employee_type: normalizeText(meta.employee_type, "Teaching"),
            position: normalizeText(meta.position, "Employee"),
            employee_status: normalizeText(meta.employee_status, "Active"),
            archived: Boolean(meta.archived),
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
