/**
 * Approved leave, as attendance sees it.
 *
 * "On approved leave that day" has one definition, in the database:
 * public.attendance_approved_leave(employee, day)
 * (supabase/migrations/20260928010000_leave_attendance_sync.sql). The nightly
 * close uses it to skip leave days, the leave_requests trigger uses it to
 * write On Leave days, and isEmployeeOnLeave() below uses it to refuse an RFID
 * tap. Only APPROVED leave counts -- pending, rejected and cancelled never do.
 */

export const LEAVE_TAP_MESSAGE = "You are on leave today. Attendance tap is not allowed.";

const LEAVE_COLUMNS = "id,leave_type,pay_status,start_date,end_date,decided_by_name,decided_at";

function shapeLeave(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    leave_type: String(row.leave_type || "Leave"),
    pay_status: String(row.pay_status || "with_pay").toLowerCase() === "without_pay" ? "without_pay" : "with_pay",
    start_date: String(row.start_date || ""),
    end_date: String(row.end_date || row.start_date || ""),
    approved_by: row.decided_by_name || null,
    approved_at: row.decided_at || null,
  };
}

/**
 * The approved leave covering `dateKey` for the employee, or null.
 *
 * Falls back to reading leave_requests directly when the database function is
 * not there yet (migration not applied), with the same rule.
 *
 * @param {object} supabase   service-role client
 * @param {string} employeeId profiles.id
 * @param {string} dateKey    "YYYY-MM-DD" (Manila)
 * @returns {Promise<object|null>}
 */
export async function isEmployeeOnLeave(supabase, employeeId, dateKey) {
  if (!employeeId || !dateKey) return null;

  const rpc = await supabase.rpc("attendance_approved_leave", { p_employee_id: employeeId, p_day: dateKey });
  if (!rpc.error) return shapeLeave((rpc.data || [])[0]);

  const direct = await supabase
    .from("leave_requests")
    .select(LEAVE_COLUMNS)
    .eq("employee_id", employeeId)
    .eq("status", "approved")
    .lte("start_date", dateKey)
    .gte("end_date", dateKey)
    .limit(1);
  if (direct.error) throw new Error(direct.error.message);
  return shapeLeave((direct.data || [])[0]);
}

/**
 * Approved leave overlapping [from, to], for describing On Leave days (type,
 * dates, approver) in the calendar and tables.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {string[]|null} [args.employeeIds]  limit to these; null = everyone
 * @param {string} args.from  "YYYY-MM-DD"
 * @param {string} args.to    "YYYY-MM-DD"
 * @returns {Promise<(employeeId: string, dateKey: string) => object|null>}
 */
export async function readApprovedLeave(supabase, { employeeIds = null, from, to }) {
  const none = () => null;
  if (!from || !to || (Array.isArray(employeeIds) && !employeeIds.length)) return none;

  let query = supabase
    .from("leave_requests")
    .select(`employee_id,${LEAVE_COLUMNS}`)
    .eq("status", "approved")
    .lte("start_date", to)
    .gte("end_date", from)
    .limit(2000);
  if (Array.isArray(employeeIds)) query = query.in("employee_id", employeeIds.slice(0, 500));
  const result = await query;
  if (result.error) return none;

  const byEmployee = new Map();
  (result.data || []).forEach((row) => {
    const key = String(row.employee_id || "");
    if (!byEmployee.has(key)) byEmployee.set(key, []);
    byEmployee.get(key).push(shapeLeave(row));
  });

  return (employeeId, dateKey) => (byEmployee.get(String(employeeId || "")) || [])
    .find((leave) => leave.start_date <= dateKey && dateKey <= leave.end_date) || null;
}

/** The refused taps for a range, newest first (reviewers only). */
export async function readBlockedTaps(supabase, { employeeIds = null, from, to }) {
  if (Array.isArray(employeeIds) && !employeeIds.length) return [];
  let query = supabase
    .from("attendance_blocked_taps")
    .select("id,employee_id,employee_name,branch_id,log_date,attempted_at,reason,leave_request_id,source")
    .gte("log_date", from)
    .lte("log_date", to)
    .order("attempted_at", { ascending: false })
    .limit(1000);
  if (Array.isArray(employeeIds)) query = query.in("employee_id", employeeIds);
  const result = await query;
  // No table yet (migration not applied): nothing to show.
  return result.error ? [] : result.data || [];
}

/**
 * Keep a refused tap for HR (public.attendance_blocked_taps). Never throws:
 * the tap is refused either way.
 */
export async function recordBlockedTap(supabase, { employee, dateKey, leave, rfidCode, source, recordedBy }) {
  try {
    const result = await supabase.from("attendance_blocked_taps").insert({
      employee_id: employee.id,
      employee_name: employee.full_name || null,
      branch_id: employee.branch_id || null,
      log_date: dateKey,
      reason: LEAVE_TAP_MESSAGE,
      leave_request_id: leave?.id || null,
      rfid_code: rfidCode || null,
      source: source || "rfid_tap",
      recorded_by: recordedBy || null,
    });
    if (result.error) throw result.error;
  } catch (error) {
    console.error("[attendance/leave] blocked tap not recorded:", error?.message || error);
  }
}
