import { listUsersCached } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission, denyForeignBranch } from "@/lib/rbac/guard";
import { collapseDailyTaps, findRepeatedTap, hoursBetween, planTap } from "@/lib/attendance/taps";
import { maskCardCode, recordRawTap, recordRefusedTap, tapDevice } from "@/lib/attendance/raw-taps";
import { getBranchAttendancePolicy, isLateForPolicy } from "@/lib/attendance/policy";
import { attendanceBucket, normalizeAttendanceStatus as normalizeEngineStatus } from "@/lib/attendance/status";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { manilaDateKey as getDateKey } from "@/lib/payroll/periods";
import { LEAVE_TAP_MESSAGE, isEmployeeOnLeave, recordBlockedTap } from "@/lib/attendance/leave";
import { annotateAttendanceRows } from "@/lib/attendance/annotate";

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

// The database computes the status (On Time, Early Bird, Late, Undertime,
// Half Day, Absent, Incomplete, Pending Correction, Corrected -- see
// src/lib/attendance/status.js); this only canonicalises the spelling. A
// pre-engine "Present" reads as On Time.
function normalizeAttendanceStatus(value, fallback = "Absent") {
  return normalizeEngineStatus(value, normalizeEngineStatus(fallback, "Absent"));
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
    employee_status: normalizeText(profile?.employee_status, "Active"),
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
      .select("id,email,full_name,branch_id,employee_status")
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
    late_minutes: Number(row.late_minutes || 0),
    undertime_minutes: Number(row.undertime_minutes || 0),
    branch_id: row.branch_id || null,
  };
}

async function fetchAttendanceRows(supabase, activeEmployees, dateKey, branchScoped = false) {
  // Both callers of this function only ever ask for a single day (today) —
  // filtering by log_date in the query itself (instead of fetching up to
  // 3000 rows across every date ever logged and discarding everything that
  // isn't today in JS) is what actually made the dashboard slow, since this
  // runs on every dashboard load.
  const result = await supabase
    .from("attendance_logs")
    .select("*")
    .eq("log_date", dateKey)
    // Folded duplicates and released leave days are not the day's record.
    .eq("archived_duplicate", false)
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

  // Scope the rows to the people this caller may see.
  //
  // The query above deliberately has no branch filter, because a row's
  // branch_id records where the tap HAPPENED -- it is stamped at insert time
  // by the attendance_logs_stamp_branch trigger and never moves afterwards.
  // Filtering on it would hand an employee's history to whichever branch they
  // used to be in. activeEmployees is derived from profiles.branch_id, which
  // is current, so scoping by that set attributes every row to where the
  // employee is NOW -- consistent with how the rest of the app scopes.
  //
  // Only applied for a branch-scoped caller. A branch-exempt one (Super
  // Admin) is passed every employee anyway, and skipping the filter keeps a
  // row whose employee no longer resolves visible to them rather than
  // silently dropped.
  //
  // This is what was missing: activeEmployees was used ONLY to add the
  // "Absent" placeholders below, so every other branch's taps came straight
  // through. An Admin in a branch with no staff still saw every tap in the
  // school.
  const visibleIds = new Set(activeEmployees.map((employee) => String(employee.id)));
  const scoped = branchScoped
    ? mapped.filter((row) => visibleIds.has(String(row.employee_id || "")))
    : mapped;

  // First tap of the day = time in, last tap = time out, however many rows
  // the day ended up with (see src/lib/attendance/taps.js).
  const byEmployee = new Map();
  collapseDailyTaps(scoped, { dateKey: () => dateKey }).forEach((row) => {
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
      branch_id: employee.branch_id || null,
      not_yet_tapped: true,
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
    present_today: normalizedRows.filter((row) => attendanceBucket(row.status) === "present").length,
    late_today: normalizedRows.filter((row) => attendanceBucket(row.status) === "late").length,
    absent_today: normalizedRows.filter((row) => attendanceBucket(row.status) === "absent").length,
    incomplete_today: normalizedRows.filter((row) => attendanceBucket(row.status) === "unresolved").length,
    on_leave_today: normalizedRows.filter((row) => attendanceBucket(row.status) === "leave").length,
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

export async function getAttendancePanels(supabase, activeEmployees, branchScoped = false) {
  const dateKey = getDateKey(new Date());
  const attendanceData = await fetchAttendanceRows(supabase, activeEmployees, dateKey, branchScoped);
  const payload = buildAttendancePayload(
    attendanceData.rows,
    dateKey,
    attendanceData.can_persist,
    attendanceData.source_mode,
  );

  return payload.panels;
}

/**
 * The employee a scanned code belongs to.
 *
 * Only a registered RFID card matches by default. Employee IDs are sequential
 * (SACS-001, SACS-002, ...), so accepting them at the kiosk let anyone type a
 * colleague's ID and clock them in. `allowEmployeeId` is set only by the
 * manual-entry box an Admin / Super Admin uses in their own portal.
 */
function resolveEmployeeByRfid(code, activeEmployees, { allowEmployeeId = false } = {}) {
  const normalized = normalizeText(code).toLowerCase();
  if (!normalized) return null;

  return activeEmployees.find((employee) => {
    const employeeId = normalizeText(employee.employee_id).toLowerCase();
    const rfidUid = normalizeText(employee.rfid_uid).toLowerCase();
    return (rfidUid && normalized === rfidUid) || (allowEmployeeId && employeeId && normalized === employeeId);
  }) || null;
}

// With a policy, Late follows that branch's work start + grace period (see
// src/lib/attendance/policy.js). Without one, the original fixed 8:00 AM rule.
function isLateInManila(now = new Date(), policy = null) {
  if (policy) return isLateForPolicy(now, policy);

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

function isDuplicateKeyError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return code === "23505" || message.includes("duplicate key");
}

/**
 * Who a write came from, for attendance_logs_history
 * (20260927020000_attendance_logs_history.sql). A fresh change_token on every
 * write is what tells the database this update was annotated by the API.
 */
function changeAnnotation(actor, source) {
  return {
    changed_by: actor?.userId || null,
    change_source: source,
    change_token: crypto.randomUUID(),
  };
}

/** The day's raw taps (attendance_taps), [] when the table is not there yet. */
async function readDayTaps(supabase, employeeId, dateKey) {
  const result = await supabase
    .from("attendance_taps")
    .select("tapped_at")
    .eq("employee_id", employeeId)
    .eq("log_date", dateKey)
    .order("tapped_at", { ascending: true })
    .limit(1000);
  return result.error ? [] : (result.data || []).map((row) => row.tapped_at);
}

/**
 * Apply one RFID tap to the employee's day. Every tap counts (there is no
 * cooldown; the caller stores the raw tap first): the first tap of the day is
 * Time In, every later tap moves Time Out to the latest tap, on the day's one
 * attendance_logs row. The database's status engine recomputes hours, late,
 * undertime and status on each write. A day HR / Admin corrected keeps its
 * corrected times and is only flagged "New tap after correction".
 *
 * @returns {{ record: object, tap: "time_in" | "time_out" | "after_correction" }}
 */
async function persistScanToTable(supabase, employee, dateKey, nowIso, rfidCode, retriesLeft = 1, policy = null, actor = null, source = "rfid_tap") {
  const lookupResult = await supabase
    .from("attendance_logs")
    .select("*")
    .eq("employee_id", employee.id)
    .eq("log_date", dateKey)
    // Rows folded into another row and flagged by
    // 20260917010000_attendance_logs_unique_employee_day.sql carry no tap data of
    // their own anymore — only the active row for this employee+day matters.
    .eq("archived_duplicate", false)
    .order("created_at", { ascending: true })
    .limit(50);

  if (lookupResult.error) {
    throw new Error(lookupResult.error.message);
  }

  const rawTaps = await readDayTaps(supabase, employee.id, dateKey);
  const plan = planTap(lookupResult.data || [], nowIso, rawTaps);

  if (plan.action === "after_correction") {
    // The corrected times stay; the tap is already in attendance_taps and the
    // day is flagged for HR to review.
    const flagResult = await supabase
      .from("attendance_logs")
      .update({ tap_after_correction_at: nowIso, ...changeAnnotation(actor, source) })
      .eq("id", plan.target.id)
      .select("*")
      .maybeSingle();
    return { record: mapAttendanceRow(flagResult.data || plan.target), tap: "after_correction" };
  }

  // The nightly close (public.attendance_close_days) may already have written
  // an Absent row for this day, with no taps. The first real tap turns that
  // row into the Time In instead of colliding with it on the one-row-per-day
  // index; the database recomputes its status.
  // An On Leave row is never claimed: the caller refuses a tap on a leave
  // day before getting here.
  const placeholder = plan.action === "time_in"
    ? (lookupResult.data || []).find((row) => !row.time_in && !row.time_out && !row.leave_request_id)
    : null;
  if (placeholder) {
    const claimResult = await supabase
      .from("attendance_logs")
      .update({
        employee_name: employee.full_name,
        employee_type: employee.employee_type,
        rfid_code: normalizeText(rfidCode),
        time_in: nowIso,
        time_out: null,
        total_hours: 0,
        ...changeAnnotation(actor, source),
      })
      .eq("id", placeholder.id)
      .select("*")
      .maybeSingle();

    if (claimResult.error || !claimResult.data) {
      throw new Error(claimResult.error?.message || "Failed to record attendance time in.");
    }
    return { record: mapAttendanceRow(claimResult.data), tap: "time_in" };
  }

  if (plan.action === "time_out") {
    const updateResult = await supabase
      .from("attendance_logs")
      .update({
        // First tap of the day in, last tap out (also normalises a day an
        // older version split across several rows).
        time_in: plan.time_in,
        time_out: plan.time_out,
        total_hours: plan.time_out ? hoursBetween(plan.time_in, plan.time_out) : 0,
        ...changeAnnotation(actor, source),
      })
      .eq("id", plan.target.id)
      .select("*")
      .maybeSingle();

    if (updateResult.error || !updateResult.data) {
      throw new Error(updateResult.error?.message || "Failed to update attendance time out.");
    }

    return { record: mapAttendanceRow(updateResult.data), tap: plan.time_out ? "time_out" : "time_in" };
  }

  const insertPayload = {
    employee_id: employee.id,
    employee_name: employee.full_name,
    employee_type: employee.employee_type,
    rfid_code: normalizeText(rfidCode),
    time_in: nowIso,
    time_out: null,
    total_hours: 0,
    // Replaced by the database's status engine on insert; kept as a sensible
    // value for a database the engine migration has not reached yet.
    status: isLateInManila(new Date(nowIso), policy) ? "Late" : "On Time",
    log_date: dateKey,
    archived_duplicate: false,
  };

  const insertResult = await supabase
    .from("attendance_logs")
    .insert(insertPayload)
    .select("*")
    .maybeSingle();

  if (insertResult.error || !insertResult.data) {
    // Two taps at the same moment for the same employee+day can both reach
    // here having seen no row; attendance_logs_employee_day_unique turns the
    // loser's insert into a 23505, and re-planning once against the winner's
    // row records this tap as the Time Out instead of failing it.
    if (isDuplicateKeyError(insertResult.error) && retriesLeft > 0) {
      return persistScanToTable(supabase, employee, dateKey, nowIso, rfidCode, retriesLeft - 1, policy, actor, source);
    }
    throw new Error(insertResult.error?.message || "Failed to create attendance login.");
  }

  return { record: mapAttendanceRow(insertResult.data), tap: "time_in" };
}

/**
 * Taps the RFID terminal could not send when they happened (network down)
 * come back with the time they were tapped. Only the terminal's kiosk
 * session may send one, and only from the last OFFLINE_TAP_MAX_AGE_MS.
 */
const OFFLINE_TAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OFFLINE_TAP_MAX_SKEW_MS = 2 * 60 * 1000;

/** { at: Date } for a usable offline tap time, { error } for an unusable one, null when none was sent. */
function offlineTapTime(value, now = new Date()) {
  if (value === undefined || value === null || value === "") return null;
  const at = new Date(String(value));
  if (Number.isNaN(at.getTime())) return { error: "The saved tap has no valid time." };
  const age = now.getTime() - at.getTime();
  if (age > OFFLINE_TAP_MAX_AGE_MS) return { error: "The saved tap is more than a day old and was not recorded. Ask HR to correct the day." };
  if (age < -OFFLINE_TAP_MAX_SKEW_MS) return { error: "The saved tap's time is in the future." };
  return { at: age < 0 ? now : at };
}

/**
 * The tap already recorded that this one repeats (see findRepeatedTap in
 * src/lib/attendance/taps.js), with the day's row, or null.
 */
async function findRepeat(supabase, employeeId, dateKey, tapIso) {
  const rows = await supabase
    .from("attendance_logs")
    .select("*")
    .eq("employee_id", employeeId)
    .eq("log_date", dateKey)
    .eq("archived_duplicate", false)
    .order("created_at", { ascending: true })
    .limit(50);
  if (rows.error) return null;
  const rawTaps = await readDayTaps(supabase, employeeId, dateKey);
  const repeated = findRepeatedTap(rows.data || [], rawTaps, tapIso);
  if (!repeated) return null;
  const day = collapseDailyTaps(rows.data || [], { dateKey: () => dateKey })[0] || null;
  return { repeated, record: day ? mapAttendanceRow(day) : null };
}

/** Why an unmatched code was refused: an archived / inactive employee's card, or no one's. */
async function unmatchedCardReason(supabase, code) {
  const value = normalizeText(code);
  const result = await supabase
    .from("profiles")
    .select("id,full_name,branch_id,archived,employee_status")
    .eq("rfid_uid", value)
    .limit(1);
  const owner = result.error ? null : (result.data || [])[0];
  if (owner) {
    return { employee: owner, reason: `Inactive employee: card ${maskCardCode(value)} belongs to an archived or inactive account.` };
  }
  return { employee: null, reason: `Unregistered RFID card ${maskCardCode(value)}.` };
}

export async function GET(request) {
  const guard = await requirePermission(request, "attendance", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const allEmployees = await fetchEmployees(supabase);

    // The scoped employee list does two jobs: it decides who gets an "Absent"
    // row, and (via the branchScoped flag below) which taps are visible at
    // all. It used to do only the first, which is how taps from other
    // branches were reaching this view.
    const activeEmployees = guard.branchExempt
      ? allEmployees
      : allEmployees.filter((e) => String(e.branch_id || "") === String(guard.branchId || ""));
    const dateKey = getDateKey(new Date());
    const attendanceData = await fetchAttendanceRows(
      supabase,
      activeEmployees,
      dateKey,
      !guard.branchExempt,
    );
    const payload = buildAttendancePayload(
      attendanceData.rows,
      dateKey,
      attendanceData.can_persist,
      attendanceData.source_mode,
    );
    // Branch, employee ID and "Corrected by" labels for the grouped table.
    payload.attendance_logs = await annotateAttendanceRows(supabase, payload.attendance_logs);

    await appendAuditLog({
      actor: guard,
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

    // Only the Admin / Super Admin portal's manual box sends manual_entry; the
    // RFID terminal never does, so at the kiosk only a registered card counts.
    // The kiosk session (src/lib/auth/kiosk-session.js) is never manual entry.
    const manualEntry = body.manual_entry === true && !guard.kiosk;

    // A tap the terminal saved while offline carries its own time.
    const offline = guard.kiosk ? offlineTapTime(body.offline_tapped_at) : null;
    if (offline?.error) {
      return NextResponse.json({ error: offline.error, persisted: false, refused: true }, { status: 422 });
    }
    const tappedAt = offline?.at || new Date();

    const supabase = getAdminClient();
    const activeEmployees = await fetchEmployees(supabase);
    const employee = resolveEmployeeByRfid(rfidCode, activeEmployees, { allowEmployeeId: manualEntry });

    const nowIso = tappedAt.toISOString();
    const dateKey = getDateKey(tappedAt);
    const tapSource = manualEntry ? "manual_entry" : "rfid_tap";
    // A tap is refused only for a real reason, and kept in Blocked Taps:
    // an unregistered card, an inactive employee, another branch's employee
    // (approved leave is handled below). Never for tapping again too soon.
    const refuse = async ({ refusedEmployee = null, reason, status, error }) => {
      await recordRefusedTap(supabase, {
        employee: refusedEmployee,
        branchId: guard.branchId || null,
        dateKey,
        reason,
        rfidCode: maskCardCode(rfidCode),
        source: tapSource,
        recordedBy: guard.userId || null,
      });
      await appendAuditLog({
        actor: guard,
        module: "attendance",
        action: "rfid_refused",
        entity_type: "employee",
        entity_id: refusedEmployee?.employee_id || maskCardCode(rfidCode),
        description: `RFID tap refused: ${reason}`,
        status: "failed",
        source: "api",
        metadata: { rfid_code: maskCardCode(rfidCode), manual_entry: manualEntry, date_key: dateKey, employee_id: refusedEmployee?.id || null },
      });
      return NextResponse.json({ error, persisted: false, refused: true }, { status });
    };

    if (!employee) {
      const unmatched = await unmatchedCardReason(supabase, rfidCode);
      return refuse({ refusedEmployee: unmatched.employee, reason: unmatched.reason, status: 404, error: "RFID not matched to an active employee." });
    }

    if (String(employee.employee_status || "").toLowerCase() === "inactive") {
      return refuse({ refusedEmployee: employee, reason: `Inactive employee: ${employee.full_name}.`, status: 403, error: "This employee is inactive. The tap was not recorded." });
    }

    // Correcting or recording a scan for someone in another branch is refused.
    const foreignBranch = denyForeignBranch(guard, employee.branch_id);
    if (foreignBranch) {
      return refuse({
        refusedEmployee: employee,
        reason: `Wrong branch: ${employee.full_name} belongs to another branch.`,
        status: foreignBranch.status || 403,
        error: "This card belongs to an employee of another branch.",
      });
    }

    // Approved leave covering today: nothing is saved, the attempt is kept
    // for HR. Applies to the kiosk and the portal's manual box alike, and
    // only to approved leave (pending, rejected and cancelled never block).
    const leave = await isEmployeeOnLeave(supabase, employee.id, dateKey);
    if (leave) {
      const source = manualEntry ? "manual_entry" : "rfid_tap";
      await recordBlockedTap(supabase, {
        employee, dateKey, leave, rfidCode: normalizeText(rfidCode), source, recordedBy: guard.userId || null,
      });
      await appendAuditLog({
        actor: guard,
        module: "attendance",
        action: "rfid_blocked_on_leave",
        entity_type: "employee",
        entity_id: employee.employee_id,
        description: `RFID tap refused for ${employee.full_name}: on approved leave (${leave.leave_type}, ${leave.start_date} to ${leave.end_date}).`,
        status: "failed",
        source: "api",
        branch_id: employee.branch_id || null,
        metadata: {
          employee_id: employee.id,
          rfid_code: rfidCode,
          manual_entry: manualEntry,
          date_key: dateKey,
          leave_request_id: leave.id,
        },
      });
      return NextResponse.json(
        { error: LEAVE_TAP_MESSAGE, on_leave: true, persisted: false },
        { status: 409 },
      );
    }

    // The tap is judged against the schedule of the branch the employee is
    // assigned to, so a 7:00 AM branch marks Late earlier than an 8:00 AM one.
    const policy = await getBranchAttendancePolicy(supabase, employee.branch_id);

    // The same tap twice (within a few minutes of one already recorded) is
    // not a Time Out: nothing is saved, and the employee is told it counted.
    const repeat = await findRepeat(supabase, employee.id, dateKey, nowIso);
    if (repeat) {
      await appendAuditLog({
        actor: guard,
        module: "attendance",
        action: "rfid_repeat_ignored",
        entity_type: "employee",
        entity_id: employee.employee_id,
        description: `Repeated RFID tap ignored for ${employee.full_name} (already tapped at ${repeat.repeated}).`,
        status: "success",
        source: "api",
        metadata: { employee_id: employee.id, rfid_code: maskCardCode(rfidCode), date_key: dateKey, tapped_at: nowIso, repeated: repeat.repeated, offline: Boolean(offline) },
      });
      return NextResponse.json({
        success: true,
        persisted: false,
        tap: "duplicate",
        message: "Already recorded. A repeated tap within a few minutes is not counted.",
        record: repeat.record,
      });
    }

    // Every accepted tap is kept as its own raw row first, then the day's
    // record is rebuilt from first tap (in) to last tap (out).
    await recordRawTap(supabase, {
      employee,
      dateKey,
      tappedAt: nowIso,
      rfidCode: normalizeText(rfidCode),
      device: offline ? `${tapDevice(body, manualEntry)} (sent late)` : tapDevice(body, manualEntry),
      source: tapSource,
      recordedBy: guard.userId || null,
    });

    const { record, tap } = await persistScanToTable(
      supabase, employee, dateKey, nowIso, rfidCode, 1, policy,
      guard, tapSource,
    );

    await appendAuditLog({
      actor: guard,
      module: "attendance",
      action: tap === "time_out" ? "rfid_timeout" : tap === "after_correction" ? "rfid_tap_after_correction" : "rfid_timein",
      entity_type: "employee",
      entity_id: employee.employee_id,
      description: `RFID scan processed for ${employee.full_name}.`,
      status: "success",
      source: "api",
      metadata: {
        employee_id: employee.id,
        rfid_code: rfidCode,
        manual_entry: manualEntry,
        date_key: dateKey,
        tapped_at: nowIso,
        offline: Boolean(offline),
        branch_id: employee.branch_id,
        schedule: `${policy.work_start}-${policy.work_end}`,
        grace: policy.grace,
      },
    });

    const messages = {
      time_in: "RFID time-in recorded. The next tap records the time out.",
      time_out: "RFID time-out recorded. A later tap today moves it to that tap.",
      after_correction: "Tap recorded. This day was corrected by HR / Admin, so its times stay as corrected; the tap is flagged for review.",
    };

    return NextResponse.json({
      success: true,
      persisted: true,
      tap,
      message: messages[tap],
      record,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
