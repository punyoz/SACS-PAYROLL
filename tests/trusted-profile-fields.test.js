/**
 * Fields that decide access or money are read from profiles, never from the
 * user_metadata the account holder can rewrite through Supabase Auth.
 *
 * THE BUGS THIS PINS
 *   - payroll read basic_salary from user_metadata, so an employee could
 *     raise their own pay;
 *   - the RFID terminal matched user_metadata.rfid_uid, so a user could move
 *     a card onto their account;
 *   - the terminal also accepted the (sequential) Employee ID, so anyone at
 *     the kiosk could clock a colleague in by typing theirs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-a";
const EMP = "u-emp";

/* ── applyTrustedProfile ────────────────────────────────────────────────── */

describe("applyTrustedProfile", () => {
  let applyTrustedProfile;
  beforeEach(async () => {
    vi.resetModules();
    ({ applyTrustedProfile } = await import("../src/lib/auth/users-cache.js"));
  });

  const tampered = {
    id: EMP,
    email: "emp@sacs.test",
    user_metadata: {
      role: "super_admin",
      basic_salary: 999999,
      rfid_uid: "STOLEN-CARD",
      branch_id: "branch-b",
      employee_id: "SACS-999",
      archived: false,
      full_name: "Edited Name",
    },
  };
  const profile = {
    id: EMP, role: "employee", basic_salary: "18500.00", rfid_uid: "CARD-1",
    branch_id: BRANCH, employee_id: "SACS-003", archived: false,
  };

  it("replaces every trusted field with the profiles copy", () => {
    const out = applyTrustedProfile(tampered, profile).user_metadata;
    expect(out.role).toBe("employee");
    expect(out.basic_salary).toBe(18500);
    expect(out.rfid_uid).toBe("CARD-1");
    expect(out.branch_id).toBe(BRANCH);
    expect(out.employee_id).toBe("SACS-003");
    expect(out.archived).toBe(false);
  });

  it("leaves the non-trusted fields and the input object alone", () => {
    const out = applyTrustedProfile(tampered, profile);
    expect(out.user_metadata.full_name).toBe("Edited Name");
    expect(tampered.user_metadata.basic_salary).toBe(999999);
  });

  it("an empty profile card really is no card", () => {
    const out = applyTrustedProfile(tampered, { ...profile, rfid_uid: null }).user_metadata;
    expect(out.rfid_uid).toBeNull();
  });

  it("archived holds when either copy says so", () => {
    expect(applyTrustedProfile(tampered, { ...profile, archived: true }).user_metadata.archived).toBe(true);
    const selfFlagged = { ...tampered, user_metadata: { ...tampered.user_metadata, archived: true } };
    expect(applyTrustedProfile(selfFlagged, profile).user_metadata.archived).toBe(true);
  });

  it("a user with no profile row is returned unchanged", () => {
    expect(applyTrustedProfile(tampered, undefined)).toBe(tampered);
  });

  it("a field missing from the row is not overwritten", () => {
    const out = applyTrustedProfile(tampered, { id: EMP, role: "employee" }).user_metadata;
    expect(out.basic_salary).toBe(999999);
    expect(out.role).toBe("employee");
  });
});

/* ── listUsersCached overlays every user ────────────────────────────────── */

describe("listUsersCached", () => {
  beforeEach(() => {
    vi.resetModules();
    resetDb();
  });

  it("hands every route the profiles values, not the metadata ones", async () => {
    users.push({ id: EMP, email: "emp@sacs.test", user_metadata: { role: "admin", basic_salary: 999999 } });
    table("profiles").push({ id: EMP, role: "employee", basic_salary: 15000, rfid_uid: null, branch_id: BRANCH, employee_id: "SACS-001", archived: false });

    const { listUsersCached } = await import("../src/lib/auth/users-cache.js");
    const { createClient } = await import("@supabase/supabase-js");
    const result = await listUsersCached(createClient("https://x", "k"));

    expect(result.error).toBeNull();
    const [user] = result.data.users;
    expect(user.user_metadata.role).toBe("employee");
    expect(user.user_metadata.basic_salary).toBe(15000);
  });
});

/* ── RFID terminal ──────────────────────────────────────────────────────── */

describe("RFID scan matching", () => {
  let POST;
  let createSessionToken;
  let SESSION_COOKIE;

  function scan(body) {
    const token = createSessionToken({
      user_id: "u-admin", role: "admin", branch_id: BRANCH, email: "admin@sacs.test",
      full_name: "Branch Admin", session_id: "s-1",
    });
    return POST(new Request("https://sacs.test/api/admin/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify(body),
    }));
  }

  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-trusted-fields";
    resetDb();
    users.push({
      id: EMP,
      email: "emp@sacs.test",
      // The metadata card is what the account holder could have written.
      user_metadata: { role: "employee", full_name: "Emma Employee", employee_id: "SACS-001", rfid_uid: "METADATA-CARD", branch_id: BRANCH },
    });
    table("profiles").push(
      { id: "u-admin", role: "admin", branch_id: BRANCH },
      { id: EMP, role: "employee", full_name: "Emma Employee", email: "emp@sacs.test", branch_id: BRANCH, employee_id: "SACS-001", rfid_uid: "CARD-1", basic_salary: 15000, archived: false },
    );

    ({ POST } = await import("../src/app/api/admin/attendance/route.js"));
    ({ createSessionToken, SESSION_COOKIE } = await import("../src/lib/rbac/session.js"));
  });

  it("the kiosk accepts the registered card", async () => {
    const res = await scan({ rfid_code: "CARD-1" });
    expect(res.status).toBe(200);
    expect(table("attendance_logs")).toHaveLength(1);
  });

  it("the kiosk refuses a typed Employee ID", async () => {
    const res = await scan({ rfid_code: "SACS-001" });
    expect(res.status).toBe(404);
    expect(table("attendance_logs")).toHaveLength(0);
  });

  it("a card written only into user_metadata does not match", async () => {
    const res = await scan({ rfid_code: "METADATA-CARD" });
    expect(res.status).toBe(404);
    expect(table("attendance_logs")).toHaveLength(0);
  });

  it("the Admin portal's manual box may still use the Employee ID", async () => {
    const res = await scan({ rfid_code: "SACS-001", manual_entry: true });
    expect(res.status).toBe(200);
    expect(table("attendance_logs")).toHaveLength(1);
  });

  it("only the portal manual boxes send manual_entry, never the kiosk", () => {
    const terminal = readFileSync("public/legacy/js/terminal.js", "utf8");
    expect(terminal).not.toMatch(/manual_entry/);
    expect(readFileSync("public/legacy/js/admin.js", "utf8")).toMatch(/rfid_code: rfidCode, manual_entry: true/);
    expect(readFileSync("public/legacy/js/super-admin.js", "utf8")).toMatch(/rfid_code: rfidCode, manual_entry: true/);
  });
});
