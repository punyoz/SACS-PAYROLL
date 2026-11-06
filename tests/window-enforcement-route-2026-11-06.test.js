/**
 * The processing window switch through the APIs (20261106090000):
 * /api/admin/window-enforcement is the Super Admin's alone; OFF needs a
 * reason (and, in production, confirm: true); the accountant payroll API
 * follows the database's answer (OFF: generation opens before the window;
 * ON or unreadable: refused exactly as before).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, rpc, setMissingTables, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-a";
const EMP = "u-emp";
const OCT_1 = "October 1-15, 2026";

let createSessionToken;
let SESSION_COOKIE;

function request(path, who, method = "GET", body = null) {
  const token = createSessionToken({ ...who, email: `${who.user_id}@sacs.test`, session_id: `s-${who.user_id}` });
  return new Request(`https://sacs.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const SA = { user_id: "u-sa", role: "super_admin", branch_id: null, full_name: "Sam Super" };
const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" };
const HR = { user_id: "u-hr", role: "hr", branch_id: BRANCH, full_name: "Hana HR" };
const ADMIN = { user_id: "u-admin", role: "admin", branch_id: BRANCH, full_name: "Abe Admin" };

const stateRow = (enforced, extra = {}) => ({ data: [{ enforced, stored_enforced: enforced, expired: false, expires_on: null, reason: "r", changed_by_name: "Sam Super", changed_at: "2026-10-09T02:00:00Z", today: "2026-10-09", ...extra }], error: null });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-window-enforcement";
  delete process.env.SACS_ENVIRONMENT;
  resetDb();
  setMissingTables([]);
  users.push({ id: EMP, email: `${EMP}@sacs.test`, user_metadata: { role: "employee", full_name: "Maria Santos", employee_id: "SACS-001", basic_salary: 30000, branch_id: BRANCH, position: "Teacher I" } });
  table("profiles").push({ id: "u-acct", branch_id: BRANCH }, { id: EMP, full_name: "Maria Santos", email: `${EMP}@sacs.test`, branch_id: BRANCH, payroll_hold: false });
  table("branches").push({ id: BRANCH, name: "Antipolo" });
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => {
  setMissingTables(["payroll_schedule_settings"]);
  vi.useRealTimers();
});

describe("/api/admin/window-enforcement", () => {
  for (const who of [ACCOUNTANT, HR, ADMIN]) {
    it(`${who.role}: GET and POST are refused`, async () => {
      const route = await import("@/app/api/admin/window-enforcement/route");
      expect((await route.GET(request("/api/admin/window-enforcement", who))).status).toBe(403);
      const post = await route.POST(request("/api/admin/window-enforcement", who, "POST", { enforced: false, reason: "try", confirm: true }));
      expect(post.status).toBe(403);
      expect(rpc.calls.some((c) => c.fn === "set_payroll_window_enforcement")).toBe(false);
    });
  }

  it("Super Admin: reads it", async () => {
    rpc.results.payroll_window_enforcement_state = stateRow(true);
    const route = await import("@/app/api/admin/window-enforcement/route");
    const body = await (await route.GET(request("/api/admin/window-enforcement", SA))).json();
    expect(body.available).toBe(true);
    expect(body.enforcement.enforced).toBe(true);
    expect(body.environment).toBe("production");
  });

  it("Super Admin: a reason is required", async () => {
    rpc.results.payroll_window_enforcement_state = stateRow(true);
    const route = await import("@/app/api/admin/window-enforcement/route");
    const res = await route.POST(request("/api/admin/window-enforcement", SA, "POST", { enforced: false, reason: "  ", confirm: true }));
    expect(res.status).toBe(400);
  });

  it("production: OFF needs confirm: true; then it is saved and audited", async () => {
    rpc.results.payroll_window_enforcement_state = stateRow(true);
    const route = await import("@/app/api/admin/window-enforcement/route");
    const unconfirmed = await route.POST(request("/api/admin/window-enforcement", SA, "POST", { enforced: false, reason: "Defense" }));
    expect(unconfirmed.status).toBe(409);
    expect((await unconfirmed.json()).code).toBe("confirmation_required");

    const ok = await route.POST(request("/api/admin/window-enforcement", SA, "POST", { enforced: false, reason: "Defense", expires_on: "2026-12-01", confirm: true }));
    expect(ok.status).toBe(200);
    const call = rpc.calls.find((c) => c.fn === "set_payroll_window_enforcement");
    expect(call.args).toMatchObject({ p_enforced: false, p_expires_on: "2026-12-01", p_reason: "Defense", p_actor: "u-sa", p_source: "super_admin", p_environment: "production" });
    const audit = table("audit_logs").find((row) => row.action === "payroll_window_enforcement_changed");
    expect(audit.metadata).toMatchObject({ old_value: { enforced: true }, reason: "Defense", environment: "production", confirmed: true });
  });

  it("local / demo: OFF without the confirmation", async () => {
    process.env.SACS_ENVIRONMENT = "demo";
    rpc.results.payroll_window_enforcement_state = stateRow(true);
    const route = await import("@/app/api/admin/window-enforcement/route");
    const res = await route.POST(request("/api/admin/window-enforcement", SA, "POST", { enforced: false, reason: "Demo" }));
    expect(res.status).toBe(200);
  });
});

describe("the accountant payroll API follows the switch", () => {
  async function generate() {
    const { PATCH } = await import("@/app/api/accountant/payroll/route");
    const res = await PATCH(request("/api/accountant/payroll", ACCOUNTANT, "PATCH", { action: "generate", employee_id: EMP, pay_period: OCT_1 }));
    return { status: res.status, body: await res.json() };
  }

  it("ON: Oct 9 is before the Oct 15 window: refused as before", async () => {
    rpc.results.payroll_window_enforcement_state = stateRow(true);
    const { status, body } = await generate();
    expect(status).toBe(403);
    expect(body.code).toBe("generation_window");
  });

  it("unreadable setting counts as ON", async () => {
    rpc.results.payroll_window_enforcement_state = { data: null, error: { message: "function does not exist" } };
    const { status, body } = await generate();
    expect(status).toBe(403);
    expect(body.code).toBe("generation_window");
  });

  it("OFF: the window no longer refuses; GET shows the testing banner data", async () => {
    rpc.results.payroll_window_enforcement_state = stateRow(false, { expires_on: "2026-12-01" });
    const { body } = await generate();
    expect(body.code).not.toBe("generation_window");
    const { GET } = await import("@/app/api/accountant/payroll/route");
    const view = await (await GET(request(`/api/accountant/payroll?period=${encodeURIComponent(OCT_1)}`, ACCOUNTANT))).json();
    expect(view.generation_window).toMatchObject({ state: "final", can_generate: true, enforced_state: "not_open", enforcement_off: true });
    expect(view.generation_window.window_enforcement).toEqual({ enforced: false, testing_mode: true, expires_on: "2026-12-01", banner: "Testing mode: processing window not enforced." });
    // Other roles never get the reason or who changed it.
    expect(JSON.stringify(view.generation_window.window_enforcement)).not.toContain("Sam Super");
  });
});
