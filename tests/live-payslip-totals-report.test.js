// Read-only report (2026-11-22): do the payslips on live add up as the new
// PDF shows them? Runs only with LIVE_PAYSLIPS_JSON=<file> (the rows exported
// read-only from live) and LIVE_PAYSLIPS_OUT=<dir>; it never touches a
// database. For each payslip: the totals check (payslipTotalsCheck) and the
// PDF (one page, nothing overlapping). Only payslip numbers and employee codes
// go in the report.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPayslipDetails } from "@/lib/payroll/payslip-details";
import { payslipTables, payslipTotalsCheck } from "@/lib/payroll/payslip-tables";
import { buildPayslipPdf } from "@/lib/payroll/payslip-pdf";
import { readPdf } from "./helpers/pdf-read";

const SOURCE = process.env.LIVE_PAYSLIPS_JSON || "";
const OUT = process.env.LIVE_PAYSLIPS_OUT || "";

function asEntry(row) {
  let payroll = row.payroll;
  if (typeof payroll === "string") payroll = JSON.parse(payroll);
  payroll = payroll && typeof payroll === "object" ? payroll : {};
  return { ...row, status: String(row.status || "").toLowerCase(), payroll: { ...payroll, totals: payroll.totals || {}, deductions: payroll.deductions || {}, incentives: payroll.incentives || {} } };
}

const state = (row) => (row.run_id ? (row.run_status === "approved" ? "Paid" : `run ${row.run_status}`) : row.final_pay_status ? `final pay ${row.final_pay_status}` : "final pay (before HR approval was required)");

describe.skipIf(!SOURCE)("live payslips add up (read-only report)", () => {
  it("lists every payslip, its state, its totals check and its PDF page count", async () => {
    const parsed = JSON.parse(readFileSync(SOURCE, "utf8"));
    const list = Array.isArray(parsed) && parsed[0]?.json_agg ? parsed[0].json_agg : parsed;
    const report = [];
    for (const row of list || []) {
      const details = buildPayslipDetails(asEntry(row));
      const t = payslipTables(details);
      const mismatches = t ? payslipTotalsCheck(t, details.net_pay) : [{ what: "layout", note: "older payslip without per-line figures (one-column layout, not checked)" }];
      const { pages } = await readPdf(await buildPayslipPdf(details));
      report.push({ payslip_no: row.payslip_no, employee_code: row.employee_code, pay_period: row.pay_period, state: state(row), gross: t?.gross ?? null, total_deductions: t?.total_deductions ?? null, net_pay: details.net_pay, pdf_pages: pages.length, mismatches });
    }
    const lines = [
      "| Payslip | Employee | Period | State | Gross | Deductions | Net | PDF pages | Adds up |",
      "|---|---|---|---|---:|---:|---:|---:|---|",
      ...report.map((r) => `| ${r.payslip_no} | ${r.employee_code} | ${r.pay_period} | ${r.state} | ${r.gross ?? "—"} | ${r.total_deductions ?? "—"} | ${r.net_pay} | ${r.pdf_pages} | ${r.mismatches.length ? r.mismatches.map((m) => (m.note ? m.note : `${m.what}: shown ${m.shown}, lines ${m.lines} (${m.difference > 0 ? "+" : ""}${m.difference})`)).join("; ") : "yes"} |`),
    ];
    if (OUT) {
      writeFileSync(join(OUT, "live-payslip-totals.json"), JSON.stringify(report, null, 2));
      writeFileSync(join(OUT, "live-payslip-totals.md"), `${lines.join("\n")}\n`);
    }
    expect(report.length).toBe(list.length);
  });
});
