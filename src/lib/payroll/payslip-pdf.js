/**
 * A payslip as an A4 PDF (one page, more when long), written by hand (no
 * dependency): the portal's Content-Security-Policy allows no third-party
 * scripts, so the PDF is built on the server and downloaded.
 *
 * Text uses the PDF's built-in Helvetica in WinAnsi encoding, which has no
 * peso sign: amounts are drawn with a real ₱ (a "P" crossed by two strokes,
 * PdfPages.peso), deductions below zero (-₱1,000.00).
 *
 * The school seal, when given, is a JPEG embedded as it is (DCTDecode, no
 * decoding needed): public/brand/seal-payslip.jpg, read by the payroll route.
 */

import { money } from "@/lib/payroll/payslip-summary";
import { contributionLabel, withholdingTaxLabel } from "@/lib/payroll/statutory";
import { describeHolidayLine } from "@/lib/payroll/holiday-lines";
import { DEFAULT_ORG_NAME, systemName } from "@/lib/org-name-format";

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;

// Helvetica advance widths (1/1000 em) for the characters right-aligned
// amounts use; anything else is approximated.
const WIDTHS = { " ": 278, ",": 278, ".": 278, "-": 333, P: 667, H: 722 };
for (const digit of "0123456789") WIDTHS[digit] = 556;

export function textWidth(text, size) {
  return [...String(text)].reduce((sum, ch) => sum + (WIDTHS[ch] ?? 556), 0) * size / 1000;
}

/** Latin-1 only, PDF string escapes applied. */
export function pdfText(value) {
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

/**
 * Width, height and colour components of a baseline or progressive JPEG,
 * from its start-of-frame marker; null for anything else.
 */
export function jpegInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < buffer.length) {
    if (buffer[at] !== 0xff) return null;
    const marker = buffer[at + 1];
    const size = buffer.readUInt16BE(at + 2);
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7), components: buffer[at + 9] };
    }
    at += 2 + size;
  }
  return null;
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

  /** Draws image /Im1 with its lower-left corner at (x, y). */
  image(x, y, width, height) {
    this.ops.push(`q ${width} 0 0 ${height} ${x} ${y} cm /Im1 Do Q`);
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

/** A per-cutoff payslip (monthly.cutoff): every earning and deduction on its own line. */
function cutoffRows(p, c, holidayLines = []) {
  const range = c.window ? ` (attendance ${c.window.start_key} to ${c.window.end_key})` : "";
  p.heading(`Earnings - ${c.half === "first" ? "1st" : "2nd"} cutoff${range}`);
  c.earnings.forEach((line) => {
    p.row(line.label, line.amount, { note: line.note || "" });
    if (line.label === "Holiday pay") holidayRows(p, holidayLines);
  });
  p.row("Gross pay", c.gross_pay || 0, { bold: true });
  p.heading("Deductions");
  if (Number(c.leave_with_pay_days) > 0) p.row(`Leave with pay (${c.leave_with_pay_days} days) - no deduction`, null);
  if (!c.deductions.length) p.row("No deductions", 0);
  // A credit (the year-end tax refund) is added to the pay: shown negative here.
  c.deductions.forEach((line) => p.row(line.credit ? `${line.label} - added to pay` : line.label, line.credit ? -line.amount : line.amount, { note: line.note || "" }));
  p.row("Total deductions", c.total_deductions || 0, { bold: true });
  if (c.half === "first") p.row("Tax, SSS, PhilHealth, Pag-IBIG and loans are deducted on the 2nd cutoff payslip.", null);
  if (Number(c.carry_over_out) > 0) p.row("Balance carried to next month", c.carry_over_out);
}

function semiMonthlyRows(p, m, holidayLines = []) {
  if (m.cutoff) {
    cutoffRows(p, m.cutoff, holidayLines);
    return;
  }
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
  p.row(contributionLabel("SSS", m.contribution_basis?.sss), m.sss || 0);
  p.row(contributionLabel("PhilHealth", m.contribution_basis?.philhealth), m.philhealth || 0);
  p.row(contributionLabel("Pag-IBIG", m.contribution_basis?.pagibig), m.pagibig || 0);
  p.row(withholdingTaxLabel("Withholding tax (monthly table)", m.tax_bracket), m.withholding_tax || 0, { note: `Taxable income ${money(m.taxable_income)}` });
  minus("Loans and cash advances", m.cash_advance);
  (m.subsidy_memos || []).forEach((memo) => p.row(memo, null));
  p.row("Monthly net", m.monthly_net || 0, { bold: true });
  p.row(m.first_half_status === "final" ? "Less: paid in 1st half" : "Less: paid in 1st half (not processed)", m.first_half_paid || 0);
  minus(`Balance carried from ${m.carry_from || "last month"}`, m.carry_in);
  // Year-end tax annualization (src/lib/payroll/year-end-tax.js).
  if (m.year_end_tax?.kind === "refund") plus(m.year_end_tax.label, m.year_end_tax.amount, m.year_end_tax.note);
  else if (m.year_end_tax) minus(m.year_end_tax.label, m.year_end_tax.amount, m.year_end_tax.note);
  if (Number(m.carry_over_out) > 0) p.row("Balance carried to next month", m.carry_over_out);
}

const SEAL_SIZE = 40;

/* ── Alpha test A8 (2026-11-09): tables, negative deductions, ₱, pages ──── */

const FOOT = 40; // space kept for the footer

/**
 * Collects what the section builders (cutoffRows, semiMonthlyRows,
 * holidayRows) write -- headings and rows -- so they can be drawn as tables
 * that run onto a second page. Same calls as the old single-page writer.
 */
class SectionCollector {
  constructor() {
    this.sections = [];
  }

  heading(label) {
    this.sections.push({ title: label, rows: [] });
  }

  row(label, amount, { bold = false, note = "" } = {}) {
    if (!this.sections.length) this.heading("Earnings");
    this.sections[this.sections.length - 1].rows.push({ label: String(label ?? "").trim(), amount, bold, note });
  }
}

/** A section of deductions: its amounts are shown below zero. */
const isDeductionSection = (title) => /deduction|contribution|tax/i.test(title);

/** The sign an amount is shown with: deductions negative (a credit then shows positive). */
function shownAmount(section, row) {
  if (row.amount === null || row.amount === undefined) return null;
  const n = Number(row.amount) || 0;
  if (/^less:/i.test(row.label)) return -Math.abs(n);
  if (/^add:/i.test(row.label)) return Math.abs(n);
  if (isDeductionSection(section.title)) return -n;
  return n;
}

/** Word-wrap with the approximate Helvetica widths (never wider than `room`). */
function wrapText(value, room, size) {
  const words = String(value ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (!current || textWidth(next, size) <= room) current = next;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

class PdfPages {
  constructor() {
    this.pages = [];
    this.add();
  }

  add() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE_H - MARGIN;
  }

  /** Room for `height` more points on this page, or a new page. */
  ensure(height) {
    if (this.y - height < MARGIN + FOOT) {
      this.add();
      return true;
    }
    return false;
  }

  text(x, y, value, { size = 10, bold = false, gray = 0 } = {}) {
    this.ops.push(`${gray} g BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(value)}) Tj ET`);
  }

  right(xRight, y, value, options = {}) {
    this.text(xRight - textWidth(value, options.size || 10), y, value, options);
  }

  line(x1, y1, x2, y2, { width = 0.6, gray = 0.75 } = {}) {
    this.ops.push(`${gray} G ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  fill(x, y, w, h, gray) {
    this.ops.push(`${gray} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  image(x, y, width, height) {
    this.ops.push(`q ${width} 0 0 ${height} ${x} ${y} cm /Im1 Do Q`);
  }

  /**
   * An amount right-aligned at xRight with a real peso sign: Helvetica has
   * no ₱, so a "P" is drawn and its stem is crossed by two short strokes.
   * Negative amounts get a minus sign: -₱1,000.00.
   */
  peso(xRight, y, amount, { size = 10, bold = false, gray = 0 } = {}) {
    const n = Number(amount) || 0;
    const digits = money(Math.abs(n));
    const sign = n < 0 ? "-" : "";
    const text = `${sign}P${digits}`;
    const x = xRight - textWidth(text, size);
    this.text(x, y, text, { size, bold, gray });
    const px = x + textWidth(sign, size);
    const w = textWidth("P", size);
    const stroke = bold ? 0.9 : 0.7;
    this.ops.push(`${gray} G ${stroke} w ${(px - size * 0.08).toFixed(2)} ${(y + size * 0.6).toFixed(2)} m ${(px + w * 0.9).toFixed(2)} ${(y + size * 0.6).toFixed(2)} l S`);
    this.ops.push(`${gray} G ${stroke} w ${(px - size * 0.08).toFixed(2)} ${(y + size * 0.45).toFixed(2)} m ${(px + w * 0.9).toFixed(2)} ${(y + size * 0.45).toFixed(2)} l S`);
  }
}

const TABLE_W = PAGE_W - 2 * MARGIN;
const COL_AMOUNT = 110; // the Amount column, right-aligned
const COL_LABEL = 210;  // the Description column; the rest is the Details column

/** One section as a table: Description | Details | Amount; the header repeats on a new page. */
function drawSection(doc, section) {
  const head = () => {
    doc.fill(MARGIN, doc.y - 5, TABLE_W, 17, 0.92);
    doc.text(MARGIN + 6, doc.y, section.title, { size: 9, bold: true });
    // A long title (an Earnings heading with its dates) takes the Details column's place.
    if (textWidth(section.title, 9) < COL_LABEL - 12) doc.text(MARGIN + COL_LABEL + 6, doc.y, "Details", { size: 8, gray: 0.35 });
    doc.right(MARGIN + TABLE_W - 6, doc.y, "Amount", { size: 8, gray: 0.35 });
    doc.y -= 17;
  };
  doc.ensure(40);
  head();
  for (const row of section.rows) {
    const labelLines = wrapText(row.label, COL_LABEL - 12, 9.5);
    const noteLines = row.note ? wrapText(row.note, TABLE_W - COL_LABEL - COL_AMOUNT - 12, 8) : [];
    const height = Math.max(labelLines.length * 12, noteLines.length * 10) + 4;
    if (doc.ensure(height + 4)) {
      doc.text(MARGIN, doc.y, `${section.title} (continued)`, { size: 8, gray: 0.4 });
      doc.y -= 14;
      head();
    }
    const top = doc.y;
    labelLines.forEach((line, i) => doc.text(MARGIN + 6, top - i * 12, line, { size: 9.5, bold: row.bold }));
    noteLines.forEach((line, i) => doc.text(MARGIN + COL_LABEL + 6, top - i * 10, line, { size: 8, gray: 0.4 }));
    const shown = shownAmount(section, row);
    if (shown !== null) doc.peso(MARGIN + TABLE_W - 6, top, shown, { size: 9.5, bold: row.bold });
    doc.y = top - height;
    doc.line(MARGIN, doc.y + 6, MARGIN + TABLE_W, doc.y + 6, { width: 0.3, gray: 0.85 });
  }
  doc.y -= 8;
}

/**
 * The payslip (buildPayslipDetails() in the payroll route) as PDF bytes: A4
 * portrait, header with the seal, school, branch and employee, then tables
 * (Earnings, Deductions -- negative --, contributions with their percentage
 * labels), Gross / Total deductions / Net pay, and on every page the footer
 * "System-generated payslip", the date and the page number. Every line the
 * on-screen payslip shows is here; a long payslip runs onto page 2 without
 * breaking a row. Only the employee's share ever appears (never the
 * employer's).
 */
export function buildPayslipPdf(details, { seal = null, orgName = DEFAULT_ORG_NAME } = {}) {
  const doc = new PdfPages();
  const final = details?.status === "final";
  const generation = details?.generation || {};
  const summary = details?.attendance_summary || null;
  const sealInfo = jpegInfo(seal);
  const sealUsable = Boolean(sealInfo && sealInfo.width > 0 && sealInfo.height > 0 && [1, 3].includes(sealInfo.components));
  const employee = details?.employee || {};

  // Header: seal, school, branch; FINAL / DRAFT and the payslip number.
  const titleX = sealUsable ? MARGIN + SEAL_SIZE + 10 : MARGIN;
  if (sealUsable) doc.image(MARGIN, doc.y - 16 - 12, SEAL_SIZE, SEAL_SIZE);
  doc.text(titleX, doc.y, "Shepherd Angels Christian School", { size: 15, bold: true });
  doc.right(PAGE_W - MARGIN, doc.y, final ? "FINAL" : "DRAFT", { size: 13, bold: true, gray: final ? 0 : 0.45 });
  doc.y -= 16;
  doc.text(titleX, doc.y, `${employee.branch || "Branch"} - Payslip - ${systemName(orgName)} Management System`, { size: 10, gray: 0.35 });
  doc.right(PAGE_W - MARGIN, doc.y, `Payslip No. ${details?.payslip_no || "-"}`, { size: 9, gray: 0.35 });
  doc.y -= 18;
  doc.line(MARGIN, doc.y, PAGE_W - MARGIN, doc.y);
  doc.y -= 16;

  // Employee and period, in two rows of three.
  const col = TABLE_W / 3;
  const pair = (label, value, x) => {
    doc.text(x, doc.y, label, { size: 8, gray: 0.45 });
    doc.text(x, doc.y - 12, clip(value, 40), { size: 10, bold: true });
  };
  pair("Employee", employee.name || "-", MARGIN);
  pair("Employee ID", employee.id || "-", MARGIN + col);
  pair("Position", employee.position || "-", MARGIN + 2 * col);
  doc.y -= 30;
  pair("Pay period", details?.pay_period || "-", MARGIN);
  pair("Pay date", details?.pay_date_label || generation.pay_date_label || generation.generated_at_label || "-", MARGIN + col);
  pair("Status", final ? "Final (locked)" : "Draft", MARGIN + 2 * col);
  doc.y -= 30;
  if (Array.isArray(employee.branch_days) && employee.branch_days.length) {
    doc.text(MARGIN, doc.y, `Days by branch: ${employee.branch_days.map((b) => `${b.branch_name} ${b.days}`).join(", ")}`, { size: 9, gray: 0.35 });
    doc.y -= 14;
  }
  if (!final && generation.attendance_through_label) {
    doc.text(MARGIN, doc.y, `Includes attendance up to ${generation.attendance_through_label}.`, { size: 9, gray: 0.35 });
    doc.y -= 14;
  }
  doc.y -= 4;

  // The sections, exactly as the on-screen payslip lists them.
  const collected = new SectionCollector();
  const monthly = details?.monthly || null;
  const earnings = details?.earnings || {};
  if (monthly) semiMonthlyRows(collected, monthly, details?.holiday_lines);
  else {
    collected.heading("Earnings");
    collected.row("Basic pay", earnings.basic_salary || 0);
    if (Number(earnings.overtime) > 0) collected.row("Overtime", earnings.overtime);
    if (Number(earnings.holiday_pay) > 0) collected.row("Holiday pay", earnings.holiday_pay);
    holidayRows(collected, details?.holiday_lines);
    if (Number(details?.incentives?.total_incentives) > 0) collected.row("Allowances / incentives", details.incentives.total_incentives);
    collected.row("Gross pay", earnings.gross_pay || 0, { bold: true });
    collected.heading("Deductions");
    const basis = Array.isArray(details?.deduction_basis) ? details.deduction_basis : [];
    if (basis.length) basis.forEach((line) => collected.row(line.label, line.amount, { note: line.basis }));
    else collected.row("No deductions", 0);
    collected.row("Total deductions", details?.deductions?.total_deductions || 0, { bold: true });
  }
  collected.sections.filter((s) => s.rows.length).forEach((section) => drawSection(doc, section));

  if (summary) {
    doc.ensure(44);
    doc.text(MARGIN, doc.y, "ATTENDANCE SUMMARY", { size: 9, bold: true, gray: 0.35 });
    doc.y -= 14;
    const items = [["Days present", summary.days_present], ["Days absent", summary.days_absent], ["Half days", summary.half_days],
      ["Late minutes", summary.late_minutes], ["Undertime minutes", summary.undertime_minutes], ["Leave days", summary.leave_days]];
    const cell = TABLE_W / 6;
    items.forEach(([label, value], index) => {
      doc.text(MARGIN + index * cell, doc.y, label, { size: 8, gray: 0.45 });
      doc.text(MARGIN + index * cell, doc.y - 13, String(value ?? 0), { size: 11, bold: true });
    });
    doc.y -= 34;
  }

  // Gross, total deductions (negative), net pay.
  doc.ensure(70);
  const gross = Number(details?.gross_pay ?? monthly?.cutoff?.gross_pay ?? earnings.gross_pay ?? 0);
  const totalDeductions = Number(details?.deductions?.total_deductions ?? monthly?.cutoff?.total_deductions ?? 0);
  doc.fill(MARGIN, doc.y - 46, TABLE_W, 58, 0.95);
  doc.text(MARGIN + 8, doc.y, "Gross pay", { size: 10 });
  doc.peso(MARGIN + TABLE_W - 8, doc.y, gross, { size: 10 });
  doc.y -= 14;
  doc.text(MARGIN + 8, doc.y, "Total deductions", { size: 10 });
  doc.peso(MARGIN + TABLE_W - 8, doc.y, -Math.abs(totalDeductions), { size: 10 });
  doc.y -= 18;
  doc.text(MARGIN + 8, doc.y, monthly ? `${monthly.half === "first" ? "1ST" : "2ND"} HALF NET PAY` : "NET PAY", { size: 12, bold: true });
  doc.peso(MARGIN + TABLE_W - 8, doc.y, details?.net_pay || 0, { size: 14, bold: true });
  doc.y -= 26;
  const by = generation.generated_by_name ? `Computed by ${generation.generated_by_name}` : "";
  if (by) { doc.ensure(14); doc.text(MARGIN, doc.y, by, { size: 8, gray: 0.45 }); doc.y -= 12; }
  doc.ensure(12);
  doc.text(MARGIN, doc.y, "Computed from attendance records (corrected values where HR / Admin corrected a day). Employee share only.", { size: 7, gray: 0.55 });

  // Footer on every page: system-generated, the date, page n of N.
  const stamp = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
  doc.pages.forEach((ops, i) => {
    ops.push(`0.8 G 0.5 w ${MARGIN} ${MARGIN + 14} m ${PAGE_W - MARGIN} ${MARGIN + 14} l S`);
    ops.push(`0.45 g BT /F1 7.5 Tf ${MARGIN} ${MARGIN} Td (${pdfText(`System-generated payslip - Generated ${stamp}`)}) Tj ET`);
    const pageText = `Page ${i + 1} of ${doc.pages.length}`;
    ops.push(`0.45 g BT /F1 7.5 Tf ${(PAGE_W - MARGIN - textWidth(pageText, 7.5)).toFixed(2)} ${MARGIN} Td (${pdfText(pageText)}) Tj ET`);
  });

  return writePdf(doc.pages, sealUsable ? { seal, sealInfo } : null);
}

/** The pages as PDF bytes (Helvetica, Helvetica-Bold, an optional JPEG seal on page 1). */
function writePdf(pages, image) {
  const pageCount = pages.length;
  const fontRegular = 3 + pageCount * 2;
  const fontBold = fontRegular + 1;
  const imageObj = image ? fontBold + 1 : null;
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  const streams = {};
  pages.forEach((ops, i) => {
    const pageObj = 3 + i * 2;
    const contentObj = pageObj + 1;
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >>${image && i === 0 ? ` /XObject << /Im1 ${imageObj} 0 R >>` : ""} >> /Contents ${contentObj} 0 R >>`;
    streams[contentObj] = Buffer.from(ops.join("\n"), "latin1");
  });
  objects[fontRegular] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[fontBold] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let length = chunks[0].length;
  const push = (buffer) => { chunks.push(buffer); length += buffer.length; };
  const last = imageObj || fontBold;
  for (let n = 1; n <= last; n += 1) {
    offsets[n] = length;
    if (streams[n]) {
      push(Buffer.concat([Buffer.from(`${n} 0 obj\n<< /Length ${streams[n].length} >>\nstream\n`, "latin1"), streams[n], Buffer.from("\nendstream\nendobj\n", "latin1")]));
    } else if (n === imageObj) {
      const colorSpace = image.sealInfo.components === 1 ? "/DeviceGray" : "/DeviceRGB";
      push(Buffer.concat([
        Buffer.from(`${n} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.sealInfo.width} /Height ${image.sealInfo.height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.seal.length} >>\nstream\n`, "latin1"),
        image.seal,
        Buffer.from("\nendstream\nendobj\n", "latin1"),
      ]));
    } else {
      push(Buffer.from(`${n} 0 obj\n${objects[n]}\nendobj\n`, "latin1"));
    }
  }
  const xrefAt = length;
  const xref = ["xref", `0 ${last + 1}`, "0000000000 65535 f "]
    .concat(offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `))
    .join("\n");
  push(Buffer.from(`${xref}\ntrailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}
