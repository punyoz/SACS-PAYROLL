import { getTrustedUserById } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission, resolveTargetEmail, denyForeignBranch } from "@/lib/rbac/guard";
import { collapseDailyTaps } from "@/lib/attendance/taps";
import { resolveCurrentBranchId } from "@/lib/auth/live-branch";
import {
  formatPolicyTime12,
  timeToMinutes,
  loadAttendanceConfig,
  resolveAttendancePolicy,
  tardinessMinutes,
  undertimeMinutes,
} from "@/lib/attendance/policy";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { HOLIDAY_TYPE_LABELS, cutoffMinutes, describeDayPart, holidayAppliesTo, holidayBadgeLabel, isDayOff, readHolidayMap } from "@/lib/attendance/holidays";
import { loadEmployeeDuty } from "@/lib/attendance/holiday-duty";
import { manilaDateKey } from "@/lib/payroll/periods";
import { isOffDay, loadEmployeeScheduleDays } from "@/lib/attendance/work-schedules";

/* ── Philippine national holidays (2024-2027) ── */
const PH_HOLIDAYS = {
  "2024-01-01": { name: "New Year's Day",       type: "holiday" },
  "2024-04-09": { name: "Araw ng Kagitingan",   type: "holiday" },
  "2024-03-28": { name: "Maundy Thursday",      type: "holiday" },
  "2024-03-29": { name: "Good Friday",          type: "holiday" },
  "2024-05-01": { name: "Labor Day",            type: "holiday" },
  "2024-06-12": { name: "Independence Day",     type: "holiday" },
  "2024-08-26": { name: "National Heroes Day",  type: "holiday" },
  "2024-11-01": { name: "All Saints Day",       type: "special" },
  "2024-11-30": { name: "Bonifacio Day",        type: "holiday" },
  "2024-12-25": { name: "Christmas Day",        type: "holiday" },
  "2024-12-30": { name: "Rizal Day",            type: "holiday" },
  "2025-01-01": { name: "New Year's Day",       type: "holiday" },
  "2025-04-09": { name: "Araw ng Kagitingan",   type: "holiday" },
  "2025-04-17": { name: "Maundy Thursday",      type: "holiday" },
  "2025-04-18": { name: "Good Friday",          type: "holiday" },
  "2025-05-01": { name: "Labor Day",            type: "holiday" },
  "2025-06-12": { name: "Independence Day",     type: "holiday" },
  "2025-08-25": { name: "National Heroes Day",  type: "holiday" },
  "2025-11-01": { name: "All Saints Day",       type: "special" },
  "2025-11-30": { name: "Bonifacio Day",        type: "holiday" },
  "2025-12-25": { name: "Christmas Day",        type: "holiday" },
  "2025-12-30": { name: "Rizal Day",            type: "holiday" },
  "2026-01-01": { name: "New Year's Day",       type: "holiday" },
  "2026-04-02": { name: "Maundy Thursday",      type: "holiday" },
  "2026-04-03": { name: "Good Friday",          type: "holiday" },
  "2026-04-09": { name: "Araw ng Kagitingan",   type: "holiday" },
  "2026-05-01": { name: "Labor Day",            type: "holiday" },
  "2026-06-12": { name: "Independence Day",     type: "holiday" },
  "2026-08-31": { name: "National Heroes Day",  type: "holiday" },
  "2026-11-01": { name: "All Saints Day",       type: "special" },
  "2026-11-30": { name: "Bonifacio Day",        type: "holiday" },
  "2026-12-25": { name: "Christmas Day",        type: "holiday" },
  "2026-12-30": { name: "Rizal Day",            type: "holiday" },
  "2027-01-01": { name: "New Year's Day",       type: "holiday" },
  "2027-03-25": { name: "Maundy Thursday",      type: "holiday" },
  "2027-03-26": { name: "Good Friday",          type: "holiday" },
  "2027-04-09": { name: "Araw ng Kagitingan",   type: "holiday" },
  "2027-05-01": { name: "Labor Day",            type: "holiday" },
  "2027-06-12": { name: "Independence Day",     type: "holiday" },
  "2027-08-30": { name: "National Heroes Day",  type: "holiday" },
  "2027-11-01": { name: "All Saints Day",       type: "special" },
  "2027-11-30": { name: "Bonifacio Day",        type: "holiday" },
  "2027-12-25": { name: "Christmas Day",        type: "holiday" },
  "2027-12-30": { name: "Rizal Day",            type: "holiday" },
};

const SHIFT_IN_H  = 8;   // 08:00 AM
const SHIFT_OUT_H = 17;  // 05:00 PM
const REQ_HOURS   = 8;

function formatTime12(isoString) {
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

function getDayName(dateStr) {
  try {
    return new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      weekday: "long",
    }).format(new Date(`${dateStr}T00:00:00+08:00`));
  } catch {
    return "";
  }
}

// UTC, like generateDateRange(): Manila midnight read back with the local
// getDay() on a UTC server (Vercel) is the previous day, so every weekday
// shifted by one — Sunday and Monday came out as rest days, Saturday as work.
function getDayOfWeek(dateStr) {
  try {
    return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  } catch {
    return -1;
  }
}

// With a branch policy these follow that branch's work start / end (see
// src/lib/attendance/policy.js); without one, the fixed SHIFT_IN_H / SHIFT_OUT_H.
function calcTardiness(timeInIso, policy = null) {
  if (policy) return tardinessMinutes(timeInIso, policy);
  if (!timeInIso) return 0;
  try {
    const timeIn = new Date(timeInIso);
    const phDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(timeIn);
    const shiftIn = new Date(
      `${phDate}T${String(SHIFT_IN_H).padStart(2, "0")}:00:00+08:00`,
    );
    const diff = Math.floor((timeIn - shiftIn) / 60000);
    return diff > 0 ? diff : 0;
  } catch {
    return 0;
  }
}

function calcUndertime(timeOutIso, policy = null) {
  if (policy) return undertimeMinutes(timeOutIso, policy);
  if (!timeOutIso) return 0;
  try {
    const timeOut = new Date(timeOutIso);
    const phDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(timeOut);
    const shiftOut = new Date(
      `${phDate}T${String(SHIFT_OUT_H).padStart(2, "0")}:00:00+08:00`,
    );
    const diff = Math.floor((shiftOut - timeOut) / 60000);
    return diff > 0 ? diff : 0;
  } catch {
    return 0;
  }
}

// Walks the calendar in UTC, where a YYYY-MM-DD key and its Date agree on
// every server. It used to parse Manila midnight (+08:00) and read it back
// with local getters — on a UTC server (Vercel) that instant is still the
// previous day, so a Sept 1–30 timesheet came out as Aug 31–Sept 29.
function generateDateRange(startDate, endDate) {
  const dates = [];
  const cur   = new Date(`${startDate}T00:00:00Z`);
  const end   = new Date(`${endDate}T00:00:00Z`);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// `holidays` is attendance_holidays for the range (Super Admin -> Holidays);
// PH_HOLIDAYS covers a database that cannot be read (holidays null). A
// morning / afternoon suspension is a working day on a shorter schedule.
//
// Holiday duty (20261102010000): the school is closed on a holiday, so
// required hours are 0, unless HR assigned the employee to report (`duty`),
// when the assigned shift applies. Every row says which holiday it is
// (`holiday`, for the badge) and whether it is also a rest day.
function getShiftInfo(dateStr, policy = null, holidays = null, { branchId = null, duty = null } = {}) {
  const dow = getDayOfWeek(dateStr);
  // The employee's own working days when their schedule sets them
  // (src/lib/attendance/work-schedules.js); otherwise Monday to Friday.
  const offDay = policy?.working_days ? isOffDay(dateStr, policy.working_days) : (dow === 0 || dow === 6);

  const found = holidays ? holidays.get(dateStr) : PH_HOLIDAYS[dateStr];
  // A branch-only day applies to that branch's people only.
  const holiday = found && holidayAppliesTo(found, branchId) ? found : null;
  const holidayInfo = holiday
    ? { name: holiday.name, type: holiday.type, day_part: holiday.day_part || "whole", type_label: HOLIDAY_TYPE_LABELS[holiday.type] || "Holiday", label: holidayBadgeLabel(holiday) }
    : null;
  const tags = { holiday: holidayInfo, rest_day: offDay, duty: null };

  if (duty && (offDay || isDayOff(holiday))) {
    return {
      ...tags,
      row_type: "duty",
      shift_type: `Holiday duty${duty.note ? ` (${duty.note})` : ""}`,
      shift_in: formatPolicyTime12(String(duty.shift_start).slice(0, 5)),
      shift_out: formatPolicyTime12(String(duty.shift_end).slice(0, 5)),
      required_hours: Number(duty.required_hours) || 0,
      duty: { shift_start: String(duty.shift_start).slice(0, 5), shift_end: String(duty.shift_end).slice(0, 5), note: duty.note || null, assigned_by_name: duty.assigned_by_name || null },
    };
  }

  if (offDay) {
    return {
      ...tags,
      row_type: "rest",
      shift_type: "Rest Day",
      shift_in: null,
      shift_out: null,
      required_hours: 0,
    };
  }

  const partial = holiday && holiday.day_part && holiday.day_part !== "whole";
  if (partial && policy) {
    const cutoff = cutoffMinutes(holiday.cutoff);
    const start = timeToMinutes(policy.work_start);
    const end = timeToMinutes(policy.work_end);
    if (cutoff !== null && start !== null && end !== null && cutoff > start && cutoff < end) {
      const span = Math.max(end - start, 1);
      const hours = Number(policy.work_hours) || REQ_HOURS;
      const cutoffText = String(holiday.cutoff).slice(0, 5);
      const shortened = holiday.day_part === "pm"
        ? { ...policy, work_end: cutoffText, work_hours: hours * (cutoff - start) / span }
        : { ...policy, work_start: cutoffText, work_hours: hours * (end - cutoff) / span };
      return {
        ...tags,
        row_type: "regular",
        shift_type: `${holiday.name} (${describeDayPart(holiday)})`,
        shift_in: formatPolicyTime12(shortened.work_start),
        shift_out: formatPolicyTime12(shortened.work_end),
        required_hours: Math.round(shortened.work_hours * 100) / 100,
        policy: shortened,
      };
    }
  }
  if (isDayOff(holiday)) {
    return {
      ...tags,
      row_type: holiday.type,
      shift_type: holiday.name,
      shift_in: null,
      shift_out: null,
      required_hours: 0,
    };
  }

  // A special working day (or no holiday): an ordinary working day.
  if (policy) {
    return {
      ...tags,
      row_type: "regular",
      // The schedule profile's name ("Pre-school Teacher") when it has one.
      shift_type: policy.schedule_name || "Regular",
      shift_in: formatPolicyTime12(policy.work_start),
      shift_out: formatPolicyTime12(policy.work_end),
      required_hours: Number(policy.work_hours) || REQ_HOURS,
    };
  }

  return {
    ...tags,
    row_type: "regular",
    shift_type: "Regular",
    shift_in: `${String(SHIFT_IN_H).padStart(2, "0")}:00 AM`,
    shift_out: `${String(SHIFT_OUT_H - 12).padStart(2, "0")}:00 PM`,
    required_hours: REQ_HOURS,
  };
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "timesheet", "read");
    if (guard.denied) return guard.denied;

    // SCOPE_SELF for Employee — pinned to the session, ?email= is ignored.
    const url       = new URL(request.url);
    const email     = resolveTargetEmail(guard, url.searchParams.get("email"));
    const startDate = String(url.searchParams.get("start_date") || "").trim();
    const endDate   = String(url.searchParams.get("end_date")   || "").trim();

    if (!email) {
      return NextResponse.json({ error: "email is required." }, { status: 400 });
    }
    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: "start_date and end_date are required." },
        { status: 400 },
      );
    }
    if (startDate > endDate) {
      return NextResponse.json(
        { error: "start_date must not be after end_date." },
        { status: 400 },
      );
    }

    const dayDiff = (new Date(endDate) - new Date(startDate)) / 86400000;
    if (dayDiff > 366) {
      return NextResponse.json(
        { error: "Date range cannot exceed 366 days." },
        { status: 400 },
      );
    }

    const supabase = getAdminClient();

    // One account, looked up directly (alpha test B5: listing every sign-in
    // account to find one was the slowest step). An employee is always
    // themselves; another role finds the person by email in profiles.
    let userId = guard.scope === "self" ? guard.userId : null;
    if (!userId) {
      const found = await supabase.from("profiles").select("id").eq("email", email).limit(1).maybeSingle();
      userId = found.data?.id || null;
    }
    const trusted = userId ? await getTrustedUserById(supabase, userId) : null;
    const user = trusted?.data?.user || null;
    if (!user || String(user.email || "").trim().toLowerCase() !== email) return NextResponse.json({ records: [] });

    const foreign = denyForeignBranch(guard, user.user_metadata?.branch_id);
    if (foreign) return foreign;

    /* Attendance logs for the date range -- read alongside everything else
       that does not depend on them (one round trip instead of five). */
    const [attResult, leaveRead, currentBranchId, holidays, duty] = await Promise.all([supabase
      .from("attendance_logs")
      .select("status, log_date, time_in, time_out, branch_id")
      .eq("employee_id", user.id)
      .gte("log_date", startDate)
      .lte("log_date", endDate)
      // Folded duplicates and released (cancelled) leave days.
      .eq("archived_duplicate", false)
      .order("log_date", { ascending: true }),
    supabase
      .from("leave_requests")
      .select("start_date, end_date, pay_status, leave_type")
      // Stored lowercase (HR writes "approved").
      .eq("status", "approved")
      .lte("start_date", endDate)
      .gte("end_date", startDate)
      // leave_requests.employee_id is the user id (UUID).
      .eq("employee_id", user.id)
      .then((r) => r, () => ({ data: null, error: true })),
    resolveCurrentBranchId(user.id, user.user_metadata?.branch_id || null),
    readHolidayMap(supabase, startDate, endDate),
    loadEmployeeDuty(supabase, user.id, startDate, endDate),
    ]);

    // One record per day: the first tap is Time In, the last tap Time Out.
    const attMap = {};
    if (!attResult.error && Array.isArray(attResult.data)) {
      for (const row of collapseDailyTaps(attResult.data, { employeeKey: () => user.id })) {
        attMap[row.log_date] = row;
      }
    }

    /* Approved leave requests overlapping the date range */
    const leaveDates = new Set();
    // Every approved leave day (with or without pay) -> its leave type.
    const leaveTypeByDate = new Map();
    try {
      const leaveResult = leaveRead;
      if (!leaveResult.error && Array.isArray(leaveResult.data)) {
        for (const lv of leaveResult.data) {
          // UTC, for the same reason as generateDateRange().
          const lc = new Date(`${lv.start_date}T00:00:00Z`);
          const le = new Date(`${lv.end_date}T00:00:00Z`);
          while (lc <= le) {
            const key = lc.toISOString().slice(0, 10);
            // The Leave w/ Pay column counts paid leave only.
            if (String(lv.pay_status || "with_pay").toLowerCase() !== "without_pay") leaveDates.add(key);
            leaveTypeByDate.set(key, String(lv.leave_type || "Leave"));
            lc.setUTCDate(lc.getUTCDate() + 1);
          }
        }
      }
    } catch {
      /* leave table may not exist — silently skip */
    }

    /* The employee's own schedule for each day (own → level → branch →
       default, src/lib/attendance/work-schedules.js). A day with a tap falls
       back to the branch that tap was recorded at (attendance_logs.branch_id,
       stamped at insert), so a transfer does not rewrite past days; a day with
       no tap uses the employee's current branch. */
    const scheduleDaysPending = loadEmployeeScheduleDays(supabase, {
      employeeId: user.id,
      branchId: currentBranchId,
      from: startDate,
      to: endDate,
      branchFor: (dateKey) => attMap[dateKey]?.branch_id || null,
    });
    const attendanceConfigPending = loadAttendanceConfig(supabase, [
      currentBranchId,
      ...Object.values(attMap).map((row) => row.branch_id),
    ]);
    const [scheduleDays, attendanceConfig] = await Promise.all([scheduleDaysPending, attendanceConfigPending]);
    const policyCache = new Map();
    const policyFor = (branchId, dateStr) => {
      if (dateStr && scheduleDays.has(dateStr)) return scheduleDays.get(dateStr);
      const key = String(branchId || "");
      if (!policyCache.has(key)) policyCache.set(key, resolveAttendancePolicy(attendanceConfig, branchId || null));
      return policyCache.get(key);
    };

    /* The holidays payroll and the nightly close use */
    // (holidays, and HR's holiday duty / decisions, were read above.)
    const { assignments: dutyByDate, reviews: reviewByDate } = duty;
    const todayKey = manilaDateKey();

    /* Build a record for every calendar day in the range */
    const dates   = generateDateRange(startDate, endDate);
    const records = dates.map((dateStr) => {
      const att       = attMap[dateStr] || null;
      const branchId  = att?.branch_id || currentBranchId;
      const policy    = policyFor(branchId, dateStr);
      let shift       = getShiftInfo(dateStr, policy, holidays, { branchId, duty: dutyByDate.get(dateStr) || null });
      const hasLeave  = leaveDates.has(dateStr) ? 1 : 0;
      // A working day covered by approved leave, with no tap of its own.
      if (shift.row_type === "regular" && !att?.time_in
        && (att?.status === "On Leave" || leaveTypeByDate.has(dateStr))) {
        shift = {
          row_type: "leave",
          shift_type: `On Leave (${leaveTypeByDate.get(dateStr) || "Leave"})`,
          shift_in: null,
          shift_out: null,
          required_hours: 0,
        };
      }
      const timeInIso = att?.time_in  || null;
      const timeOutIso= att?.time_out || null;

      let tardiness = 0;
      let undertime = 0;
      if (shift.row_type === "regular" && att?.time_in) {
        // A partial suspension's shorter schedule, when the day has one.
        const dayPolicy = shift.policy || policy;
        tardiness = calcTardiness(att.time_in, dayPolicy);
        if (att.time_out) undertime = calcUndertime(att.time_out, dayPolicy);
      }

      return {
        date:           dateStr,
        day:            getDayName(dateStr),
        shift_type:     shift.shift_type,
        shift_in:       shift.shift_in,
        shift_out:      shift.shift_out,
        required_hours: shift.required_hours,
        time_in:        formatTime12(timeInIso),
        time_out:       formatTime12(timeOutIso),
        tardiness,
        undertime,
        leave_with_pay: hasLeave,
        row_type:       shift.row_type,
        holiday:        shift.holiday || null,
        rest_day:       Boolean(shift.rest_day),
        duty:           shift.duty || null,
        // Assigned to report, the day has passed, no tap: for HR to decide
        // (never deducted automatically).
        duty_no_show:   Boolean(shift.duty) && dateStr < todayKey && !att?.time_in,
        // Worked a day off (holiday) without an assignment: HR approves it as
        // holiday work before any premium is paid.
        holiday_work:   !shift.duty && isDayOff(shift.holiday) && att?.time_in
          ? (reviewByDate.get(dateStr)?.decision || "pending")
          : null,
        status:         att?.status
          || (shift.row_type === "rest" ? "Rest Day" : shift.row_type === "leave" ? "On Leave" : "No Record"),
      };
    });

    return NextResponse.json({ records });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
