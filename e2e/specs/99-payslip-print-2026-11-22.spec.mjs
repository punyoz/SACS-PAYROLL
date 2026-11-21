// Payslip print = PDF (2026-11-22): the Print button on Pay Record prints the
// PDF the server builds (src/lib/portal/print-pdf.js), so this fetches that
// exact URL for a Paid payslip the run made (20-payroll-flow approves October
// 1-15) and checks the two-panel layout, the year to date and one page. The
// file is saved for the print-preview PNG (scripts/checks/payslip-png.py).
// Skips when no Paid payslip exists (the spec running alone).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { main, settle } from "../support/portal.mjs";
import { db, rows } from "../support/db.mjs";
import { pdfText } from "../support/pdf-text.mjs";

const OUT = join(process.cwd(), "screenshots", "2026-11-22-payslip");

test("Print on Pay Record prints the two-panel payslip PDF (one page, totals, year to date)", async ({ page }) => {
  const runs = await rows(db().from("payroll_runs").select("id").eq("status", "approved"));
  const paid = runs.length
    ? await rows(db().from("payroll_entries").select("id,payslip_no,pay_period,net_pay").in("run_id", runs.map((r) => r.id)).neq("status", "draft").order("pay_period").limit(1))
    : [];
  test.skip(!paid.length, "needs a Paid payslip (run after 20-payroll-flow)");
  const entry = paid[0];

  await as(page, "accountant", "ac-payslips");
  await settle(page);
  await expect(main(page)).toBeVisible();
  // The URL the Print button opens (pay-record-page.jsx).
  const res = await page.request.get(`/api/accountant/payroll?format=pdf&entry_id=${encodeURIComponent(entry.id)}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/pdf");
  const pdf = await res.body();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "payslip-print-preview.pdf"), pdf);

  const text = await pdfText(pdf);
  for (const piece of ["PAYSLIP", entry.payslip_no, "Earnings", "Deductions", "Gross pay", "Total deductions", "Year to date (2026)", "Employee share only.", "Page 1 of 1"]) {
    expect(text, piece).toContain(piece);
  }
  expect(text).not.toContain("Page 2");
});
