/**
 * GET /api/admin/branch-reports
 *
 * The Branch Reports module the permission matrix flags as missing for Admin:
 * a view-only summary of attendance, headcount and payroll status for the
 * caller's own branch.
 *
 * Read-only by construction — there is no POST/PATCH/DELETE here. Payroll
 * figures stay editable by the Accountant alone; this route only reports what
 * already exists. Super Admin, being branch-exempt, gets the same summary
 * across every branch.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { listUsersCached } from "@/lib/auth/users-cache";
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

function todayKeyManila() {
  // Attendance is recorded against the school's local day, not UTC.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function GET(request) {
  const guard = await requirePermission(request, "branch_reports", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const branchId = guard.branchId;

    // ── Branch identity ──
    let branchLabel = "All branches";
    if (branchId) {
      const branchResult = await supabase
        .from("branches")
        .select("name,location,status")
        .eq("id", branchId)
        .maybeSingle();
      branchLabel = normalizeText(branchResult.data?.name, "Your branch");
    }

    // ── Headcount ──
    // profiles.branch_id is the source of truth for who belongs where.
    let profileQuery = supabase
      .from("profiles")
      .select("id,role,employee_status,archived,branch_id");
    if (branchId) profileQuery = profileQuery.eq("branch_id", branchId);

    const profileResult = await profileQuery;
    if (profileResult.error) {
      throw new Error(`Failed to fetch profiles: ${profileResult.error.message}`);
    }

    const profiles = profileResult.data || [];
    const activeProfiles = profiles.filter((p) => !p.archived);

    const headcount = {
      total: activeProfiles.length,
      archived: profiles.length - activeProfiles.length,
      by_role: activeProfiles.reduce((acc, p) => {
        const role = String(p.role || "employee").toLowerCase();
        acc[role] = (acc[role] || 0) + 1;
        return acc;
      }, {}),
    };

    // ── Attendance today ──
    const dateKey = todayKeyManila();
    let attendanceQuery = supabase
      .from("attendance_logs")
      .select("id,status,employee_id,branch_id,log_date")
      .eq("log_date", dateKey);
    if (branchId) attendanceQuery = attendanceQuery.eq("branch_id", branchId);

    const attendanceResult = await attendanceQuery;
    const attendanceRows = attendanceResult.error ? [] : (attendanceResult.data || []);

    const countStatus = (name) =>
      attendanceRows.filter(
        (r) => String(r.status || "").toLowerCase() === name,
      ).length;

    const present = countStatus("present");
    const late = countStatus("late");
    const attendance = {
      date: dateKey,
      present,
      late,
      // Anyone on the active roster with no log for today is absent.
      absent: Math.max(0, headcount.total - present - late),
      logged: attendanceRows.length,
    };

    // ── Payroll status (read-only) ──
    let payrollQuery = supabase
      .from("payroll_records")
      .select("id,net_pay,gross_pay,period_label,processed_at,branch_id")
      .order("processed_at", { ascending: false })
      .limit(500);
    if (branchId) payrollQuery = payrollQuery.eq("branch_id", branchId);

    const payrollResult = await payrollQuery;
    const payrollRows = payrollResult.error ? [] : (payrollResult.data || []);
    const latestPeriod = normalizeText(payrollRows[0]?.period_label, "");

    const periodRows = latestPeriod
      ? payrollRows.filter((r) => normalizeText(r.period_label) === latestPeriod)
      : [];

    let pendingQuery = supabase
      .from("payroll_entries")
      .select("id,status,branch_id")
      .limit(500);
    if (branchId) pendingQuery = pendingQuery.eq("branch_id", branchId);

    const pendingResult = await pendingQuery;
    const pendingRows = pendingResult.error ? [] : (pendingResult.data || []);

    const payroll = {
      latest_period: latestPeriod || null,
      processed_this_period: periodRows.length,
      total_net_pay_this_period: periodRows.reduce(
        (sum, r) => sum + Number(r.net_pay || 0),
        0,
      ),
      pending_entries: pendingRows.filter(
        (r) => String(r.status || "draft").toLowerCase() !== "posted",
      ).length,
      // Whoever still has no record in the latest period.
      awaiting_processing: Math.max(0, headcount.total - periodRows.length),
    };

    // Unassigned staff are a branch-manager concern, so surface the count.
    const usersResult = await listUsersCached(supabase);
    const unassigned = usersResult.error
      ? 0
      : (usersResult.data.users || []).filter((u) => {
          const meta = u.user_metadata || {};
          return !meta.archived && !meta.branch_id;
        }).length;

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      branch: { id: branchId, label: branchLabel, all_branches: guard.branchExempt },
      headcount,
      attendance,
      payroll,
      unassigned_staff: unassigned,
      // Stated explicitly so the UI never renders an edit affordance here.
      read_only: true,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
