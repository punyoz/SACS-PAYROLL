import { listUsersCached, invalidateUsersCache, getTrustedUserById } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog, listAuditLogs } from "@/lib/audit/store";
import { requirePermission, denyForeignBranch, scopeListToBranch } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

async function fetchSystemStats(supabase) {
  const usersResult = await listUsersCached(supabase);
  const users = usersResult.error ? [] : (usersResult.data.users || []);

  const roleCounts = { admin: 0, hr: 0, accountant: 0, employee: 0 };
  let rfidRegistered = 0;

  users.forEach((user) => {
    const metadata = user.user_metadata || {};
    const role = String(metadata.role || "employee").toLowerCase();
    if (role in roleCounts) roleCounts[role]++;
    else roleCounts.employee++;
    if (normalizeText(metadata.rfid_uid)) rfidRegistered++;
  });

  return {
    total_users: users.length,
    role_counts: roleCounts,
    rfid_registered: rfidRegistered,
    rfid_unregistered: users.filter((u) => {
      const role = String(u.user_metadata?.role || "employee").toLowerCase();
      return (role === "employee" || role === "accountant") && !normalizeText(u.user_metadata?.rfid_uid);
    }).length,
  };
}

async function fetchRfidDevices(supabase) {
  const usersResult = await listUsersCached(supabase);
  if (usersResult.error) {
    throw new Error(`Failed to list users: ${usersResult.error.message}`);
  }

  const employeeUsers = (usersResult.data.users || []).filter((user) => {
    const role = String(user.user_metadata?.role || "employee").toLowerCase();
    return role === "employee" || role === "accountant";
  });

  const userIds = employeeUsers.map((u) => u.id);
  const profileMap = new Map();

  if (userIds.length) {
    const profileResult = await supabase
      .from("profiles")
      .select("id,email,full_name,branch_id")
      .in("id", userIds);
    if (!profileResult.error) {
      (profileResult.data || []).forEach((p) => profileMap.set(p.id, p));
    }
  }

  return employeeUsers.map((user) => {
    const metadata = user.user_metadata || {};
    const profile = profileMap.get(user.id);
    return {
      id: user.id,
      full_name: normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email)),
      employee_id: normalizeText(metadata.employee_id, ""),
      employee_type: normalizeText(metadata.employee_type, "Teaching"),
      rfid_uid: normalizeText(metadata.rfid_uid, ""),
      archived: Boolean(metadata.archived),
      // profiles.branch_id is authoritative; metadata is the pre-migration fallback.
      branch_id: profile?.branch_id || metadata.branch_id || null,
    };
  }).sort((a, b) => a.full_name.localeCompare(b.full_name));
}

async function checkTableExists(supabase, tableName) {
  const result = await supabase.from(tableName).select("id").limit(1);
  return !result.error;
}

export async function GET(request) {
  const guard = await requirePermission(request, "system_maintenance", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const [systemStats, allRfidDevices] = await Promise.all([
      fetchSystemStats(supabase),
      fetchRfidDevices(supabase),
    ]);

    // Super Admin registers cards for every branch; an Admin only for the
    // staff of its own branch.
    const rfidDevices = scopeListToBranch(allRfidDevices, guard, (d) => d.branch_id);

    const [attendanceOk, payrollOk, branchesOk, configOk, auditResult] = await Promise.all([
      checkTableExists(supabase, "attendance_logs"),
      checkTableExists(supabase, "payroll_records"),
      checkTableExists(supabase, "branches"),
      checkTableExists(supabase, "system_config"),
      listAuditLogs({ module: "all", action: "all", search: "", limit: 10 }),
    ]);

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      system_stats: systemStats,
      database_status: {
        connection: "ok",
        attendance_logs: attendanceOk ? "ok" : "missing",
        payroll_records: payrollOk ? "ok" : "missing",
        profiles: "ok",
        branches: branchesOk ? "ok" : "missing",
        system_config: configOk ? "ok" : "missing",
      },
      rfid_devices: rfidDevices,
      recent_security_events: auditResult.logs || [],
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  const guard = await requirePermission(request, "system_maintenance", "update");
  if (guard.denied) return guard.denied;
  // Cards are card records now (rfid_cards, 20261021030000): registered,
  // replaced and deactivated with a history, through /api/rfid/cards. The
  // database refuses a direct change of profiles.rfid_uid.
  return NextResponse.json({
    error: "RFID cards are managed in RFID Cards now (register, replace, deactivate).",
    code: "use_rfid_cards",
  }, { status: 410 });
}
