/**
 * RFID taps (20261002020000_attendance_raw_taps.sql): every tap is accepted
 * (no cooldown) and kept in attendance_taps; the day's one attendance_logs row
 * is Time In = first tap, Time Out = last tap. A day HR / Admin corrected keeps
 * its corrected times and is flagged "New tap after correction". Only a real
 * reason refuses a tap: unregistered card, inactive employee, another branch.
 *
 * The status engine (hours, late, undertime, status) runs in the database;
 * these tests pin the taps and times the route writes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users, rpc } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-a";
const OTHER = "branch-b";
const EMP = "u-emp";
const CARD = "0012345678";
const DAY = "2026-10-02";

let POST;
let createSessionToken;
let SESSION_COOKIE;

/** A tap at Manila time hh:mm:ss on DAY, through the RFID terminal. */
async function tapAt(hms, { code = CARD, branchId = BRANCH, device = "RFID Terminal · Main Branch" } = {}) {
  vi.setSystemTime(new Date(`${DAY}T${hms}+08:00`));
  const token = createSessionToken({
    user_id: "u-admin", role: "admin", branch_id: branchId, email: "admin@sacs.test", full_name: "Ada Admin", session_id: "s-1",
  });
  const response = await POST(new Request("https://sacs.test/api/admin/attendance", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: JSON.stringify({ rfid_code: code, device }),
  }));
  return { response, body: await response.json() };
}

const manila = (hms) => new Date(`${DAY}T${hms}+08:00`).toISOString();
const dayRows = () => table("attendance_logs").filter((row) => row.employee_id === EMP && row.log_date === DAY);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-raw-taps";
  resetDb();
  users.push(
    { id: "u-admin", email: "admin@sacs.test", user_metadata: { role: "admin", full_name: "Ada Admin", branch_id: BRANCH } },
    { id: EMP, email: "emp@sacs.test", user_metadata: { role: "employee", full_name: "Ella Employee", employee_id: "SACS-001", rfid_uid: CARD, branch_id: BRANCH } },
    { id: "u-far", email: "far@sacs.test", user_metadata: { role: "employee", full_name: "Fred Far", employee_id: "SACS-009", rfid_uid: "9999000011", branch_id: OTHER } },
    { id: "u-off", email: "off@sacs.test", user_metadata: { role: "employee", full_name: "Ivy Inactive", employee_id: "SACS-010", rfid_uid: "5555000022", branch_id: BRANCH } },
  );
  table("profiles").push(
    { id: "u-admin", branch_id: BRANCH, role: "admin" },
    { id: EMP, full_name: "Ella Employee", email: "emp@sacs.test", branch_id: BRANCH, role: "employee", employee_status: "Active" },
    { id: "u-far", full_name: "Fred Far", email: "far@sacs.test", branch_id: OTHER, role: "employee", employee_status: "Active" },
    { id: "u-off", full_name: "Ivy Inactive", email: "off@sacs.test", branch_id: BRANCH, role: "employee", employee_status: "Inactive" },
  );
  rpc.results.attendance_approved_leave = { data: [], error: null };

  ({ POST } = await import("@/app/api/admin/attendance/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Every tap counts", () => {
  it("2 taps a few seconds apart: both accepted, the day is complete", async () => {
    const first = await tapAt("08:00:00");
    const second = await tapAt("08:00:04");
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(second.body.tap).toBe("time_out");
    expect(dayRows()).toHaveLength(1);
    expect(dayRows()[0]).toMatchObject({ time_in: manila("08:00:00"), time_out: manila("08:00:04") });
    expect(table("attendance_taps")).toHaveLength(2);
    expect(table("attendance_blocked_taps")).toHaveLength(0);
  });

  it("5 taps in one day: Time In = first, Time Out = last, every tap stored", async () => {
    for (const hms of ["07:55:00", "07:55:02", "12:00:00", "13:00:00", "17:05:00"]) {
      const { response } = await tapAt(hms);
      expect(response.status, hms).toBe(200);
    }
    expect(dayRows()).toHaveLength(1);
    expect(dayRows()[0]).toMatchObject({ time_in: manila("07:55:00"), time_out: manila("17:05:00") });
    const raw = table("attendance_taps");
    expect(raw).toHaveLength(5);
    expect(raw[0]).toMatchObject({ employee_id: EMP, branch_id: BRANCH, log_date: DAY, rfid_uid: CARD, device: "RFID Terminal · Main Branch", source: "rfid_tap" });
  });

  it("1 tap only: Time In with no Time Out (Incomplete once the shift ends)", async () => {
    const { response, body } = await tapAt("08:10:00");
    expect(response.status).toBe(200);
    expect(body.tap).toBe("time_in");
    expect(dayRows()[0]).toMatchObject({ time_in: manila("08:10:00"), time_out: null });
  });

  it("a tap after a Time Out moves the Time Out; no new record, no refusal", async () => {
    await tapAt("08:00:00");
    await tapAt("17:00:00");
    const late = await tapAt("18:30:00");
    expect(late.response.status).toBe(200);
    expect(late.body.tap).toBe("time_out");
    expect(dayRows()).toHaveLength(1);
    expect(dayRows()[0]).toMatchObject({ time_in: manila("08:00:00"), time_out: manila("18:30:00") });
  });

  it("a tap after an Admin / HR correction keeps the corrected times and flags the day", async () => {
    table("attendance_logs").push({
      id: "log-c", employee_id: EMP, employee_name: "Ella Employee", log_date: DAY, archived_duplicate: false,
      time_in: manila("08:00:00"), time_out: manila("17:00:00"), status: "Corrected", created_at: manila("08:00:00"),
    });
    const { response, body } = await tapAt("19:00:00");
    expect(response.status).toBe(200);
    expect(body.tap).toBe("after_correction");
    expect(dayRows()).toHaveLength(1);
    expect(dayRows()[0]).toMatchObject({
      time_in: manila("08:00:00"), time_out: manila("17:00:00"), status: "Corrected", tap_after_correction_at: manila("19:00:00"),
    });
    expect(table("attendance_taps")).toHaveLength(1);
  });
});

describe("Refused only for a real reason", () => {
  it("an unregistered card is still blocked, and kept in Blocked Taps", async () => {
    const { response } = await tapAt("08:00:00", { code: "7777123456" });
    expect(response.status).toBe(404);
    expect(table("attendance_logs")).toHaveLength(0);
    expect(table("attendance_taps")).toHaveLength(0);
    expect(table("attendance_blocked_taps")).toEqual([expect.objectContaining({
      employee_id: null, branch_id: BRANCH, reason: expect.stringMatching(/Unregistered RFID card/), rfid_code: "••••••3456",
    })]);
  });

  it("an inactive employee is blocked", async () => {
    const { response } = await tapAt("08:00:00", { code: "5555000022" });
    expect(response.status).toBe(403);
    expect(table("attendance_taps")).toHaveLength(0);
    expect(table("attendance_blocked_taps")[0]).toMatchObject({ employee_id: "u-off", reason: expect.stringMatching(/Inactive employee/) });
  });

  it("another branch's card is blocked at this branch's terminal", async () => {
    const { response } = await tapAt("08:00:00", { code: "9999000011" });
    expect(response.status).toBe(403);
    expect(table("attendance_taps")).toHaveLength(0);
    expect(table("attendance_blocked_taps")[0]).toMatchObject({ employee_id: "u-far", branch_id: BRANCH, reason: expect.stringMatching(/Wrong branch/) });
  });
});
