// Attendance rules by API and SQL (no browser). Every request carries a
// saved session (storageState), so nothing signs in here.
//   branch limits · counts = rows = export for each filter · range edges ·
//   paging and order · count values (never null) · export file contents
import { inflateRawSync } from "node:zlib";
import { test, expect } from "@playwright/test";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_NORTH } from "../accounts.mjs";
import { SEED, stateFile } from "./roles.mjs";

test.describe.configure({ mode: "parallel" });

const logs = (params) => `/api/attendance/logs?${new URLSearchParams({ from: SEED.from, to: SEED.to, ...params })}`;
const json = async (res) => ({ status: res.status(), data: await res.json().catch(() => null) });
const manila = (days = 0) => new Date(Date.now() + 8 * 3600 * 1000 + days * 86400000).toISOString().slice(0, 10);

/** A tiny ZIP reader for the .xlsx: entry name -> text. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < entries; i += 1) {
    const packed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const skip = buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    files[name] = inflateRawSync(buffer.subarray(start, start + packed)).toString("utf8");
    at += 46 + nameLength + skip;
  }
  return files;
}
const dataRows = (files) => Math.max(0, ((files["xl/worksheets/sheet1.xml"] || "").match(/<row /g) || []).length - 1);
const everything = (files) => Object.values(files).join("\n");

test.describe("HR (every branch)", () => {
  test.use({ storageState: stateFile("hr") });

  test("the seeded statuses are there, labeled; rest days and future days are not counted", async ({ request }) => {
    const { status, data } = await json(await request.get(logs({ page: "1", page_size: "50", q: "Bea" })));
    expect(status).toBe(200);
    const byDay = Object.fromEntries(data.logs.map((r) => [r.log_date, r.status]));
    expect(byDay).toMatchObject({ "2026-10-22": "On Time", "2026-10-23": "Early Bird", "2026-10-26": "Undertime", "2026-10-27": "Half Day", "2026-10-28": "Incomplete", "2026-10-29": "Corrected", "2026-10-30": "On Leave" });
    expect(Object.keys(byDay)).not.toContain("2026-10-24");
    expect(Object.keys(byDay)).not.toContain("2026-10-25");
    const carlo = (await json(await request.get(logs({ page: "1", page_size: "50", q: "Carlo" })))).data;
    const holiday = carlo.logs.find((r) => r.log_date === "2026-10-28");
    expect(holiday.status).toBe("Holiday");
    // Any range reaching past today: no row after today, nothing future counted as Absent.
    const ahead = (await json(await request.get(`/api/attendance/logs?from=${manila(-5)}&to=${manila(10)}&page=1&page_size=100`))).data;
    // Only approved leave can be on file ahead of time; a future day is never Absent or "not tapped".
    expect(ahead.logs.filter((r) => r.log_date > manila(0)).every((r) => r.status === "On Leave")).toBe(true);
    expect(ahead.logs.filter((r) => r.log_date === manila(0) && r.status === "Absent").length).toBe(0);
  });

  test("for each filter: the counts, the rows and the total agree", async ({ request }) => {
    const all = (await json(await request.get(logs({ page: "1", page_size: "100" })))).data;
    const sum = Object.values(all.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(all.total);
    for (const [s, n] of Object.entries(all.counts)) {
      const one = (await json(await request.get(logs({ page: "1", page_size: "100", status: s })))).data;
      expect(one.total, `status ${s}`).toBe(n);
      expect(one.logs.every((r) => r.status === s), `rows of ${s}`).toBe(true);
    }
    const north = (await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH)))[0];
    const branch = (await json(await request.get(logs({ page: "1", page_size: "100", branch_id: north.id })))).data;
    const branchProfiles = await rows(db().from("profiles").select("id").eq("branch_id", north.id));
    const northIds = new Set(branchProfiles.map((p) => p.id));
    expect(branch.logs.every((r) => northIds.has(r.employee_id))).toBe(true);
    const day = (await json(await request.get(logs({ page: "1", page_size: "100", day: "2026-10-22" })))).data;
    expect(day.logs.every((r) => r.log_date === "2026-10-22")).toBe(true);
    expect(Object.values(day.counts).reduce((a, b) => a + b, 0)).toBe(day.total);
    const queue = (await json(await request.get(logs({ page: "1", page_size: "100", status: "unresolved" })))).data;
    expect(queue.total).toBe((all.counts.Incomplete || 0) + (all.counts["Pending Correction"] || 0));
  });

  test("range edge cases: reversed, too long, no data, future only", async ({ request }) => {
    const reversed = await json(await request.get(`/api/attendance/logs?from=${SEED.to}&to=${SEED.from}&page=1`));
    expect(reversed).toMatchObject({ status: 400, data: { code: "range_reversed", error: "The To date is before the From date." } });
    const long = await json(await request.get(`/api/attendance/logs?from=2026-08-01&to=2026-10-31&page=1`));
    expect(long.status).toBe(400);
    expect(long.data.error).toMatch(/62 days or fewer/);
    const empty = (await json(await request.get(`/api/attendance/logs?from=2025-01-04&to=2025-01-05&page=1`))).data; // a weekend before anyone was hired
    expect(empty.total).toBe(0);
    const future = (await json(await request.get(`/api/attendance/logs?from=${manila(30)}&to=${manila(40)}&page=1`))).data;
    expect(future.total).toBe(0);
    expect(future.counts).toEqual({});
  });

  test("server pages: 10, 25, 50; pages do not overlap; newest day first, then name", async ({ request }) => {
    for (const size of [10, 25, 50]) {
      const p1 = (await json(await request.get(logs({ page: "1", page_size: String(size) })))).data;
      const p2 = (await json(await request.get(logs({ page: "2", page_size: String(size) })))).data;
      expect(p1.logs.length).toBe(Math.min(size, p1.total));
      expect(p1.page_size).toBe(size);
      const ids = new Set(p1.logs.map((r) => r.id));
      expect(p2.logs.some((r) => ids.has(r.id))).toBe(false);
      const ordered = [...p1.logs, ...p2.logs];
      for (let i = 1; i < ordered.length; i += 1) {
        const [a, b] = [ordered[i - 1], ordered[i]];
        expect(a.log_date > b.log_date || (a.log_date === b.log_date && String(a.employee_name) <= String(b.employee_name)), `order at ${i}`).toBe(true);
      }
    }
  });

  test("the values behind the tab counts are numbers, never null", async ({ request }) => {
    const board = (await json(await request.get(logs({ page: "1", page_size: "10" })))).data;
    for (const [k, v] of Object.entries(board.counts)) {
      expect(["null", "undefined", ""].includes(k)).toBe(false);
      expect(Number.isInteger(v) && v >= 0, `count ${k}`).toBe(true);
    }
    expect(Array.isArray(board.blocked_taps)).toBe(true);
    expect(board.blocked_taps.some((t) => /E2E seed/.test(t.reason))).toBe(true);
    const corrections = (await json(await request.get("/api/attendance/corrections?status=pending"))).data;
    expect(Array.isArray(corrections.corrections)).toBe(true);
    expect(corrections.corrections.some((c) => /E2E seed/.test(c.reason))).toBe(true);
    const overtime = (await json(await request.get(`/api/attendance/overtime?from=${SEED.from}&to=${SEED.to}`))).data;
    expect(Array.isArray(overtime.overtime)).toBe(true);
  });

  test("the Excel and PDF files follow the filters", async ({ request }) => {
    const filtered = (await json(await request.get(logs({ page: "1", page_size: "10", status: "Incomplete", q: "Bea" })))).data;
    const xlsx = await request.get(logs({ status: "Incomplete", q: "Bea", format: "xlsx" }));
    expect(xlsx.status()).toBe(200);
    const files = unzip(Buffer.from(await xlsx.body()));
    expect(dataRows(files)).toBe(filtered.total);
    expect(everything(files)).toContain("Status: Incomplete");
    expect(everything(files)).toContain("Search: Bea");
    const pdf = await request.get(logs({ status: "Incomplete", q: "Bea", format: "pdf" }));
    expect(pdf.status()).toBe(200);
    const text = Buffer.from(await pdf.body()).toString("latin1");
    expect(text.startsWith("%PDF")).toBe(true);
    expect(text).toContain("Status: Incomplete");
  });
});

test.describe("branch limits (direct API)", () => {
  test.describe("Accountant", () => {
    test.use({ storageState: stateFile("accountant") });
    test("asking for another branch still returns its own branch only", async ({ request }) => {
      const me = await profileByEmail(ACCOUNTS.accountant.email);
      const north = (await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH)))[0];
      const { status, data } = await json(await request.get(logs({ page: "1", page_size: "100", branch_id: north.id })));
      expect(status).toBe(200);
      const ids = [...new Set(data.logs.map((r) => r.employee_id))];
      const branches = ids.length ? await rows(db().from("profiles").select("branch_id").in("id", ids)) : [];
      expect(branches.every((b) => b.branch_id === me.branch_id)).toBe(true);
    });
  });
  test.describe("Admin", () => {
    test.use({ storageState: stateFile("admin") });
    test("the board API is refused; its own branch view ignores another branch", async ({ request }) => {
      const me = await profileByEmail(ACCOUNTS.admin.email);
      const north = (await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH)))[0];
      expect((await request.get(logs({ page: "1", branch_id: north.id }))).status()).toBe(403);
      const own = (await json(await request.get(`/api/admin/branch-oversight?view=attendance&from=${SEED.from}&to=${SEED.to}&branch_id=${north.id}&page=1&page_size=100`))).data;
      const ids = [...new Set(own.logs.map((r) => r.employee_id))];
      const branches = ids.length ? await rows(db().from("profiles").select("branch_id").in("id", ids)) : [];
      expect(branches.every((b) => b.branch_id === me.branch_id)).toBe(true);
      expect(Object.values(own.counts).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(own.total);
    });
  });
  test.describe("Employee", () => {
    test.use({ storageState: stateFile("employee") });
    test("only their own records, whatever is asked", async ({ request }) => {
      const me = await profileByEmail(ACCOUNTS.employee.email);
      const north = (await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH)))[0];
      for (const extra of [{ branch_id: north.id }, { q: "Bea" }, {}]) {
        const { status, data } = await json(await request.get(`/api/attendance/logs?${new URLSearchParams({ from: "2026-10-01", to: "2026-10-31", page: "1", page_size: "100", ...extra })}`));
        expect(status).toBe(200);
        expect(data.logs.every((r) => r.employee_id === me.id), JSON.stringify(extra)).toBe(true);
      }
      expect((await request.get(logs({ format: "xlsx" }))).headers()["content-type"]).not.toContain("spreadsheet");
    });
  });
});
