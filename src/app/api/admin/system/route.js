import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog, listAuditLogs } from "@/lib/audit/store";

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
  const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const users = usersResult.error ? [] : (usersResult.data.users || []);

  const roleCounts = { admin: 0, hr: 0, it: 0, accountant: 0, employee: 0 };
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
  const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
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
      .select("id,email,full_name")
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
    };
  }).sort((a, b) => a.full_name.localeCompare(b.full_name));
}

async function checkTableExists(supabase, tableName) {
  const result = await supabase.from(tableName).select("id").limit(1);
  return !result.error;
}

export async function GET() {
  try {
    const supabase = getAdminClient();
    const [systemStats, rfidDevices] = await Promise.all([
      fetchSystemStats(supabase),
      fetchRfidDevices(supabase),
    ]);

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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
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

    const existingUser = userResult.data.user;
    const nextMetadata = {
      ...(existingUser.user_metadata || {}),
      rfid_uid: rfidUid,
    };

    const updatedResult = await supabase.auth.admin.updateUserById(id, {
      user_metadata: nextMetadata,
    });

    if (updatedResult.error) {
      return NextResponse.json({ error: updatedResult.error.message }, { status: 400 });
    }

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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
