/**
 * 2026-11-08 batch:
 *   - the hourly rate is always the daily rate ÷ 8 (peso rounding), its
 *     history follows the daily rate's dates, typed hourly versions are kept
 *     but superseded, branch rates never leak, undertime = minutes ÷ 60 ×
 *     (daily ÷ 8) everywhere;
 *   - the rates routes refuse a typed hourly rate and a daily change without
 *     a reason; the read-only pay-rates route scopes the Admin to its branch;
 *   - the streaming Excel writer writes a valid workbook;
 *   - the Super Admin's payroll CSV quoting and the backup groups.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { inflateRawSync } from "node:zlib";
import { resetDb, table } from "./helpers/fake-supabase.js";
import {
  branchPayRates, derivedHourlyHistory, hourlyFromDaily, rateHistory, resolveRates, typedHourlyVersions, validateRateInput,
} from "@/lib/payroll/rates";
import { hourlyRateFor } from "@/lib/payroll/semi-monthly";
import { computeAttendancePay } from "@/lib/payroll/attendance-pay";
import { crc32Update, writeXlsx, MAX_CELL_CHARS } from "@/lib/export/xlsx-stream";
import { csvField, PAYROLL_EXPORT_COLUMNS } from "@/lib/backup/payroll-export";
import { BACKUP_GROUPS, pickGroups } from "@/lib/backup/full-backup";
import { can } from "@/lib/rbac/permissions";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

// The live rows of 2026-11-08 (payroll_rate_configs), with made-up ids.
const LIVE = [
  { id: "d0", rate_type: "daily", scope: "global", scope_ref: null, value: 550, effective_date: "2026-01-01", created_at: "2026-09-26T00:33:37Z", created_by_name: "System default" },
  { id: "d1", rate_type: "daily", scope: "global", scope_ref: null, value: 600, effective_date: "2026-10-01", created_at: "2026-09-28T05:27:30Z", created_by_name: "Super Administrator" },
  { id: "d2", rate_type: "daily", scope: "global", scope_ref: null, value: 900, effective_date: "2026-11-16", created_at: "2026-11-05T09:18:06Z", created_by_name: "Super Administrator" },
  { id: "b1", rate_type: "daily", scope: "branch", scope_ref: "branch-a", value: 525, effective_date: "2026-10-01", created_at: "2026-09-28T05:27:08Z", created_by_name: "Super Administrator" },
  { id: "h0", rate_type: "hourly", scope: "global", scope_ref: null, value: 68.75, effective_date: "2026-01-01", created_at: "2026-09-26T00:33:37Z", created_by_name: "System default" },
  { id: "h1", rate_type: "hourly", scope: "global", scope_ref: null, value: 75, effective_date: "2026-10-01", created_at: "2026-09-28T05:28:58Z", created_by_name: "Super Administrator" },
  { id: "h2", rate_type: "hourly", scope: "global", scope_ref: null, value: 72, effective_date: "2026-10-16", created_at: "2026-10-13T08:15:43Z", created_by_name: "Super Administrator" },
  { id: "w1", rate_type: "working_days_per_year", scope: "global", scope_ref: null, value: 261, effective_date: "2026-10-01", created_at: "2026-10-09T14:49:03Z" },
];

describe("Hourly rate = daily rate ÷ 8, peso rounding", () => {
  it("matches the examples shown in the dialog", () => {
    expect(hourlyFromDaily(700)).toBe(87.5);
    expect(hourlyFromDaily(650)).toBe(81.25);
    expect(hourlyFromDaily(600)).toBe(75);
    expect(hourlyFromDaily(900)).toBe(112.5);
    // Does not divide evenly: roundPeso, half away from zero.
    expect(hourlyFromDaily(611)).toBe(76.38);
    expect(hourlyFromDaily(1379.31)).toBe(172.41);
  });

  it("is the same figure as the semi-monthly payslip's hourly rate", () => {
    for (const daily of [525, 550, 600, 611, 689.65, 689.66, 781.61, 850.57, 919.54, 1379.31]) {
      expect(hourlyFromDaily(daily)).toBe(hourlyRateFor(daily));
    }
  });

  it("is never typed: refused for every date and scope; a daily rate must be more than 0", () => {
    for (const effective of ["2026-09-16", "2026-10-01", "2027-01-01"]) {
      expect(validateRateInput({ rate_type: "hourly", scope: "global", value: 80, effective_date: effective })).toMatch(/daily rate ÷ 8/);
    }
    expect(validateRateInput({ rate_type: "daily", scope: "global", value: 0, effective_date: "2026-12-01" })).toMatch(/more than ₱0/);
    expect(validateRateInput({ rate_type: "daily", scope: "branch", scope_ref: "branch-a", value: 700, effective_date: "2026-12-01" })).toBeNull();
  });
});

describe("Hourly history follows the daily history", () => {
  it("has the daily rate's dates, each version ÷ 8", () => {
    const daily = rateHistory(LIVE, "daily", "global");
    const hourly = derivedHourlyHistory(LIVE, "global");
    expect(hourly.map((v) => [v.effective_date, v.until, v.value])).toEqual([
      ["2026-01-01", "2026-09-30", 68.75],
      ["2026-10-01", "2026-11-15", 75],
      ["2026-11-16", null, 112.5],
    ]);
    expect(hourly.map((v) => [v.effective_date, v.until])).toEqual(daily.map((v) => [v.effective_date, v.until]));
  });

  it("keeps the hand-typed hourly versions, marked with what became of them", () => {
    const typed = typedHourlyVersions(LIVE);
    expect(typed.map((t) => [t.value, t.effective_date, t.status])).toEqual([
      [68.75, "2026-01-01", "in_force_before_rule"],
      [75, "2026-10-01", "superseded"],
      [72, "2026-10-16", "superseded"],
    ]);
    expect(typed[2].status_label).toMatch(/Superseded: now automatic/);
  });

  it("payroll never reads the typed ₱72 / ₱75: it uses the daily rate ÷ 8", () => {
    for (const start of ["2026-10-16", "2026-11-01"]) {
      const r = resolveRates(LIVE, {}, start);
      expect(r.hourly.value).toBe(75);
      expect(r.hourly.source).toBe("derived");
    }
    expect(resolveRates(LIVE, {}, "2026-11-16").hourly.value).toBe(112.5);
  });
});

describe("Branch daily rates", () => {
  const BRANCHES = [{ id: "branch-a", name: "Main" }, { id: "branch-b", name: "Annex" }];
  it("derives each branch's hourly rate; a branch without its own rate uses the system default", () => {
    const rows = branchPayRates(LIVE, BRANCHES, "2026-11-01", "2026-11-16");
    const main = rows.find((b) => b.branch_id === "branch-a");
    const annex = rows.find((b) => b.branch_id === "branch-b");
    expect([main.current.value, main.hourly_current, main.uses_default]).toEqual([525, 65.63, false]);
    expect([annex.current.value, annex.hourly_current, annex.uses_default]).toEqual([600, 75, true]);
    // Main's own rate never reaches Annex, now or next period.
    expect([annex.next_period.value, annex.hourly_next]).toEqual([900, 112.5]);
    expect([main.next_period.value, main.hourly_next]).toEqual([525, 65.63]);
  });

  it("a new branch rate changes only that branch", () => {
    const configs = [...LIVE, { id: "b2", rate_type: "daily", scope: "branch", scope_ref: "branch-b", value: 700, effective_date: "2026-12-01", created_at: "2026-11-08T00:00:00Z" }];
    const rows = branchPayRates(configs, BRANCHES, "2026-12-01", "2026-12-16");
    expect(rows.find((b) => b.branch_id === "branch-b").hourly_current).toBe(87.5);
    expect(rows.find((b) => b.branch_id === "branch-a").current.value).toBe(525);
  });
});

describe("Undertime = minutes ÷ 60 × (daily ÷ 8), by hand", () => {
  const RULES = [
    { id: "x1", rate_type: "half_day_pct", scope: "global", value: 50, effective_date: "2026-01-01" },
    { id: "x2", rate_type: "absent_pct", scope: "global", value: 100, effective_date: "2026-01-01" },
  ];
  const undertime = (configs, who, minutes, start = "2026-12-01") => {
    const rates = resolveRates([...configs, ...RULES], who, start);
    const pay = computeAttendancePay({
      logs: [{ id: "l1", log_date: start, status: "Present", undertime_minutes: minutes, late_minutes: 0 }],
      rates, periodStart: start, periodEnd: start,
    });
    return { hourly: rates.hourly.value, amount: pay.amounts.undertime };
  };

  it("an employee with a salary on file: 30,000 × 12 ÷ 261 = 1,379.31 a day; 172.41 an hour; 45 min = 129.31", () => {
    expect(undertime(LIVE, { employeeId: "e1", branchId: "branch-a", monthlySalary: 30000 }, 45)).toEqual({ hourly: 172.41, amount: 129.31 });
  });

  it("no salary, a branch rate: 525 ÷ 8 = 65.63; 30 min = 32.82", () => {
    expect(undertime(LIVE, { employeeId: "e2", branchId: "branch-a" }, 30)).toEqual({ hourly: 65.63, amount: 32.82 });
  });

  it("no salary, the system default after a change to ₱700: 87.50 an hour; 20 min = 29.17", () => {
    const configs = [...LIVE, { id: "d3", rate_type: "daily", scope: "global", value: 700, effective_date: "2026-12-01", created_at: "2026-11-08T00:00:00Z" }];
    expect(undertime(configs, { employeeId: "e3", branchId: "branch-b" }, 20)).toEqual({ hourly: 87.5, amount: 29.17 });
    // The period before the change keeps the old rate.
    expect(undertime(configs, { employeeId: "e3", branchId: "branch-b" }, 20, "2026-11-16")).toEqual({ hourly: 112.5, amount: 37.5 });
  });
});

/* ── Routes ─────────────────────────────────────────────────────────────── */

let createSessionToken;
let SESSION_COOKIE;
function requestAs({ userId, role, branchId = null, fullName = "Tester" }, url, method = "GET", body) {
  const token = createSessionToken({ user_id: userId, role, branch_id: branchId, email: `${userId}@sacs.test`, full_name: fullName, session_id: "s-1" });
  return new Request(`https://sacs.test${url}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Rates routes", () => {
  const SUPER = { userId: "u-sa", role: "super_admin", fullName: "Sam Super" };
  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-2026-11-08";
    resetDb();
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("refuses a typed hourly rate with a clear message and code", async () => {
    const { POST } = await import("@/app/api/admin/payroll-rates/route");
    const response = await POST(requestAs(SUPER, "/api/admin/payroll-rates", "POST", { rate_type: "hourly", scope: "global", value: 80, effective_date: "2026-12-01", note: "x" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "hourly_rate_derived", error: expect.stringMatching(/daily rate ÷ 8/) });
    expect(table("payroll_rate_configs")).toHaveLength(0);
  });

  it("needs a reason for a daily change, and logs old → new for daily and hourly", async () => {
    table("payroll_rate_configs").push(...LIVE.filter((r) => r.rate_type === "daily" && r.scope === "global"));
    const { POST } = await import("@/app/api/admin/payroll-rates/route");
    const missing = await POST(requestAs(SUPER, "/api/admin/payroll-rates", "POST", { rate_type: "daily", scope: "global", value: 700, effective_date: "2026-12-01" }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe("reason_required");

    const saved = await POST(requestAs(SUPER, "/api/admin/payroll-rates", "POST", { rate_type: "daily", scope: "global", value: 700, effective_date: "2026-12-01", note: "Board resolution" }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).hourly_rate).toBe(87.5);
    const entry = table("audit_logs").find((l) => l.action === "rate_version");
    expect(entry.metadata).toMatchObject({ previous_value: 900, value: 700, reason: "Board resolution", hourly: { previous_hourly: 112.5, new_hourly: 87.5 } });
  });

  it("shows the hourly row as automatic, with history from the daily rate and the typed rows superseded", async () => {
    table("payroll_rate_configs").push(...LIVE);
    const { GET } = await import("@/app/api/admin/payroll-rates/route");
    const body = await (await GET(requestAs(SUPER, "/api/admin/payroll-rates"))).json();
    const hourly = body.rates.find((r) => r.rate_type === "hourly");
    expect(hourly).toMatchObject({ derived: true, editable: false });
    expect(hourly.history.map((v) => v.value)).toEqual([68.75, 75, 112.5]);
    expect(hourly.typed_versions.filter((t) => t.status === "superseded").map((t) => t.value)).toEqual([75, 72]);
  });

  it("pay rates are read-only for every role; Admin and Accountant see only their own branch", async () => {
    table("payroll_rate_configs").push(...LIVE);
    table("branches").push({ id: "branch-a", name: "Main", status: "Active" }, { id: "branch-b", name: "Annex", status: "Active" });
    table("profiles").push(
      { id: "u-adm", role: "admin", branch_id: "branch-a", archived: false },
      { id: "u-ac", role: "accountant", branch_id: "branch-b", archived: false },
    );
    const route = await import("@/app/api/payroll/pay-rates/route");
    const admin = await (await route.GET(requestAs({ userId: "u-adm", role: "admin", branchId: "branch-a" }, "/api/payroll/pay-rates"))).json();
    expect(admin.branches.map((b) => b.name)).toEqual(["Main"]);
    expect(admin.branches[0]).toMatchObject({ hourly_current: 65.63, uses_default: false });
    const accountant = await (await route.GET(requestAs({ userId: "u-ac", role: "accountant", branchId: "branch-b" }, "/api/payroll/pay-rates"))).json();
    expect(accountant.branches.map((b) => b.name)).toEqual(["Annex"]);
    expect(accountant.default.hourly.current.value).toBe(hourlyFromDaily(accountant.default.daily.current.value));
    const employee = await route.GET(requestAs({ userId: "u-emp", role: "employee", branchId: "branch-a" }, "/api/payroll/pay-rates"));
    expect(employee.status).toBe(403);
    expect((await route.POST(requestAs(SUPER, "/api/payroll/pay-rates", "POST", {}))).status).toBe(405);
    for (const role of ["admin", "hr", "accountant", "employee"]) expect(can(role, "system_configuration", "create")).toBe(false);
  });
});

/* ── Streaming Excel writer ─────────────────────────────────────────────── */

/** A tiny ZIP reader for the test: name -> text, checking each CRC. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i += 1) {
    const crc = buffer.readUInt32LE(at + 16);
    const packed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30);
    const comment = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const data = inflateRawSync(buffer.subarray(start, start + packed));
    expect(crc32Update(0, data), name).toBe(crc);
    files[name] = data.toString("utf8");
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

describe("Streaming Excel writer", () => {
  it("writes a valid workbook: sheets, rows, numbers, long cells in parts", async () => {
    const chunks = [];
    const longJson = "x".repeat(MAX_CELL_CHARS + 500);
    const summary = await writeXlsx(async function* sheets() {
      yield { key: "a", name: "Payroll", columns: [{ header: "Name" }, { header: "Net", money: true }, { header: "JSON", parts: 2 }],
        rows: (async function* rows() { for (let i = 0; i < 2500; i += 1) yield [`Emp <${i}> & "co"`, 1379.31 + i, i === 0 ? longJson : { i }]; })() };
      yield { key: "b", name: "Payroll", columns: [{ header: "Only" }], rows: [["one"]] };
    }, async (chunk) => { chunks.push(chunk); });
    expect(summary.sheets.map((s) => [s.name, s.rows])).toEqual([["Payroll", 2500], ["Payroll (2)", 1]]);
    const files = unzip(Buffer.concat(chunks));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "[Content_Types].xml", "xl/styles.xml"]));
    const sheet = files["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain("Emp &lt;0&gt; &amp; &quot;co&quot;");
    expect(sheet).toContain('<c r="B2" s="2"><v>1379.31</v></c>');
    expect(sheet).toContain("JSON (part 2)");
    expect((sheet.match(/<row /g) || []).length).toBe(2501);
    expect(files["xl/workbook.xml"]).toContain('name="Payroll (2)"');
  });
});

describe("Super Admin payroll export file", () => {
  it("keeps amounts as stored and neutralises formula-looking text", () => {
    expect(csvField(1379.31, "money")).toBe("1379.31");
    expect(csvField(-5, "money")).toBe("-5");
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField('Cruz, "Ana"')).toBe('"Cruz, ""Ana"""');
    expect(PAYROLL_EXPORT_COLUMNS.map(([, field]) => field)).toEqual(expect.arrayContaining(["gross_pay", "total_deductions", "net_pay", "branch_name", "pay_period"]));
  });
});

describe("Full backup groups", () => {
  it("covers the ten groups and refuses an unknown one", () => {
    expect(BACKUP_GROUPS.map((g) => g.key)).toEqual(["users", "employees", "attendance", "leave", "payroll", "benefits", "rates", "branches", "announcements", "audit"]);
    expect(pickGroups(["all"])).toHaveLength(10);
    expect(pickGroups(["payroll"]).map((g) => g.key)).toEqual(["payroll"]);
    expect(() => pickGroups(["secrets"])).toThrow(/Unknown backup group/);
    const tables = BACKUP_GROUPS.flatMap((g) => g.tables);
    for (const secret of ["auth_email_otps", "auth_throttle", "notifications"]) expect(tables).not.toContain(secret);
  });

  it("is the Super Admin's alone", () => {
    for (const role of ["admin", "hr", "accountant", "employee"]) expect(can(role, "backup_recovery", "read"), role).toBe(false);
    expect(can("super_admin", "backup_recovery", "create")).toBe(true);
    // Never an Accountant action for the Super Admin.
    expect(can("super_admin", "process_payroll", "read")).toBe(false);
  });

  it("the Super Admin posts announcements; the Admin keeps its branch scope", () => {
    expect(can("super_admin", "announcements", "create")).toBe(true);
    expect(can("accountant", "announcements", "create")).toBe(false);
    expect(can("employee", "announcements", "create")).toBe(false);
  });
});
