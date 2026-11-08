/**
 * Positions (alpha test B3, 20261109050000): HR picks from a list and adds to
 * it; the list never repeats a position, whatever the capitals or spaces.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetDb, table } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

let createSessionToken;
let SESSION_COOKIE;
const HR = { user_id: "u-hr", role: "hr", branch_id: null, email: "hr@sacs.test", full_name: "Hana HR", session_id: "s-hr" };

function call(method, body, who = HR) {
  const token = createSessionToken(who);
  const request = new Request("https://sacs.test/api/hr/positions", {
    method, headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` }, body: body ? JSON.stringify(body) : undefined,
  });
  request.nextUrl = new URL(request.url);
  return request;
}

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-positions";
  resetDb();
  table("employee_positions").push({ id: "p1", name: "Employee" }, { id: "p2", name: "Teacher I" });
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("the positions list", () => {
  it("HR adds a new position; the same one in other capitals / spaces is refused with the existing spelling", async () => {
    const { POST, GET } = await import("@/app/api/hr/positions/route");
    const added = await POST(call("POST", { name: "  Guidance   Counselor " }));
    expect(added.status).toBe(200);
    expect((await added.json()).name).toBe("Guidance Counselor");
    const dup = await POST(call("POST", { name: "teacher  i" }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: "duplicate", name: "Teacher I" });
    expect((await (await GET(call("GET"))).json()).positions).toEqual(["Employee", "Guidance Counselor", "Teacher I"]);
    expect(table("audit_logs").filter((l) => l.action === "position_added")).toHaveLength(1);
  });

  it("refuses an empty, too long or odd position", async () => {
    const { POST } = await import("@/app/api/hr/positions/route");
    for (const name of ["", "x", "y".repeat(81), "<script>"]) expect((await POST(call("POST", { name }))).status, name).toBe(400);
  });

  it("an employee is saved with the existing spelling; a new one is added once; HR accounts stay HR Officer", async () => {
    const { resolvePosition } = await import("@/lib/hr/positions");
    const { getServiceClient } = await import("@/lib/supabase/admin");
    const db = getServiceClient();
    const fallback = (input, role) => (role === "hr" ? "HR Officer" : role === "accountant" ? "Accountant" : "Employee");
    expect(await resolvePosition(db, "TEACHER I", "employee", fallback, {})).toEqual({ name: "Teacher I", created: false });
    expect(await resolvePosition(db, "Registrar", "employee", fallback, {})).toEqual({ name: "Registrar", created: true });
    expect(await resolvePosition(db, "registrar", "accountant", fallback, {})).toEqual({ name: "Registrar", created: false });
    expect(await resolvePosition(db, "", "accountant", fallback, {})).toEqual({ name: "Accountant" });
    expect(await resolvePosition(db, "Teacher I", "hr", fallback, {})).toEqual({ name: "HR Officer" });
    expect(table("employee_positions").map((p) => p.name).sort()).toEqual(["Employee", "Registrar", "Teacher I"]);
  });

  it("the Accountant and Employee cannot add positions (proxy)", async () => {
    const { proxy } = await import("@/proxy");
    for (const role of ["accountant", "employee"]) {
      expect((await proxy(call("POST", { name: "Clerk" }, { ...HR, user_id: `u-${role}`, role, branch_id: "b1" }))).status, role).toBe(403);
    }
  });

  it("the database refuses a second spelling of the same position", () => {
    const sql = readFileSync("supabase/migrations/20261109050000_employee_positions.sql", "utf8");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS employee_positions_name_folded_key");
    expect(sql).toContain(String.raw`lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))`);
    expect(sql).toContain("REVOKE ALL ON public.employee_positions FROM anon, authenticated;");
  });
});
