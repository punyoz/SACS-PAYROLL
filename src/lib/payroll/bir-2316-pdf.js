/**
 * BIR Form 2316 as a PDF, one A4 page per employee, written by hand like the
 * payslip (src/lib/payroll/payslip-pdf.js): Helvetica in WinAnsi, no
 * dependency. The figures are loadBirYear()'s rows (src/lib/payroll/bir-forms.js).
 *
 * It follows the 2316 (January 2018 ENCS) part and box numbers so it can be
 * checked against, or copied onto, the official form.
 */

import { money } from "@/lib/payroll/payslip-summary";
import { pdfText, textWidth } from "@/lib/payroll/payslip-pdf";

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const RIGHT = PAGE_W - MARGIN;

function clip(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

const shortDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
};

class Page {
  constructor() {
    this.ops = [];
    this.y = PAGE_H - MARGIN;
  }

  text(x, y, value, { size = 9, bold = false, gray = 0 } = {}) {
    this.ops.push(`${gray} g BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(value)}) Tj ET`);
  }

  right(xRight, y, value, options = {}) {
    this.text(xRight - textWidth(value, options.size || 9), y, value, options);
  }

  line(x1, y1, x2, y2, { width = 0.5, gray = 0.7 } = {}) {
    this.ops.push(`${gray} G ${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
  }

  band(label) {
    this.y -= 4;
    this.ops.push(`0.92 g ${MARGIN} ${this.y - 4} ${RIGHT - MARGIN} 13 re f`);
    this.text(MARGIN + 4, this.y, label, { size: 8.5, bold: true });
    this.y -= 15;
  }

  /** "box  label ........ amount" */
  amount(box, label, value, { bold = false } = {}) {
    this.text(MARGIN + 2, this.y, String(box), { size: 8, gray: 0.4 });
    this.text(MARGIN + 28, this.y, label, { size: 8.5, bold });
    this.right(RIGHT - 2, this.y, money(value || 0), { size: 8.5, bold });
    this.line(MARGIN + 28, this.y - 3, RIGHT, this.y - 3, { gray: 0.88 });
    this.y -= 12;
  }

  /** "box label: value" fields in columns of `width`. */
  field(box, label, value, x, width) {
    this.text(x, this.y, `${box}  ${label}`, { size: 7, gray: 0.4 });
    this.text(x, this.y - 10, clip(value || "-", Math.max(8, Math.floor(width / 5))), { size: 9, bold: true });
  }
}

function drawCertificate(p, row, { employer, year }) {
  const form = row.form;
  const b = form.boxes;
  const half = (RIGHT - MARGIN) / 2;
  const third = (RIGHT - MARGIN) / 3;

  p.text(MARGIN, p.y, "BIR Form No. 2316", { size: 9, bold: true });
  p.right(RIGHT, p.y, "January 2018 (ENCS)", { size: 8, gray: 0.4 });
  p.y -= 15;
  p.text(MARGIN, p.y, "Certificate of Compensation Payment / Tax Withheld", { size: 13, bold: true });
  p.y -= 12;
  p.text(MARGIN, p.y, "For Compensation Payment With or Without Tax Withheld", { size: 8.5, gray: 0.35 });
  p.y -= 16;
  p.field(1, "For the year", String(year), MARGIN, third);
  p.field(2, "For the period", `${shortDate(form.period_from)} to ${shortDate(form.period_to)}`, MARGIN + third, third);
  p.field("", "Employee no.", row.employee_code, MARGIN + 2 * third, third);
  p.y -= 24;

  p.band("Part I - Employee Information");
  p.field(3, "TIN", row.tin, MARGIN, third);
  p.field(4, "Employee's name (Last, First, Middle)", [row.name.last, [row.name.first, row.name.middle].filter(Boolean).join(" ")].filter(Boolean).join(", "), MARGIN + third, 2 * third);
  p.y -= 24;
  p.field("6B", "Local home address", row.address, MARGIN, 2 * third);
  p.field(7, "Date of birth", shortDate(row.date_of_birth), MARGIN + 2 * third, third / 2);
  p.field(8, "Contact number", row.contact, MARGIN + 2.5 * third, third / 2);
  p.y -= 24;
  p.field("", "Position", row.position, MARGIN, 2 * third);
  p.field("", "Branch", row.branch_name, MARGIN + 2 * third, third);
  p.y -= 24;
  p.text(MARGIN, p.y, "9-11  Minimum wage earner: No", { size: 8, gray: 0.35 });
  p.y -= 12;

  p.band("Part II - Employer Information (Present)");
  p.field(12, "TIN", employer.bir_employer_tin, MARGIN, third);
  p.field(13, "Employer's name", employer.bir_employer_name, MARGIN + third, 2 * third);
  p.y -= 24;
  p.field(14, "Registered address", employer.bir_registered_address, MARGIN, 2 * third);
  p.field("14A", "ZIP code", employer.bir_zip_code, MARGIN + 2 * third, third / 2);
  p.field("", "RDO code", employer.bir_rdo_code, MARGIN + 2.5 * third, third / 2);
  p.y -= 24;
  p.text(MARGIN, p.y, "15  Type of employer: Main employer.  Part III (previous employer): none recorded.", { size: 8, gray: 0.35 });
  p.y -= 12;

  p.band("Part IV-A - Summary");
  p.amount(19, "Gross compensation income from present employer (38 + 52)", b[19], { bold: true });
  p.amount(20, "Less: total non-taxable / exempt compensation (38)", b[20]);
  p.amount(21, "Taxable compensation income from present employer (52)", b[21]);
  p.amount(22, "Add: taxable compensation income from previous employer", b[22]);
  p.amount(23, "Gross taxable compensation income (21 + 22)", b[23], { bold: true });
  p.amount(24, "Tax due", b[24], { bold: true });
  p.amount("25A", "Amount of taxes withheld - present employer", b["25A"]);
  if (Math.abs(Number(form.year_end_adjustment) || 0) >= 0.01) {
    p.amount("", `   of which year-end tax adjustment (${form.year_end_adjustment > 0 ? "collected" : "refunded"})`, form.year_end_adjustment);
  }
  p.amount("25B", "Amount of taxes withheld - previous employer", b["25B"]);
  p.amount(26, "Total amount of taxes withheld as adjusted (25A + 25B)", b[26]);
  p.amount(27, "5% tax credit (PERA Act of 2008)", b[27]);
  p.amount(28, "Total taxes withheld (26 + 27)", b[28], { bold: true });

  p.band("Part IV-B - Details of Compensation Income - A. Non-taxable / Exempt");
  p.amount("29-33", "Minimum wage earner pay (basic, holiday, overtime, night diff., hazard)", 0);
  p.amount(34, "13th month pay and other benefits (up to the exempt ceiling)", b[34]);
  p.amount(35, "De minimis benefits", 0);
  p.amount(36, "SSS, PhilHealth and Pag-IBIG contributions (employee share)", b[36]);
  p.amount(37, "Salaries and other forms of compensation", b[37]);
  p.amount(38, "Total non-taxable / exempt compensation income", b[38], { bold: true });

  p.band("B. Taxable Compensation Income - Regular and Supplementary");
  p.amount(39, "Basic salary (net of the contributions in 36)", b[39]);
  p.amount("40-44", "Representation, transportation, COLA, housing and other allowances", 0);
  p.amount("45-47", "Commission, profit sharing, fees", 0);
  p.amount(48, "Taxable 13th month pay and other benefits (above the ceiling)", b[48]);
  p.amount(49, "Hazard pay", 0);
  p.amount(50, "Overtime pay", b[50]);
  p.amount("51A", "Others: holiday and overload pay", b["51A"]);
  p.amount("51B", "Others: incentives and taxable subsidy", b["51B"]);
  p.amount(52, "Total taxable compensation income", b[52], { bold: true });

  p.y -= 4;
  const diff = form.difference;
  const note = form.settlement === "none"
    ? "Tax withheld equals the tax due for the year."
    : form.settlement === "collect"
      ? `Tax due is PHP ${money(diff)} more than the tax withheld: to be collected by the year-end tax adjustment.`
      : `Tax withheld is PHP ${money(-diff)} more than the tax due: to be refunded by the year-end tax adjustment.`;
  p.text(MARGIN, p.y, `Year-end: ${note}`, { size: 8.5, bold: form.settlement !== "none" });
  p.y -= 18;

  // Declarations and signatures.
  p.text(MARGIN, p.y, "I declare, under the penalties of perjury, that the information herein stated are reported under BIR Form No. 1604-C,", { size: 7, gray: 0.35 });
  p.y -= 9;
  p.text(MARGIN, p.y, "which have been made in good faith, verified by me, and to the best of my knowledge and belief, are true and correct.", { size: 7, gray: 0.35 });
  p.y -= 26;
  const sign = (x, name, caption) => {
    p.line(x, p.y, x + half - 20, p.y, { gray: 0.3 });
    p.text(x, p.y + 3, clip(name || "", 48), { size: 9, bold: true });
    p.text(x, p.y - 9, caption, { size: 7, gray: 0.4 });
  };
  sign(MARGIN, [employer.bir_signatory_name, employer.bir_signatory_title].filter(Boolean).join(", "), "53  Present employer / authorized agent - signature over printed name");
  sign(MARGIN + half + 20, row.full_name, "54  Employee - signature over printed name");
  p.y -= 24;

  p.text(MARGIN, MARGIN + 9, `Computed from ${form.payslip_count} paid payslip(s), the 13th month and benefits paid in ${year}.`, { size: 6.5, gray: 0.5 });
  p.text(MARGIN, MARGIN, "Not recorded by the system and shown as zero: previous employer, minimum wage, de minimis, allowances.", { size: 6.5, gray: 0.5 });
}

/** One page per row. */
export function build2316Pdf(rows, { employer = {}, year } = {}) {
  const pages = (rows.length ? rows : [null]).map((row) => {
    const p = new Page();
    if (row) drawCertificate(p, row, { employer, year });
    else p.text(MARGIN, p.y, `No paid payslips in ${year}.`, { size: 11 });
    return Buffer.from(p.ops.join("\n"), "latin1");
  });

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then a page + content pair each.
  const pageIds = pages.map((_, i) => 5 + i * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
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
  pages.forEach((content, i) => {
    const pageId = pageIds[i];
    offsets.push(length);
    push(Buffer.from(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>\nendobj\n`, "latin1"));
    offsets.push(length);
    push(Buffer.concat([
      Buffer.from(`${pageId + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n`, "latin1"),
      content,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    ]));
  });

  const xrefAt = length;
  const xref = ["xref", `0 ${offsets.length + 1}`, "0000000000 65535 f "]
    .concat(offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `))
    .join("\n");
  push(Buffer.from(`${xref}\ntrailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}
