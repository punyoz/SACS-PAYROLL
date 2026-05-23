import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function calcHours(timeIn, timeOut) {
  if (!timeIn || !timeOut) return 0;
  try {
    const diff = (new Date(timeOut) - new Date(timeIn)) / 3600000;
    return diff > 0 && diff < 24 ? Math.round(diff * 100) / 100 : 0;
  } catch {
    return 0;
  }
}

function formatTime(isoString) {
  if (!isoString) return null;
  try {
    return new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
      .format(new Date(isoString))
      .toUpperCase();
  } catch {
    return null;
  }
}

function getMonthRange(monthParam) {
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [year, mon] = monthParam.split("-").map(Number);
    const monthStart = `${year}-${String(mon).padStart(2, "0")}-01`;
    const nextYear = mon === 12 ? year + 1 : year;
    const nextMon = mon === 12 ? 1 : mon + 1;
    const monthEnd = `${nextYear}-${String(nextMon).padStart(2, "0")}-01`;
    const monthLabel = new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      month: "long",
      year: "numeric",
    }).format(new Date(`${monthStart}T00:00:00+08:00`));
    return { monthStart, monthEnd, monthLabel };
  }

  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, mon] = dateStr.split("-").map(Number);
  const monthStart = `${year}-${String(mon).padStart(2, "0")}-01`;
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const monthEnd = `${nextYear}-${String(nextMon).padStart(2, "0")}-01`;
  const monthLabel = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "long",
    year: "numeric",
  }).format(now);
  return { monthStart, monthEnd, monthLabel };
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
    const month = String(url.searchParams.get("month") || "").trim();

    if (!email) {
      return NextResponse.json({ error: "email is required." }, { status: 400 });
    }

    const { monthStart, monthEnd, monthLabel } = getMonthRange(month);
    const supabase = getAdminClient();

    const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersResult.error) throw new Error(`Failed to list users: ${usersResult.error.message}`);

    const user = (usersResult.data.users || []).find(
      (u) => String(u.email || "").trim().toLowerCase() === email,
    );

    const empty = {
      records: [],
      month_label: monthLabel,
      totals: { days: 0, hours: 0, overtime: 0, avg: 0 },
    };
    if (!user) return NextResponse.json(empty);

    const attResult = await supabase
      .from("attendance_logs")
      .select("status, log_date, time_in, time_out")
      .eq("employee_id", user.id)
      .gte("log_date", monthStart)
      .lt("log_date", monthEnd)
      .order("log_date", { ascending: true });

    if (attResult.error) return NextResponse.json(empty);

    let totalDays = 0;
    let totalHours = 0;
    let totalOvertime = 0;

    const records = (attResult.data || []).map((row) => {
      const hours = calcHours(row.time_in, row.time_out);
      const overtime = Math.max(0, hours - 8);
      const status = String(row.status || "").toLowerCase();

      if (status === "present" || status === "late") {
        totalDays++;
        totalHours += hours;
        totalOvertime += overtime;
      }

      let dayName = "";
      try {
        dayName = new Intl.DateTimeFormat("en-PH", {
          timeZone: "Asia/Manila",
          weekday: "short",
        }).format(new Date(`${row.log_date}T00:00:00+08:00`));
      } catch {
        dayName = "";
      }

      return {
        date: row.log_date,
        day: dayName,
        time_in: formatTime(row.time_in),
        time_out: formatTime(row.time_out),
        hours: hours ? Math.round(hours * 100) / 100 : 0,
        overtime: overtime ? Math.round(overtime * 100) / 100 : 0,
        status: row.status || "Absent",
      };
    });

    const avg = totalDays > 0 ? Math.round((totalHours / totalDays) * 100) / 100 : 0;

    return NextResponse.json({
      records,
      month_label: monthLabel,
      totals: {
        days: totalDays,
        hours: Math.round(totalHours * 100) / 100,
        overtime: Math.round(totalOvertime * 100) / 100,
        avg,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
