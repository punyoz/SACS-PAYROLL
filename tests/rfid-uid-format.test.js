/**
 * RFID cards (POST /api/rfid/cards, 20261021030000): the UID must be the
 * card's number, digits only. The RFID terminal keeps only the digits a
 * reader types (src/app/rfid-terminal/rfid-terminal.jsx onScanChange), so a
 * UID saved with letters or spaces could never be matched at the kiosk.
 *
 * Also who reaches the card and terminal routes at all: HR, the Super Admin
 * and the branch Admin (its own branch only); never the Accountant or an
 * Employee. The database functions check the same again
 * (scripts/checks/rfid-cards-terminals-scenarios.sql).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetDb, rpc, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const MAIN = "b-main";
const NORTH = "b-north";
const PAOLO = "11111111-0000-4000-8000-0000000000a1";
const NORA = "11111111-0000-4000-8000-0000000000b1";
const who = {
  admin: { user_id: "u-adm", role: "admin", branch_id: MAIN, full_name: "Ada Admin" },
  hr: { user_id: "u-hr", role: "hr", branch_id: null, full_name: "Hana HR" },
  accountant: { user_id: "u-acct", role: "accountant", branch_id: MAIN, full_name: "Acel Accountant" },
  employee: { user_id: PAOLO, role: "employee", branch_id: MAIN, full_name: "Paolo Diaz" },
};

const ROUTES = {
  "rfid/cards": () => import("@/app/api/rfid/cards/route"),
  "rfid/terminals": () => import("@/app/api/rfid/terminals/route"),
  "admin/system": () => import("@/app/api/admin/system/route"),
};

let createSessionToken;
let SESSION_COOKIE;

async function call(as, path, method, body) {
  const token = createSessionToken({ ...as, email: `${as.user_id}@sacs.test`, session_id: `s-${as.user_id}` });
  const route = await ROUTES[path]();
  const res = await route[method](new Request(`https://sacs.test/api/${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: await res.json() };
}

const register = (uid, as = who.admin) => call(as, "rfid/cards", "POST", { action: "register", employee_id: PAOLO, uid });

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-rfid-uid-format";
  resetDb();
  users.push(
    { id: PAOLO, email: "p@sacs.test", user_metadata: { role: "employee", full_name: "Paolo Diaz", branch_id: MAIN } },
    { id: "u-adm", email: "u-adm@sacs.test", user_metadata: { role: "admin", full_name: "Ada Admin", branch_id: MAIN } },
  );
  table("branches").push({ id: MAIN, name: "Main" }, { id: NORTH, name: "North" });
  table("profiles").push(
    { id: PAOLO, role: "employee", full_name: "Paolo Diaz", branch_id: MAIN, archived: false, rfid_uid: null },
    { id: NORA, role: "employee", full_name: "Nora North", branch_id: NORTH, archived: false, rfid_uid: null },
    { id: "u-adm", role: "admin", branch_id: MAIN, archived: false },
    { id: "u-hr", role: "hr", branch_id: null, archived: false },
    { id: "u-acct", role: "accountant", branch_id: MAIN, archived: false },
  );
  table("rfid_cards").push(
    { id: "c-main", employee_id: PAOLO, branch_id: MAIN, uid: "1000000001", uid_last4: "0001", status: "active", registered_by_name: "Hana HR", registered_by_role: "hr", registered_at: "2026-10-20T00:00:00Z" },
    { id: "c-north", employee_id: NORA, branch_id: NORTH, uid: "1000000002", uid_last4: "0002", status: "active", registered_by_name: "Hana HR", registered_by_role: "hr", registered_at: "2026-10-20T00:00:00Z" },
  );
  table("rfid_terminals").push(
    { id: "t-main", name: "Main Gate", branch_id: MAIN, status: "active", created_by_name: "Ada Admin", created_by_role: "admin" },
    { id: "t-north", name: "North Gate", branch_id: NORTH, status: "active", created_by_name: "Hana HR", created_by_role: "hr" },
  );
  rpc.results.rfid_card_register = ({ p_uid }) => ({ data: { id: "c-new", status: "active", uid_last4: p_uid.slice(-4), branch_id: MAIN }, error: null });
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("RFID UID format", () => {
  it("registers a numeric card number, through the database function, as the signed-in person", async () => {
    const { status, body } = await register("0012345678");
    expect(status).toBe(200);
    expect(body.card).toMatchObject({ status: "active", uid_masked: "••••••5678" });
    expect(rpc.calls.find((c) => c.fn === "rfid_card_register").args).toMatchObject({ p_actor: "u-adm", p_employee: PAOLO, p_uid: "0012345678" });
  });

  it.each(["04A2B3C4", "12 34 56", "card-1", "12345678901234567", ""])("refuses %j, which the terminal could never match", async (uid) => {
    const { status, body } = await register(uid);
    expect(status).toBe(400);
    expect(body.error).toMatch(/digits/i);
    expect(rpc.calls.some((c) => c.fn === "rfid_card_register")).toBe(false);
  });

  it("passes the database's refusals on (duplicate card, another branch)", async () => {
    rpc.results.rfid_card_register = () => ({ data: null, error: { message: "duplicate: this card is already assigned to Nora North." } });
    expect(await register("1000000002")).toMatchObject({ status: 409, body: { error: "This card is already assigned to Nora North." } });
    rpc.results.rfid_card_register = () => ({ data: null, error: { message: "forbidden: an Admin manages RFID cards of its own branch only." } });
    expect((await register("1000000003")).status).toBe(403);
  });

  it("the old direct assignment is retired: cards go through RFID Cards", async () => {
    const { status, body } = await call(who.admin, "admin/system", "PATCH", { id: PAOLO, rfid_uid: "0012345678" });
    expect(status).toBe(410);
    expect(body.code).toBe("use_rfid_cards");
  });
});

describe("who reaches RFID cards and terminals", () => {
  it("the Accountant and an Employee are refused, reading and writing", async () => {
    for (const as of [who.accountant, who.employee]) {
      expect((await call(as, "rfid/cards", "GET")).status).toBe(403);
      expect((await register("1000000009", as)).status).toBe(403);
      expect((await call(as, "rfid/cards", "PATCH", { action: "deactivate", card_id: "11111111-0000-4000-8000-000000000001", reason: "Resigned" })).status).toBe(403);
      expect((await call(as, "rfid/terminals", "GET")).status).toBe(403);
      expect((await call(as, "rfid/terminals", "POST", { name: "Gate" })).status).toBe(403);
    }
  });

  it("an Admin sees only its own branch's cards and terminals; HR sees every branch", async () => {
    const adminCards = await call(who.admin, "rfid/cards", "GET");
    expect(adminCards.body.cards.map((c) => c.id)).toEqual(["c-main"]);
    expect(adminCards.body.cards[0]).toMatchObject({ uid_masked: "••••••0001", status_label: "Active", registered_by_role: "HR" });
    expect(JSON.stringify(adminCards.body)).not.toContain("1000000001");   // never the full number
    const adminTerminals = await call(who.admin, "rfid/terminals", "GET");
    expect(adminTerminals.body.terminals.map((t) => t.id)).toEqual(["t-main"]);
    const hrCards = await call(who.hr, "rfid/cards", "GET");
    expect(hrCards.body.cards.map((c) => c.id).sort()).toEqual(["c-main", "c-north"]);
  });

  it("an Admin's new terminal is always its own branch's, whatever it sends", async () => {
    rpc.results.rfid_terminal_save = (args) => ({ data: { id: "t-new", name: args.p_name, branch_id: args.p_branch }, error: null });
    await call(who.admin, "rfid/terminals", "POST", { name: "Side Gate", branch_id: NORTH });
    expect(rpc.calls.find((c) => c.fn === "rfid_terminal_save").args).toMatchObject({ p_actor: "u-adm", p_branch: MAIN });
  });

  it("HR adds no terminal (2026-10-26) but still renames and switches them", async () => {
    rpc.results.rfid_terminal_save = (args) => ({ data: { id: args.p_terminal || "t-new", name: args.p_name, branch_id: args.p_branch }, error: null });
    const added = await call(who.hr, "rfid/terminals", "POST", { name: "HR Gate", branch_id: MAIN });
    expect(added.status).toBe(403);
    expect(rpc.calls.filter((c) => c.fn === "rfid_terminal_save")).toHaveLength(0);
    expect(table("audit_logs").filter((row) => row.action === "rfid_terminal_added")).toHaveLength(0);

    const GATE = "00000000-0000-4000-8000-0000000000e1";
    table("rfid_terminals").push({ id: GATE, name: "Main Gate", branch_id: MAIN, status: "active", created_by_name: "Ada Admin", created_by_role: "admin" });
    const renamed = await call(who.hr, "rfid/terminals", "PATCH", { terminal_id: GATE, name: "Main Gate 1" });
    expect(renamed.status).toBe(200);
    expect(rpc.calls.find((c) => c.fn === "rfid_terminal_save").args).toMatchObject({ p_actor: "u-hr", p_terminal: GATE, p_name: "Main Gate 1" });
    const migration = readFileSync("supabase/migrations/20261026010000_hr_no_terminal_create.sql", "utf8");
    expect(migration).toMatch(/IF p_terminal IS NULL AND v_actor\.role = 'hr' THEN/);
  });
});
