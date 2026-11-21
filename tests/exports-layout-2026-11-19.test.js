// PDF / print / Excel / CSV output (2026-11-19): layout only, the figures are the stored ones.
// The PDFs are read back with pdfjs (tests/helpers/pdf-read.js) and measured.
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildLineGroups } from "@/lib/payroll/line-tags";
import { payslipTables } from "@/lib/payroll/payslip-tables";
import { buildPayslipPdf, payslipFileName } from "@/lib/payroll/payslip-pdf";
import { payslipStatus } from "@/lib/payroll/payslip-details";
import { pesoPdf, textWidth } from "@/lib/export/pdf-text";
import { buildReport } from "@/lib/export/report-file";
import { readPdf } from "./helpers/pdf-read";

const PAGE_W = 595;
const M = 42;
const COL = (PAGE_W - 2 * M) / 3;
const AMOUNT_RIGHT = PAGE_W - M - 6; // every Deductions-panel (right) amount ends here
// Two panels since 2026-11-22 (Earnings | Deductions, 12 pt apart): the Earnings amounts end here.
const EARNINGS_RIGHT = M + (PAGE_W - 2 * M - 12) / 2 - 6;
const MONEY = /^−?₱[\d,]+\.\d\d$/;

const LONG_NAME = "Maria Concepcion Dela Cruz-Villanueva Spring Valle"; // 50 characters

function secondHalf({ loan = 0 } = {}) {
  const g = buildLineGroups({
    half: "second",
    additions: { basic: { label: "Basic pay (2nd cutoff)", amount: 14750, formula: "₱29,500 ÷ 2" } },
    contributions: { sss: 1475, philhealth: 737.5, pagibig: 200, basis: { sss: { pct: 5, base: 29500, base_label: "salary credit" }, philhealth: { pct: 2.5, base: 29500, base_label: "basic" }, pagibig: { pct: 2, base: 10000, base_label: "fund salary cap" } } },
    taxable: { amount: 24374.87 },
    tax: { amount: 531.28, bracket: { base: 0, over: 20833, rate_pct: 15 } },
    loans: loan ? [{ kind: "loan", label: "Salary loan (Pag-IBIG MPL)", amount: loan, how: `Installment 3 of 24 = ${pesoPdf(loan)}` }] : [],
  });
  return {
    status: "final", status_label: "Paid", pay_date_label: "Nov 19, 2026", payslip_no: "PS-202611-1255", pay_period: "October 16-31, 2026",
    employee: { name: LONG_NAME, id: "DEMO-013", position: "Accountant", branch: "Spring Valley Branch" },
    line_groups: { ...g, gross: 14750, total_deductions: 2943.78 + loan },
    tax_box: {
      rows: [{ label: "Monthly basic salary", amount: 29500, sign: "" }, { label: "Attendance deductions (whole month)", amount: 2712.63, sign: "-" }, { label: "SSS, PhilHealth and Pag-IBIG", amount: 2412.5, sign: "-" }],
      taxable: 24374.87, bracket: "over ₱20,833", formula: "₱0.00 + 15% × (₱24,374.87 − ₱20,833.00) = ₱531.28", tax: 531.28,
    },
    month_total: { label: `Month total: 1st half ₱12,037.36 + 2nd half ${pesoPdf(11806.22 - loan)} = ${pesoPdf(23843.58 - loan)}` },
    net_pay: 11806.22 - loan, monthly: { half: "second" },
  };
}

/** Pairs of text boxes on one page that overlap (more than a hair). */
function overlaps(page) {
  const found = [];
  page.items.forEach((a, i) => page.items.slice(i + 1).forEach((b) => {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (w > 0.3 && h > 0.3) found.push(`${a.text} / ${b.text}`);
  }));
  return found;
}

describe("payslip PDF layout (2026-11-19, one template, embedded Noto Sans)", () => {
  it("a 50-character name wraps inside its column; nothing overlaps; amounts end at one x", async () => {
    const { pages, text } = await readPdf(await buildPayslipPdf(secondHalf({ loan: 10500 })));
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(overlaps(page)).toEqual([]);
    // The name's lines start at the margin and stay inside the first column.
    const nameLines = page.items.filter((i) => Math.abs(i.x0 - M) < 0.5 && Math.abs(i.size - 10) < 0.1 && LONG_NAME.includes(i.text));
    expect(nameLines.length).toBeGreaterThan(1);
    nameLines.forEach((i) => expect(i.x1).toBeLessThanOrEqual(M + COL - 10 + 0.5));
    expect(text).toContain("DEMO-013");
    // Every amount in a panel's Amount column (and the boxes under it) ends at that panel's x
    // (2026-11-22: two panels; the net pay box in between is left out, its amounts are larger).
    const amounts = page.items.filter((i) => MONEY.test(i.text) && i.size < 11);
    expect(amounts.length).toBeGreaterThan(12);
    amounts.forEach((i) => expect(Math.min(Math.abs(i.x1 - AMOUNT_RIGHT), Math.abs(i.x1 - EARNINGS_RIGHT)), i.text).toBeLessThan(0.5));
    // Deductions read positive (2026-11-22).
    expect(text).toContain("₱10,500.00");
    expect(text).not.toContain("−₱10,500.00");
  });

  it("2nd half: zero rows hidden, short formulas, tax computation, month total in the box, page x of y", async () => {
    const { pages, text } = await readPdf(await buildPayslipPdf(secondHalf()));
    const labels = new Set(pages[0].items.map((i) => i.text));
    ["Overtime", "Holiday pay", "Perfect attendance", "Absences", "Late", "Undertime", "Half day", "Leave without pay", "Loans / cash advance"]
      .forEach((label) => expect(labels.has(label), label).toBe(false));
    ["₱29,500 ÷ 2", "5% × ₱29,500", "2.5% × ₱29,500", "2% × ₱10,000 (cap)", "15% of excess over ₱20,833", "Monthly tax computation", "Taxable income",
      "₱24,374.87", "Month total: 1st half ₱12,037.36 + 2nd half ₱11,806.22 = ₱23,843.58", "PAID", "Nov 19, 2026", "Page 1 of 1", "₱1,475.00"]
      .forEach((piece) => expect(text, piece).toContain(piece));
    expect(text).not.toMatch(/PHP|Final \(locked\)|of taxable income|-₱/);
    expect(text).not.toContain("−₱1,475.00"); // deductions read positive (2026-11-22)
    // The month total sits inside the summary box: below the net pay, above the footer.
    const net = pages[0].items.find((i) => i.text === "₱11,806.22" && i.size > 12);
    const month = pages[0].items.find((i) => i.text.startsWith("Month total"));
    expect(month.y).toBeLessThan(net.y);
    expect(month.y).toBeGreaterThan(M + 40);
  });

  it("1st half: the note once as a plain line, no contribution or tax rows, no empty column headers", async () => {
    const g = buildLineGroups({ half: "first", additions: { basic: { amount: 14750 } } });
    const details = { status: "final", status_label: "Pending HR approval", employee: { name: "Ana" }, pay_period: "October 1-15, 2026", line_groups: { ...g, gross: 14750, total_deductions: 0 }, net_pay: 14750, monthly: { half: "first" } };
    const { pages, text } = await readPdf(await buildPayslipPdf(details));
    expect(text.match(/Government contributions and withholding tax are deducted on the 2nd-half payslip/g)).toHaveLength(1);
    ["SSS", "PhilHealth", "Pag-IBIG", "Withholding tax", "Monthly tax computation", "Notes"].forEach((label) => expect(pages[0].items.some((i) => i.text === label), label).toBe(false));
    expect(text).toContain("PENDING HR APPROVAL");
    expect(text).toContain("After HR approval");
    expect(overlaps(pages[0])).toEqual([]);
  });

  it("the screen and the PDF list the same rows (payslipTables)", async () => {
    const d = secondHalf();
    const t = payslipTables(d);
    const { text } = await readPdf(await buildPayslipPdf(d));
    [...t.earnings, ...t.deductions].forEach((r) => expect(text, r.label).toContain(r.label));
    expect(t.deductions.map((r) => r.key)).toEqual(["sss", "philhealth", "pagibig", "withholding_tax"]);
  });
});

describe("payslip status, pay date and file name", () => {
  it("labels the stored state in the employee's words (rules unchanged)", () => {
    expect(payslipStatus({ status: "draft" }).label).toBe("Draft");
    expect(payslipStatus({ status: "paid", run_id: "r", approved_at: "2026-11-19T02:00:00Z" })).toEqual({ label: "Paid", pay_date_label: "Nov 19, 2026" });
    expect(payslipStatus({ status: "paid", run_id: "r" }).label).toBe("Pending HR approval");
    expect(payslipStatus({ status: "paid", run_id: "r" }, "rejected").label).toBe("Returned by HR");
    expect(payslipStatus({ status: "paid", run_id: null }).label).toBe("Paid"); // a final pay: its own approval
  });

  it("names the file by payslip number and dates, no spaces", () => {
    expect(payslipFileName({ payslip_no: "PS-202611-1255", pay_period: "October 16-31, 2026" })).toBe("payslip-PS-202611-1255-2026-10-16-to-31.pdf");
    expect(payslipFileName({ payslip_no: "PS-1", pay_period: "November 1-15, 2026" }, true)).toBe("payslip-PS-1-2026-11-01-to-15-DRAFT.pdf");
    expect(payslipFileName({ employee_code: "E 1", pay_period: "Final pay" })).toBe("payslip-E1-Final-pay.pdf");
  });
});

describe("the embedded font", () => {
  it("one string per amount with U+2212; digits all one width (tabular)", () => {
    expect(pesoPdf(-1475)).toBe("−₱1,475.00");
    expect(pesoPdf(1475)).toBe("₱1,475.00");
    const widths = [..."0123456789"].map((d) => textWidth(d, 10));
    expect(new Set(widths).size).toBe(1);
    expect(textWidth("₱", 10)).toBeGreaterThan(0);
  });
});

/** The files in an .xlsx (a ZIP of XML parts). */
function unzip(buffer) {
  const files = {};
  let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const size = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extra = buffer.readUInt16LE(at + 28);
    const name = buffer.slice(at + 30, at + 30 + nameLength).toString("utf8");
    const start = at + 30 + nameLength + extra;
    files[name] = inflateRawSync(buffer.slice(start, start + size)).toString("utf8");
    at = start + size;
  }
  return files;
}

describe("report exports", () => {
  const report = (format, rows = [["Ana Garaña", 15000, 750], ["Ben", 12000, 600]]) => buildReport({
    format, title: "Payroll records", branch: "Main Branch", period: "Nov 1 – 15, 2026", filters: [["Status", "Paid"]],
    columns: [{ header: "Employee" }, { header: "Gross", kind: "money" }, { header: "SSS", kind: "deduction" }],
    rows, totals: true,
  });

  it("PDF: ₱ amounts, filters, record count, bold totals, page x of y; each money column ends at one x", async () => {
    const { pages, text } = await readPdf(await report("pdf"));
    ["₱15,000.00", "−₱750.00", "TOTAL", "₱27,000.00", "Status: Paid", "Records", "Page 1 of 1", "Garaña"].forEach((piece) => expect(text, piece).toContain(piece));
    expect(text).not.toContain("PHP");
    expect(overlaps(pages[0])).toEqual([]);
    const edges = (re) => new Set(pages[0].items.filter((i) => re.test(i.text)).map((i) => i.x1.toFixed(1)));
    expect(edges(/^₱[\d,]+\.\d\d$/).size).toBe(1);
    expect(edges(/^−₱[\d,]+\.\d\d$/).size).toBe(1);
  });

  it("PDF: a long report repeats the column headers on every page and numbers the pages", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`Employee ${i}`, 1000 + i, 50]);
    const { pages } = await readPdf(await report("pdf", rows));
    expect(pages.length).toBeGreaterThan(2);
    pages.forEach((page, n) => {
      expect(page.items.some((i) => i.text === "Employee"), `header on page ${n + 1}`).toBe(true);
      expect(page.items.some((i) => i.text === `Page ${n + 1} of ${pages.length}`)).toBe(true);
      expect(overlaps(page)).toEqual([]);
    });
  });

  it("Excel: title and filters above a frozen header, ₱ number format, numbers as numbers, SUM totals", async () => {
    const files = unzip(await report("xlsx"));
    const sheet = files["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain("Payroll records");
    expect(sheet).toContain("Filters: Status: Paid");
    expect(sheet).toContain("2 records");
    // 4 title lines + a blank row: the header is row 6, frozen.
    expect(sheet).toMatch(/<pane ySplit="6" topLeftCell="A7"/);
    expect(sheet).toContain('<c r="B7" s="4"><v>15000</v></c>');
    expect(sheet).toContain('<c r="C7" s="4"><v>-750</v></c>');
    expect(sheet).toContain("<f>SUM(B7:B8)</f><v>27000</v>");
    expect(files["xl/styles.xml"]).toContain('formatCode="&quot;₱&quot;#,##0.00;-&quot;₱&quot;#,##0.00"');
  });
});
