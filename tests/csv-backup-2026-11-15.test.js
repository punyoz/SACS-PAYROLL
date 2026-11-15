/**
 * 2026-11-15: the Super Admin's CSV backup format (src/lib/backup/csv-backup.js):
 * values, quoting, formula guard, column order, payslip amounts as stored,
 * filters, file names, and a ZIP that unzips with a README.
 */

import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  BOM, PAYSLIP_COLUMNS, backupFileName, csvCell, csvLine, label, manilaDateTime, money, parseFilters, parsePayPeriod,
  payslipAmounts, preparePayslip, readmeText, round2, rowMatches, tableColumns, writeCsvBackup,
} from "@/lib/backup/csv-backup";
import { BACKUP_GROUPS, fileKeysOf } from "@/lib/backup/full-backup";
import { TABLE_COLUMNS } from "@/lib/backup/schema";

const ctx = {
  profile: (id) => ({ p1: { code: "SACS-001", name: "Ana Peña", branch_id: "b1" } })[id],
  branchName: (id) => ({ b1: "Main Campus", b2: "North" })[id] || "",
};

function unzip(buffer) {
  const files = {};
  let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const nameLength = buffer.readUInt16LE(at + 26);
    const name = buffer.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    let end = at + 30 + nameLength;
    while (buffer.readUInt32LE(end) !== 0x08074b50) end += 1;
    files[name] = inflateRawSync(buffer.subarray(at + 30 + nameLength, end));
    at = end + 16;
  }
  return files;
}

describe("CSV values", () => {
  it("formats amounts with 2 decimals and never rounds a stored value", () => {
    expect(money(6436.8)).toBe("6436.80");
    expect(money(0)).toBe("0.00");
    expect(money(-553.16)).toBe("-553.16");
    expect(money("1379.31")).toBe("1379.31");
    expect(money(689.655)).toBe("689.655");
    expect(money(null)).toBe("");
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-1.005)).toBe(-1.01);
  });

  it("writes Manila time, words for codes, Yes/No and never null/undefined/[object Object]", () => {
    expect(manilaDateTime("2026-10-01T00:30:00+00:00")).toBe("2026-10-01 08:30:00");
    expect(csvCell("2026-10-01T16:05:09Z", "tstz")).toBe("2026-10-02 00:05:09");
    expect(csvCell("08:00:00", "time")).toBe("08:00");
    expect(label("on_time")).toBe("On Time");
    expect(label("paid")).toBe("Paid");
    expect(label("first")).toBe("1st cutoff");
    expect(label("Already Words")).toBe("Already Words");
    expect(csvCell(true, "bool")).toBe("Yes");
    for (const empty of [null, undefined]) expect(csvCell(empty, "text")).toBe("");
    expect(csvCell({ a: 1 }, "json")).toBe('"{""a"":1}"');
  });

  it("guards formulas on text only, quotes when needed, keeps leading zeros", () => {
    expect(csvCell("=1+1", "text")).toBe("'=1+1");
    for (const start of ["+63", "-x", "@SUM", "\tx", "\rx"]) expect(csvCell(start, "text").replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvCell(-5, "money")).toBe("-5.00");
    expect(csvCell('Cruz, "Ana"', "text")).toBe('"Cruz, ""Ana"""');
    expect(csvCell("0012-3456-789", "text")).toBe("0012-3456-789");
    expect(csvLine(["Peña", 6436.8], [{ kind: "text" }, { kind: "money" }])).toBe("Peña,6436.80\r\n");
  });
});

describe("Columns", () => {
  it("puts readable identifiers first and UUIDs last, with units in the headers", () => {
    const cols = tableColumns("attendance_logs");
    const headers = cols.map((c) => c.header);
    expect(headers.slice(0, 3)).toEqual(["Employee ID", "Employee name", "Branch"]);
    expect(headers).toContain("Time in (Asia/Manila)");
    expect(headers.at(-1)).toMatch(/UUID$/);
    const firstUuid = cols.findIndex((c) => c.kind === "uuid");
    expect(cols.slice(firstUuid).every((c) => c.kind === "uuid" || /UUIDs/.test(c.header) || c.key === "id")).toBe(true);
    expect(headers).toContain("Employee profile UUID");
    expect(headers).toContain("Branch UUID");
    expect(tableColumns("payroll_loans").map((c) => c.header)).toContain("Principal (PHP)");
    expect(tableColumns("payroll_loans").map((c) => c.header)).toContain("Interest %");
  });

  it("knows every backup table's columns, and no secret column", () => {
    const tables = BACKUP_GROUPS.flatMap((g) => g.tables);
    for (const t of tables) expect(TABLE_COLUMNS[t], t).toBeTruthy();
    expect(Object.values(TABLE_COLUMNS).join(",")).not.toMatch(/(_enc|code_hash|password|data_url|proof_url):/);
  });

  it("payslip file: readable first, employee and employer shares apart, UUIDs last", () => {
    const h = PAYSLIP_COLUMNS.map((c) => c.header);
    expect(h.slice(0, 4)).toEqual(["Payslip number", "Employee ID", "Employee name", "Branch"]);
    expect(h).toEqual(expect.arrayContaining(["Pay period start", "Pay period end", "SSS employee share (PHP)", "SSS employer share (PHP)", "Basic pay earned this cutoff (PHP)"]));
    expect(h).not.toContain("Basic salary");
    expect(h.slice(-7).every((x) => /UUID/.test(x))).toBe(true);
  });
});

describe("Payslip amounts as stored", () => {
  it("reads the payslip record when the amount columns were never filled (old October payslips)", () => {
    const stale = { gross_pay: 0, net_pay: 0, total_deductions: 0, sss: 0, basic_salary: 0, payroll: { totals: { gross_pay: 7499.96, net_pay: 6147.81, total_deductions: 1352.15, absence_deduction: 689.65 }, deductions: { sss: 375 } } };
    const a = payslipAmounts(stale);
    expect([a.gross_pay, a.net_pay, a.total_deductions, a.sss, a.absence_deduction]).toEqual([7499.96, 6147.81, 1352.15, 375, 689.65]);
    expect(a.monthly_salary).toBe(0); // the record never held it: the column as stored
  });

  it("uses the database's own rules: cutoff gross first, final-pay lines, net never below 0, employer shares", () => {
    const a = payslipAmounts({ gross_pay: 1, payroll: {
      monthly: { cutoff: { gross_pay: 5000 } }, totals: { gross_pay: 10000, net_pay: -3 },
      final_pay: { breakdown: { deductions: [{ kind: "sss", amount: 250.1 }, { kind: "sss", amount: 249.9 }, { kind: "pagibig", amount: 100 }] } },
      employer_contributions: { employer: { sss: 1000, sss_ec: 10, philhealth: 250, pagibig: 200, total: 1460 } },
    } });
    expect([a.gross_pay, a.net_pay, a.sss, a.pagibig, a.philhealth]).toEqual([5000, 0, 500, 100, 0]);
    expect([a.er_sss, a.er_sss_ec, a.er_total]).toEqual([1000, 10, 1460]);
  });

  it("splits the pay period into dates and a readable label", () => {
    expect(parsePayPeriod("October 16-31, 2026")).toEqual({ start: "2026-10-16", end: "2026-10-31", label: "Oct 16–31, 2026" });
    expect(parsePayPeriod("Final pay — separated 2026-10-21")).toBeNull();
  });
});

describe("Filters", () => {
  it("validates dates and branches", () => {
    expect(parseFilters({})).toEqual({ from: null, to: null, branch: null });
    expect(() => parseFilters({ from: "2026-13-01" })).toThrow(/date/);
    expect(() => parseFilters({ from: "2026-11-02", to: "2026-11-01" })).toThrow(/after/);
    expect(() => parseFilters({ branch: "x" }, new Set(["b1"]))).toThrow(/Unknown branch/);
  });

  it("filters by branch (own column or the employee's) and by the table's date column", () => {
    const f = { from: "2026-10-16", to: "2026-10-31", branch: "b1" };
    expect(rowMatches("attendance_logs", { branch_id: "b1", log_date: "2026-10-20" }, f, ctx)).toBe(true);
    expect(rowMatches("attendance_logs", { branch_id: "b2", log_date: "2026-10-20" }, f, ctx)).toBe(false);
    expect(rowMatches("attendance_logs", { branch_id: "b1", log_date: "2026-10-15" }, f, ctx)).toBe(false);
    expect(rowMatches("employee_salary_changes", { employee_id: "p1" }, f, ctx)).toBe(true);
    expect(rowMatches("payroll_tax_brackets", {}, f, ctx)).toBe(true); // no branch, no date filter: kept
    expect(rowMatches("audit_logs", { branch_id: "b1", created_at: "2026-10-31T17:00:00Z" }, f, ctx)).toBe(false); // Nov 1 in Manila
    expect(rowMatches("payroll_entries", preparePayslip({ branch_id: "b1", pay_period: "October 16-31, 2026" }), f, ctx)).toBe(true);
    expect(rowMatches("leave_requests", { branch_id: "b1", start_date: "2026-10-10", end_date: "2026-10-17" }, f, ctx)).toBe(true);
  });

  it("names files with the time, branch and range", () => {
    const at = new Date("2026-11-15T02:05:00Z");
    expect(backupFileName("everything", { at, ext: "zip" })).toBe("sacs-payroll_everything_2026-11-15_1005.zip");
    expect(backupFileName("payroll_entries", { at, filters: { branch: "b1", from: "2026-10-01", to: "2026-10-31" }, branchName: "Main Campus" }))
      .toBe("sacs-payroll_payroll_entries_2026-11-15_1005_main-campus_2026-10-01-to-2026-10-31.csv");
  });

  it("lists every group's files once", () => {
    const keys = fileKeysOf(BACKUP_GROUPS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(["users", "employees", "payroll_entries", "audit_logs"]));
  });
});

describe("Writing", () => {
  const files = () => (async function* gen() {
    const columns = [{ header: "Employee name", kind: "text", meaning: "Name." }, { header: "Net pay (PHP)", kind: "money" }];
    yield { key: "a", name: "a.csv", title: "A", columns, rows: (async function* rows() { yield ["=1+1", 6436.8]; yield ["Peña", 1]; })() };
    yield { key: "b", name: "b.csv", title: "B", columns, rows: [] };
  })();

  it("writes a ZIP of CSVs with BOM and a README with counts and checksums", async () => {
    const chunks = [];
    const summary = await writeCsvBackup(files, async (c) => { chunks.push(c); }, {
      readme: (written) => readmeText(written, { exportedAt: new Date(), exportedBy: "SA (SACS-SA)", filters: { from: null, to: null, branch: null }, version: "test", environment: "local", groups: ["A"] }),
    });
    expect(summary.files.map((f) => [f.name, f.rows])).toEqual([["a.csv", 2], ["b.csv", 0]]);
    const zip = unzip(Buffer.concat(chunks));
    expect(Object.keys(zip)).toEqual(["a.csv", "b.csv", "README.txt"]);
    const a = zip["a.csv"].toString("utf8");
    expect(a.startsWith(BOM)).toBe(true);
    expect(a).toBe(`${BOM}Employee name,Net pay (PHP)\r\n'=1+1,6436.80\r\nPeña,1.00\r\n`);
    expect(zip["b.csv"].toString("utf8")).toBe(`${BOM}Employee name,Net pay (PHP)\r\n`);
    const readme = zip["README.txt"].toString("utf8");
    expect(readme).toContain(createHash("sha256").update(zip["a.csv"]).digest("hex"));
    expect(readme).toContain("Rows: 2");
    expect(readme).toContain("Employee name - Name.");
  });

  it("writes one CSV alone when single", async () => {
    const chunks = [];
    const summary = await writeCsvBackup(files, async (c) => { chunks.push(c); }, { single: true });
    expect(summary.files).toHaveLength(1);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(`${BOM}Employee name,Net pay (PHP)\r\n'=1+1,6436.80\r\nPeña,1.00\r\n`);
  });
});
