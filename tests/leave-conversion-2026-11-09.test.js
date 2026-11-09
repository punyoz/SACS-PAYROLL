/**
 * Unused leave conversion in final pay (decision 2026-11-09 #1): off by
 * default; HR or the Super Admin switch it with a reason; when on it pays
 * min(unused days, max days) × daily rate.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table } from "./helpers/fake-supabase.js";
import { leaveConversionAmount, leaveConversionFrom } from "@/lib/payroll/leave-conversion";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

let createSessionToken;
let SESSION_COOKIE;
const who = (role, id = `u-${role}`) => ({ user_id: id, role, branch_id: role === "accountant" ? "b1" : null, email: `${id}@sacs.test`, full_name: role, session_id: `s-${id}` });
const call = (method, person, body) => {
  const request = new Request("https://sacs.test/api/payroll/leave-conversion", {
    method, headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${createSessionToken(person)}` }, body: body ? JSON.stringify(body) : undefined,
  });
  request.nextUrl = new URL(request.url);
  return request;
};

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-leave-conversion";
  resetDb();
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("the rule", () => {
  it("is off when nothing is saved; pays nothing when off", () => {
    expect(leaveConversionFrom([])).toEqual({ enabled: false, max_days: null });
    expect(leaveConversionAmount({ enabled: false }, 8, 700)).toEqual({ paid_days: 0, amount: 0 });
  });
  it("when on: unused days × daily rate, capped by the maximum days", () => {
    expect(leaveConversionAmount({ enabled: true, max_days: null }, 8, 700)).toEqual({ paid_days: 8, amount: 5600 });
    expect(leaveConversionAmount({ enabled: true, max_days: 5 }, 8, 700)).toEqual({ paid_days: 5, amount: 3500 });
  });
});

describe("PATCH /api/payroll/leave-conversion", () => {
  it("HR switches it on with a reason; audited; the Accountant cannot", async () => {
    const { PATCH, GET } = await import("@/app/api/payroll/leave-conversion/route");
    expect((await PATCH(call("PATCH", who("hr"), { enabled: true, max_days: 5 }))).status).toBe(400); // no reason
    expect((await PATCH(call("PATCH", who("hr"), { enabled: true, max_days: 5, reason: "Board resolution" }))).status).toBe(200);
    expect((await (await GET(call("GET", who("hr")))).json()).setting).toEqual({ enabled: true, max_days: 5 });
    expect(table("audit_logs").at(-1)).toMatchObject({ action: "leave_conversion_setting" });
    expect((await PATCH(call("PATCH", who("accountant"), { enabled: false, reason: "x" }))).status).toBe(403);
  });
});
