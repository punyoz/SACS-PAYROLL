/**
 * A payslip as an A4 PDF, built on the server and downloaded (the portal's
 * Content-Security-Policy allows no third-party scripts). Since 2026-11-19 it
 * is laid out by the shared template (src/lib/export/pdf-doc.js,
 * @react-pdf/renderer) in the embedded Noto Sans, which has ₱ and −:
 * deductions read −₱1,000.00, one string per amount.
 *
 * The school seal, when given, is a JPEG: public/brand/seal-payslip.jpg,
 * read by the payroll route. pdfText / textWidth below (Helvetica, WinAnsi)
 * are kept for the BIR 2316 form (src/lib/payroll/bir-2316-pdf.js).
 */

import { money } from "@/lib/payroll/payslip-summary";
import { contributionLabel, withholdingTaxLabel } from "@/lib/payroll/statutory";
import { describeHolidayLine } from "@/lib/payroll/holiday-lines";
import { DEDUCTION_GROUPS, payslipTables } from "@/lib/payroll/payslip-tables";
import { DEFAULT_ORG_NAME, systemName } from "@/lib/org-name-format";
import { pesoPdf } from "@/lib/export/pdf-text";
import { renderPayslipDocument } from "@/lib/export/pdf-doc";
import { periodFromLabel } from "@/lib/payroll/periods";

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
    .replace(/[–—−]/g, "-")
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

/* ── The payslip (2026-11-19): a model for the shared template (src/lib/export/pdf-doc.js) ── */

/**
 * Collects what the section builders (tablesRows, taxBoxRows, semiMonthlyRows,
 * holidayRows) write -- headings and rows -- for the template's tables.
 */
class SectionCollector {
  constructor() {
    this.sections = [];
  }

  heading(label) {
    this.sections.push({ title: label, rows: [] });
  }

  row(label, amount, { bold = false, note = "", signed } = {}) {
    if (!this.sections.length) this.heading("Earnings");
    this.sections[this.sections.length - 1].rows.push({ label: String(label ?? "").trim(), amount, bold, note, signed });
  }
}

/** A section of deductions: its amounts are shown below zero. */
const isDeductionSection = (title) => /deduction|contribution/i.test(title);

/** The sign an amount is shown with: deductions negative (a credit then shows positive). */
function shownAmount(section, row) {
  if (row.amount === null || row.amount === undefined) return null;
  if (row.signed !== undefined) return row.signed;
  const n = Number(row.amount) || 0;
  if (/^less:/i.test(row.label)) return -Math.abs(n);
  if (/^add:/i.test(row.label)) return Math.abs(n);
  if (isDeductionSection(section.title)) return -n;
  return n;
}

/** "payslip-PS-202611-1255-2026-10-16-to-31.pdf": the payslip number and the period's dates, no spaces. */
export function payslipFileName(entry, draft = false) {
  const no = String(entry?.payslip_no || entry?.employee_code || "payslip").replace(/[^\w-]/g, "");
  const period = periodFromLabel(entry?.pay_period || "");
  const dates = period?.start_key && period?.end_key
    ? `${period.start_key}-to-${period.end_key.slice(8)}`
    : String(entry?.pay_period || "").trim().replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "");
  return `payslip-${no}${dates ? `-${dates}` : ""}${draft ? "-DRAFT" : ""}.pdf`;
}

/** Deductions read positive on the payslip (2026-11-22); a credit (a tax refund) reads −₱ against them. */
const deductionAmount = (r) => (r.text ? "" : pesoPdf(r.credit ? -Math.abs(r.amount) : Math.abs(r.amount)));
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The two panels from payslipTables(): Earnings (pay, holiday lines, incentives) | Deductions (grouped). */
function panelsFor(t) {
  const earnings = [];
  t.earnings.forEach((r) => {
    earnings.push({ label: r.label, formula: r.text || r.formula || "", amount: r.text ? "" : pesoPdf(r.amount) });
    if (r.key === "holiday" && Number(r.amount) > 0) {
      (t.holiday_lines || []).forEach((line) => earnings.push({ label: describeHolidayLine(line), amount: pesoPdf(line.amount), indent: true }));
    }
  });
  if (t.incentives.length) {
    earnings.push({ group: "Incentives" });
    t.incentives.forEach((r) => earnings.push({ label: r.label, formula: r.formula || "", amount: pesoPdf(r.amount) }));
  }
  const deductions = [];
  DEDUCTION_GROUPS.forEach(([key, label]) => {
    const rows = t.deductions.filter((r) => r.group === key);
    if (!rows.length) return;
    deductions.push({ group: label });
    rows.forEach((r) => deductions.push({ label: r.label, formula: r.text || r.formula || "", amount: deductionAmount(r) }));
  });
  if (!deductions.length) deductions.push({ label: "None", amount: "" });
  return {
    earnings: { title: "Earnings", rows: earnings, total: ["Gross pay", pesoPdf(t.gross)] },
    deductions: { title: "Deductions", rows: deductions, total: ["Total deductions", pesoPdf(Math.abs(Number(t.total_deductions) || 0))] },
  };
}

/** The monthly tax computation (2nd half; employeePayslipView tax_box), positive amounts with "Less:". */
function taxBox(box) {
  return {
    title: "Monthly tax computation",
    rows: [
      ...box.rows.map((r) => [r.sign === "-" ? `Less: ${r.label}` : r.label, pesoPdf(Math.abs(Number(r.amount) || 0))]),
      ["Taxable income", pesoPdf(box.taxable), true],
      ["Withholding tax", pesoPdf(box.tax), true],
    ],
    note: [box.bracket ? `Bracket: ${box.bracket}` : null, box.formula, box.reason].filter(Boolean).join(" · ") || null,
  };
}

/** Year to date (loadPayslipYtd): the employee's share only. */
function ytdBox(ytd) {
  return {
    title: `Year to date (${ytd.year})`,
    rows: [["Gross pay", pesoPdf(ytd.gross)], ["Taxable income", pesoPdf(ytd.taxable)], ["Tax withheld", pesoPdf(ytd.tax)],
      ["SSS", pesoPdf(ytd.sss)], ["PhilHealth", pesoPdf(ytd.philhealth)], ["Pag-IBIG", pesoPdf(ytd.pagibig)]],
    note: `${ytd.payslips} released payslip${ytd.payslips === 1 ? "" : "s"} of ${ytd.year}, this one included.`,
  };
}

/** "1st half", "2nd half", "Final pay", "13th month" (details.pay_type wins). */
function payType(details) {
  if (details?.pay_type) return details.pay_type;
  if (details?.final_pay) return "Final pay";
  const half = details?.monthly?.half || details?.line_groups?.half || details?.employee_view?.half;
  if (half === "first") return "1st half";
  if (half === "second") return "2nd half";
  return "Payslip";
}

/**
 * The payslip (buildPayslipDetails() in the payroll route) as PDF bytes
 * (async), A4 portrait, one page (2026-11-22): header (seal, school, branch,
 * PAYSLIP, number, status), header cells (period, pay date, pay type), the
 * employee grid, Earnings | Deductions side by side with their totals on one
 * line, Net pay = Gross - Total deductions, the month total, then the monthly
 * tax computation (2nd half) and the year to date. Every amount is a stored
 * figure (payslipTables); only the employee's share ever appears.
 */
export function buildPayslipPdf(details, { seal = null, orgName = DEFAULT_ORG_NAME } = {}) {
  const final = details?.status === "final";
  const status = details?.status_label || (final ? "Final" : "Draft");
  const generation = details?.generation || {};
  const summary = details?.attendance_summary || null;
  const sealInfo = jpegInfo(seal);
  const sealUsable = Boolean(sealInfo && sealInfo.width > 0 && sealInfo.height > 0 && [1, 3].includes(sealInfo.components));
  const employee = details?.employee || {};
  const view = details?.employee_view || null;
  const extra = view || details || {};
  const waiting = status === "Pending HR approval" || status === "Returned by HR";

  const monthly = details?.monthly || null;
  const earnings = details?.earnings || {};
  const tables = payslipTables(view ? { ...details, line_groups: view } : details);
  // An older semi-monthly payslip without per-line figures keeps its one-column layout.
  let sections = null;
  if (!tables) {
    const collected = new SectionCollector();
    semiMonthlyRows(collected, monthly, details?.holiday_lines);
    sections = collected.sections.filter((s) => s.rows.length).map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => {
        const shown = shownAmount(s, r);
        return { label: r.label, details: r.note || "", amount: shown === null ? null : pesoPdf(shown), bold: r.bold };
      }),
    }));
  }

  const gross = Number(tables ? tables.gross : view ? view.gross : details?.gross_pay ?? monthly?.cutoff?.gross_pay ?? earnings.gross_pay ?? 0);
  const totalDeductions = Number(tables ? tables.total_deductions : view ? view.total_deductions : details?.deductions?.total_deductions ?? monthly?.cutoff?.total_deductions ?? 0);
  const netLabel = view ? view.net_label : monthly && !details?.final_pay ? `${monthly.half === "first" ? "1st" : "2nd"} half net pay` : "Net pay";
  const stamp = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
  const boxes = [extra.tax_box ? taxBox(extra.tax_box) : null, details?.ytd ? ytdBox(details.ytd) : null].filter(Boolean);

  return renderPayslipDocument({
    seal: sealUsable ? seal : null,
    status,
    payslipNo: details?.payslip_no,
    branchLine: `${employee.branch || "Branch"} - Payslip - ${systemName(orgName)} Management System`,
    strip: [
      ["Pay period", details?.pay_period],
      [details?.final_pay ? "Release date" : "Pay date", details?.pay_date_label || (waiting ? "After HR approval" : "—")],
      ["Pay type", payType(details)],
    ],
    grid: [
      [["Employee", employee.name], ["Employee ID", employee.id], ["Position", employee.position]],
      [["Branch", employee.branch], ["Category", employee.type], ["Status", status]],
    ],
    lines: [
      Array.isArray(employee.branch_days) && employee.branch_days.length ? `Days by branch: ${employee.branch_days.map((b) => `${b.branch_name} ${b.days}`).join(", ")}` : null,
      !final && generation.attendance_through_label ? `Includes attendance up to ${generation.attendance_through_label}.` : null,
      // A final pay: who approved it and when (20261120010000).
      details?.approval_line || null,
    ].filter(Boolean),
    stats: summary ? [["Days present", summary.days_present], ["Days absent", summary.days_absent], ["Half days", summary.half_days],
      ["Late minutes", summary.late_minutes], ["Undertime minutes", summary.undertime_minutes], ["Leave days", summary.leave_days]] : null,
    panels: tables ? panelsFor(tables) : null,
    sections,
    notes: (tables?.notes || []).map(sentence),
    net: { gross: pesoPdf(gross), deductions: pesoPdf(Math.abs(totalDeductions)), carried: tables?.carry_over_out ? pesoPdf(tables.carry_over_out) : null, net: pesoPdf(details?.net_pay || 0), netLabel: String(netLabel || "Net pay").toUpperCase() },
    monthTotal: extra.month_total?.label || null,
    boxes,
    by: generation.generated_by_name ? `Computed by ${generation.generated_by_name}` : null,
    footer: ["Employee share only. Attendance includes HR-approved corrections.", `Generated ${stamp} by ${systemName(orgName)}`],
  });
}
