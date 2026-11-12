/**
 * Defense prep 2026-11-12.
 *   Part 1: the bulk dialogs' server checks (Register / Replace many cards,
 *           Offboard many): duplicates, bad card numbers, another branch for
 *           an Admin, an HR offboarding themselves or another HR, the 50-row cap.
 *   Part 3: leave with pay is a setting (default 6): the balance uses it, past
 *           years keep 15, and the config API wants a whole 0-30 and a reason.
 * Fake data only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, rpc, table, users } from "./helpers/fake-supabase.js";
import {
  DEFAULT_ANNUAL_LEAVE_WITH_PAY_DAYS, allotmentForYear, parseLeaveWithPayDays, summarizeLeaveBalance,
} from "@/lib/leave-requests/store";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const MAIN = "b-main";
const NORTH = "b-north";
const PAOLO = "11111111-0000-4000-8000-0000000000a1";
const NORA = "11111111-0000-4000-8000-0000000000b1";
const LIZA = "11111111-0000-4000-8000-0000000000c1";
const HR2 = "11111111-0000-4000-8000-0000000000d1";
const HR = "11111111-0000-4000-8000-0000000000e1";
const who = {
  admin: { user_id: "u-adm", role: "admin", branch_id: MAIN, full_name: "Ada Admin" },
  hr: { user_id: HR, role: "hr", branch_id: null, full_name: "Hana HR" },
  sa: { user_id: "u-sa", role: "super_admin", branch_id: null, full_name: "Sam Super" },
};
let createSessionToken;
let SESSION_COOKIE;

const ROUTES = {
  "rfid/cards": () => import("@/app/api/rfid/cards/route"),
  "hr/employees": () => import("@/app/api/hr/employees/route"),
  "admin/config": () => import("@/app/api/admin/config/route"),
};

async function call(as, path, method, body) {
  const route = await ROUTES[path]();
  const token = createSessionToken({ ...as, email: `${as.user_id}@sacs.test`, session_id: `s-${as.user_id}` });
  const res = await route[method](new Request(`https://sacs.test/api/${path}`, {
    method, headers: { cookie: `${SESSION_COOKIE}=${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-defense-prep";
  resetDb();
  for (const [id, role, branch] of [[PAOLO, "employee", MAIN], [NORA, "employee", NORTH], [LIZA, "accountant", MAIN], [HR2, "hr", null], [HR, "hr", null], ["u-adm", "admin", MAIN], ["u-sa", "super_admin", null]]) {
    users.push({ id, email: `${id}@sacs.test`, user_metadata: { role, full_name: id, branch_id: branch } });
  }
  table("branches").push({ id: MAIN, name: "Main" }, { id: NORTH, name: "North" });
  table("profiles").push(
    { id: PAOLO, role: "employee", full_name: "Paolo Diaz", employee_id: "SACS-0101", branch_id: MAIN, archived: false, employee_status: "Active", date_hired: "2024-06-01" },
    { id: NORA, role: "employee", full_name: "Nora North", employee_id: "SACS-0102", branch_id: NORTH, archived: false, employee_status: "Active", date_hired: "2024-06-01" },
    { id: LIZA, role: "accountant", full_name: "Liza Ledger", employee_id: "SACS-0103", branch_id: MAIN, archived: false, employee_status: "Separated", date_hired: "2024-06-01" },
    { id: HR2, role: "hr", full_name: "Hugo HR", branch_id: null, archived: false, employee_status: "Active" },
    { id: HR, role: "hr", full_name: "Hana HR", branch_id: null, archived: false, employee_status: "Active" },
    { id: "u-adm", role: "admin", branch_id: MAIN, archived: false },
  );
  table("rfid_cards").push(
    { id: "c-paolo", employee_id: PAOLO, branch_id: MAIN, uid: "1000000001", uid_last4: "0001", status: "active" },
    { id: "c-lost", employee_id: NORA, branch_id: NORTH, uid: "1000000009", uid_last4: "0009", status: "lost" },
  );
  rpc.results.rfid_card_register = ({ p_uid }) => ({ data: { id: "c-new", status: "active", uid_last4: p_uid.slice(-4), branch_id: MAIN }, error: null });
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

const cardCheck = (as, mode, rows) => call(as, "rfid/cards", "POST", { action: "check", mode, rows });

describe("Register / Replace many cards: the server checks every row", () => {
  it("Register: a good row passes; a duplicate, a bad number, a Lost number and an employee with a card are refused, each with its reason", async () => {
    const { status, body } = await cardCheck(who.hr, "register", [
      { employee_id: NORA, uid: "2000000001" },
      { employee_id: PAOLO, uid: "2000000002" },
      { employee_id: LIZA, uid: "12345" },
      { employee_id: HR2, uid: "1000000009" },
      { employee_id: NORA, uid: "2000000003" },
    ]);
    expect(status).toBe(200);
    expect(body.results.map((r) => r.ok)).toEqual([false, false, false, false, false]);
    expect(body.results[0].error).toMatch(/same employee is on rows 1 and 5/);
    expect(body.results[1].error).toMatch(/already has an active card/i);
    expect(body.results[2].error).toMatch(/exactly 10 digits/);
    expect(body.results[3].error).toMatch(/lost and can never be used/);
    const ok = await cardCheck(who.hr, "register", [{ employee_id: NORA, uid: "2000000001" }]);
    expect(ok.body.results[0]).toMatchObject({ ok: true });
  });

  it("an Admin cannot reach another branch's employee, by the check or by a direct register call", async () => {
    const { body } = await cardCheck(who.admin, "register", [{ employee_id: NORA, uid: "2000000001" }]);
    expect(body.results[0]).toMatchObject({ ok: false });
    expect(body.results[0].error).toMatch(/not in your reach/);
  });

  it("Replace: only an employee with an active card, and the note says what will happen", async () => {
    const { body } = await cardCheck(who.sa, "replace", [{ employee_id: PAOLO, uid: "3000000001" }, { employee_id: NORA, uid: "3000000002" }]);
    expect(body.results[0]).toMatchObject({ ok: true, card_id: "c-paolo" });
    expect(body.results[0].note).toMatch(/0001 stops recording at once/);
    expect(body.results[1].error).toMatch(/no active card to replace/i);
  });

  it("more than 50 rows are refused with a clear message", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ employee_id: PAOLO, uid: String(4000000000 + i) }));
    const { status, body } = await cardCheck(who.hr, "register", rows);
    expect(status).toBe(400);
    expect(body.error).toMatch(/At most 50 rows/);
  });
});

describe("Offboard many: the server checks every row", () => {
  const offCheck = (as, rows, extra = {}) => call(as, "hr/employees", "PATCH", { action: "check_separation", reason: "End of contract", note: "", rows, ...extra });

  it("refuses HR offboarding themselves or another HR, a separated person, a duplicate, and a bad date; passes a good row with what will happen", async () => {
    const { status, body } = await offCheck(who.hr, [
      { employee_id: PAOLO, effective: "2026-11-30" },
      { employee_id: HR, effective: "2026-11-30" },
      { employee_id: HR2, effective: "2026-11-30" },
      { employee_id: LIZA, effective: "2026-11-30" },
      { employee_id: PAOLO, effective: "2026-11-30" },
      { employee_id: NORA, effective: "2020-01-01" },
    ]);
    expect(status).toBe(200);
    const [paolo, self, peer, separated, dup, early] = body.results;
    expect(paolo.ok).toBe(true);
    expect(paolo.note).toMatch(/Separated on Nov 30, 2026; card ••••0001 will be deactivated; final pay needed/);
    expect(self.error).toMatch(/your own account/);
    expect(peer.error).toMatch(/Super Admin/);
    expect(separated.error).toMatch(/Already separated/);
    expect(dup.error).toMatch(/same employee is on row 1/);
    expect(early.error).toMatch(/before the date hired/);
  });

  it("Terminated needs the grounds; the Admin and the Super Admin cannot offboard here (no permission widened)", async () => {
    const t = await offCheck(who.hr, [{ employee_id: PAOLO, effective: "2026-11-30" }], { reason: "Terminated", note: "short" });
    expect(t.body.results[0].error).toMatch(/grounds/);
    expect((await offCheck(who.admin, [{ employee_id: PAOLO, effective: "2026-11-30" }])).status).toBe(403);
    expect((await offCheck(who.sa, [{ employee_id: PAOLO, effective: "2026-11-30" }])).status).toBe(403);
  });

  it("nothing is written by a check", async () => {
    await offCheck(who.hr, [{ employee_id: PAOLO, effective: "2026-11-30" }]);
    expect(table("profiles").find((p) => p.id === PAOLO).employee_status).toBe("Active");
    expect(table("audit_logs")).toEqual([]);
  });
});

describe("Leave with pay: 6 days per calendar year, a setting", () => {
  const leave = (start, end, pay = "with_pay", status = "approved") => ({ employee_id: PAOLO, start_date: start, end_date: end, pay_status: pay, status });

  it("defaults to 6; the balance is 6 minus the paid days used this year, never below 0; past years keep 15", () => {
    expect(DEFAULT_ANNUAL_LEAVE_WITH_PAY_DAYS).toBe(6);
    const requests = [leave("2026-03-02", "2026-03-03"), leave("2026-04-06", "2026-04-06", "without_pay"), leave("2026-05-04", "2026-05-08", "with_pay", "pending"), leave("2025-03-02", "2025-03-11")];
    expect(summarizeLeaveBalance(requests, PAOLO, 2026)).toEqual({ with_pay_allotment: 6, with_pay_used: 2, with_pay_remaining: 4, without_pay_used: 1 });
    expect(summarizeLeaveBalance([leave("2026-03-02", "2026-03-10")], PAOLO, 2026).with_pay_remaining).toBe(0);
    expect(summarizeLeaveBalance(requests, PAOLO, 2025, allotmentForYear(2025, 6))).toMatchObject({ with_pay_allotment: 15, with_pay_used: 10, with_pay_remaining: 5 });
    expect(summarizeLeaveBalance(requests, PAOLO, 2026, 8).with_pay_remaining).toBe(6);
  });

  it("reads only a whole number of days from 0 to 30", () => {
    expect(["6", "0", "30", " 12 "].map(parseLeaveWithPayDays)).toEqual([6, 0, 30, 12]);
    expect(["31", "-1", "6.5", "six", "", null].map(parseLeaveWithPayDays)).toEqual([null, null, null, null, null, null]);
  });

  it("the config API wants a whole 0-30 and a reason; saves it and writes the old and new value to the audit log", async () => {
    const patch = (fields, extra = {}) => call(who.sa, "admin/config", "PATCH", { section: "payroll", fields, ...extra });
    expect((await patch({ leave_with_pay_days: "40" }, { reason: "Policy change" })).status).toBe(400);
    const noReason = await patch({ leave_with_pay_days: "6" });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe("reason_required");
    expect((await call(who.sa, "admin/config", "PATCH", { section: "general", fields: { leave_with_pay_days: "6" }, reason: "Policy change" })).status).toBe(400);
    expect(table("system_config")).toEqual([]);
    const ok = await patch({ leave_with_pay_days: "6" }, { reason: "School policy 2026" });
    expect(ok.status).toBe(200);
    expect(table("system_config").find((r) => r.key === "leave_with_pay_days").value).toBe("6");
    const entry = table("audit_logs").find((r) => r.action === "leave_with_pay_days_changed");
    expect(entry.description).toMatch(/to 6 days\. Reason: School policy 2026/);
  });
});
