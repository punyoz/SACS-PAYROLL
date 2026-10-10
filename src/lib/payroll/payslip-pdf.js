/**
 * A payslip as a one-page A4 PDF, written by hand (no dependency): the
 * portal's Content-Security-Policy allows no third-party scripts, so the PDF
 * is built on the server and downloaded.
 *
 * Text uses the PDF's built-in Helvetica in WinAnsi encoding, which has no
 * peso sign; amounts are written "PHP 1,300.00".
 */

import { money } from "@/lib/payroll/payslip-summary";
import { describeHolidayLine } from "@/lib/payroll/holiday-lines";

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;

// Helvetica advance widths (1/1000 em) for the characters right-aligned
// amounts use; anything else is approximated.
const WIDTHS = { " ": 278, ",": 278, ".": 278, "-": 333, P: 667, H: 722 };
for (const digit of "0123456789") WIDTHS[digit] = 556;

function textWidth(text, size) {
  return [...String(text)].reduce((sum, ch) => sum + (WIDTHS[ch] ?? 556), 0) * size / 1000;
}

/** Latin-1 only, PDF string escapes applied. */
function pdfText(value) {
  return String(value ?? "")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/₱/g, "PHP ")
    .replace(/[^\x20-\xff]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function clip(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…`.replace("…", "...") : text;
}

class Page {
  constructor() {
    this.ops = [];
    this.y = PAGE_H - MARGIN;
  }

  text(x, y, value, { size = 10, bold = false, gray = 0 } = {}) {
    this.ops.push(`${gray} g BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(value)}) Tj ET`);
  }

  right(xRight, y, value, options = {}) {
    this.text(xRight - textWidth(value, options.size || 10), y, value, options);
  }

  line(x1, y1, x2, y2, { width = 0.6, gray = 0.75 } = {}) {
    this.ops.push(`${gray} G ${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
  }

  rule() {
    this.line(MARGIN, this.y, PAGE_W - MARGIN, this.y);
    this.y -= 14;
  }

  heading(label) {
    this.y -= 6;
    this.text(MARGIN, this.y, label.toUpperCase(), { size: 9, bold: true, gray: 0.35 });
    this.y -= 14;
  }

  row(label, amount, { bold = false, note = "" } = {}) {
    this.text(MARGIN, this.y, label, { size: 10, bold });
    if (amount !== null && amount !== undefined) this.right(PAGE_W - MARGIN, this.y, `PHP ${money(amount)}`, { size: 10, bold });
    this.y -= 13;
    if (note) {
      this.text(MARGIN + 12, this.y, clip(note, 100), { size: 8, gray: 0.4 });
      this.y -= 12;
    }
  }

  pair(label, value, x, y) {
    this.text(x, y, label, { size: 8, gray: 0.45 });
    this.text(x, y - 12, clip(value, 42), { size: 10, bold: true });
  }
}

/**
 * Semi-monthly payslip (src/lib/payroll/semi-monthly.js): the 1st half is half
 * the monthly salary with nothing deducted; the 2nd half shows the month less
 * what the 1st half paid.
 */
/** One indented row per holiday worked, under Holiday pay. */
function holidayRows(p, lines) {
  (lines || []).forEach((line) => p.row(`   ${describeHolidayLine(line)}`, line.amount));
}

function semiMonthlyRows(p, m, holidayLines = []) {
  if (m.half === "first") {
    p.heading("Earnings - 1st half");
    p.row("Monthly salary", m.monthly_salary || 0);
    if (m.new_hire) p.row(`Paid from hire date (${m.new_hire.days} days)`, m.semi_monthly_pay || 0, { bold: true, note: m.new_hire.text });
    else p.row("Semi-monthly pay (monthly salary / 2)", m.semi_monthly_pay || 0, { bold: true });
    p.heading("Deductions");
    p.row("None this half", 0, { note: `Absences, leave, incentives, contributions and tax are settled on the ${m.second_half_label || "2nd half"} payslip.` });
    return;
  }
  const window = m.window ? ` (attendance ${m.window.start_key} to ${m.window.end_key})` : "";
  p.heading(`Month of ${m.month_label || ""}${window}`);
  if (m.new_hire) p.row(`Paid from hire date (${m.new_hire.days} days)`, m.monthly_salary || 0, { note: m.new_hire.text });
  else p.row("Monthly salary", m.monthly_salary || 0, { note: `Daily rate ${money(m.daily_rate)}, hourly ${money(m.hourly_rate)}` });
  const minus = (label, amount, note) => { if (Number(amount) > 0) p.row(`Less: ${label}`, amount, { note }); };
  const plus = (label, amount, note) => { if (Number(amount) > 0) p.row(`Add: ${label}`, amount, { note }); };
  minus(`Absences without pay (${m.absent_days || 0} days)`, m.absent_deduction);
  minus(`Leave without pay (${m.leave_without_pay_days || 0} days)`, m.leave_without_pay_deduction);
  minus("Late", m.late_deduction);
  minus("Undertime", m.undertime_deduction);
  minus("Half day", m.half_day_deduction);
  if (Number(m.leave_with_pay_days) > 0) p.row(`Leave with pay (${m.leave_with_pay_days} days) - no deduction`, null);
  plus("Incentives", Number(m.other_incentive || 0) + Number(m.attendance_incentives || 0));
  plus(`Overload pay (${m.overload_hours} h)`, m.overload_pay);
  plus("Overtime", m.overtime_pay);
  plus("Holiday pay", m.holiday_pay);
  holidayRows(p, holidayLines);
  plus("Licensed teacher subsidy", m.subsidy_pay);
  p.row("Monthly gross", m.monthly_gross || 0, { bold: true });

  p.heading("Contributions and tax");
  p.row("SSS", m.sss || 0);
  p.row("PhilHealth", m.philhealth || 0);
  p.row("Pag-IBIG", m.pagibig || 0);
  p.row("Withholding tax (monthly table)", m.withholding_tax || 0, { note: `Taxable income ${money(m.taxable_income)}` });
  minus("Loans and cash advances", m.cash_advance);
  (m.subsidy_memos || []).forEach((memo) => p.row(memo, null));
  p.row("Monthly net", m.monthly_net || 0, { bold: true });
  p.row(m.first_half_status === "final" ? "Less: paid in 1st half" : "Less: paid in 1st half (not processed)", m.first_half_paid || 0);
  minus(`Balance carried from ${m.carry_from || "last month"}`, m.carry_in);
  if (Number(m.carry_over_out) > 0) p.row("Balance carried to next month", m.carry_over_out);
}

/** The payslip (buildPayslipDetails() in the payroll route) as PDF bytes. */
export function buildPayslipPdf(details) {
  const p = new Page();
  const final = details?.status === "final";
  const generation = details?.generation || {};
  const summary = details?.attendance_summary || null;

  p.text(MARGIN, p.y, "Shepherd Angels Christian School", { size: 15, bold: true });
  p.right(PAGE_W - MARGIN, p.y, final ? "FINAL" : "DRAFT", { size: 13, bold: true, gray: final ? 0 : 0.45 });
  p.y -= 16;
  p.text(MARGIN, p.y, "Payslip - SACS Payroll Management System", { size: 10, gray: 0.35 });
  p.right(PAGE_W - MARGIN, p.y, `Payslip No. ${details?.payslip_no || "-"}`, { size: 9, gray: 0.35 });
  p.y -= 18;
  p.rule();

  const col = (PAGE_W - 2 * MARGIN) / 3;
  const employee = details?.employee || {};
  p.pair("Employee", employee.name || "-", MARGIN, p.y);
  p.pair("Employee ID", employee.id || "-", MARGIN + col, p.y);
  p.pair("Branch", employee.branch || "-", MARGIN + 2 * col, p.y);
  p.y -= 30;
  p.pair("Position", employee.position || "-", MARGIN, p.y);
  p.pair("Payroll period", details?.pay_period || "-", MARGIN + col, p.y);
  p.pair("Status", final ? "Final (locked)" : "Draft", MARGIN + 2 * col, p.y);
  p.y -= 30;
  if (!final && generation.attendance_through_label) {
    p.text(MARGIN, p.y, `Includes attendance up to ${generation.attendance_through_label}.`, { size: 9, gray: 0.35 });
    p.y -= 14;
  }
  p.rule();

  const monthly = details?.monthly || null;
  const earnings = details?.earnings || {};
  if (monthly) semiMonthlyRows(p, monthly, details?.holiday_lines);
  if (!monthly) {
    p.heading("Earnings");
    p.row("Basic pay", earnings.basic_salary || 0);
    if (Number(earnings.overtime) > 0) p.row("Overtime", earnings.overtime);
    if (Number(earnings.holiday_pay) > 0) p.row("Holiday pay", earnings.holiday_pay);
    holidayRows(p, details?.holiday_lines);
    if (Number(details?.incentives?.total_incentives) > 0) p.row("Allowances / incentives", details.incentives.total_incentives);
    p.row("Gross pay", earnings.gross_pay || 0, { bold: true });

    if (summary) {
      p.heading("Attendance summary");
      const items = [
        ["Days present", summary.days_present],
        ["Days absent", summary.days_absent],
        ["Half days", summary.half_days],
        ["Late minutes", summary.late_minutes],
        ["Undertime minutes", summary.undertime_minutes],
        ["Leave days", summary.leave_days],
      ];
      const cell = (PAGE_W - 2 * MARGIN) / 6;
      items.forEach(([label, value], index) => {
        p.text(MARGIN + index * cell, p.y, label, { size: 8, gray: 0.45 });
        p.text(MARGIN + index * cell, p.y - 13, String(value ?? 0), { size: 11, bold: true });
      });
      p.y -= 30;
    }

    p.heading("Deductions");
    const basis = Array.isArray(details?.deduction_basis) ? details.deduction_basis : [];
    if (basis.length) basis.forEach((line) => p.row(line.label, line.amount, { note: line.basis }));
    else p.row("No deductions", 0);
    p.row("Total deductions", details?.deductions?.total_deductions || 0, { bold: true });
  }

  p.y -= 4;
  p.rule();
  p.text(MARGIN, p.y, monthly ? `${monthly.half === "first" ? "1ST" : "2ND"} HALF NET PAY` : "NET PAY", { size: 12, bold: true });
  p.right(PAGE_W - MARGIN, p.y, `PHP ${money(details?.net_pay || 0)}`, { size: 14, bold: true });
  p.y -= 26;

  const by = generation.generated_by_name ? `Generated by ${generation.generated_by_name}` : "";
  const at = generation.generated_at_label ? ` on ${generation.generated_at_label}` : "";
  if (by || at) p.text(MARGIN, Math.max(p.y, MARGIN + 12), `${by}${at}`.trim(), { size: 8, gray: 0.45 });
  p.text(MARGIN, MARGIN, "Computed from attendance records (corrected values where HR / Admin corrected a day).", { size: 7, gray: 0.55 });

  const content = Buffer.from(p.ops.join("\n"), "latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let length = chunks[0].length;
  const push = (buffer) => { chunks.push(buffer); length += buffer.length; };

  objects.forEach((body, index) => {
    offsets.push(length);
    push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1"));
  });
  offsets.push(length);
  push(Buffer.concat([
    Buffer.from(`6 0 obj\n<< /Length ${content.length} >>\nstream\n`, "latin1"),
    content,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]));

  const xrefAt = length;
  const xref = ["xref", `0 ${offsets.length + 1}`, "0000000000 65535 f "]
    .concat(offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `))
    .join("\n");
  push(Buffer.from(`${xref}\ntrailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"));

  return Buffer.concat(chunks);
}
