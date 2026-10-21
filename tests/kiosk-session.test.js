/**
 * The RFID terminal's kiosk session (src/lib/auth/kiosk-session.js) and its
 * offline queue:
 *
 *   - unlocking the terminal issues a kiosk cookie; taps on it keep working
 *     after the Admin's own sign-in is replaced elsewhere or has expired;
 *   - it is refused once the account is archived or no longer an Admin;
 *   - it only ever covers a terminal tap (POST + x-sacs-kiosk header);
 *   - a tap saved while offline is recorded at the time it was tapped, only
 *     from the kiosk session and only up to a day late.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users, rpc } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-a";
const EMP = "u-emp";
const CARD = "0012345678";
const DAY = "2026-10-02";
const manila = (hms, day = DAY) => new Date(`${day}T${hms}+08:00`).toISOString();

let kiosk;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(manila("07:00:00")));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-kiosk";
  resetDb();
  users.push(
    // The Admin has since signed in elsewhere: app_metadata holds another id.
    { id: "u-admin", email: "admin@sacs.test", app_metadata: { session_id: "s-newer" }, user_metadata: { role: "admin", branch_id: BRANCH } },
    { id: EMP, email: "emp@sacs.test", user_metadata: { role: "employee", full_name: "Ella Employee", employee_id: "SACS-001", branch_id: BRANCH } },
  );
  table("profiles").push(
    { id: "u-admin", branch_id: BRANCH, role: "admin", archived: false },
    { id: EMP, full_name: "Ella Employee", email: "emp@sacs.test", branch_id: BRANCH, role: "employee", employee_status: "Active", rfid_uid: CARD, archived: false },
  );
  rpc.results.attendance_approved_leave = { data: [], error: null };
  // The registered terminal the kiosk was unlocked on (2026-10-21).
  table("rfid_terminals").push({ id: TERMINAL, name: "Main Gate", branch_id: BRANCH, status: "active", key_version: 1 });
  rpc.results.rfid_terminal_touch = { data: null, error: null };
  kiosk = await import("@/lib/auth/kiosk-session");
});

afterEach(() => {
  vi.useRealTimers();
});

const TERMINAL = "t-main-gate";

function kioskToken(role = "admin", terminal = { id: TERMINAL, name: "Main Gate", branch_id: BRANCH, key_version: 1 }) {
  return kiosk.createKioskToken({ user_id: "u-admin", role, branch_id: BRANCH, email: "admin@sacs.test", full_name: "Ada Admin", terminal });
}

async function viaProxy({ cookie, header = true, method = "POST", body = { rfid_code: CARD } }) {
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  return proxy(new NextRequest("https://sacs.test/api/admin/attendance", {
    method,
    headers: { "Content-Type": "application/json", cookie, ...(header ? { "x-sacs-kiosk": "1" } : {}) },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  }));
}

async function tap(body, { token = kioskToken(), header = true } = {}) {
  const { POST } = await import("@/app/api/admin/attendance/route");
  const response = await POST(new Request("https://sacs.test/api/admin/attendance", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `${kiosk.KIOSK_COOKIE}=${token}`, ...(header ? { "x-sacs-kiosk": "1" } : {}) },
    body: JSON.stringify(body),
  }));
  return { response, body: await response.json() };
}

describe("kiosk token", () => {
  it("is valid for 16 hours from unlock, then expires", () => {
    const token = kioskToken();
    expect(kiosk.verifyKioskToken(token)).toMatchObject({ kind: "kiosk", sub: "u-admin", role: "admin" });
    vi.setSystemTime(new Date(Date.now() + kiosk.KIOSK_MAX_AGE_SECONDS * 1000 + 1000));
    expect(kiosk.verifyKioskToken(token)).toBeNull();
  });

  it("is never issued for a role that cannot run the terminal, and an ordinary session cookie is not one", async () => {
    expect(kiosk.verifyKioskToken(kioskToken("employee"))).toBeNull();
    const { createSessionToken } = await import("@/lib/rbac/session");
    expect(kiosk.verifyKioskToken(createSessionToken({ user_id: "u-admin", role: "admin", session_id: "s1" }))).toBeNull();
  });
});

describe("proxy", () => {
  it("lets a terminal tap through on the kiosk session after the Admin signed in elsewhere", async () => {
    const response = await viaProxy({ cookie: `${kiosk.KIOSK_COOKIE}=${kioskToken()}` });
    expect(response.status).toBe(200);
  });

  it("refuses the kiosk session once the account is archived, and clears it", async () => {
    table("profiles")[0].archived = true;
    const response = await viaProxy({ cookie: `${kiosk.KIOSK_COOKIE}=${kioskToken()}` });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("account_archived");
    expect(response.cookies.get(kiosk.KIOSK_COOKIE)?.value).toBe("");
  });

  it("refuses the kiosk session once the account is no longer an Admin", async () => {
    table("profiles")[0].role = "employee";
    const response = await viaProxy({ cookie: `${kiosk.KIOSK_COOKIE}=${kioskToken()}` });
    expect(response.status).toBe(401);
  });

  it("refuses a kiosk whose terminal was switched off, or whose key was reset, or that has no terminal", async () => {
    table("rfid_terminals")[0].status = "inactive";
    let response = await viaProxy({ cookie: `${kiosk.KIOSK_COOKIE}=${kioskToken()}` });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("terminal_inactive");
    vi.resetModules();
    kiosk = await import("@/lib/auth/kiosk-session");
    Object.assign(table("rfid_terminals")[0], { status: "active", key_version: 2 });
    response = await viaProxy({ cookie: `${kiosk.KIOSK_COOKIE}=${kioskToken()}` });
    expect((await response.json()).code).toBe("terminal_reset");
    response = await viaProxy({ cookie: `${kiosk.KIOSK_COOKIE}=${kioskToken("admin", null)}` });
    expect((await response.json()).code).toBe("kiosk_no_terminal");
  });

  it("lets HR run a terminal too", async () => {
    table("profiles")[0].role = "hr";
    const response = await viaProxy({ cookie: `${kiosk.KIOSK_COOKIE}=${kioskToken("hr")}` });
    expect(response.status).toBe(200);
  });

  it("does not use the kiosk session for anything but a terminal tap", async () => {
    const cookie = `${kiosk.KIOSK_COOKIE}=${kioskToken()}`;
    expect((await viaProxy({ cookie, header: false })).status).toBe(401);
    expect((await viaProxy({ cookie, method: "GET" })).status).toBe(401);
  });
});

describe("taps on the kiosk session", () => {
  it("records a tap", async () => {
    const { response, body } = await tap({ rfid_code: CARD, device: "RFID Terminal · Main" });
    expect(response.status).toBe(200);
    expect(body.tap).toBe("time_in");
    expect(table("attendance_logs")[0]).toMatchObject({ employee_id: EMP, time_in: manila("07:00:00") });
    // Stored against the registered terminal, named after it, and the
    // terminal's last tap is updated; the screen gets the name to show.
    expect(table("attendance_taps")[0]).toMatchObject({ terminal_id: TERMINAL, device: "Main Gate", branch_id: BRANCH });
    expect(rpc.calls.some((c) => c.fn === "rfid_terminal_touch" && c.args.p_terminal === TERMINAL)).toBe(true);
    expect(body.employee).toMatchObject({ name: "Ella Employee" });
  });

  it("a branch's terminal refuses another branch's card, whoever unlocked it", async () => {
    table("profiles")[1].branch_id = "b-other";
    const { response, body } = await tap({ rfid_code: CARD }, { token: kioskToken("super_admin") });
    expect(response.status).toBe(403);
    expect(body.code).toBe("wrong_branch");
  });

  it("names an unknown card, and an inactive one", async () => {
    let result = await tap({ rfid_code: "99999999" });
    expect(result.body.code).toBe("card_unknown");
    table("rfid_cards").push({ uid: "88888888", employee_id: EMP, status: "lost", updated_at: "2026-10-20T00:00:00Z" });
    result = await tap({ rfid_code: "88888888" });
    expect(result.body).toMatchObject({ code: "card_inactive", error: "Card inactive. It no longer records attendance." });
  });

  it("never counts as manual entry, so an employee ID typed at the kiosk is refused", async () => {
    const { response } = await tap({ rfid_code: "SACS-001", manual_entry: true });
    expect(response.status).toBe(404);
    expect(table("attendance_logs")).toHaveLength(0);
  });

  it("records a tap saved while offline at the time it was tapped", async () => {
    vi.setSystemTime(new Date(manila("09:30:00")));
    const { response, body } = await tap({ rfid_code: CARD, offline_tapped_at: manila("07:52:00") });
    expect(response.status).toBe(200);
    expect(body.tap).toBe("time_in");
    expect(table("attendance_logs")[0]).toMatchObject({ log_date: DAY, time_in: manila("07:52:00") });
    expect(table("attendance_taps")[0]).toMatchObject({ tapped_at: manila("07:52:00"), device: "Main Gate (sent late)", terminal_id: TERMINAL });
  });

  it("refuses a saved tap more than a day old, and keeps it in Blocked Taps for HR", async () => {
    vi.setSystemTime(new Date(manila("09:30:00", "2026-10-04")));
    const { response } = await tap({ rfid_code: CARD, offline_tapped_at: manila("07:52:00") });
    expect(response.status).toBe(422);
    expect(table("attendance_logs")).toHaveLength(0);
    // Not lost silently: filed under the day it was tapped, with who and why.
    const blocked = table("attendance_blocked_taps");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ log_date: DAY, source: "rfid_tap" });
    expect(blocked[0].employee_id).toBeTruthy();
    expect(blocked[0].reason).toMatch(/^Saved offline tap refused \(tapped .*7:52 AM\): The saved tap is more than a day old/);
  });

  it("refuses a saved tap from the future, and keeps it in Blocked Taps", async () => {
    vi.setSystemTime(new Date(manila("07:00:00")));
    const { response } = await tap({ rfid_code: CARD, offline_tapped_at: manila("09:00:00") });
    expect(response.status).toBe(422);
    expect(table("attendance_logs")).toHaveLength(0);
    expect(table("attendance_blocked_taps")[0].reason).toMatch(/in the future/);
  });

  it("ignores an offline time sent on an ordinary session (only the kiosk may back-date)", async () => {
    const { createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session");
    const token = createSessionToken({ user_id: "u-admin", role: "admin", branch_id: BRANCH, email: "admin@sacs.test", session_id: "s-1" });
    const { POST } = await import("@/app/api/admin/attendance/route");
    vi.setSystemTime(new Date(manila("09:30:00")));
    const response = await POST(new Request("https://sacs.test/api/admin/attendance", {
      method: "POST",
      // The terminal's header without a kiosk cookie: still not the kiosk session.
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}`, "x-sacs-kiosk": "1" },
      body: JSON.stringify({ rfid_code: CARD, offline_tapped_at: manila("07:00:00") }),
    }));
    expect(response.status).toBe(200);
    expect(table("attendance_logs")[0].time_in).toBe(manila("09:30:00"));
  });
});
