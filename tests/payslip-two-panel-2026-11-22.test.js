// Payslip PDF and print (2026-11-22): A4 portrait, one page, Earnings |
// Deductions side by side with their totals on one line, Net pay = Gross -
// Total deductions, the 2nd-half tax computation and the year to date. Layout
// only: every amount is a stored figure, and the totals must equal the lines
// shown (a ₱0.01 difference fails here and is listed).
//
// PAYSLIP_OUT=<dir> also writes each PDF and the alignment measurements there
// (scripts/checks/payslip-png.py turns them into 200% PNGs).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLineGroups } from "@/lib/payroll/line-tags";
import { payslipTables, payslipTotalsCheck } from "@/lib/payroll/payslip-tables";
import { buildPayslipDetails, payslipYtd, thirteenthMonthDetails } from "@/lib/payroll/payslip-details";
import { buildPayslipPdf } from "@/lib/payroll/payslip-pdf";
import { pesoPdf } from "@/lib/export/pdf-text";
import { money } from "@/lib/portal/payroll-preview";
import { readPdf } from "./helpers/pdf-read";
import { crossings, readPdfRules } from "./helpers/pdf-rules";

const PAGE_W = 595;
const M = 42;
const PANEL_W = (PAGE_W - 2 * M - 12) / 2;
const EARNINGS_RIGHT = M + PANEL_W - 6;
const DEDUCTIONS_RIGHT = PAGE_W - M - 6;
const MONEY = /^−?₱[\d,]+\.\d\d$/;
const OUT = process.env.PAYSLIP_OUT || "";

const employee = (name = "Ana Reyes Santos") => ({ name, id: "SACS-014", position: "Teacher III", branch: "Main Branch", type: "Teaching · Regular · Full-time" });

function firstHalf() {
  const g = buildLineGroups({
    half: "first",
    additions: { basic: { label: "Basic pay (1st cutoff)", amount: 14750, formula: "₱29,500 ÷ 2" } },
    attendance: { absent: { days: 1, amount: 1357.14, unit: 1357.14 }, undertime: { minutes: 45, hourly: 169.64, amount: 127.23 } },
  });
  return {
    status: "final", status_label: "Paid", pay_date_label: "Oct 15, 2026", payslip_no: "PS-202610-0014", pay_period: "October 1-15, 2026", employee: employee(),
    line_groups: { ...g, gross: 14750, total_deductions: 1484.37 }, net_pay: 13265.63, monthly: { half: "first" },
    ytd: { year: "2026", gross: 281389.87, taxable: 219373.83, tax: 4781.52, sss: 13275, philhealth: 6637.5, pagibig: 1800, payslips: 19 },
  };
}

function secondHalf({ name, basic = 14750, monthly = 29500 } = {}) {
  const loan = 1250.5;
  const overtime = 1152.38;
  const substitution = 300;
  const absent = 1357.14;
  const g = buildLineGroups({
    half: "second",
    additions: {
      basic: { label: "Basic pay (2nd cutoff)", amount: basic, formula: `${pesoPdf(monthly).replace(".00", "")} ÷ 2` },
      overtime: { amount: overtime, premium_pct: 25, hourly: 184.38, minutes: 300 },
      // A STORED payslip from before the 2026-11-26 policy (₱150 a period): old lines stay readable as they were.
      // Payslips computed now carry "Overtime (substitution): 2 h × ₱183.91 × 125%, …" (tests/substitutions-2026-11-22.test.js).
      incentives: { label: "Substitute teaching (2 periods × ₱150)", amount: substitution, how: "2 periods × ₱150 = ₱300.00" },
    },
    attendance: { absent: { days: 1, amount: absent, unit: absent } },
    contributions: { sss: 1475, philhealth: 737.5, pagibig: 200, basis: { sss: { pct: 5, base: 29500, base_label: "salary credit" }, philhealth: { pct: 2.5, base: 29500, base_label: "basic" }, pagibig: { pct: 2, base: 10000, base_label: "fund salary cap" } } },
    taxable: { amount: 24374.87 },
    tax: { amount: 531.28, bracket: { base: 0, over: 20833, rate_pct: 15 } },
    loans: [{ kind: "loan", label: "Salary loan (Pag-IBIG MPL)", amount: loan, how: `Installment 3 of 24 = ${pesoPdf(loan)}` }],
  });
  const gross = Math.round((basic + overtime + substitution) * 100) / 100;
  const total = Math.round((absent + 1475 + 737.5 + 200 + 531.28 + loan) * 100) / 100;
  const net = Math.round((gross - total) * 100) / 100;
  const first = firstHalf();
  return {
    status: "final", status_label: "Paid", pay_date_label: "Nov 3, 2026", payslip_no: "PS-202610-0114", pay_period: "October 16-31, 2026", employee: employee(name),
    line_groups: { ...g, gross, total_deductions: total }, net_pay: net, monthly: { half: "second" },
    tax_box: {
      rows: [{ label: "Monthly basic salary", amount: monthly, sign: "" }, { label: "Attendance deductions (whole month)", amount: 2712.63, sign: "-" }, { label: "SSS, PhilHealth and Pag-IBIG", amount: 2412.5, sign: "-" }],
      taxable: 24374.87, bracket: "over ₱20,833", formula: "₱0.00 + 15% × (₱24,374.87 − ₱20,833.00) = ₱531.28", tax: 531.28,
    },
    month_total: { label: `Month total: 1st half ${pesoPdf(first.net_pay)} + 2nd half ${pesoPdf(net)} = ${pesoPdf(first.net_pay + net)}` },
    ytd: { year: "2026", payslips: 20, gross: 296140.25, taxable: 243748.7, tax: 5312.8, sss: 14750, philhealth: 7375, pagibig: 2000 },
  };
}

function finalPay() {
  const fp = {
    earnings: [{ kind: "salary", month_key: "2026-11", amount: 9833.33, note: "Nov 1-20: 20 days × ₱491.67" }, { kind: "thirteenth_month", amount: 22416.67 }, { kind: "subsidy", amount: 2000 },
      { kind: "leave_conversion", label: "Unused leave conversion", amount: 2950, note: "3 days × ₱983.33" }],
    deductions: [{ kind: "sss", month_key: "2026-11", amount: 1475 }, { kind: "philhealth", month_key: "2026-11", amount: 737.5 }, { kind: "pagibig", month_key: "2026-11", amount: 200 },
      { kind: "withholding_tax", month_key: "2026-11", amount: 0 }, { kind: "loan", amount: 4500, note: "Salary loan — balance 4,500.00" }],
    gross: 37200, total_deductions: 6912.5,
  };
  return {
    status: "final", status_label: "Paid", pay_type: "Final pay", pay_date_label: "Nov 28, 2026", payslip_no: "FP-2026-0003", pay_period: "Final pay (separated Nov 20, 2026)",
    employee: employee("Jose Mari Dela Paz"), final_pay: fp, earnings: {}, deductions: {}, net_pay: 30287.5,
    approval_line: "Approved by HR (Liza Manalo), Nov 27, 2026",
  };
}

function thirteenth() {
  const periods = Array.from({ length: 22 }, (_, i) => ({ pay_period: `p${i}`, basic_earned: 14500 }));
  return { ...thirteenthMonthDetails({ id: "t1", year: 2026, amount: 26583.33, basic_earned: 319000, processed_at: "2026-12-15T02:00:00Z", breakdown: { periods } }, employee()), payslip_no: "13M-2026-0014" };
}

const LONG = "Maria Concepcion Dela Cruz-Villanueva y Spring Valley Montenegro"; // 64 characters
const big = () => {
  const d = secondHalf({ name: LONG, basic: 112500.75, monthly: 225001.5 });
  return { ...d, employee: { ...d.employee, position: "School Principal and Head of the Basic Education Department" } };
};

/** Deductions above the pay: the rest is carried to next month and the net is ₱0 (live PS-202610-0013's case). */
function carried() {
  const d = secondHalf();
  const absent = 14000;
  const total = Math.round((absent + 1475 + 737.5 + 200 + 531.28 + 1250.5) * 100) / 100;
  const carry = Math.round((total - d.line_groups.gross) * 100) / 100;
  const groups = d.line_groups.groups.map((g) => ({ ...g, lines: g.lines.map((l) => (l.key === "absent" ? { ...l, amount: absent, how: `10 days × ₱1,400.00/day = ${pesoPdf(absent)}` } : l)) }));
  return { ...d, payslip_no: "PS-202610-0115", line_groups: { ...d.line_groups, groups, total_deductions: total, carry_over_out: carry }, net_pay: 0, month_total: null };
}

const CASES = { "deductions-above-pay": carried, "1st-half": firstHalf, "2nd-half": secondHalf, "final-pay": finalPay, "13th-month": thirteenth, "long-name-large-amounts": big };

async function measure(details) {
  const pdf = await buildPayslipPdf(details);
  const { pages, text } = await readPdf(pdf);
  const [rules] = await readPdfRules(pdf);
  const page = pages[0];
  const amounts = page.items.filter((i) => MONEY.test(i.text) && i.size < 11);
  const left = amounts.filter((i) => i.x1 < PAGE_W / 2);
  const right = amounts.filter((i) => i.x1 >= PAGE_W / 2);
  const spread = (list, edge) => (list.length ? Math.max(...list.map((i) => Math.abs(i.x1 - edge))) : 0);
  const range = (list) => (list.length ? Math.max(...list.map((i) => i.x1)) - Math.min(...list.map((i) => i.x1)) : 0);
  const overlaps = [];
  page.items.forEach((a, i) => page.items.slice(i + 1).forEach((b) => {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (w > 0.3 && h > 0.3) overlaps.push(`${a.text} / ${b.text}`);
  }));
  return {
    pdf, text, page, pages: pages.length, lines: rules.segments.length,
    overlaps, crossings: crossings(page.items, rules.segments),
    earnings_amounts: left.length, deductions_amounts: right.length,
    earnings_right_edge_max_off_pt: Number(spread(left, EARNINGS_RIGHT).toFixed(3)),
    deductions_right_edge_max_off_pt: Number(spread(right, DEDUCTIONS_RIGHT).toFixed(3)),
    // Amounts in one panel: farthest right edge minus nearest (0 = one x).
    earnings_right_edge_spread_pt: Number(range(left).toFixed(3)),
    deductions_right_edge_spread_pt: Number(range(right).toFixed(3)),
  };
}

describe("payslip PDF: two panels, one page, everything adds up (2026-11-22)", () => {
  const report = {};
  for (const [name, build] of Object.entries(CASES)) {
    it(`${name}: the totals equal the lines shown; one page; nothing overlaps or crosses a line; amounts end at one x per panel`, async () => {
      const details = build();
      const t = payslipTables(details);
      expect(t, name).toBeTruthy();
      expect(payslipTotalsCheck(t, details.net_pay), name).toEqual([]);
      const m = await measure(details);
      expect(m.pages).toBe(1);
      expect(m.overlaps).toEqual([]);
      expect(m.crossings).toEqual([]);
      expect(m.lines).toBeGreaterThan(10);
      expect(m.earnings_amounts).toBeGreaterThan(0);
      expect(m.earnings_right_edge_max_off_pt).toBeLessThan(0.5);
      expect(m.deductions_right_edge_max_off_pt).toBeLessThan(0.5);
      expect(m.earnings_right_edge_spread_pt).toBeLessThan(0.5);
      expect(m.deductions_right_edge_spread_pt).toBeLessThan(0.5);
      // Screen = PDF: every row the screen shows, with the same amount, is on the PDF (deductions positive).
      for (const r of [...t.earnings, ...t.incentives]) {
        expect(m.text, r.label).toContain(r.label);
        if (!r.text) expect(m.text, r.label).toContain(pesoPdf(r.amount));
      }
      for (const r of t.deductions) {
        expect(m.text, r.label).toContain(r.label);
        if (!r.text) expect(m.text, r.label).toContain(r.credit ? `−${pesoPdf(Math.abs(r.amount))}` : pesoPdf(Math.abs(r.amount)));
      }
      expect(m.text).not.toContain("Total deductions −₱");
      // Net pay = Gross − Total deductions, in the net box.
      expect(m.text).toContain(`Gross pay ${pesoPdf(t.gross)} − Total deductions ${pesoPdf(t.total_deductions)} ${t.carry_over_out ? `+ Carried to next month ${pesoPdf(t.carry_over_out)} ` : ""}=`);
      expect(m.text).toContain(pesoPdf(details.net_pay));
      expect(m.text).toContain("Employee share only. Attendance includes HR-approved corrections.");
      expect(m.text).toMatch(/Generated .+ by SACS Payroll/);
      expect(m.text).toContain("Page 1 of 1");
      // The two totals sit on one line.
      const gross = m.page.items.find((i) => i.text === "Gross pay" && i.x0 < PAGE_W / 2);
      const total = m.page.items.find((i) => i.text === "Total deductions" && i.x0 > PAGE_W / 2);
      expect(Math.abs(gross.y - total.y)).toBeLessThan(0.5);
      const { pdf, text: _t, page: _p, ...numbers } = m;
      report[name] = numbers;
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, `payslip-${name}.pdf`), pdf);
        writeFileSync(join(OUT, "alignment-measurements.json"), JSON.stringify(report, null, 2));
      }
    });
  }

  it("1st half: attendance lines only, with the deferral note", async () => {
    const { text } = await readPdf(await buildPayslipPdf(firstHalf()));
    expect(text).toContain("Government contributions and withholding tax are deducted on the 2nd-half payslip.");
    ["SSS", "PhilHealth", "Pag-IBIG", "Withholding tax", "Monthly tax computation"].forEach((label) => expect(text.split(" Government contributions and withholding")[0], label).not.toContain(` ${label} `));
    expect(text).toContain("Absences");
    expect(text).toContain("Undertime");
  });

  it("2nd half: monthly tax computation, month total, year to date; deductions grouped in order", async () => {
    const d = secondHalf();
    const { text } = await readPdf(await buildPayslipPdf(d));
    ["Monthly tax computation", "Taxable income ₱24,374.87", "Month total: 1st half", "Year to date (2026)", "Tax withheld", "125% of the hourly rate", "Substitute teaching"].forEach((piece) => expect(text, piece).toContain(piece));
    const order = ["Attendance", "Government contributions", "Tax", "Cash advances and government loans"].map((g) => text.indexOf(` ${g} `));
    order.forEach((at) => expect(at).toBeGreaterThan(0));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("final pay and 13th month use the same layout", async () => {
    for (const d of [finalPay(), thirteenth()]) {
      const { text } = await readPdf(await buildPayslipPdf(d));
      ["PAYSLIP", "Earnings", "Deductions", "Gross pay", "Total deductions", "NET PAY", "Page 1 of 1"].forEach((piece) => expect(text, piece).toContain(piece));
    }
    const { text } = await readPdf(await buildPayslipPdf(thirteenth()));
    expect(text).toContain("13th month pay");
    expect(text).toContain("Basic pay earned ₱319,000.00 ÷ 12 (22 payslips)");
    expect(text).toContain("₱26,583.33");
  });

  it("the line check finds a line through text (the check itself works)", () => {
    const text = [{ text: "Basic pay", x0: 50, x1: 100, y0: 700, y1: 709 }];
    expect(crossings(text, [{ x0: 40, x1: 300, y0: 704, y1: 704 }])).toEqual(["Basic pay × line at y 704.00"]);
    expect(crossings(text, [{ x0: 40, x1: 300, y0: 698, y1: 698 }])).toEqual([]);
    expect(crossings(text, [{ x0: 70, x1: 70, y0: 600, y1: 800 }])).toEqual(["Basic pay × line at x 70.00"]);
  });

  it("a ₱0.01 difference between a total and its lines fails loudly and is listed", () => {
    const d = secondHalf();
    const t = payslipTables({ ...d, line_groups: { ...d.line_groups, gross: d.line_groups.gross + 0.01 } });
    const found = payslipTotalsCheck(t, d.net_pay);
    expect(found.map((f) => f.what)).toEqual(["gross", "net_pay"]);
    expect(found[0].difference).toBeCloseTo(0.01, 5);
  });

  it("year to date adds up each payslip's shown lines (stored figures only)", () => {
    const entry = (half, gross, sss, tax, taxable) => ({
      id: half, employee_code: "E1", employee_name: "Ana", pay_period: half === "first" ? "October 1-15, 2026" : "October 16-31, 2026", status: "paid",
      payroll: { basic_salary: 20000, totals: { gross_pay: gross, total_deductions: sss + tax, net_pay: gross - sss - tax }, deductions: { sss, philhealth: 0, pagibig: 0, withholding_tax: tax }, incentives: {},
        monthly: half === "second" ? { half, taxable_income: taxable } : { half } },
    });
    const ytd = payslipYtd([buildPayslipDetails(entry("first", 10000, 0, 0, 0)), buildPayslipDetails(entry("second", 10000.25, 1000, 125.555, 19000))]);
    const shown = (n) => Number(pesoPdf(n).replace(/[₱,]/g, "")); // what the payslip prints for a line
    expect(ytd.gross).toBe(20000.25);
    expect(ytd.sss).toBe(1000);
    expect(ytd.tax).toBe(shown(125.555));
    expect(ytd.taxable).toBe(19000);
  });

  it("the screen formats amounts like the PDF (₱, commas, 2 decimals)", () => {
    // The app-wide screen format puts a space after ₱ ("₱ 1,475.00"); the digits are the same.
    [0, 1475, 100000.5, 1234567.891].forEach((n) => expect(money(n).replace("₱ ", "₱")).toBe(pesoPdf(n)));
  });
});
