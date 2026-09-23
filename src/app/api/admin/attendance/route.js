import { listUsersCached } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission, denyForeignBranch } from "@/lib/rbac/guard";
import { collapseDailyTaps, hoursBetween, planTap } from "@/lib/attendance/taps";

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

export function getDateKey(date = new Date()) {
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

function buildEmployeeId(currentCount = 0) {
  const next = currentCount + 1;
  return `SACS-${String(next).padStart(3, "0")}`;
}

function parseEmployeeIdNumber(employeeId) {
  const match = /^SACS-(\d+)$/i.exec(String(employeeId || "").trim());
  if (!match) return null;
  return Number(match[1]);
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function calculateHours(timeInIso, timeOutIso) {
  const timeIn = new Date(timeInIso);
  const timeOut = new Date(timeOutIso);

  if (Number.isNaN(timeIn.getTime()) || Number.isNaN(timeOut.getTime())) {
    return 0;
  }

  const diffMs = timeOut.getTime() - timeIn.getTime();
  if (diffMs <= 0) return 0;
  return Math.round((diffMs / 3600000) * 100) / 100;
}

function normalizeAttendanceStatus(value, fallback = "Absent") {
  const status = normalizeText(value, fallback).toLowerCase();
  if (status === "late") return "Late";
  if (status === "present") return "Present";
  return "Absent";
}

function shapeEmployee(user, profile, index) {
  const metadata = user.user_metadata || {};

  return {
    id: user.id,
    email: normalizeText(profile?.email, user.email),
    full_name: normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email)),
    employee_id: normalizeText(metadata.employee_id, buildEmployeeId(index)),
    employee_type: normalizeText(metadata.employee_type, "Teaching"),
    rfid_uid: normalizeText(metadata.rfid_uid),
    archived: Boolean(metadata.archived),
    branch_id: profile?.branch_id || metadata.branch_id || null,
  };
}

export async function fetchEmployees(supabase) {
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
    .filter((employee) => !employee.archived)
    .sort((a, b) => {
      const idA = parseEmployeeIdNumber(a.employee_id) ?? Number.MAX_SAFE_INTEGER;
      const idB = parseEmployeeIdNumber(b.employee_id) ?? Number.MAX_SAFE_INTEGER;
      if (idA !== idB) return idA - idB;
      return a.full_name.localeCompare(b.full_name);
    });
}

function mapAttendanceRow(row) {
  const status = normalizeAttendanceStatus(
    row.status
      ?? row.attendance_status
      ?? (row.time_in || row.check_in ? "Present" : "Absent"),
    "Absent",
  );

  const timeIn = toIso(row.time_in ?? row.check_in ?? row.timeIn);
  const timeOut = toIso(row.time_out ?? row.check_out ?? row.timeOut);
  const totalHours = Number(
    row.total_hours
      ?? row.hours_worked
      ?? calculateHours(timeIn, timeOut),
  );

  return {
    id: String(row.id || row.log_id || row.employee_id || "record"),
    employee_id: normalizeText(row.employee_id || row.user_id || row.profile_id),
    employee_name: normalizeText(row.employee_name),
    employee_type: normalizeText(row.employee_type),
    time_in: timeIn,
    time_out: timeOut,
    total_hours: totalHours,
    status,
    log_date: normalizeText(row.log_date || row.attendance_date || row.date),
    created_at: toIso(row.created_at),
  };
}

async function fetchAttendanceRows(supabase, activeEmployees, dateKey) {
  // Both callers of this function only ever ask for a single day (today) —
  // filtering by log_date in the query itself (instead of fetching up to
  // 3000 rows across every date ever logged and discarding everything that
  // isn't today in JS) is what actually made the dashboard slow, since this
  // runs on every dashboard load.
  const result = await supabase
    .from("attendance_logs")
    .select("*")
    .eq("log_date", dateKey)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (result.error) {
    throw new Error(`Failed to fetch attendance logs: ${result.error.message}`);
  }

  const mapped = (result.data || [])
    .map(mapAttendanceRow)
    .filter((row) => {
      // Defensive: log_date has a NOT NULL DEFAULT CURRENT_DATE, so every row
      // should already match via the query above — this only catches a row
      // whose log_date was somehow written wrong, by falling back to the
      // date implied by time_in/created_at instead.
      const rowDate = row.log_date || getDateKey(row.time_in || row.created_at || new Date());
      return rowDate === dateKey;
    });

  // First tap of the day = time in, last tap = time out, however many rows
  // the day ended up with (see src/lib/attendance/taps.js).
  const byEmployee = new Map();
  collapseDailyTaps(mapped, { dateKey: () => dateKey }).forEach((row) => {
    if (row.employee_id) byEmployee.set(row.employee_id, row);
  });

  activeEmployees.forEach((employee) => {
    if (byEmployee.has(employee.id)) return;
    byEmployee.set(employee.id, {
      id: `absent-${dateKey}-${employee.id}`,
      employee_id: employee.id,
      employee_name: employee.full_name,
      employee_type: employee.employee_type,
      time_in: null,
      time_out: null,
      total_hours: 0,
      status: "Absent",
      log_date: dateKey,
      created_at: null,
    });
  });

  return {
    source_mode: "table",
    can_persist: true,
    rows: Array.from(byEmployee.values()),
  };
}

function buildAttendancePayload(rows, dateKey, canPersist, sourceMode) {
  const normalizedRows = rows.map((row) => ({
    ...row,
    status: normalizeAttendanceStatus(row.status),
  }));

  const panels = {
    present_today: normalizedRows.filter((row) => row.status === "Present").length,
    late_today: normalizedRows.filter((row) => row.status === "Late").length,
    absent_today: normalizedRows.filter((row) => row.status === "Absent").length,
  };

  const attendance_logs = normalizedRows.sort((a, b) => a.employee_name.localeCompare(b.employee_name));

  return {
    generated_at: new Date().toISOString(),
    date_key: dateKey,
    date_label: getDateLabel(new Date()),
    source_mode: sourceMode,
    can_persist: canPersist,
    panels,
    attendance_logs,
  };
}

export async function getAttendancePanels(supabase, activeEmployees) {
  const dateKey = getDateKey(new Date());
  const attendanceData = await fetchAttendanceRows(supabase, activeEmployees, dateKey);
  const payload = buildAttendancePayload(
    attendanceData.rows,
    dateKey,
    attendanceData.can_persist,
    attendanceData.source_mode,
  );

  return payload.panels;
}

export function resolveEmployeeByRfid(code, activeEmployees) {
  const normalized = normalizeText(code).toLowerCase();
  if (!normalized) return null;

  return activeEmployees.find((employee) => {
    const employeeId = normalizeText(employee.employee_id).toLowerCase();
    const rfidUid = normalizeText(employee.rfid_uid).toLowerCase();
    return normalized === employeeId || normalized === rfidUid;
  }) || null;
}

function isLateInManila(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

  const [hourText, minuteText] = formatter.format(now).split(":");
  const hour = Number(hourText || 0);
  const minute = Number(minuteText || 0);

  if (hour > 8) return true;
  if (hour === 8 && minute > 0) return true;
  return false;
}

/**
 * Record one RFID tap. Only the first and last tap of the day count: the first
 * creates the day's row (Time In), every later tap moves that same row's Time
 * Out, and a repeat tap within a minute of the previous one is ignored.
 *
 * @returns {{ record: object, tap: "time_in" | "time_out" | "duplicate" }}
 */
function isDuplicateKeyError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return code === "23505" || message.includes("duplicate key");
}

export async function persistScanToTable(supabase, employee, dateKey, nowIso, rfidCode, retriesLeft = 1) {
  const lookupResult = await supabase
    .from("attendance_logs")
    .select("*")
    .eq("employee_id", employee.id)
    .eq("log_date", dateKey)
    // Rows folded into another row and flagged by
    // 20260917_attendance_logs_unique_employee_day.sql carry no tap data of
    // their own anymore — only the active row for this employee+day matters.
    .eq("archived_duplicate", false)
    .order("created_at", { ascending: true })
    .limit(50);

  if (lookupResult.error) {
    throw new Error(lookupResult.error.message);
  }

  const plan = planTap(lookupResult.data || [], nowIso);

  if (plan.action === "duplicate") {
    return { record: mapAttendanceRow(plan.record), tap: "duplicate" };
  }

  if (plan.action === "time_out") {
    const updateResult = await supabase
      .from("attendance_logs")
      .update({
        // Normalise the row to the day's first tap too, in case an older
        // version split this day across several rows.
        time_in: plan.time_in,
        time_out: nowIso,
        total_hours: hoursBetween(plan.time_in, nowIso),
      })
      .eq("id", plan.target.id)
      .select("*")
      .maybeSingle();

    if (updateResult.error || !updateResult.data) {
      throw new Error(updateResult.error?.message || "Failed to update attendance time out.");
    }

    return { record: mapAttendanceRow(updateResult.data), tap: "time_out" };
  }

  const insertPayload = {
    employee_id: employee.id,
    employee_name: employee.full_name,
    employee_type: employee.employee_type,
    rfid_code: normalizeText(rfidCode),
    time_in: nowIso,
    time_out: null,
    total_hours: 0,
    status: isLateInManila(new Date(nowIso)) ? "Late" : "Present",
    log_date: dateKey,
  };

  const insertResult = await supabase
    .from("attendance_logs")
    .insert(insertPayload)
    .select("*")
    .maybeSingle();

  if (insertResult.error || !insertResult.data) {
    // Two concurrent first-taps for the same employee+day can both reach here
    // having seen zero existing rows (the lookup above ran before either had
    // written). attendance_logs_employee_day_unique (see
    // 20260917_attendance_logs_unique_employee_day.sql) turns the loser's
    // insert into a 23505 instead of a second silent row — re-planning once
    // against the row the winner just committed resolves it as this tap's
    // rightful time_out (or duplicate) instead of failing the scan outright.
    if (isDuplicateKeyError(insertResult.error) && retriesLeft > 0) {
      return persistScanToTable(supabase, employee, dateKey, nowIso, rfidCode, retriesLeft - 1);
    }
    throw new Error(insertResult.error?.message || "Failed to create attendance login.");
  }

  return { record: mapAttendanceRow(insertResult.data), tap: "time_in" };
}

export async function GET(request) {
  const guard = await requirePermission(request, "attendance", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const allEmployees = await fetchEmployees(supabase);

    // Attendance is reported per employee, so scoping the employee list is
    // what scopes the attendance: a branch-scoped caller never sees a row for
    // someone outside their branch.
    const activeEmployees = guard.branchExempt
      ? allEmployees
      : allEmployees.filter((e) => String(e.branch_id || "") === String(guard.branchId || ""));
    const dateKey = getDateKey(new Date());
    const attendanceData = await fetchAttendanceRows(supabase, activeEmployees, dateKey);
    const payload = buildAttendancePayload(
      attendanceData.rows,
      dateKey,
      attendanceData.can_persist,
      attendanceData.source_mode,
    );

    await appendAuditLog({
      module: "attendance",
      action: "view",
      entity_type: "attendance_log",
      entity_id: payload.date_key,
      description: `Attendance monitoring viewed for ${payload.date_label}.`,
      status: "success",
      source: "api",
      metadata: {
        present_today: payload.panels.present_today,
        late_today: payload.panels.late_today,
        absent_today: payload.panels.absent_today,
      },
    });

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requirePermission(request, "attendance", "update");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json();
    const rfidCode = normalizeText(body.rfid_code || body.employee_id || body.employee_code);

    if (!rfidCode) {
      return NextResponse.json({ error: "rfid_code is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const activeEmployees = await fetchEmployees(supabase);
    const employee = resolveEmployeeByRfid(rfidCode, activeEmployees);

    if (!employee) {
      return NextResponse.json({ error: "RFID not matched to an active employee." }, { status: 404 });
    }

    // Correcting or recording a scan for someone in another branch is refused.
    const foreignBranch = denyForeignBranch(guard, employee.branch_id);
    if (foreignBranch) return foreignBranch;

    const nowIso = new Date().toISOString();
    const dateKey = getDateKey(new Date());

    const { record, tap } = await persistScanToTable(supabase, employee, dateKey, nowIso, rfidCode);

    if (tap !== "duplicate") {
      await appendAuditLog({
        module: "attendance",
        action: tap === "time_out" ? "rfid_timeout" : "rfid_timein",
        entity_type: "employee",
        entity_id: employee.employee_id,
        description: `RFID scan processed for ${employee.full_name}.`,
        status: "success",
        source: "api",
        metadata: {
          employee_id: employee.id,
          rfid_code: rfidCode,
          date_key: dateKey,
        },
      });
    }

    const messages = {
      time_in: "RFID time-in recorded.",
      time_out: "RFID time-out recorded. A later tap today will replace it.",
      duplicate: "Repeated tap ignored — only the first and last tap of the day are counted.",
    };

    return NextResponse.json({
      success: true,
      persisted: tap !== "duplicate",
      tap,
      message: messages[tap],
      record,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
