/**
 * Assigning an RFID card (PATCH /api/admin/system): the UID must be the
 * card's number, digits only. The RFID terminal keeps only the digits a
 * reader types (src/app/rfid-terminal/rfid-terminal.jsx onScanChange), so a
 * UID saved with letters or spaces could never be matched at the kiosk.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const MAIN = "b-main";
const admin = { user_id: "u-adm", role: "admin", branch_id: MAIN, full_name: "Ada Admin" };

let createSessionToken;
let SESSION_COOKIE;

async function assign(rfidUid) {
  const token = createSessionToken({ ...admin, email: "u-adm@sacs.test", session_id: "s-1" });
  const { PATCH } = await import("@/app/api/admin/system/route");
  const res = await PATCH(new Request("https://sacs.test/api/admin/system", {
    method: "PATCH",
    headers: { cookie: `${SESSION_COOKIE}=${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "u-paolo", rfid_uid: rfidUid }),
  }));
  return { status: res.status, body: await res.json() };
}

const savedUid = () => table("profiles").find((row) => row.id === "u-paolo")?.rfid_uid ?? null;

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-rfid-uid-format";
  resetDb();
  users.push(
    { id: "u-paolo", email: "u-paolo@sacs.test", user_metadata: { role: "employee", full_name: "Paolo Diaz", employee_id: "SACS-010", branch_id: MAIN } },
    { id: "u-adm", email: "u-adm@sacs.test", user_metadata: { role: "admin", full_name: "Ada Admin", branch_id: MAIN } },
  );
  table("profiles").push(
    { id: "u-paolo", role: "employee", full_name: "Paolo Diaz", branch_id: MAIN, archived: false, rfid_uid: null },
    { id: "u-adm", role: "admin", branch_id: MAIN, archived: false },
  );
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("RFID UID format", () => {
  it("saves a numeric card number", async () => {
    const { status } = await assign("0012345678");
    expect(status).toBe(200);
    expect(savedUid()).toBe("0012345678");
  });

  it.each(["04A2B3C4", "12 34 56", "card-1", "12345678901234567"])("refuses %s, which the terminal could never match", async (uid) => {
    const { status, body } = await assign(uid);
    expect(status).toBe(400);
    expect(body.error).toMatch(/digits/i);
    expect(savedUid()).toBe(null);
  });

  it("still lets an empty UID void the card", async () => {
    table("profiles").find((row) => row.id === "u-paolo").rfid_uid = "0012345678";
    const { status } = await assign("");
    expect(status).toBe(200);
    expect(savedUid()).toBe(null);
  });
});
