/**
 * POST /api/rfid/tap — attendance from an unattended RFID reader.
 *
 * WHY THIS EXISTS SEPARATELY FROM /api/admin/attendance
 * The admin endpoint backs the RFID Terminal kiosk: an Admin signs in, unlocks
 * the screen, and their session authorises every scan (see
 * src/app/api/admin/attendance/verify-password/route.js). That is the right
 * model for a staffed desk, but a reader mounted by a door has no operator and
 * no session to borrow.
 *
 * This route authenticates the DEVICE instead, with a fixed key it presents on
 * every request (src/lib/auth/device-key.js). No user session is involved at
 * any point, and no app login is consulted: an RFID tag maps to an employee,
 * and the tap records a timestamp against them. Password authentication and
 * attendance logging stay entirely separate systems.
 *
 * The write itself uses the service role key, which bypasses RLS by design —
 * the reader is not a Postgres principal and has no branch of its own. The
 * attendance_logs_stamp_branch trigger fills branch_id from the employee, so
 * the branch on the row comes from the employee record, never from whatever
 * the device claimed.
 *
 * DEVICE SETUP
 *   1. Add the reader to RFID_DEVICE_KEYS as "<device-id>:<long-random-secret>".
 *   2. Configure the reader to POST here with:
 *        header  x-device-key: <that secret>
 *        body    { "tag_id": "04A2B3C4", "device_id": "lobby-main",
 *                  "scanned_at": "2026-09-24T01:15:00.000Z" }
 *      device_id and scanned_at are optional; tag_id is not.
 *   3. Serve this over HTTPS. The key is a bearer secret — anything that can
 *      read it can file attendance.
 *
 * WHAT A LEAKED KEY COULD DO
 * Append attendance taps, nothing else. It cannot read payroll, list employees,
 * change a record, or sign in as anybody. Rotate by editing the env entry.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { deviceKeysConfigured, resolveDeviceId } from "@/lib/auth/device-key";
import {
  fetchEmployees,
  getDateKey,
  persistScanToTable,
  resolveEmployeeByRfid,
} from "@/app/api/admin/attendance/route";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * How far a device's own clock may be out before we stop believing it.
 *
 * A reader's clock drifts, and a wrong one would otherwise write payroll hours
 * for the wrong minute — or the wrong day, at either end of a shift. Inside the
 * window we honour the device's timestamp (it is closer to the moment of the
 * tap than the moment the request arrived); outside it we use server time and
 * record what the device claimed in the audit entry, so a drifting clock is
 * visible to whoever reviews it rather than silently corrupting attendance.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Failed-key attempts tolerated from one address before it is shut out.
 *
 * Duplicate taps are already handled correctly and durably in the database (see
 * planTap in src/lib/attendance/taps.js — a repeat tap within a minute is
 * ignored), so this guard is aimed at the other risk: someone on the network
 * guessing the device key. Best-effort and process-local, like the kiosk
 * lockout it mirrors — it resets on redeploy and is not shared across
 * instances, which is acceptable for slowing a guessing loop.
 */
const MAX_BAD_KEYS = 10;
const BAD_KEY_LOCKOUT_MS = 10 * 60 * 1000;
const badKeyAttempts = new Map(); // address -> { count, lockedUntil }

function clientAddress(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return normalizeText(forwarded.split(",")[0]) || "unknown";
}

function lockedOut(address) {
  const entry = badKeyAttempts.get(address);
  if (!entry?.lockedUntil) return false;
  if (Date.now() < entry.lockedUntil) return true;
  badKeyAttempts.delete(address);
  return false;
}

function recordBadKey(address) {
  const entry = badKeyAttempts.get(address) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_BAD_KEYS) {
    entry.lockedUntil = Date.now() + BAD_KEY_LOCKOUT_MS;
  }
  badKeyAttempts.set(address, entry);
}

/** Resolve the moment of the tap. See MAX_CLOCK_SKEW_MS. */
function resolveTapTime(scannedAt) {
  const serverNow = new Date();
  const claimed = normalizeText(scannedAt);
  if (!claimed) return { iso: serverNow.toISOString(), claimed: "", trusted: true };

  const parsed = new Date(claimed);
  if (Number.isNaN(parsed.getTime())) {
    return { iso: serverNow.toISOString(), claimed, trusted: false };
  }

  const drift = Math.abs(parsed.getTime() - serverNow.getTime());
  if (drift > MAX_CLOCK_SKEW_MS) {
    return { iso: serverNow.toISOString(), claimed, trusted: false };
  }

  return { iso: parsed.toISOString(), claimed, trusted: true };
}

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function POST(request) {
  const address = clientAddress(request);

  try {
    if (!deviceKeysConfigured()) {
      // Refuse rather than fall open: with no keys configured, every request
      // would otherwise be indistinguishable from an authorised one.
      return NextResponse.json(
        { error: "RFID device authentication is not configured." },
        { status: 503 },
      );
    }

    if (lockedOut(address)) {
      return NextResponse.json(
        { error: "Too many failed attempts. Try again later." },
        { status: 429 },
      );
    }

    const deviceId = resolveDeviceId(request.headers.get("x-device-key"));
    if (!deviceId) {
      recordBadKey(address);
      // A rejected key is worth reviewing: it is either a misconfigured reader
      // or someone probing the endpoint.
      await appendAuditLog({
        module: "attendance",
        action: "rfid_device_rejected",
        entity_type: "device",
        entity_id: address,
        description: "An RFID scan was rejected: unrecognised device key.",
        status: "failed",
        source: "device",
        metadata: { address },
      });
      return NextResponse.json({ error: "Unrecognised device." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const tagId = normalizeText(body.tag_id || body.rfid_code || body.rfid_uid);
    const reportedDevice = normalizeText(body.device_id) || deviceId;

    if (!tagId) {
      return NextResponse.json({ error: "tag_id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const employees = await fetchEmployees(supabase);
    const employee = resolveEmployeeByRfid(tagId, employees);

    if (!employee) {
      // Logged for review, not silently dropped: an unmatched tag is usually a
      // card that was issued but never assigned, or one that has been voided.
      await appendAuditLog({
        module: "attendance",
        action: "rfid_unknown_tag",
        entity_type: "rfid_tag",
        entity_id: tagId,
        description: `Unrecognised RFID tag ${tagId} scanned at ${reportedDevice}.`,
        status: "failed",
        source: "device",
        metadata: { tag_id: tagId, device_id: reportedDevice, address },
      });
      return NextResponse.json(
        { error: "This card is not registered to an active employee.", tag_id: tagId },
        { status: 404 },
      );
    }

    if (employee.archived) {
      await appendAuditLog({
        module: "attendance",
        action: "rfid_archived_employee",
        entity_type: "employee",
        entity_id: employee.employee_id,
        description: `Archived employee ${employee.full_name} scanned at ${reportedDevice}.`,
        status: "failed",
        source: "device",
        metadata: { tag_id: tagId, device_id: reportedDevice },
      });
      return NextResponse.json(
        { error: "This card belongs to an archived employee." },
        { status: 403 },
      );
    }

    const tapTime = resolveTapTime(body.scanned_at);
    const dateKey = getDateKey(new Date(tapTime.iso));

    // Same writer the kiosk uses: first tap of the day is Time In, later taps
    // move Time Out, and a repeat within DUPLICATE_TAP_WINDOW_MS is ignored.
    const { record, tap } = await persistScanToTable(
      supabase,
      employee,
      dateKey,
      tapTime.iso,
      tagId,
    );

    if (tap !== "duplicate") {
      await appendAuditLog({
        module: "attendance",
        action: tap === "time_out" ? "rfid_timeout" : "rfid_timein",
        entity_type: "employee",
        entity_id: employee.employee_id,
        description: `RFID scan processed for ${employee.full_name} at ${reportedDevice}.`,
        status: "success",
        source: "device",
        metadata: {
          employee_id: employee.id,
          tag_id: tagId,
          device_id: reportedDevice,
          date_key: dateKey,
          // Present only when the reader's clock was not believed, so a
          // drifting device is findable in the log.
          ...(tapTime.trusted ? {} : { rejected_device_time: tapTime.claimed }),
        },
      });
    }

    const messages = {
      time_in: "Time in recorded.",
      time_out: "Time out recorded. A later tap today will replace it.",
      duplicate: "Repeated tap ignored — only the first and last tap of the day are counted.",
    };

    return NextResponse.json({
      success: true,
      persisted: tap !== "duplicate",
      tap,
      message: messages[tap],
      employee: { name: employee.full_name, employee_id: employee.employee_id },
      record,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
