import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";

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

function getDateLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "2-digit",
    year: "numeric",
  }).format(date);
}

export async function GET(request) {
  try {
    const supabase = getAdminClient();
    const url = new URL(request.url);
    const dateParam = url.searchParams.get("date") || getDateKey();
    const viewAll = url.searchParams.get("view") === "all";

    let logs = [];

    if (viewAll) {
      const { data, error } = await supabase
        .from("attendance_logs")
        .select("*")
        .order("date", { ascending: false })
        .order("time_in", { ascending: false })
        .limit(500);
      if (!error) logs = data || [];
    } else {
      const { data, error } = await supabase
        .from("attendance_logs")
        .select("*")
        .eq("date", dateParam)
        .order("time_in", { ascending: true });
      if (!error) logs = data || [];
    }

    // Summary counts
    const present = logs.filter((r) => String(r.status || "").toLowerCase() === "present").length;
    const late = logs.filter((r) => String(r.status || "").toLowerCase() === "late").length;
    const absent = logs.filter((r) => String(r.status || "").toLowerCase() === "absent").length;

    return NextResponse.json({
      logs,
      summary: { present, late, absent },
      date: dateParam,
      date_label: getDateLabel(new Date(dateParam + "T00:00:00")),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
