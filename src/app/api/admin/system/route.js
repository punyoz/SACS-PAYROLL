import { listUsersCached, invalidateUsersCache } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog, listAuditLogs } from "@/lib/audit/store";
import { requirePermission, denyForeignBranch, scopeListToBranch } from "@/lib/rbac/guard";

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

  try {
    const body = await request.json();
    const id = normalizeText(body.id);
    const rfidUid = normalizeText(body.rfid_uid);

    if (!id) {
      return NextResponse.json({ error: "Employee id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const userResult = await supabase.auth.admin.getUserById(id);
    if (userResult.error || !userResult.data?.user) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }

    const targetRole = String(userResult.data.user.user_metadata?.role || "employee").toLowerCase();
    if (targetRole !== "employee" && targetRole !== "accountant") {
      return NextResponse.json({ error: "RFID cards can only be assigned to employee accounts." }, { status: 400 });
    }

    const rfidDevices = await fetchRfidDevices(supabase);

    // An Admin may assign, replace or void cards only for its own branch's staff.
    if (!guard.branchExempt) {
      const target = rfidDevices.find((device) => device.id === id);
      if (!target?.branch_id) {
        return NextResponse.json({ error: "That employee is not assigned to your branch." }, { status: 403 });
      }
      const foreign = denyForeignBranch(guard, target.branch_id);
      if (foreign) return foreign;
    }

    if (rfidUid) {
      const conflict = rfidDevices.find(
        (device) => device.id !== id && !device.archived && device.rfid_uid.toLowerCase() === rfidUid.toLowerCase(),
      );
      if (conflict) {
        return NextResponse.json(
          { error: `This RFID card is already assigned to ${conflict.full_name}.` },
          { status: 409 },
        );
      }
    }

    const existingUser = userResult.data.user;
    const nextMetadata = {
      ...(existingUser.user_metadata || {}),
      rfid_uid: rfidUid,
    };

    const updatedResult = await supabase.auth.admin.updateUserById(id, {
      user_metadata: nextMetadata,
    });

    if (updatedResult.error) {
      return NextResponse.json({ error: sanitizeError(updatedResult.error) }, { status: 400 });
    }

    invalidateUsersCache();

    await appendAuditLog({
      module: "system",
      action: rfidUid ? "rfid_assign" : "rfid_remove",
      entity_type: "employee",
      entity_id: id,
      description: rfidUid
        ? `RFID UID assigned to employee by admin.`
        : `RFID UID removed from employee by admin.`,
      status: "success",
      source: "api",
      metadata: { employee_id: id, rfid_uid: rfidUid },
    });

    return NextResponse.json({ success: true, rfid_uid: rfidUid });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
