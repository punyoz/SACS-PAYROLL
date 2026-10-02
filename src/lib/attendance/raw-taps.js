/**
 * Raw RFID taps (public.attendance_taps, append-only) and refused taps
 * (public.attendance_blocked_taps).
 *
 * Every accepted tap is stored as its own row, however soon after the last
 * one; the day's attendance_logs row is built from them (first tap = Time In,
 * last tap = Time Out, see src/lib/attendance/taps.js). Raw taps are never
 * updated or deleted -- the database refuses both
 * (supabase/migrations/20261002020000_attendance_raw_taps.sql).
 *
 * A tap is refused (and kept in Blocked Taps) only for a real reason: an
 * unregistered card, an inactive / archived employee, another branch's
 * employee, or approved leave (recordBlockedTap in ./leave.js).
 *
 * None of these throw: a failed write is logged, and the tap itself goes on
 * (or stays refused) either way.
 */

export const TAP_COLUMNS = "id,employee_id,branch_id,log_date,tapped_at,rfid_uid,device,source";

/** "••••5678" -- enough for HR to recognise a card without storing it in full twice. */
export function maskCardCode(code) {
  const value = String(code ?? "").trim();
  if (!value) return "";
  return value.length <= 4 ? "•".repeat(value.length) : `${"•".repeat(Math.min(value.length - 4, 6))}${value.slice(-4)}`;
}

/** The reader a tap came from: the kiosk's own label, or the portal's manual box. */
export function tapDevice(body, manualEntry) {
  if (manualEntry) return "Manual entry (portal)";
  const label = String(body?.device ?? "").replace(/[^\w .:#()·-]/g, "").trim().slice(0, 80);
  return label || "RFID Terminal";
}

export async function recordRawTap(supabase, { employee, dateKey, tappedAt, rfidCode, device, source, recordedBy }) {
  try {
    const result = await supabase.from("attendance_taps").insert({
      employee_id: employee.id,
      employee_name: employee.full_name || null,
      branch_id: employee.branch_id || null,
      log_date: dateKey,
      tapped_at: tappedAt,
      rfid_uid: rfidCode || null,
      device: device || null,
      source: source === "manual_entry" ? "manual_entry" : "rfid_tap",
      recorded_by: recordedBy || null,
    });
    if (result.error) throw result.error;
    return true;
  } catch (error) {
    console.error("[attendance/raw-taps] tap not stored:", error?.message || error);
    return false;
  }
}

/** One employee's raw taps for a range, oldest first ([] when unreadable). */
export async function readRawTaps(supabase, { employeeId, from, to }) {
  try {
    const result = await supabase
      .from("attendance_taps")
      .select(TAP_COLUMNS)
      .eq("employee_id", employeeId)
      .gte("log_date", from)
      .lte("log_date", to)
      .order("tapped_at", { ascending: true })
      .limit(5000);
    if (result.error) throw result.error;
    return result.data || [];
  } catch {
    return [];
  }
}

/**
 * Keep a tap refused for a reason other than leave. `employee` is null for
 * an unregistered card. `branchId` is the terminal's branch (null for Super
 * Admin), so the Admin of the branch where the card was tapped sees it.
 */
export async function recordRefusedTap(supabase, { employee = null, branchId = null, dateKey, reason, rfidCode, source, recordedBy }) {
  try {
    const result = await supabase.from("attendance_blocked_taps").insert({
      employee_id: employee?.id || null,
      employee_name: employee?.full_name || null,
      // Where the tap happened (the terminal's branch), else the employee's.
      branch_id: branchId || employee?.branch_id || null,
      log_date: dateKey,
      reason,
      rfid_code: rfidCode || null,
      source: source || "rfid_tap",
      recorded_by: recordedBy || null,
    });
    if (result.error) throw result.error;
  } catch (error) {
    console.error("[attendance/raw-taps] refused tap not recorded:", error?.message || error);
  }
}
